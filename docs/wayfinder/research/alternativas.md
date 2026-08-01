# Barrido de alternativas — sander

Investigación del ticket "El barrido de alternativas" (mapa de wayfinding para `sander`).
Fecha: 2026-08-01. Método: solo fuentes primarias (docs oficiales, repos reales, manuales de CLI), verificadas de primera mano.

## Criterios

- **Listón alto**: flujo end-to-end en una herramienta — crear sandbox con un harness elegido, ejecutar un prompt dentro, attach/exec estilo docker, con provider y harness pluggeables.
- **Listón de conformidad**: docker como sandbox + soporte de opencode y claude code como harness → podría bastar.

## Checklist (por candidato)

1. Clona el repo actual con sus dependencias pesadas (node_modules) ya presentes.
2. Instala la config global del harness en el sandbox sin ensuciar el repo.
3. Rama git por sandbox atada a un ticket/issue.
4. Ejecuta un prompt de forma headless.
5. Attach/exec interactivo estilo docker.
6. Usa un token de GitHub para issues.

## Tabla resumen

| Candidato | qué es | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| **agentbox** (madarco/agentbox) | CLI docker+tmux para correr agentes (claude/codex/opencode) en "boxes" con proyecto teleportado y sync de settings | ◐ | ✔ | ✘ | ◐ | ✔ | ✘ |
| **GitHub Codespaces** (`gh codespace`) | dev containers gestionados en la nube de GitHub | ◐ | ◐ | ◐ | ✘ | ✔ | ✔ |
| **`gh agent-task`** (Copilot coding agent) | task headless gestionado por GitHub: prompt → agente → rama + PR | ◐ | ✘ | ✔ | ✔ | ✘ | ✔ |
| **devcontainer CLI** (devcontainers/cli) | reference impl. del spec Dev Container sobre docker local | ◐ | ◐ | ✘ | ✘ | ✔ | ✘ |
| **devpod** (loft-sh/devpod) | dev containers reproducibles, multi-provider, client-only | ◐ | ◐ | ✘ | ✘ | ✔ | ✘ |
| **gitpod → Ona** | plataforma cloud para agentes de fondo (dev containers, automations) | ◐ | ◐ | ◐ | ✔ | ✘ | ◐ |
| **e2b** | sandboxes cloud (microVMs) para agentes, vía SDK | ◐ | ✘ | ✘ | ◐ | ◐ | ✘ |
| **daytona** | sandboxes cloud para agentes de IA, CLI + SDK + MCP | ◐ | ✘ | ✘ | ◐ | ✔ | ✘ |
| **opencode** (harness) | agente de código; headless + GitHub Actions; sin sandbox nativo | ◐ | ◐ | ◐ | ✔ | ✘ | ◐ |
| **claude code** (harness) | agente de código; headless + sandbox bash + devcontainer oficial | ◐ | ✔ | ✘ | ✔ | ✘ | ✘ |

## Detalle por candidato

### agentbox — https://github.com/madarco/agentbox · https://agent-box.sh/docs

CLI (TypeScript, npm `@madarco/agentbox`) que corre agentes en paralelo dentro de VMs/contenedores docker (FUSE overlay), en local o en la nube (hetzner, vercel, e2b, daytona, digitalocean, remote-docker vía SSH). Lanzo `agentbox claude` / `agentbox codex` / `agentbox opencode` → crea un box con el proyecto dentro ("teleport") y arranca el harness en una sesión tmux detachable.

- Config global del harness: **✔**. "Automatic — Bring all your skills, plugins, and settings for **Claude Code**, **Codex**, **Open Code**" (fuente: README). Es exactamente el punto 2 del checklist.
- Attach/exec: **✔**. `agentbox attach <id>` (reconectar al tmux), `agentbox shell <id>` (bash interactivo), `agentbox cp` (estilo `docker cp`), `agentbox dashboard`, `agentbox wait`, `agentbox stop/pause/start`.
- Dependencias pesadas: **◐**. El wizard de setup "installs required project libraries and launches your dev server"; el "upper volume" preserva `node_modules` entre paradas/arranques. El proyecto se copia al box (sync "gitignore-aware", `agentbox download` trae `/workspace` de vuelta). No es "clonar repo con deps ya dentro", pero es lo más parecido: deps se instalan dentro del box y persisten.
- Prompt headless: **◐**. El foco es lanzar el harness interactivo en tmux (detachable, sigue corriendo al desconectar). No hay comando `agentbox run "<prompt>"`. Ejecutar un prompt headless equivale a hacer `claude -p "…"` / `opencode run "…"` dentro del box vía `shell`/`exec` — viable pero no es un comando propio.
- Rama por issue: **✘**. No vincula issue→branch. Guarda las git credentials en el host y **pide permiso para push** ("Your git credentials are kept on your local machine, with permission requests to push to the remote repository"), que es una decisión de seguridad distinta a "rama por sandbox atada a issue".
- Token GitHub para issues: **✘** (trabaja con las credenciales git del usuario, sin primitivas de issues).

**Posición**: el candidato más cercano a `sander` (docker + múltiples harnesses + sync de config global + attach/shell), con dos gaps: (a) sin comando de prompt headless dedicado, (b) sin orquestación issue→rama→token.

### GitHub Codespaces / `gh codespace` — https://cli.github.com/manual/gh_codespace_create · https://cli.github.com/manual/gh_codespace_ssh

Dev containers gestionados en la nube de GitHub (no docker local). El CLI `gh cs` permite `create` (con `--branch`, `--devcontainer-path`, `--machine`), `ssh` (interactivo o con `<command>`), `cp`, `stop`, `logs`, `ports`, `rebuild`.

- Clone con deps: **◐**. Codespaces clona el repo; los **prebuilds** (imagen preconstruida con `postCreateCommand` ejecutado) dejan las dependencias instaladas de arranque.
- Config global: **◐**. Soporta **dotfiles** personales (mecanismo oficial), donde podría vivir la config del harness; no es automático por harness.
- Rama por issue: **◐**. `gh codespace create --branch X` crea el codespace en una rama; combinado con `gh issue develop <n> --checkout` (crea rama vinculada al issue) se puede montar el flujo, pero no es automático por sandbox.
- Prompt headless: **✘**. Codespaces es infra; no ejecuta prompts. Se haría `gh codespace ssh` + correr `opencode run` / `claude -p` dentro.
- Attach/exec: **✔**. `gh codespace ssh` con/sin comando (estilo exec remoto).
- Token GitHub: **✔**. Todo pasa por `gh auth` (token GitHub), y `gh issue`/`gh pr` cubren issues.

### `gh agent-task` (Copilot coding agent) — https://cli.github.com/manual/gh_agent-task_create · .../gh_agent-task_view

Comando en preview de GitHub CLI que crea un **task de agente gestionado por GitHub**: `gh agent-task create "desc"` → el agente Copilot se ejecuta en infra gestionada, crea una rama y abre un PR (`--base`, `--custom-agent`, `--follow`). `gh agent-task view <id|pr>` con logs y estado.

- Headless: **✔**. El agente corre solo; `--follow` sigue los logs.
- Rama + PR: **✔**. Crea la rama y abre PR desde el task (los campos JSON incluyen `pullRequestNumber`, `pullRequestUrl`, `pullRequestState`).
- Token GitHub: **✔**.
- Harness pluggeable: **✘**. `--custom-agent` se refiere a un agente definido en `.github/agents/my-agent.md` del ecosistema **Copilot**, no a opencode/claude code. Es GitHub-hosted (no docker local).
- Attach/exec: **✘** (solo `--follow`/`--log`; no shell interactivo).
- Config global del harness: **✘** (harness fijo y gestionado).

### devcontainer CLI — https://github.com/devcontainers/cli

Reference implementation del spec Dev Container (containers.dev) sobre **docker local**/remoto. Comandos: `devcontainer build`, `up`, `run-user-commands`, `read-configuration`, `exec <cmd>`, `stop`, `down`, `features`, `templates`. Genera lockfiles reproducibles.

- Exec: **✔**. `devcontainer exec --workspace-folder <path> <cmd>` es el equivalente directo de `docker exec`.
- Clone con deps: **◐**. Trabaja sobre un `--workspace-folder` (carpeta o repo montada); las deps llegan por `features`/`postCreateCommand` en la imagen, o por estar ya en la carpeta montada.
- Config global: **◐**. `features` + lifecycle hooks pueden instalar config del harness (ej. feature claude-code), pero es configurado por el repo, no automático por harness.
- Rama/issue/token/headless: **✘** (no sabe nada de issues ni de harnesses; ejecuta comandos, no prompts).

### devpod — https://devpod.sh/docs/what-is-devpod

CLI open-source de Loft, "client-only", que crea workspaces (contenedores) a partir de `devcontainer.json` en docker local, máquinas remotas o nubes. `devpod up`, `devpod ssh`, `devpod stop`, prebuilds, auto-shutdown, sync de credenciales git/docker, dotfiles.

- Exec/attach: **✔**. `devpod ssh <ws>` (interactivo) y `devpod ssh <ws> -- <cmd>` (comando único, estilo exec).
- Dependencias: **◐**. Igual que devcontainer CLI: el entorno se define por `devcontainer.json` (features/`postCreateCommand`); si montas tu carpeta local con `node_modules`, está presente.
- Config global: **◐**. Soporta dotfiles; no es específico de harnesses.
- Rama/issue/headless/token: **✘**.

### gitpod → Ona — https://www.gitpod.io/docs (redirige a https://ona.com/docs)

Gitpod se ha reposicionado como **Ona, "the platform for background agents"**: correr equipos de agentes de software en la nube, orquestados y gobernados, con dev containers reproducibles, automations disparadas por PR/schedule/issue tracker (Linear, Jira), source control conectado, guardrails y SSO.

- Headless: **✔** (agentes en segundo plano en la nube, por evento/schedule).
- Rama/issue: **◐** (automations desde issue tracker y eventos PR; gestionado, no rama por sandbox local).
- Config del harness: **◐** ("bring your configuration from Claude Code or Cursor").
- Dependencias: **◐** (dev containers reproducibles).
- Attach docker local / token para issues: **✘ / ◐** (es cloud gestionado; la conexión a GitHub es vía app, no docker local).

### e2b — https://e2b.dev/docs

Sandboxes cloud (microVMs Linux) para agentes, vía SDK (Python/JS) con `Sandbox.create()`, `sandbox.commands.run`, filesystem upload/download, templates (Dockerfile). Requiere `E2B_API_KEY`; cloud, no docker local.

- Headless: **◐** (SDK para ejecutar comandos; no es un runner de prompts de coding agents).
- Attach/exec: **◐** (SDK/API; el CLI no ofrece shell interactivo "docker-style" como tal).
- Deps/repo: **◐** (templates Dockerfile + upload de archivos; no clona tu repo ni preinstala deps automáticamente).
- Config harness/rama/issue/token: **✘**.

### daytona — https://www.daytona.io/docs/en/tools/cli · https://www.daytona.io/docs

Daytona se ha convertido en infraestructura cloud ("sandboxes") para agentes de IA: `daytona create/exec/ssh/stop/snapshot/volume/list`, SDKs (TS/Python/Go/Ruby/Java), API y **servidor MCP** (`daytona mcp init` para claude, windsurf, cursor). Sandboxes OCI/Docker-compatible en la nube, con snapshots persistentes.

- Exec/ssh: **✔** (`daytona exec <id> -- cmd`, `daytona ssh <id>`).
- Headless: **◐** (infra para ejecutar procesos/código y conectar agentes vía MCP; no orquesta un harness dado).
- Deps/repo: **◐** (`daytona create` admite `--dockerfile`, `--context` (build context), `--env`; no clona tu repo actual ni preinstala deps por defecto).
- Config harness/rama/issue/token: **✘**.
- No es docker local: es cloud.

### opencode (harness) — https://opencode.ai/docs/cli/ · https://opencode.ai/docs/github/

Como **harness**: headless **✔** — `opencode run "…"` (modo no interactivo, `--format json`, `--continue`, `--session`, `--auto` para auto-aprobar) y servidor headless `opencode serve`/`web` con `opencode attach` para TUI remota. Config global en `~/.config/opencode` + `OPENCODE_CONFIG_DIR` (fácil de inyectar en un sandbox).

- Sandbox nativo: **✘**. opencode corre donde se ejecute (host o runner); **no** trae aislamiento de contenedor propio (tiene permisos por herramienta, no OS-level container).
- GitHub: **◐/✔**. `opencode github install` + workflow en GitHub Actions (`opencode github run` con `GITHUB_TOKEN` o PAT) permite "fix this issue" → rama nueva + PR, comentarios en issues/PRs. **◐** para rama-atada-a-issue (funciona por comentario/evento, no por sandbox). El runner de Actions es el "sandbox" (efímero, checkout fresco sin deps preinstaladas → **◐**).
- Attach/exec docker-style: **✘** (no gestiona sandboxes).

### claude code (harness) — https://code.claude.com/docs/en/headless · .../sandboxing · .../devcontainer

Headless **✔**: `claude -p "…"` (no interactivo), `--output-format json|stream-json`, `--bare`, `--allowedTools`, `--permission-mode acceptEdits`, `--continue/--resume` (sessions), y Agent SDK (Python/TS) para correr el mismo loop como librería.

- Sandboxing nativo: **◐**. Tiene un **sandbox para el tool Bash** (bubblewrap en Linux / Seatbelt en macOS, con aislamiento de filesystem + proxy de red), pero no es un contenedor completo; además hay soporte oficial de **dev container** como entorno (feature `ghcr.io/anthropics/devcontainer-features/claude-code`, docs que recomiendan correr en container como non-root con `--dangerously-skip-permissions`).
- Config global: **✔**. `~/.claude` + `CLAUDE_CONFIG_DIR` (volumen recomendado en el devcontainer oficial para persistir auth/settings sin ensuciar el repo).
- Rama/issue/token: **✘** nativo (hay página y acción de GitHub Actions para workflows, con `GITHUB_TOKEN`; fuera del CLI).
- Attach/exec: **✘** (el CLI es el harness; no gestiona sandboxes).

## Otros candidatos considerados y descartados

- **GitHub Actions como "sandbox"** (runner `ubuntu-latest` + `gh issue develop`/`gh pr create`): usado por opencode (`opencode github run`) y por claude code (acción oficial). Cubre headless+rama+PR+token, pero el entorno es efímero, sin deps preinstaladas y sin attach — no es un sandbox persistente.
- **Wrappers docker+tmux**: el único relevante y activo encontrado es **agentbox** (arriba). Búsqueda en GitHub (términos "agent sandbox CLI", "docker tmux claude code") no devuelve otros con el mismo alcance.
- **E2B/Daytona/Ona** son plataformas cloud gestionadas; quedan fuera del listón de conformidad (que exige docker local como sandbox).

## Veredicto

- **¿Listón alto?** **No.** No existe una herramienta única que cubra el flujo end-to-end (crear sandbox con harness elegido, prompt headless, attach/exec, rama-issue, token GitHub, todo pluggeable). Ningún candidato combina "harness pluggeable + sandbox docker + rama-atada-a-issue".
- **¿Listón de conformidad (docker + opencode + claude code)?** **No lo cumple nadie de forma directa**, pero **agentbox es el más cercano**: ya es docker-local con opencode + claude code + codex, sync automático de config global del harness y attach/shell estilo docker; le faltan el prompt headless dedicado y la orquestación issue→rama→token, que se cubrirían pegando `gh issue develop` y los modos headless (`opencode run`, `claude -p`) dentro del box. El camino de "construir sin sander" sería exactamente esa combinación (agentbox, o devcontainer CLI/devpod + features), y es precisamente el pegamento que `sander` quiere orquestar.

## Fuentes primarias clave

- agentbox: https://github.com/madarco/agentbox · https://agent-box.sh/docs
- `gh codespace` create/ssh: https://cli.github.com/manual/gh_codespace_create · https://cli.github.com/manual/gh_codespace_ssh
- `gh agent-task` create/view: https://cli.github.com/manual/gh_agent-task_create · https://cli.github.com/manual/gh_agent-task_view
- `gh issue develop`: https://cli.github.com/manual/gh_issue_develop
- devcontainer CLI: https://github.com/devcontainers/cli
- devpod: https://devpod.sh/docs/what-is-devpod
- daytona: https://www.daytona.io/docs/en/tools/cli
- e2b: https://e2b.dev/docs
- gitpod/Ona: https://www.gitpod.io/docs
- opencode CLI: https://opencode.ai/docs/cli/ · GitHub: https://opencode.ai/docs/github/
- claude code headless: https://code.claude.com/docs/en/headless · sandboxing: https://code.claude.com/docs/en/sandboxing · devcontainer: https://code.claude.com/docs/en/devcontainer
