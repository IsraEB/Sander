# 03 — Wizard propio + predicado "configurado" + `sander config` bare/oneliner

**What to build:** El predicado "configurado" derivado (claves requeridas = `provider` + `harness`; presente en config global ∪ workspace ∪ flags del comando; los defaults internos no cuentan) y el wizard interactivo propio de sander (prompts hand-rolled, sin framework). `sander config` a pelo o con flags (`--provider`/`--harness`/`--token`) escribe los flags dados y luego ejecuta el wizard por cada clave requerida que no se haya pasado ya como flag (incluso si está configurada), mostrando el valor actual como default. `--token` nunca dispara preguntas. En no-TTY, el `sander config` a pelo falla SIEMPRE con un error accionable: si faltan claves requeridas, las lista y sugiere cómo fijarlas; si todo está configurado, explica que necesita una terminal interactiva y sugiere `sander config list` o `sander config set <key> <value>`.

**Blocked by:** 02 — `sander config CLI de lectura/escritura`

**Status:** ready-for-agent

- [ ] `sander config --harness codex --provider agentbox` no hace ninguna pregunta y persiste ambas claves.
- [ ] `sander config --token <x>` persiste el token y pregunta por las claves requeridas no pasadas como flags (con el valor actual como default).
- [ ] `sander config` a pelo en un TTY pregunta SIEMPRE por `provider` y `harness` (incluso con todo configurado), mostrando el valor actual como default (Enter lo conserva); en no-TTY falla SIEMPRE con un error accionable (claves faltantes, o sugerencia de `sander config list`/`sander config set <key> <value>` si todo está configurado).
- [ ] Las preguntas son prompts de terminal planos, sin dependencias nuevas de runtime.
- [ ] El predicado "configurado" es una función pura: una clave en config global, workspace o flags cuenta como presente; un default interno no.
- [ ] En no-TTY con claves requeridas faltantes, `sander config` falla con un error que lista las claves y sugiere `sander config set <key> <value>` o los flags.
