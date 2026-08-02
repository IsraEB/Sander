# Spec: `sander config` — eliminación del wizard de agentbox + config propia de sander

Status: ready-for-agent

## Problem Statement

La primera vez que un usuario ejecuta `sander create` (y en ciertos casos `sander attach`), aparece el wizard interactivo de agentbox: la terminal de instalación de agentbox se apodera de la sesión, muestra un banner y pregunta cosas que a sander no le interesan. Ese wizard entra por dos vías: (1) sander lo invoca explícitamente en el setup del provider (`agentbox install -y --provider docker`), y (2) el propio CLI de agentbox lo auto-dispara antes de cualquier comando no-exento (`create`, `shell`, `attach`, `prepare`…) cuando el marker `~/.agentbox/setup-complete.json` no existe y hay TTY.

El resultado: sander delega su "primer arranque" a un tercero con su propia UI, su propio banner y sus propias preguntas. El usuario quiere que ese terminal de agentbox **jamás** aparezca, y que sea sander quien tenga su propio flujo de configuración (interactivo y por CLI), que se ejecute automáticamente en el primer `sander create` si falta configuración.

## Solution

Sander deja de invocar el wizard de agentbox y escribe el marker de setup de agentbox **antes de tocar cualquier comando de agentbox**, de modo que el auto-trigger de agentbox no puede ocurrir nunca. En su lugar, sander obtiene un comando `sander config` propio:

- `sander config` (a pelo, o con flags `--provider`/`--harness`/`--token`): los flags se escriben en la config global; a continuación sander SIEMPRE ejecuta su wizard por las claves requeridas (`provider`, `harness`) que no se hayan pasado ya como flags — incluso si ya están configuradas — mostrando el valor actual como default (Enter lo conserva). En no-TTY, el `sander config` a pelo falla SIEMPRE con un error accionable. `sander config list` imprime la config actual.
- Subcomandos `set`/`get`/`unset`/`list` con scopes `--global` (default) y `--workspace`, incluida la clave anidada `env.<KEY>`.

"Configurado" es una propiedad **derivada**, no un flag: un sandbox se considera configurado si las claves requeridas (`provider`, `harness`) están presentes en la config (global ∪ workspace) o fueron pasadas como flags en el comando. Un default interno (`agentbox`/`opencode`) **no** cuenta como configurado. El `token` nunca es requerido y por tanto nunca dispara preguntas.

En el primer `sander create` interactivo, si faltan claves requeridas, sander hace sus propias preguntas y escribe las respuestas en la config global, para luego proceder con la creación. En un entorno sin TTY, si faltan claves, `create` **falla con un error accionable** (nunca se cuela un wizard, ni el de agentbox ni el de sander). La imagen base de agentbox se prepara en segundo plano (`agentbox prepare --provider docker -y`) detrás del spinner de sander cuando falta, sin UI de agentbox.

## User Stories

1. As a new sander user, I want the agentbox install wizard to never appear, so that I never see agentbox's interactive terminal or banner.
2. As a new sander user, I want the agentbox setup marker to be written before sander runs any agentbox command, so that agentbox's own auto-trigger can never fire.
3. As a new sander user, I want a `sander config` command, so that I can configure sander directly instead of through agentbox.
4. As a new sander user, I want the first interactive `sander create` to automatically ask me sander's own questions when I haven't configured anything, so that I'm set up before creating my first sandbox.
5. As a user, I want the wizard to ask only the required keys that are missing, so that I don't repeat configuration I already provided.
6. As a user, I want the wizard to persist its answers to the global `config.json`, so that future creates are configured and won't ask again.
7. As a user, I want `sander config --harness <name> --provider agentbox` to run without any prompts, so that I can fully configure in a single CLI call.
8. As a user, I want `sander config --token <x>` to set the token and then ask only for the still-missing required keys, so that the token never triggers a question.
9. As a user, I want `sander config set <key> <value>` to write a value to the config file, so that I can configure from scripts and dotfiles.
10. As a user, I want `sander config set env.<KEY> <value>` to manage environment variables in the config, so that I can inject env vars without touching `.env.sander`.
11. As a user, I want `sander config get`, `sander config list`, and `sander config unset`, so that I can inspect and remove configuration.
12. As a user, I want `sander config` scoped with `--global` or `--workspace`, so that I can keep per-project settings separate from machine-wide ones.
13. As a user, I want `sander config` to validate values (provider only `agentbox`, harness valid), so that I can't persist unusable config.
14. As a user, I want bare `sander config` in a terminal to always show the wizard (with the current values as defaults) so that I can review or change configuration at any time, and `sander config list` to be the read-only view of the current config.
15. As a user, I want passing `--harness`/`--provider` on `sander create` to count as "configured", so that a one-off scripted create doesn't prompt.
16. As a user, I want `sander create` with missing required keys in a non-TTY environment to fail with a clear, actionable error, so that I know exactly what to set (e.g. `sander config set harness <name>` or `--harness`).
17. As a CI user, I want the non-TTY error to list which keys are missing, so that my pipeline reports precisely what configuration is absent.
18. As a user, I want the base docker image prepared behind sander's own spinner on first create when missing, so that I see progress instead of a silent hang or agentbox output.
19. As a user, I want `sander attach` to never trigger any wizard (sander's or agentbox's), so that attaching is always non-interactive.
20. As a user, I want deleting or clearing `config.json` to re-trigger sander's wizard on the next create, so that I can reconfigure by resetting config.
21. As a user, I want `sander config set provider <unsupported>` to error with a hint, so that I'm told the supported provider immediately.
22. As a developer, I want `sander create` and `sander config` to share the same config-resolution and wizard logic, so that behavior stays consistent.
23. As a user, I want config resolution to apply the workspace layer's `harness`/`provider` values, so that what counts as "configured" matches what actually gets used.
24. As a user, I want the config file to remain valid JSON after wizard and `set` writes, so that other tooling can read it.
25. As a user, I want the interactive questions to be plain terminal prompts (no TUI framework), so that sander keeps its minimal, dependency-free feel.

## Implementation Decisions

- **Garantía "jamás interactivo de agentbox"**: se elimina la invocación de `agentbox install` del setup del provider. El marker de agentbox (`~/.agentbox/setup-complete.json`) se escribe **siempre** antes de la primera invocación de cualquier comando de agentbox (`create`, `shell`, `attach`, `exec`, `prepare`), en todos los caminos (TTY o no, wizard o no). Así queda muerto el auto-trigger (`isFirstRun()`) de agentbox. `agentbox create` sigue llamándose con `-y --carry-yes`, ya verificado no-interactivo.
- **Predicado "configurado" derivado** (nuevo módulo compartido bajo el dominio de config): claves requeridas = `provider` + `harness`. Un sandbox está configurado cuando cada clave requerida está presente en la config global (`config.json`), en la config de workspace (`.sander/config.json`) o en los flags del comando. Los defaults internos no cuentan. Función pura: entrada (global, workspace, flags) → claves requeridas que faltan.
- **`token` nunca requerido**: forma parte del set de claves configurables por CLI (`set`/flag) pero no dispara preguntas del wizard. Se sigue resolviendo por la cadena existente (flag → global → workspace → gh CLI con confirmación).
- **Comando `sander config`** (nuevo comando de CLI):
  - Sin subcomando (**intencionadamente SIEMPRE interactivo**): aplica los flags dados como escrituras y luego ejecuta el wizard por cada clave requerida (`provider`, `harness`) que no se haya pasado ya como flag, incluso cuando todo está ya configurado, mostrando el valor actual como default (Enter lo conserva, escribir un valor nuevo lo cambia). Las claves pasadas como `--provider`/`--harness` no se vuelven a preguntar, así que el oneliner completo corre sin prompts. En no-TTY falla SIEMPRE con un error accionable: si faltan claves requeridas, las lista y sugiere `sander config set <key> <value>` o los flags; si todo está configurado, explica que el comando a pelo necesita una terminal interactiva y sugiere `sander config list` para ver la config o `sander config set <key> <value>`/los flags para cambiarla. Nunca debe regresar al atajo antiguo de "imprimir la config cuando no falta nada": `sander config list` es la vista de solo lectura.
  - Subcomandos `set <key> <value>`, `get [<key>]`, `unset <key>`, `list`; scopes `--global` (default) y `--workspace`. `set` valida: `provider` ∈ {`agentbox`}, `harness` válida, y acepta `env.<KEY>` como clave anidada.
  - Los errores usan el formato `CliError` estándar con mensaje accionable.
- **`sander create`**: antes del setup del provider, resuelve las capas de config; si faltan claves requeridas: TTY → ejecuta el wizard compartido (solo las que faltan) y escribe en la config global; no-TTY → `CliError` que lista las claves faltantes y sugiere `sander config set <key> <value>` o los flags de `create`. El resolver de defaults de `create` amplía su lectura de `harness`/`provider` a la capa de workspace (precedencia flag → global → workspace → default) para que lo que cuenta como "configurado" se aplique realmente.
- **Imagen base**: en `create`, si la imagen `agentbox/box:dev` no existe, se ejecuta `agentbox prepare --provider docker -y` (headless verificado) detrás del spinner de sander; si `prepare` falla, avisa y deja que el ensure lazy de `agentbox create` lo reintente.
- **Interfaz de provider**: `ensureSetup` pierde su rama de wizard interactivo; pasa a "escribir marker (y, en `create`, asegurar la imagen base)". El contrato `interactive:false` (usado por `attach`) permanece y es ahora el único comportamiento. Se puede añadir un método/modo específico para el aseguramiento de la imagen base.
- **Wizard propio (prompts hand-rolled)**: preguntas por terminal plana siguiendo el patrón existente (`fs.readSync` sobre el fd de stdin para texto, confirmaciones tipo `y/N`). Entrada/salida inyectables.
- **Seam de prompt**: nueva dependencia en el objeto de deps de CLI (`prompt`/pregunta interactiva, con default real sobre stdin/stdout), al mismo nivel que el `confirm` existente.
- **Sin dependencias nuevas de runtime**: se mantiene el estilo zero-deps del proyecto.

## Testing Decisions

- **Qué hace un buen test**: verifica comportamiento externo observable — códigos de salida, mensajes en stdout/stderr, contenido de `config.json` resultante, y argv de agentbox — nunca los internals del wizard ni de los módulos.
- **Seam primario — CLI layer**: tests de `sander create` (extendiendo el fichero de tests existente de create) y un nuevo fichero de tests del comando `sander config`, ambos usando `runCli` con los fakes existentes (`FakeProvider`, `FakeHarnessFactory`, `FakeWorktree`, `CaptureStream`, config en un dir temporal) más el seam de `prompt` inyectado con respuestas predefinidas. Cubren: wizard que solo pregunta las claves faltantes; escritura de `config.json`; flags que cuentan como configurado; oneliner completo sin prompts; `--token` que no dispara preguntas; error accionable en no-TTY (y que `provider.create` no se llama); `attach` sin wizard; `sander config` bare ya configurado preguntando de nuevo con los valores actuales como default y fallando en no-TTY; `set env.<KEY>` y validaciones.
- **Seam secundario — Provider layer**: en los tests existentes del provider de agentbox (fake runner de comandos): `ensureSetup` siempre escribe el marker y **nunca** ejecuta `install`; en `create`, cuando la imagen base falta se invoca `prepare --provider docker -y` y cuando existe no; `attach` escribe el marker sin wizard.
- **Prior art**: `create.test.ts` (fakes + `runCli` + `process.chdir` + asserts sobre ops del provider y registry), `attach.test.ts` (asserts sobre `ensureSetupCalls`), y los tests del provider con runners fake que asertan argv.
- **Tests existentes a actualizar**: los que hoy asumen que el primer `create` interactivo ejecuta el wizard de agentbox pasan a asumir el nuevo comportamiento (wizard propio o marker directo sin `install`).

## Out of Scope

- Soportar providers distintos de `agentbox` (sigue siendo el único admitido; el wizard muestra una sola opción).
- Añadir el `token` como pregunta del wizard (solo CLI).
- Cambios en agentbox upstream (el marker, `prepare`, el auto-trigger son de agentbox; sander solo los usa de forma no-interactiva).
- Publicación del spec en GitHub Issues (tracker local elegido; token de `gh` inválido).
- Reconfiguración "forzada" del wizard (p. ej. un `--force`); reconfigure = `unset`/borrar config.
- Gestión interactiva de `env` en el wizard (solo CLI: `set env.<KEY>`).

## Further Notes

- El guard de orden es la pieza crítica: el marker de agentbox debe escribirse antes de **cualquier** invocación de agentbox, incluidas las de `shell`/`exec`/`copy` que ocurren durante `create` (sync de config, alineación de usuario del box). Si se escapara una, agentbox podría auto-disparar su wizard en un TTY.
- `agentbox create` ya está verificado como no-interactivo (`-y` → `nonInteractiveOutcome`; `ensureImage` construye/pull la imagen base sin prompts).
- La config del provider está gestionada por agentbox (marker, imagen, `box.provider`); sander no la replica — solo garantiza la ausencia de UI de agentbox y la presencia del marker.
