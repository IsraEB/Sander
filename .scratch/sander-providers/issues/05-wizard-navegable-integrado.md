# 05 — Wizard navegable integrado (provider cerrado + harness con "Other…")

**What to build:** El wizard de `sander config` a pelo y del primer `sander create` interactivo usa el selector navegable en vez del prompt de texto. La pregunta de provider es una lista cerrada con las 5 opciones (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`), sin entrada de texto libre, con los providers cloud marcados visualmente como "requieren setup". La pregunta de harness es un selector con `opencode`, `claude` y `codex` más una entrada "Other…" que, al elegirse, pasa a tipeo libre manteniendo la validación de nombre existente. Se navega con ↑/↓ y Enter, atajos numéricos 1–N, y `q`/Esc cancelan con un error accionable sin dejar config a medias. En un entorno sin TTY el wizard jamás se ejecuta: `sander config` a pelo y `sander create` con claves requeridas faltantes fallan con un error accionable que sugiere los flags o `sander config set <key> <value>` (contrato actual). Las respuestas del wizard se guardan en la config global. La lógica de selección se prueba unitariamente con una fuente de teclas inyectable (secuencias normalizadas), sin PTY.

**Blocked by:** 02 — Providers reales en config y create, 04 — Selector navegable hand-rolled (prefactor del wizard)

**Status:** ready-for-agent

- [ ] `sander config` a pelo en un TTY muestra la pregunta de provider como selector cerrado (5 opciones, cloud marcados "requieren setup") y la de harness como selector con "Other…".
- [ ] ↑/↓ y Enter eligen; los atajos numéricos 1–N eligen directamente; `q`/Esc cancelan con un error accionable y sin guardar config a medias.
- [ ] Elegir "Other…" en harness abre tipeo libre y valida el nombre como hoy.
- [ ] En no-TTY, `sander config` a pelo y `sander create` sin claves requeridas fallan con un error accionable que sugiere los flags o `sander config set <key> <value>`, y el motor de provider no se invoca.
- [ ] Las respuestas del wizard se persisten en la config global (un `create` posterior no vuelve a preguntar).
- [ ] La lógica de selección pura se prueba con una fuente de teclas inyectable (secuencias normalizadas), sin PTY; el render se prueba aparte como texto generado.
