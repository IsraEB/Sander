# Spec: two-way sync de los worktrees del sandbox

Status: ready-for-agent

## Problem Statement

Sander crea dos worktrees enlazados al **mismo `.git`** y a la **misma rama** `refs/heads/<id>`: el worktree del box (dentro del contenedor, `/workspace`) y el worktree hermano del host (`<parent>/<repo>-sander-<id>`). Por compartir `.git`, los **commits** del agente aterrizan en el host al instante; pero los **cambios sin commitear** (el árbol sucio) solo existen dentro del contenedor. Para enterarse de lo que el agente está editando, el usuario depende de que el agente haga un commit — cosa que a veces olvida. La dirección inversa sufre lo mismo: ediciones del usuario en el worktree del host no llegan al box hasta que se commitean.

Hoy no existe ningún mecanismo que espeje el **árbol de trabajo** entre el box y el worktree del host.

## Solution

Sander gana un **sync a nivel de archivos, bidireccional y sin tocar la historia git**, que espeja el árbol de trabajo entre el box (`/workspace`) y el worktree del host (`<parent>/<repo>-sander-<id>`). El transporte es `agentbox cp` (bidireccional, binary-safe, excluye `.git`/`node_modules` por defecto). La detección de cambios usa **git como baseline**: ambos lados comparten HEAD, así que un `git status --porcelain -uall` en cada lado dice quién cambió qué sin necesitar estado previo:

- archivo modificado/untracked en un solo lado → se copia ese lado al otro;
- modificado en ambos lados e idéntico → no-op;
- modificado en ambos lados y distinto → **conflicto**: se guarda la versión local como backup y se aplica el otro lado (no-interactivo, reportado en el log);
- borrado (`D`) en un lado y limpio en el otro → se propaga el borrado; borrado vs. modificado → conflicto.

La sincronización es **automática y transparente**: `sander create` lanza por defecto un **watcher** en background del host (polling cada 2 s, mismo patrón que el supervisor del box); `sander create --no-watch` la desactiva. El checklist de `create` gana el paso **"Activando watcher de git"**. También existe el comando `sander sync <id>` (one-shot), `sander sync <id> --watch` (loop en foreground) y `sander sync <id> --stop`.

El estado del watcher (pid, log) vive en el configDir de sander (`<configDir>/sync/<id>.pid`/`.log`), fuera del árbol de trabajo, para que no se sincronice consigo mismo. No cambia el esquema del registry.

## User Stories

1. Como usuario de sander, quiero que los cambios sin commitear del agente dentro del box aparezcan en el worktree del host sin que el agente tenga que hacer commit, para enterarme de su trabajo al momento.
2. Como usuario de sander, quiero que las ediciones que haga en el worktree del host (rama del sandbox) lleguen al box, para que el agente las vea sin que yo commitee.
3. Como usuario de sander, quiero que `sander create` active automáticamente un watcher de sync por defecto, para que la sincronización sea transparente y no tenga que acordarme de nada.
4. Como usuario de sander, quiero `sander create --no-watch` para desactivar el watcher en un sandbox concreto.
5. Como usuario de sander, quiero que el checklist de `create` muestre el paso "Activando watcher de git", para saber que la sync quedó encendida (y verlo saltarse con `--no-watch`).
6. Como usuario de sander, quiero que los commits del agente sigan aterrizando en el host igual que hoy, para no romper el modelo existente de `.git` compartido.
7. Como usuario de sander, quiero que la sincronización no genere commits ni toque la historia git de la rama del sandbox, para mantener la rama limpia.
8. Como usuario de sander, quiero que los archivos ignorados por `.gitignore` y los directorios `.git`/`node_modules` no se sincronicen, para no copiar basura ni dependencias del volumen.
9. Como usuario de sander, quiero que la sincronización sea binary-safe, para que los archivos binarios se copien intactos.
10. Como usuario de sander, quiero que los borrados de archivos rastreados se propaguen de un lado al otro, para que ambos árboles queden iguales.
11. Como usuario de sander, quiero `sander sync <id>` para forzar una sincronización puntual manual y ver un resumen (copiados/push/conflictos).
12. Como usuario de sander, quiero `sander sync <id> --watch` para levantar el watcher de un sandbox ya existente (o ver el bucle en foreground).
13. Como usuario de sander, quiero `sander sync <id> --stop` para detener el watcher de un sandbox.
14. Como usuario de sander, quiero que cada ciclo del watcher sincronice en ambas direcciones, para que box y host queden espejados.
15. Como usuario de sander, quiero que si un archivo cambió distinto en ambos lados se conserve mi versión local como backup `.sander/<rel>.sander-<lado>` y se aplique el otro lado, para no perder trabajo.
16. Como usuario de sander, quiero que los conflictos queden reportados en el log del watcher, para enterarme de las decisiones automáticas.
17. Como usuario de sander, quiero que el watcher sobreviva a `stop`/`start` del box (con el box parado omite el ciclo y lo registra), para que al reanudar siga sincronizando solo.
18. Como usuario de sander, quiero que `sander rm` detenga el watcher del sandbox, para que no queden procesos huérfanos.
19. Como usuario de sander, quiero que si el proyecto no es un repositorio git se avise de que la sync está desactivada, para no asumir sincronización que no existe.
20. Como usuario de sander, quiero que el estado del watcher (pid, log) viva fuera del árbol de trabajo, para que no se sincronice consigo mismo.
21. Como usuario de sander, quiero que la sincronización no pise el trabajo del agente si él está editando justo en ese momento (intervalo de polling conservador), para reducir el riesgo de sobrescribir un archivo abierto.
22. Como usuario de sander, quiero que los archivos untracked (nuevos, aún no añadidos) se copien al otro lado, para que los archivos nuevos del agente o míos lleguen aunque no estén en git.
23. Como desarrollador de sander, quiero que la lógica de sync (detección/plan/ejecución) sea un módulo con seams inyectables, para probarla con fakes sin box real.
24. Como desarrollador de sander, quiero que `Provider.pull` sea el inverso de `copy` (box→host) sobre `agentbox cp`, para reutilizar el seam bidireccional.
25. Como desarrollador de sander, quiero que la detección de cambios use `git status --porcelain -uall` de cada lado contra el HEAD compartido, para decidir quién cambió qué sin estado previo ni comparación de contenido de todos los archivos.
26. Como usuario de sander, quiero que los borrados de archivos untracked no se propaguen en v1 (limitación conocida y documentada), para no complicar la primera versión.
27. Como usuario de sander, quiero que las invocaciones de `agentbox cp` desde la sync sean no-interactivas (`--yes`), para que el watcher en background nunca se quede esperando una confirmación.

## Implementation Decisions

- **Mecanismo: sync file-level bidireccional.** Nuevo módulo de sync con seams inyectables (`provider`, host-worktree path, `gitRunner`). No commitea, no toca refs, no reescribe `.git`. La rama del sandbox queda como la deje el agente.
- **Detección con git como baseline (compartido).** Cada ciclo calcula el conjunto de paths cambiados de cada lado con `git status --porcelain -uall`:
  - host: `git -C <host-worktree> status --porcelain -uall`;
  - box: `provider.exec(id, ['git', '-C', BOX_WORKTREE, 'status', '--porcelain', '-uall'])`.
  Los `??` (untracked) se tratan igual que los modificados. Esto es gitignore-aware gratis y evita hashear todo el árbol en cada ciclo.
- **Plan por path** (módulo puro, sin I/O): un path solo en un lado → copiar ese lado al otro; en ambos → comparar contenido (hash) de cada lado; iguales → no-op; distintos → conflicto. `D` en un lado y limpio en el otro → borrar en el otro; `D` vs. modificado → conflicto. Archivos untracked que faltan en un lado se copian (borrados de untracked no se detectan — limitación v1).
- **Ejecución de transferencias:**
  - host→box: `provider.copy` (ya re-chown al box user en hosts uid≠1000);
  - box→host: nuevo **`Provider.pull(id, source, destination)`** → `agentbox cp <box>:<source> <destination>`;
  - borrados: `fs.rmSync` en el host, `provider.exec(id, ['rm', ...])` en el box;
  - todas las invocaciones de `agentbox cp` desde la ruta de sync pasan `--yes` (no-interactivo).
- **Conflicto (no-interactivo):** backup de la versión local como `.sander/<rel>.sander-<lado>` dentro del worktree correspondiente, se aplica el otro lado y se registra en el log del watcher (o en el resumen del one-shot). Sin resolución interactiva en v1.
- **Comando `sander sync`:** `sander sync <id>` (one-shot con resumen en stdout: copiados box→host, host→box, conflictos), `sander sync <id> --watch` (bucle de polling en foreground, intervalo 2 s por defecto), `sander sync <id> --stop` (mata el watcher por pidfile). Se registra en la ayuda de la CLI.
- **Watch por defecto en `create`:** nuevo flag booleano `--no-watch` (default: watch activo). En `runCreate`, tras `saveRegistry`, si `watch && worktreeRef !== null` se spawna detached `node <bin> sync <id> --watch` (`stdio: 'ignore'`, `detached: true`, patrón supervisor). Si el proyecto no es git (sin worktree host) o viene `--no-watch`, el paso se marca saltado y se avisa.
- **Paso del checklist de `create`:** nuevo paso "Activando watcher de git", añadido al plan de pasos actual, que se marca done/skipped según el resultado del spawn.
- **Estado del watcher fuera del árbol:** pid y log derivados de forma determinista en `<configDir>/sync/<id>.pid` y `<configDir>/sync/<id>.log`. **Sin cambio de esquema del registry** (el id del sandbox ya identifica todo). La primera sincronización ocurre inmediatamente al arrancar el watcher, luego cada 2 s.
- **Ciclo de vida:** `sander rm` detiene el watcher por pidfile (y elimina su pid/log) dentro del orden existente de `runRm`. `stop`/`start` no tocan el watcher: con el box parado, `exec`/`pull` fallan → el ciclo se omite y se registra; al `start` reanuda solo.
- **Robustez del watcher:** si el box no existe o no responde, el ciclo se omite sin abortar; el watcher sigue polleando (el sandbox puede re-crearse o reiniciarse).
- **Verificación en implementación:** semántica exacta de `agentbox cp` con un único source (destino = ruta completa) y del tope `box.cpMaxBytes` (100 MB) en sentido box→host; consultar `agentbox cp --help` antes de fijar el formato de destino.

## Testing Decisions

- **Qué hace un buen test:** verifica comportamiento externo observable — las ops que sander le pide al provider (`exec`, `copy`, `pull`), los archivos resultantes en el worktree del host (dir temporal real), el resumen impreso por `sander sync`, el estado del pidfile, y el parseo del flag `--no-watch`. Nunca los internals del plan ni del bucle.
- **Seam primario — CLI layer** (el existente): tests de `create` y del nuevo comando `sync` con `runCli` + los fakes existentes (`FakeProvider` registrando ops, `FakeWorktree`, `CaptureStream`, config/registry en dir temporal), al estilo de `create.test.ts` y `lifecycle.test.ts`. Cubren: que `create` por defecto registra el paso "Activando watcher de git" y spawna el watcher; que `create --no-watch` no lo spawna (y el paso se salta); que `sander sync <id>` ejecuta el plan contra un provider fake (ops `pull`/`copy`/`exec` esperadas) e imprime el resumen; que `--stop` mata el pid del pidfile; que un proyecto no-git avisa y no spawna.
- **Seam secundario — módulo de sync puro:** `planSync` se prueba unitario con manifiestos sintéticos (path solo-host, solo-box, ambos-iguales, ambos-distintos, `D` vs. limpio, `D` vs. modificado, untracked) sin box ni provider reales, al estilo de las funciones puras de `teleport.ts`.
- **Seam `Provider.pull`:** se añade a `provider/fake.ts` (registro de ops) y se cubre con un test del proveedor agentbox real-mock (argv `cp <box>:<src> <dst>` con `--yes`), al estilo de los tests existentes de `copy`/`exec` en `provider/agentbox.test.ts`.
- **Prior art:** `create.test.ts` (fakes + `runCli` + asserts sobre ops del provider y registry), `lifecycle.test.ts` (orden de ops de `rm`), `provider/fake.ts` (registro de ops), `teleport.test.ts` (funciones puras), `resources/supervisor.sh` + `supervisor.test.ts` (patrón de watcher y de scripts de estado).

## Out of Scope

- **Auto-commit / transporte vía historia git**: la sync es file-level; no se generan commits de sync ni se modifica la rama.
- **Sincronización de `.git`, `node_modules` o la config del harness**: quedan fuera por diseño (excluidos por `agentbox cp` y por gitignore).
- **Resolución interactiva de conflictos**: v1 es backup + sobrescribir + reporte.
- **Propagación de borrados de archivos untracked**: no se detectan con `git status` en v1 (documentado en la ayuda).
- **Cambios en agentbox (npm)**: se consume `agentbox cp` tal cual; sus topes (100 MB) y prompt no-interactivo se manejan desde sander.
- **Watcher configurable por config persistente**: el default de watch es un flag de `create`; no hay clave de config en v1 (posible fase futura junto a `interval`).
- **Sync con el box parado**: el watcher no inicia el box; solo omite el ciclo y lo registra.
- **Cambios de esquema del registry**: ninguno; el estado del watcher se deriva del configDir.

## Further Notes

- Criterio de aceptación transversal: sin commits por parte del agente ni del usuario, un cambio de archivos en el box aparece como modificación local en el worktree del host (`git status`/`git diff` lo muestran) y viceversa, en un ciclo de watcher.
- Tras un pull box→host, los cambios del agente aparecen en el worktree del host como árbol sucio: ese es justamente el mecanismo de "enterarme de los cambios".
- Un push host→box dispara el reinicio del servicio vía el supervisor (el watcher del box observa cambios de archivos): comportamiento ya definido, coherente con este spec.
- El concepto nuevo "watcher de sync" convive con el "supervisor" del box (que sigue reiniciando `start.sh`); no se confunden: uno es host-side (sync) y el otro box-side (servicio).
- El paso de `create` "Activando watcher de git" se posiciona en el checklist tras desplegar el supervisor, en la parte de materialización final (antes de `upsertBox`/`saveRegistry`, para que el watcher ya encuentre el box registrado).
- Este spec continúa la línea de `sander-config`, `sander-providers` y `sander-yolo` (seam CLI con fakes, mensajes en español, registry como fuente de verdad por box).
- Idioma de la conversación y de los mensajes de la CLI: español.
