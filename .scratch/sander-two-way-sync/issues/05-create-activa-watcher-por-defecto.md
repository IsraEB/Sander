# 05 — `sander create` activa el watcher por defecto (`--no-watch`)

**What to build:** `sander create` activa el watcher de sync por defecto, para que la sincronización box↔host sea transparente. Nuevo flag booleano `--no-watch` (default: watch activo). En `runCreate`, tras desplegar el supervisor y en la parte de materialización final (antes de guardar el registry), si `watch && worktreeRef !== null` se spawna detached `node <bin> sync <id> --watch` con `stdio: 'ignore'` y `detached: true` (patrón supervisor). El checklist de `create` gana el paso "Activando watcher de git", que se marca done si se spawna y saltado si no. Si el proyecto no es git (sin worktree host) o viene `--no-watch`, el paso se salta y se avisa de que la sync está desactivada. La ayuda de `create` documenta `--no-watch` y la limitación v1 de no propagar borrados de archivos untracked.

**Blocked by:** 04 — Watcher de sync: `--watch` y `--stop`

**Status:** ready-for-agent

- [ ] `sander create <id>` por defecto registra el paso "Activando watcher de git" en el checklist y spawna detached `node <bin> sync <id> --watch` (`stdio: 'ignore'`, `detached: true`); el watcher se lanza tras desplegar el supervisor, antes de guardar el registry.
- [ ] `sander create <id> --no-watch` no spawna nada y marca el paso como saltado, con aviso.
- [ ] Proyecto no-git (worktreeRef null, sin worktree host) → el paso se salta y se avisa de que la sync está desactivada.
- [ ] El flag `--no-watch` se parsea correctamente y no altera el resto del flujo de create (mismas ops del provider y mismo registro).
- [ ] `create --help` documenta `--no-watch` (y la limitación de no detectar borrados de untracked); pruebas a nivel CLI con `runCli` + fakes existentes aseverando el paso del checklist y el spawn (mockeando `child_process.spawn`).
