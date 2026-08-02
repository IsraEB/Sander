#!/bin/sh
# sander supervisor — Sander-owned generic service supervisor.
#
# Deployed inside the box at <worktree>/.sander/supervisor.sh by `sander create`
# and relaunched by `sander start`. Responsibilities (spec §57):
#   - run the project's `.sander/start.sh` (a long-running foreground service)
#   - watch the worktree and restart start.sh whenever files change
#   - append the service output to `<worktree>/.sander/start.log`
#   - record the supervisor's own pid in `<worktree>/.sander/supervisor.pid`
#
# Interface:
#   supervisor.sh start [<worktree>]   launch; no-op when already running (default /workspace)
#   supervisor.sh stop  [<worktree>]   terminate the running supervisor and its service
#
# Portable POSIX sh + GNU coreutils (find/sort/md5sum). No inotify, no
# systemd/supervisord (spec §61). The watcher is a polling loop: it snapshots
# every file's mtime+size+path under the worktree (excluding .git and the
# supervisor's own runtime files) and restarts start.sh when the snapshot
# changes between polls.

set -u

WORKTREE="${2:-/workspace}"
SANDER_DIR="$WORKTREE/.sander"
START_SCRIPT="$SANDER_DIR/start.sh"
PIDFILE="$SANDER_DIR/supervisor.pid"
LOGFILE="$SANDER_DIR/start.log"
POLL_SECONDS=2

SERVICE_PID=""
BASELINE=""

log() { echo "[sander-supervisor] $*" >> "$LOGFILE"; }

is_alive() { kill -0 "$1" 2>/dev/null; }

# whether a live pid actually belongs to a sander supervisor (its /proc
# cmdline mentions supervisor.sh). After an unclean shutdown the pidfile may
# hold a stale pid that was recycled by an innocent process: trusting it would
# make `start` log "already running" with no service, or make `stop` kill a
# process that is not ours.
is_supervisor() {
    if ! is_alive "$1"; then
        return 1
    fi
    cmd=$(cat "/proc/$1/cmdline" 2>/dev/null) || return 1
    case "$cmd" in
        *"supervisor.sh"*) return 0 ;;
    esac
    return 1
}

# pid of a live supervisor recorded in the pidfile, or empty
running_pid() {
    [ -f "$PIDFILE" ] || return 0
    pid=$(cat "$PIDFILE" 2>/dev/null) || return 0
    case "$pid" in
        ''|*[!0-9]*) return 0 ;;
    esac
    if is_supervisor "$pid"; then
        printf '%s' "$pid"
    fi
}

snapshot() {
    find "$WORKTREE" -type f \
        -not -path "$WORKTREE/.git/*" \
        -not -path "$WORKTREE/.sander/supervisor.sh" \
        -not -path "$WORKTREE/.sander/supervisor.pid" \
        -not -path "$WORKTREE/.sander/start.log" \
        -printf '%T@ %s %p\n' 2>/dev/null \
        | sort \
        | md5sum
}

start_service() {
    log "starting start.sh"
    # own session/group so the whole service tree can be killed together
    setsid "$START_SCRIPT" >> "$LOGFILE" 2>&1 &
    SERVICE_PID=$!
    # absorb the service's own startup writes into the new baseline
    sleep 1
    BASELINE=$(snapshot)
}

stop_service() {
    if [ -n "$SERVICE_PID" ]; then
        kill -TERM "-$SERVICE_PID" 2>/dev/null
        sleep 1
        kill -KILL "-$SERVICE_PID" 2>/dev/null
    fi
    SERVICE_PID=""
}

cleanup() {
    stop_service
    rm -f "$PIDFILE"
    exit 0
}
trap cleanup TERM INT

cmd="${1:-start}"
case "$cmd" in
    start)
        pid=$(running_pid)
        if [ -n "$pid" ]; then
            log "already running (pid $pid); refusing a second supervisor"
            exit 0
        fi
        mkdir -p "$SANDER_DIR"
        echo "$$" > "$PIDFILE"
        log "supervisor started (pid $$)"
        start_service
        while :; do
            sleep "$POLL_SECONDS"
            current=$(snapshot)
            if [ "$current" != "$BASELINE" ]; then
                log "worktree changed; restarting start.sh"
                stop_service
                start_service
            fi
        done
        ;;
    stop)
        pid=$(running_pid)
        if [ -z "$pid" ]; then
            # no live supervisor: drop the stale pidfile (unclean shutdown) and
            # do nothing — never kill an innocent process that recycled the pid
            rm -f "$PIDFILE"
            exit 0
        fi
        kill -TERM "$pid" 2>/dev/null
        i=0
        while [ "$i" -lt 10 ] && is_alive "$pid"; do
            sleep 1
            i=$((i + 1))
        done
        if is_alive "$pid"; then
            kill -KILL "$pid" 2>/dev/null
        fi
        rm -f "$PIDFILE"
        exit 0
        ;;
    *)
        echo "usage: supervisor.sh start|stop [worktree]" >&2
        exit 2
        ;;
esac
