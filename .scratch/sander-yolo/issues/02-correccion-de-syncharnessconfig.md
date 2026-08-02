# 02 — Corrección de `syncHarnessConfig`: copiar a los directorios reales del box

**What to build:** Que la config del harness del host de verdad llegue al harness dentro del box. Hoy `syncHarnessConfig` copia la config a `~/.config/<harness>` dentro del box, que no es el directorio que cada harness lee realmente (opencode lee del volumen `OPENCODE_CONFIG_DIR`, claude de `~/.claude`, codex de `~/.codex`); el sync actual es decorativo. Usando el módulo de recetas del ticket 01, el sync copia la config del host (desde `hostConfigDir`) al directorio real que el harness lee dentro del box (`boxConfigDir`). El resto del comportamiento del sync se conserva: filtrado por `.gitignore` del proyecto, staging, el aviso cuando no hay config de host o está vacía, y la nota final de cuántos archivos se sincronizaron.

**Blocked by:** 01 — Módulo de recetas por harness.

**Status:** ready-for-agent

- [ ] Tras `sander create`, las ops `copy`/`exec` del provider dejan la config del harness en su directorio real dentro del box (volumen de opencode, `~/.claude`, `~/.codex`), y no en `~/.config/<harness>`.
- [ ] La fuente es el directorio real del host de cada harness (opencode: `~/.config/opencode`; claude: `~/.claude`; codex: `~/.codex`), no un path genérico.
- [ ] Sin config de host → se conserva la nota actual ("el box usará defaults"); config de host vacía o excluida por `.gitignore` → mismas notas actuales.
- [ ] El conocimiento de directorios (host y box) vive en el módulo de recetas (compartido con la inyección de yolo), no duplicado en `syncHarnessConfig`.
