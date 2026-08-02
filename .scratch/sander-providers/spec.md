# Spec: providers reales de sandbox + wizard navegable

Status: ready-for-agent

## Problem Statement

`provider` en sander no significa hoy lo que debería: el wizard y `sander list` muestran `agentbox` como si fuera el proveedor de sandbox, cuando en realidad agentbox es una herramienta que a su vez crea boxes sobre providers reales (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`). Un usuario de sander debería elegir el sandbox que quiere (`docker` local, una VPS de hetzner, una sandbox gestionada de vercel…), no una herramienta interna.

Además, sander fija en código que el único provider posible es `agentbox` (`configured.ts` y `create.ts`, duplicados) y hardcodea docker en el preparado de la imagen base, de modo que los providers cloud de agentbox existen pero sander no los ofrece ni los pasa a agentbox. Y el wizard actual es texto plano ("Provider [agentbox]: "), donde el usuario escribe a mano en vez de navegar por las opciones.

## Solution

El usuario de sander elige un **provider real de sandbox**: `docker`, `daytona`, `hetzner`, `vercel` o `e2b`. agentbox pasa a ser un detalle de implementación (un motor) que sander maneja internamente: el usuario nunca ve "agentbox" ni el comando `prepare` de agentbox. El default interno pasa a `docker`, consolidado en una única fuente de verdad. El wizard se convierte en un selector navegable (flechas ↑/↓, atajos numéricos, `q`/Esc para cancelar) tanto para provider como para harness. Los providers que requieren setup previo (los cloud) se muestran marcados. En no-TTY nunca se pregunta: error accionable. Los boxes existentes creados con `agentbox` siguen siendo operables, tolerando el valor legacy en el registry.

## User Stories

1. Como usuario de sander, quiero que `provider` sea el proveedor real de sandbox (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`), para que elija el sandbox que quiero sin saber que agentbox está por debajo.
2. Como usuario de sander, quiero que agentbox sea un motor invisible (sin dimensión "engine" en config ni registry), para que el modelo mental sea solo "proveedor + harness".
3. Como usuario de sander, quiero que el default de provider sea `docker`, para que un `sander create` sin config no me cree una VM cloud por accidente.
4. Como usuario de sander, quiero que los 5 providers soportados se ofrezcan en el wizard, para poder elegir el sandbox adecuado a cada tarea.
5. Como usuario de sander, quiero que los providers cloud se muestren en el wizard marcados como "requieren setup", para saber de antemano que necesitan credenciales/preparación.
6. Como usuario de sander, quiero que `sander create --provider vercel` cree la sandbox en vercel, para usar un proveedor cloud sin pasos extra.
7. Como usuario de sander, quiero que `sander config set provider docker` (y los otros 4) sea válido, para configurar por CLI.
8. Como usuario de sander, quiero que `sander config set provider agentbox` falle con un error accionable que sugiera `docker`, para no persistir un valor obsoleto.
9. Como usuario de sander, quiero que al leer config vieja con `provider: agentbox` se me diga que migre a `docker` (por ejemplo con `sander config set provider docker`), para no quedar bloqueado sin entender qué pasó.
10. Como usuario con boxes existentes grabados como `agentbox` en el registry, quiero que `list`/`attach`/`stop`/`start`/`rm`/`logs`/`exec`/`run` sigan funcionando sobre ellos interpretando `agentbox` como `docker`, para no perder el trabajo de las sandboxes ya creadas.
11. Como usuario de sander, quiero que `sander list` muestre el provider real (`docker`, no `agentbox`) en la columna PROVIDER, para que lo que veo coincida con lo que es.
12. Como usuario de sander, quiero navegar el wizard con las flechas ↑/↓ y Enter, para elegir opción sin escribir.
13. Como usuario de sander, quiero poder elegir con atajos numéricos (1–N) en el wizard, para ir rápido.
14. Como usuario de sander, quiero poder cancelar el wizard con `q`/Esc, para abortar sin dejar config a medias.
15. Como usuario de sander, quiero que la pregunta de harness sea un selector con `opencode`, `claude`, `codex` y una entrada "Other…" que pasa a tipeo libre, para elegir rápido y aun así poder usar harnesses custom.
16. Como usuario de sander, quiero que la pregunta de provider sea un selector con las 5 opciones, sin entrada de texto libre (lista cerrada), para no poder escribir un provider inválido.
17. Como usuario de sander en un entorno sin TTY, quiero que el wizard nunca se ejecute y que en su lugar falle con un error accionable que sugiere flags o `sander config set`, para poder automatizar sin prompts colgados.
18. Como usuario de sander, quiero que `sander create` sin config en TTY ejecute el wizard navegable, para quedar configurado en mi primer create.
19. Como usuario de sander, quiero que el wizard guarde sus respuestas en la config global, para no volver a preguntar.
20. Como usuario de sander, quiero que sander ejecute internamente el `prepare` del provider elegido (sin mostrármelo) cuando haga falta, para no preocuparme por los comandos de agentbox.
21. Como desarrollador de sander, quiero que la lista de providers soportados viva en un único lugar (fuente de verdad única), para que config, create y wizard no divergan.
22. Como desarrollador de sander, quiero un factory de providers que resuelva la implementación a partir del nombre, para que cada comando que opera sobre un box use el motor correcto según el registry.
23. Como desarrollador de sander, quiero que `attach`/`exec`/`run`/`stop`/`start`/`rm`/`list`/`logs` resuelvan el provider desde `registry.boxes[id].provider`, para soportar múltiples providers sin singletons.
24. Como desarrollador de sander, quiero que el código que tolera el valor legacy `agentbox` en el registry esté marcado con un comentario de retrocompatibilidad que indique que se elimine cuando no quede ningún box con `agentbox`, para no arrastrar el alias para siempre.
25. Como desarrollador de sander, quiero que si un agente se encuentra ese código legacy y no hay ningún box con `provider: agentbox`, lo elimine, para limpiar la deuda acumulada.
26. Como usuario de sander, quiero que `sander config set provider <cloud>` funcione sin prompt extra de agentbox, para configurar un provider cloud de forma no interactiva.
27. Como usuario de sander, quiero que el selector se mantenga zero-deps (sin bibliotecas), para conservar la portabilidad y simplicidad del CLI.
28. Como desarrollador de sander, quiero que la lógica de selección pura del wizard sea testeable con un seam de teclas inyectable (secuencias normalizadas), para probar el wizard sin PTY.

## Implementation Decisions

- **Modelo de dos ejes**: `provider` es el proveedor real de sandbox que elige el usuario. El **motor** (cómo sander materializa ese provider — hoy agentbox) es un detalle de implementación interno, sin dimensión visible en config ni registry. Un factory interno mapea proveedor → motor.
- **Conjunto de providers v0**: exactamente los que soporta agentbox — `docker`, `daytona`, `hetzner`, `vercel`, `e2b`. Cada uno se pasa a agentbox como `--provider <nombre>` tanto en `create` como en `prepare`. Podman queda fuera (no lo soporta agentbox; requeriría un motor directo futuro).
- **Default**: `docker`, consolidado como fuente de verdad única en el módulo de config/validación (reemplaza el default duplicado que hoy vive en la resolución de `create` y en el wizard).
- **Validación**: `validateConfiguredKey` (o su equivalente único) acepta solo los 5 providers. `agentbox` ya no es un valor válido para config: `config set provider agentbox` y `--provider agentbox` fallan con error accionable que sugiere `docker`.
- **Compatibilidad de config legacy**: al resolver config que contiene `provider: agentbox`, se informa al usuario de que migre (`sander config set provider docker`) y se comporta como si no hubiera provider configurado (usa el default docker). No se reescribe silenciosamente la config.
- **Compatibilidad de registry legacy**: los boxes existentes con `provider: agentbox` en el registry se interpretan como `docker` para operarlos (attach/exec/run/stop/start/rm/logs/list). El list muestra `docker`. Esta sección de código lleva un comentario que indica: solo retrocompatibilidad; eliminar cuando no quede ningún box con `provider: agentbox`; si un agente la encuentra y no existen boxes actuales con `agentbox`, debe eliminarla.
- **Factory de providers**: nuevo módulo que expone `createProvider(providerName): Provider`. `create` resuelve el provider desde flags → config global → workspace → default y construye el motor. Los comandos que operan sobre boxes ya creados resuelven el provider desde `registry.boxes[id].provider` y usan el motor correspondiente. En v0, todos los providers se resuelven al motor agentbox; el factory es el punto donde en el futuro entra un motor directo.
- **AgentboxProvider con provider parametrizable**: `create` y `ensureBaseImage`/`prepare` reciben el provider y pasan `--provider <nombre>` a agentbox (hoy está fijado a docker). `CreateRequest.provider` ya transporta el nombre; el motor lo usa.
- **Wizard navegable (selector hand-rolled)**: implementación con raw-mode (`stdin.setRawMode(true)`), sin dependencias de runtime. La pregunta de provider es una lista cerrada (los 5 providers, con marca visual en los cloud que requieren setup previo). La pregunta de harness es un selector con las opciones conocidas (`opencode`, `claude`, `codex`) más una entrada "Other…" que, al elegirse, pasa a tipeo libre (manteniendo la validación de nombre existente).
- **Teclado del selector**: ↑/↓ mueven la selección; Enter elige; atajos numéricos 1–N eligen directamente; `q` o Esc cancelan el wizard con un error accionable. Sin type-to-filter.
- **Comportamiento no-TTY**: el wizard jamás se ejecuta sin terminal interactiva. En no-TTY, `sander config` a pelo y `sander create` con claves faltantes fallan con error accionable que sugiere los flags o `sander config set`. Idéntico al contrato actual.
- **Seam del wizard**: separación entre (a) la lógica de selección pura — dada una secuencia de entradas normalizadas (`down`/`enter`/`q`/`1`…), ¿qué opción se elige? — y (b) la lectura raw del TTY (secuencias de escape → entradas normalizadas) y el render. El seam de input es inyectable (fuente de teclas), testable sin PTY.
- **Fuente de verdad única**: la lista de providers soportados vive en un único módulo compartido por config, create y wizard.

## Testing Decisions

- **Qué hace un buen test**: verifica comportamiento externo observable — códigos de salida, mensajes en stdout/stderr, contenido resultante de config.json/registry.json, y los argv que sander pasa a agentbox — nunca los internals del selector ni del factory.
- **Seam primario — CLI layer** (el existente): tests de `create`, `config`, `list` y los comandos de ciclo de vida usando `runCli` con los fakes existentes (`FakeProvider`, `FakeHarnessFactory`, `FakeWorktree`, `CaptureStream`, config en un dir temporal) más el seam de `prompt`/fuente de teclas inyectado. Cubren: validación de los 5 providers; rechazo de `agentbox` en config con error accionable; default docker; wizard navegable respondiendo con secuencias normalizadas; atajos numéricos; cancelación con `q`/Esc; entrada "Other…" de harness con tipeo libre; no-TTY → error accionable (y que `provider.create` no se llama); `create --provider vercel` pidiendo el motor correcto; resolución por box desde el registry en attach/stop/start/rm; `list` mostrando `docker` para boxes legacy; comportamiento ante config legacy `agentbox`.
- **Seam nuevo — key stream del selector**: la lógica de selección pura se prueba unitario con una fuente de teclas inyectable (secuencias normalizadas), verificando qué opción queda seleccionada para cada secuencia (`down`/`enter`, `3`/`enter`, `q`, `esc`). El render se prueba aparte como texto generado.
- **Seam secundario — Provider layer** (el existente en los tests del provider de agentbox con runners fake): `create` invoca `agentbox create --provider <elegido> …` y no el argv hardcodeado a docker; `ensureBaseImage` invoca `agentbox prepare --provider <elegido> -y` en vez del docker fijo; los 5 providers producen el `--provider` correcto.
- **Prior art**: `create.test.ts` (fakes + `runCli` + asserts sobre ops del provider y registry), `config.test.ts` (wizard con prompt seam y validación), `attach.test.ts` (asserts sobre `ensureSetupCalls`), y los tests del provider con runners fake que asertan argv (`agentbox.test.ts`).

## Out of Scope

- **Podman y motores directos** (docker CLI directo, podman): requieren un motor fuera de agentbox; el factory queda listo pero no se implementa ningún motor nuevo en este spec.
- **Gestión de credenciales de providers cloud**: las credenciales de hetzner/vercel/etc. las gestiona agentbox/el entorno; sander solo prepara y crea.
- **Type-to-filter** en el selector.
- **Detección dinámica de disponibilidad** (p. ej. ocultar providers sin credenciales): el wizard muestra los 5 siempre, marcando los cloud.
- **Soporte de harness adicionales con adaptador propio** (solo opencode/claude tienen adaptador; codex y demás usan el genérico) — el selector los lista como opciones, pero su headless/interactive ya está sin implementar fuera del scope actual.
- **Reescritura automática de config legacy** `agentbox` → `docker` (solo registry tolera el alias; la config se informa al usuario).

## Further Notes

- El usuario nunca debe ver "agentbox" ni el comando `prepare` en la UX de sander: ese es el criterio de aceptación transversal de este spec.
- El comentario de retrocompatibilidad del registry es parte del contrato: cualquier agente que toque esa sección debe leerlo y, si no hay boxes `agentbox`, eliminar el alias.
- Idioma de la conversación y de los mensajes de la CLI: español.
- Este spec continúa la línea de `sander-config` (wizard propio, predicado "configurado") y de la spec v0 (seam provider intercambiable, story #30 y #3).
