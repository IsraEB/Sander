# 04 — `create` materializa yolo: flags `--yolo`/`--no-yolo`, resolución, inyección de la receta y registry

**What to build:** El yolo se vuelve una propiedad del sandbox, nunca de la config del harness en el host. `sander create` acepta los flags simétricos `--yolo` y `--no-yolo` (mismo patrón de parseo de flags existente) y resuelve el modo con la precedencia unificada flag > workspace > global > default `true`. Al crear, tras el sync de config (ticket 02), sander aplica la receta del harness dentro del box: si el harness tiene receta, lee la config real del box en su directorio correcto (`boxConfigDir`), aplica `applyYolo`/`applyNoYolo` según el modo resuelto (merge aditivo, `deny` preservados, JSONC se omite con aviso) y escribe el resultado de vuelta en el mismo directorio. Un harness sin receta avisa y el create continúa sin inyección. La config del harness del host nunca se escribe. El modo yolo resuelto se persiste por box en el registry como campo opcional `yolo?: boolean`. La inyección ocurre solo al crear (el volumen del box persiste entre `stop`/`start`); se documenta la limitación de que lanzar el agente por fuera vía `agentbox … start` re-sincroniza host→volumen y puede quitar el yolo.

**Blocked by:** 01 — Módulo de recetas por harness; 02 — Corrección de `syncHarnessConfig`; 03 — Config key `yolo` y precedencia unificada.

**Status:** ready-for-agent

- [ ] `sander create` sin config → box yolo por defecto y el registry guarda `yolo: true`.
- [ ] `sander create --no-yolo` impone no-yolo y `sander create --yolo` re-activa yolo aunque la config diga `yolo: false`; `sander config set yolo false` + create sin flag → box no-yolo.
- [ ] En un box yolo de opencode con config del host que trae restricciones `ask`/`deny`, la inyección produce una config transformada (ask → allow, deny intactos) en el volumen del box, vía ops `copy`/`exec` del provider sobre el directorio real.
- [ ] En un box no-yolo de opencode, la config del box gana el catch-all `"*": "ask"` preservando los deny.
- [ ] claude y codex producen sus payloads correspondientes según el modo (`permissions.defaultMode` / `approval_policy`).
- [ ] Un harness sin receta avisa y el create continúa sin inyección; un archivo JSONC se omite con aviso.
- [ ] La config del harness en el host queda intacta en todos los casos (yolo y no-yolo, todos los harnesses).
- [ ] La config existente del box se conserva (merge aditivo, no clobber).
- [ ] La inyección no se re-afirma en `attach`/`start`/`stop`; la limitación de `agentbox … start` queda documentada.
