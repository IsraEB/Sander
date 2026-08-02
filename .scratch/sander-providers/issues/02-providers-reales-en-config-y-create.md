# 02 — Providers reales en config y create

**What to build:** `provider` pasa a significar el proveedor real de sandbox (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`). `sander config set provider <cualquiera de los 5>` es válido y persiste; `provider agentbox` (en `set`, en `--provider` de `config` y en `--provider` de `create`) falla con un error accionable que sugiere `docker`. El default interno pasa a `docker`, consolidado en la fuente de verdad única (un `sander create` sin config crea en docker y lo guarda como `docker`). `sander create --provider vercel` crea la sandbox en vercel (agentbox recibe `--provider vercel`) y el registry la guarda como `vercel`. Al resolver config vieja con `provider: agentbox`, se informa al usuario de que migre (p. ej. `sander config set provider docker`) y se comporta como si no hubiera provider configurado (usa el default docker); no se reescribe silenciosamente la config. El wizard sigue siendo de texto plano por ahora, pero con default `docker` y validando los 5. La UX y la ayuda dejan de mostrar "agentbox" y el comando `prepare`.

**Blocked by:** 01 — Motor agentbox parametrizable + fuente de verdad única + factory de providers

**Status:** ready-for-agent

- [ ] `sander config set provider docker|daytona|hetzner|vercel|e2b` sale 0 y persiste el valor.
- [ ] `sander config set provider agentbox` y `sander config --provider agentbox` fallan con un error accionable que sugiere `docker`, sin escribir config.
- [ ] `sander create --provider agentbox` falla con un error accionable que sugiere `docker`.
- [ ] `sander create` sin provider en config ni flags pasa `--provider docker` a agentbox y guarda `docker` en el registry.
- [ ] `sander create --provider vercel` pasa `--provider vercel` a agentbox y guarda `vercel` en el registry.
- [ ] Con config legacy `provider: agentbox`, `sander create` avisa de que migre y actúa como default docker (argv `--provider docker`, registry `docker`); el archivo de config no se modifica.
- [ ] La pregunta de provider del wizard (texto, aún sin selector) muestra default `docker` y valida los 5 providers.
- [ ] La UX de `create` y la ayuda no muestran "agentbox" ni el comando `prepare`.
