# 05 — `list` y `attach` informan el modo yolo

**What to build:** Que el modo yolo guardado por box en el registry sea visible para el usuario. `sander list` muestra una columna con el modo yolo de cada sandbox (p. ej. YOLO sí/no); `sander attach` informa si el box es yolo al entrar, para saber qué esperar. Se apoya en el campo opcional `yolo?: boolean` que create persiste por box (ticket 04), compatible con el versionado actual del registry: un box sin el campo se muestra con el default `true` y no rompe `list`/`attach`.

**Blocked by:** 04 — `create` materializa yolo.

**Status:** ready-for-agent

- [ ] `sander list` muestra una columna de yolo por box; los boxes sin el campo (legacy) se muestran con el default.
- [ ] `sander attach` informa el modo del box al entrar.
- [ ] El registry sigue siendo version 1 con el campo opcional: boxes sin `yolo` no rompen `list` ni `attach`.
