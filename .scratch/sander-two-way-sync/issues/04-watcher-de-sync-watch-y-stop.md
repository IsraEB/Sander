# 04 — Watcher de sync: `sander sync <id> --watch` (bucle foreground) y `--stop`

**What to build:** El watcher de sync y su estado. El estado (pid y log) vive fuera del árbol de trabajo, derivado de forma determinista del configDir: `<configDir>/sync/<id>.pid` y `<configDir>/sync/<id>.log`, sin cambio de esquema del registry (el id del sandbox ya lo identifica todo). `sander sync <id> --watch` levanta un bucle de polling en foreground con intervalo de 2 s por defecto: la primera sincronización ocurre inmediatamente al arrancar (el mismo one-shot del comando `sync`), luego cada 2 s, en ambas direcciones, y cada ciclo anota su resultado en el log (incluidos los conflictos). Es robusto: si el box no existe, está parado o no responde, el ciclo se omite y se registra, pero el watcher sigue polleando (el sandbox puede re-crearse o reiniciarse) — nunca aborta. El intervalo de 2 s es el polling conservador que reduce el riesgo de pisar un archivo que el agente esté editando justo en ese momento. `sander sync <id> --stop` lee el pidfile y mata el watcher. La ayuda de `sync` documenta `--watch` y `--stop`.

**Blocked by:** 03 — `sander sync <id>` one-shot bidireccional con resumen

**Status:** ready-for-agent

- [ ] `--watch` escribe el pid del proceso en `<configDir>/sync/<id>.pid` y anota cada ciclo en `<configDir>/sync/<id>.log`, ambos fuera del árbol de trabajo (no se sincronizan consigo mismos) y sin tocar el registry.
- [ ] `--watch` sincroniza inmediatamente al arrancar y luego cada 2 s en ambas direcciones; un ciclo con el box caído (exec/pull fallan) se omite y se registra sin abortar el bucle.
- [ ] Los conflictos de cada ciclo quedan reportados en el log del watcher.
- [ ] `--stop` mata el watcher por pidfile y limpia su pid/log; con el watcher no corriendo avisa sin fallar.
- [ ] El bucle de polling es un módulo con seams inyectables (provider, gitRunner, interval) y se prueba a nivel CLI con fakes (ops del provider, contenido del pidfile/log en un configDir temporal, `--stop` contra un pid real).
