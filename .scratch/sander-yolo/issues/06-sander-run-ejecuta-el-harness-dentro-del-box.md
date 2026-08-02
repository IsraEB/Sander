# 06 — `sander run` ejecuta el harness dentro del box

**What to build:** `sander run <id> "prompt"` deja de ejecutar el harness headless en el host y lo ejecuta **dentro del box** vía el seam de `provider.exec`: el argv construido es `['<harness>', ...headlessCommand(prompt)]` (p. ej. `opencode run <prompt>`), ejecutado sobre el id del box. El run hereda así la config del box, incluido su modo yolo. El entorno inyectado al crear (`envKeys`) sigue siendo el transporte de credenciales; no se resuelve ni se inyecta token nuevo en el host durante el run. El `runRun` host-side actual (que llamaba a `harness.headless`) se reemplaza por completo. El exit code y la salida del exec se reportan al usuario igual que hoy.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `sander run` genera una op `exec` del provider con `['<harness>', ...headlessCommand(prompt)]` sobre el id del box, y no invoca `harness.headless` en el host.
- [ ] No se resuelve token nuevo en el host (sin prompts de confirmación) cuando el box ya tiene `envKeys`; el run usa el entorno del box.
- [ ] Se reporta el exit code del exec y su salida igual que hoy (mensaje "Sandbox … finished with exit code …").
- [ ] `run --help` y los errores existentes (sandbox no encontrado, prompt vacío) se conservan.
- [ ] El provider se resuelve desde el id del box en el registry (como los demás comandos que operan sobre un box).
