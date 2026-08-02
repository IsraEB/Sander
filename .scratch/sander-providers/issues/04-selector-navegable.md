# 04 — Selector navegable hand-rolled (prefactor del wizard)

**What to build:** Primitiva del selector interactivo, sin dependencias de runtime: navegación con flechas ↑/↓, confirmación con Enter, atajos numéricos 1–N y cancelación con `q`/Esc. Renderiza la lista de opciones con marca visual opcional por opción (para señalar las que "requieren setup") y cursor. Lee el terminal en raw-mode y normaliza las secuencias de escape a entradas normalizadas (`up`/`down`/`enter`/`q`/`esc`/`1`…`N`). La lógica de selección es pura: dada una secuencia de entradas normalizadas, devuelve la opción elegida o cancela; su fuente de teclas es inyectable, de modo que se puede probar sin PTY. En este ticket el selector se construye y se prueba de forma aislada; todavía no se usa en el wizard de sander.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Dada una secuencia normalizada (`down`/`enter`, `3`/`enter`, atajo numérico fuera de rango, `q`, `esc`), la lógica pura elige la opción correcta o cancela.
- [ ] El render produce texto estable: opciones con su número, cursor sobre la selección y marca visual por opción cuando se pide.
- [ ] La lectura raw del TTY traduce secuencias de escape reales (flechas, teclas de números, `q`, Esc) a entradas normalizadas.
- [ ] Cancelar (`q`/Esc) devuelve un resultado de cancelación distinguible de elegir una opción.
- [ ] El selector funciona sin ninguna dependencia de runtime nueva.
