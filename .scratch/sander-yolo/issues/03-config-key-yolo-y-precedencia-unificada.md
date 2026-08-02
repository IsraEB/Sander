# 03 — Config key `yolo` + precedencia unificada flag > workspace > global > default

**What to build:** `yolo` pasa a ser una clave top-level de la config de sander, opcional y booleana, gestionable por CLI igual que `provider`/`harness`. `sander config set yolo true|false` guarda un booleano (no un string); `get`, `list` y `unset` funcionan igual que las claves existentes. `GlobalConfig` gana el campo opcional `yolo?: boolean`. Además, la precedencia de resolución de `provider`, `harness` y `yolo` se unifica al orden **flag > workspace > global > default**: hoy `provider`/`harness` se resuelven en create como global > workspace; se alinean al nuevo orden. El default de resolución de `yolo` es `true`. Como `yolo` nunca es una clave faltante (tiene default), no entra en las claves requeridas y el wizard no la pregunta — sin cambios en el wizard.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `sander config set yolo false` (y `true`) persisten un booleano en `config.json`; `sander config get yolo`, `config list` y `config unset yolo` funcionan.
- [ ] `sander config set yolo ja` (o cualquier valor que no sea `true`/`false`) falla con un error accionable.
- [ ] La resolución de `yolo` sigue flag > workspace > global > default `true`.
- [ ] La resolución de `provider` y `harness` pasa a flag > workspace > global > default, y los tests existentes de create con la precedencia previa se actualizan sin romper el comportamiento esperado.
- [ ] El wizard no pregunta por `yolo` en ningún caso (ni en `sander config` ni en `sander create`).
