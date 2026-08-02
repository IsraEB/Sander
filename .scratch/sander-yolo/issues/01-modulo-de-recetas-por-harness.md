# 01 — Módulo de recetas por harness (transforms puros + directorios reales)

**What to build:** Prefactor sin cambio de comportamiento visible en la CLI. Introduce el módulo único de recetas que centraliza el conocimiento de "dónde lee cada harness su config", tanto en el host como dentro del box, y define los transforms yolo/no-yolo como funciones puras. Es un mapa genérico `harness → receta` con recetas para opencode, claude y codex; un harness sin receta no tiene entrada en el mapa (señal distinguible de "sin receta"). Cada receta expone: `hostConfigDir` (directorio real del host, fuente del sync), `boxConfigDir` (directorio real dentro del box, destino del sync y de la inyección) y las funciones puras `applyYolo(config)` / `applyNoYolo(config)` que operan sobre el contenido parseado del archivo de config y devuelven el contenido transformado:

- opencode (`opencode.json`, leído en el volumen `OPENCODE_CONFIG_DIR`): yolo convierte cada regla `"ask"` en `"allow"` preservando los `"deny"` explícitos; no-yolo asegura el catch-all `"*": "ask"` preservando los `"deny"`.
- claude (`settings.json` en `~/.claude`): yolo fija `permissions.defaultMode: "bypassPermissions"`; no-yolo fija `permissions.defaultMode: "default"`.
- codex (`config.toml` en `~/.codex`): yolo fija `approval_policy = "never"`; no-yolo fija `approval_policy = "on-request"`.

El merge con la config existente es aditivo: se lee el archivo actual si existe, se transforma y se devuelve el contenido completo. Los `deny`/denials nunca se tocan. Si el archivo es JSONC con comentarios, el transform se omite con aviso (nunca se arriesga corromper el archivo). En este ticket el módulo se construye y se prueba de forma aislada como seam secundario; todavía no se consume desde create ni desde sync.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `applyYolo` sobre un `opencode.json` con reglas `ask` y `deny` convierte solo las `ask` en `allow` y preserva las `deny`; `applyNoYolo` añade el catch-all `"*": "ask"` preservando las `deny`.
- [ ] Los payloads de claude (`settings.json`) y codex (`config.toml`) producen el contenido esperado para yolo y para no-yolo.
- [ ] Archivo de config ausente → el transform parte del contenido inicial; JSONC con comentarios → resultado de omisión con aviso (el contenido no se corrompe ni se reescribe).
- [ ] Cada receta expone los directorios reales: opencode lee su config del volumen del box (`OPENCODE_CONFIG_DIR`), claude de `~/.claude`, codex de `~/.codex`; y el directorio real del host como fuente.
- [ ] Un harness sin receta no tiene entrada en el mapa y la ausencia es distinguible de una receta válida.
- [ ] Las funciones son puras: mismo contenido de entrada → mismo contenido de salida, sin I/O ni dependencias de box/provider (probado unitariamente).
