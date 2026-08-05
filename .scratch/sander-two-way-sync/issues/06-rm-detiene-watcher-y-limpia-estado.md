# 06 — `sander rm` detiene el watcher y limpia su estado

**What to build:** Al eliminar un sandbox, `sander rm` detiene también su watcher de sync y elimina su estado (`<configDir>/sync/<id>.pid` y `.log`), para que no queden procesos huérfanos. Usa el mismo módulo de estado del watcher que `--stop` (ticket 04), integrado dentro del orden existente de `runRm`; es idempotente: con el watcher ya detenido o inexistente, rm no falla.

**Blocked by:** 04 — Watcher de sync: `--watch` y `--stop`

**Status:** ready-for-agent

- [ ] `sander rm <id>` detiene el watcher del sandbox por pidfile y elimina `<configDir>/sync/<id>.pid` y `<configDir>/sync/<id>.log`.
- [ ] Con el watcher ya detenido o inexistente, `sander rm` no falla (idempotente, en el estilo de la verificación "ya no está" de rm).
- [ ] Tras `sander rm` no quedan procesos watcher del sandbox (verificado por pidfile ausente y proceso muerto).
- [ ] El paso de detención del watcher se integra en el orden existente de `runRm` y se prueba a nivel CLI con los fakes de `lifecycle.test.ts` (pidfile temporal real + proceso real o fake del watcher).
