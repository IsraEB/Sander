# 03 — `sander sync <id>` one-shot bidireccional con resumen

**What to build:** El primer slice vertical completo: el comando `sander sync <id>` espeja el árbol de trabajo entre el box (`/workspace`) y el worktree hermano del host (registrado en el registry), en ambas direcciones y sin tocar la historia git. Cada invocación detecta los cambios de cada lado con `git status --porcelain -uall` (host vía `gitRunner` con `-C <worktree-host>`; box vía `provider.exec(id, ['git', '-C', BOX_WORKTREE, 'status', '--porcelain', '-uall'])`), calcula los hashes de contenido de los paths sucios en ambos lados, planifica con `planSync` (módulo puro) y ejecuta el plan con `provider.copy` (host→box), `provider.pull` (box→host), `fs.rmSync` en el host y `provider.exec rm` en el box; los conflictos guardan la versión local como backup `.sander/<rel>.sander-<lado>` y aplican el otro lado. Imprime un resumen en stdout: copiados box→host, host→box y conflictos. Si el proyecto no es git (sin worktree host registrado) avisa de que la sync está desactivada y no transfiere nada; si el box está caído o una exec falla, el ciclo se omite con aviso sin abortar. Todas las transferencias pasan `--yes` (no-interactivas). El comando se registra en `sander --help` y en `sander help sync`. Los commits del agente siguen aterrizando en el host vía `.git` compartido: este comando nunca commitea ni toca refs.

**Blocked by:** 01 — Seam `Provider.pull` + `--yes`; 02 — Módulo puro `planSync`

**Status:** ready-for-agent

- [ ] `sander sync <id>` con un cambio solo en el box → op `pull` al host, el archivo aparece como modificación local en el worktree del host y el resumen lo reporta; con un cambio solo en el host → op `copy` al box y llega al box en el mismo ciclo.
- [ ] Path sucio en ambos lados con contenido idéntico → no se transfiere nada (no-op); con contenido distinto → conflicto: backup `.sander/<rel>.sander-<lado>` del lado local + se aplica el otro lado, reportado en el resumen.
- [ ] Borrado (`D`) en un lado → se propaga al otro (rm en el lado correspondiente); `D` vs modificado → conflicto con backup.
- [ ] Los paths untracked (`??`) se transfieren igual que los modificados; el resumen imprime copiados box→host, host→box y conflictos.
- [ ] Proyecto no-git (sandbox sin worktreePath) → aviso "sync desactivada" y salida sin transferencias; box caído o exec fallida → ciclo omitido con aviso, sin abortar.
- [ ] Todas las invocaciones de `agentbox cp` desde la ruta de sync pasan `--yes`; el comando aparece en `sander --help` y en `sander help sync`; el resumen de salida se prueba a nivel CLI con `runCli` + `FakeProvider` + `CaptureStream` (asserts sobre ops `pull`/`copy`/`exec` y stdout).
