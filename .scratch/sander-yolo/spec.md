# Spec: yolo mode en sandboxes

Status: ready-for-agent

## Problem Statement

Los sandboxes de sander deberían ejecutar el harness en modo yolo (auto-aprobar las acciones) por defecto — un box es un entorno desechable y aislado, y pedir aprobación ahí es fricción inútil. Hoy sander no tiene el concepto de "modo yolo": la config del harness se copia tal cual al box, de modo que si la config del host pide confirmación (p. ej. `permission: { "edit": "ask" }` en opencode), el agente dentro del box se detiene a preguntar.

Además hay dos defectos colaterales que impiden que la config del harness llegue de verdad al harness dentro del box y que el agente se ejecute donde debería:

- `syncHarnessConfig` copia la config a `~/.config/<harness>` dentro del box, pero cada harness lee de su propio directorio real (opencode lee del volumen `OPENCODE_CONFIG_DIR`, claude de `~/.claude`). El sync actual es decorativo.
- `sander run` ejecuta el harness headless en el host con la config del host, en lugar de dentro del box.

El requisito central es que el yolo sea una propiedad del sandbox (del box), nunca de la config del harness en el host: el host no se modifica.

## Solution

El concepto de **yolo** es un valor de config de sander con default `true`: los boxes se crean en modo yolo salvo que se indique lo contrario. Se puede apagar por box con `--no-yolo`, re-activar con `--yolo`, y cambiar el default con `sander config set yolo true|false`. La precedencia de resolución se unifica para `provider`, `harness` y `yolo` como **flag > workspace > global > default**.

Al crear un box, sander aplica una **receta por harness** que transforma la config del harness *dentro del box* (en el directorio que el harness realmente lee) para materializar el modo yolo o no-yolo elegido:

- **yolo** = auto-aprobar todo lo no denegado: convierte cada regla `ask` en `allow`, preservando los `deny` explícitos (semántica idéntica a `opencode --auto` y a `permissions.defaultMode: "bypassPermissions"` de claude).
- **no-yolo** = el inverso: hacer que el harness pregunte (catch-all `"*": "ask"` en opencode, `defaultMode: "default"` en claude, `approval_policy = "on-request"` en codex).

Las recetas cubren opencode, claude y codex. Un harness sin receta no se transforma: sander avisa y sigue. La inyección ocurre solo al crear (el volumen del box persiste entre `stop`/`start`); si alguien lanza el agente por fuera vía `agentbox … start`, la re-sincronización host→volumen puede borrar el yolo — limitación documentada.

El modo yolo resuelto se persiste por box en el registry (`yolo?: boolean`), se muestra en `sander list` y se informa en `sander attach`.

De paso se corrigen los dos defectos: `syncHarnessConfig` copia a los directorios reales del box, y `sander run` ejecuta el harness headless **dentro del box**, heredando así la config del box (y por tanto su modo yolo).

## User Stories

1. Como usuario de sander, quiero que un `sander create` cree el sandbox en modo yolo por defecto, para que el agente dentro del box trabaje sin pedirme aprobación.
2. Como usuario de sander, quiero que la config del harness en el host nunca se modifique por esta feature, para que el yolo sea exclusivamente del box.
3. Como usuario de sander, quiero `sander create --no-yolo` para que ese sandbox pida aprobación aunque el default sea yolo.
4. Como usuario de sander, quiero `sander create --yolo` para re-activar el yolo en un sandbox concreto aunque la config diga `yolo: false`.
5. Como usuario de sander, quiero `sander config set yolo false` para cambiar el default a no-yolo.
6. Como usuario de sander, quiero que `sander config set yolo true` vuelva a poner el default en yolo.
7. Como usuario de sander, quiero que la resolución de `yolo` siga la precedencia flag > workspace > global > default `true`, para que la config del proyecto mande sobre la global y el flag mande sobre todo.
8. Como usuario de sander, quiero que `yolo` sea una clave válida de `sander config get/list/set/unset`, para gestionarla por CLI igual que provider/harness.
9. Como usuario de sander, quiero que en un box yolo con opencode las restricciones `ask` de mi config (sincronizada del host) se conviertan en `allow` dentro del box, para que el agente no pregunte.
10. Como usuario de sander, quiero que los `deny` explícitos de mi config se preserven dentro del box incluso en yolo, para que nada que haya denegado se ejecute.
11. Como usuario de sander con un box no-yolo de opencode, quiero que el harness pregunte ante acciones no denegadas, para tener control.
12. Como usuario de sander, quiero que la misma semántica funcione con claude (`settings.json` → `permissions.defaultMode`), para tener yolo/no-yolo también ahí.
13. Como usuario de sander, quiero que la misma semántica funcione con codex (`config.toml` → `approval_policy`), para tener yolo/no-yolo también ahí.
14. Como usuario de sander, quiero que si elijo un harness sin receta (p. ej. "Other…") se me avise de que el yolo no aplica, para no asumir que el box es yolo cuando no lo es.
15. Como usuario de sander, quiero que el modo yolo quede guardado en el registry por box, para saber cómo se creó cada sandbox.
16. Como usuario de sander, quiero que `sander list` muestre una columna con el modo yolo de cada box, para verlo de un vistazo.
17. Como usuario de sander, quiero que `sander attach` informe si el box es yolo, para saber qué esperar al entrar.
18. Como usuario de sander, quiero que la inyección del yolo ocurra al crear y persista entre `stop`/`start` del box, para no re-afirmar nada manualmente.
19. Como usuario de sander, quiero que `sander run <id> "prompt"` ejecute el harness headless dentro del box, para que el run use la config del box (incluido su modo yolo) y no la del host.
20. Como usuario de sander, quiero que la config del harness se sincronice al directorio real que el harness lee dentro del box (volumen de opencode, `~/.claude`, `~/.codex`), para que mi config de host de verdad llegue al agente.
21. Como usuario de sander, quiero que la precedencia de `provider` y `harness` también sea flag > workspace > global > default, para que el modelo de config sea consistente en toda la CLI.
22. Como usuario de sander, quiero que el wizard no pregunte por `yolo`, para que el primer create no tenga una pregunta más (el default yolo basta).
23. Como desarrollador de sander, quiero que las recetas yolo/no-yolo sean un mapa genérico `harness → transform`, para que añadir un harness nuevo sea añadir una fila sin tocar el flujo de create.
24. Como desarrollador de sander, quiero que los transforms de las recetas sean funciones puras sobre la config (JSON/TOML), para probarlas sin box ni provider.
25. Como desarrollador de sander, quiero que el merge con la config existente del box sea aditivo (no clobber), para que el resto de la config sincronizada del host se conserve.
26. Como desarrollador de sander, quiero que si un harness no tiene receta la inyección se omita con un aviso, para no fallar el create por un harness custom.
27. Como desarrollador de sander, quiero que la inyección de yolo y la corrección de `syncHarnessConfig` compartan el conocimiento de "dónde lee cada harness su config en el box", para no divergir.
28. Como usuario de sander, quiero que `--no-yolo` de un box claude siga siendo yolo si el agente se lanza después vía `agentbox claude` (la flag CLI de agentbox gana), para entender el límite y no sorprenderme.
29. Como desarrollador de sander, quiero que el `runRun` actual (host-side) se reemplace por ejecución en el box vía el seam de `provider.exec`, para que `sander run` sea coherente con el modelo de sandbox.

## Implementation Decisions

- **Concepto `yolo`**: nueva clave opcional `yolo?: boolean` en la config de sander (global y workspace layer). Default de resolución: `true`.
- **Precedencia unificada**: `provider`, `harness` y `yolo` se resuelven con **flag > workspace > global > default**. Esto cambia la resolución actual de `provider`/`harness` (hoy global > workspace): se alinea al nuevo orden.
- **Flags de `sander create`**: `--yolo` y `--no-yolo` simétricos, con el mismo patrón de parseo de flags existente. Resuelven sobre el default de config.
- **Clave de config**: `yolo` entra en el conjunto de claves top-level del comando `sander config` con parseo booleano: `sander config set yolo true|false` guarda un booleano (no un string). `get`/`list`/`unset` funcionan igual que provider/harness.
- **Receta por harness (mapa genérico)**: nuevo módulo que define, por harness, el directorio de config dentro del box y los dos transforms:
  - `opencode` → `opencode.json` en el volumen (`OPENCODE_CONFIG_DIR`). yolo: convertir cada `"ask"` en `"allow"` preservando `"deny"`. no-yolo: asegurar catch-all `"*": "ask"` preservando `"deny"`.
  - `claude` → `settings.json` en `~/.claude`. yolo: `permissions.defaultMode: "bypassPermissions"`. no-yolo: `permissions.defaultMode: "default"`.
  - `codex` → `config.toml` en `~/.codex`. yolo: `approval_policy = "never"`. no-yolo: `approval_policy = "on-request"`.
- **Transform = función pura**: cada receta expone `applyYolo(config)` y `applyNoYolo(config)` que operan sobre el contenido parseado del archivo de config y devuelven el contenido transformado. El merge con la config existente es aditivo: se lee el archivo actual del box (si existe), se transforma, se escribe de vuelta. Los `deny`/denials nunca se tocan.
- **Formato de archivo**: los transforms se aplican a `opencode.json`/`settings.json` (JSON). Si el archivo del box es JSONC con comentarios, el yolo se omite con aviso (no se arriesga corromper el archivo). codex es TOML: el transform manipula o añade la línea `approval_policy`.
- **Aplicación en create**: tras el sync de config al box, si el harness tiene receta, sander lee la config real del box, aplica el transform del modo resuelto y escribe el resultado en el directorio correcto. Si no hay receta, aviso y se continúa.
- **Solo al crear**: la inyección ocurre una vez en `create`. No hay re-afirmación en `attach`/`start`/`stop`. Limitación documentada: lanzar el agente por fuera (`agentbox opencode/claude start`) re-sincroniza host→volumen y puede quitar el yolo.
- **Registry**: nuevo campo opcional `yolo?: boolean` por box, con el modo resuelto. `list` muestra una columna; `attach` informa el modo. Compatible con el versionado actual del registry (campo opcional).
- **Corrección de `syncHarnessConfig`**: copia la config del host al directorio real que el harness lee dentro del box (volumen de opencode, `~/.claude`, `~/.codex`), no a `~/.config/<harness>`. Este conocimiento (dónde lee cada harness) vive en el mismo módulo de recetas, compartido por sync e inyección de yolo.
- **`sander run` box-side**: `runRun` ejecuta el harness headless dentro del box vía el seam de `provider.exec`, construyendo el argv con el nombre del harness y `headlessCommand(prompt)` (p. ej. `opencode run <prompt>`). El entorno inyectado al crear (`envKeys`) sigue siendo el transporte de credenciales; no se resuelve ni inyecta token nuevo en el host en el run. El `runRun` host-side actual se reemplaza.
- **Sin pregunta en el wizard**: `yolo` tiene default, nunca es una clave faltante, por lo que el wizard no la pregunta.

## Testing Decisions

- **Qué hace un buen test**: verifica comportamiento externo observable — códigos de salida, mensajes en stdout/stderr, contenido resultante de `config.json`/`registry.json`, y las ops que sander le pide al provider (especialmente `exec` y `copy`). Nunca los internals de los transforms ni del render de `list`.
- **Seam primario — CLI layer** (el existente): tests de `create`, `config`, `list`, `run` y `attach` usando `runCli` con los fakes existentes (`FakeProvider` que registra ops, `FakeHarnessFactory`, `FakeWorktree`, `CaptureStream`, config en dir temporal). Cubren: parseo y precedencia de `--yolo`/`--no-yolo` (flag > workspace > global > default `true`); `sander config set yolo true|false` guardando booleano y su `get/list/unset`; que la inyección de la receta aparece como op `exec`/`copy` de `FakeProvider` sobre el directorio correcto del harness; que el modo resuelto queda en `registry.json` y se muestra en `list`; que `attach` informa el modo; que un harness sin receta avisa y no inyecta; que `run` genera una op `exec` con `['<harness>', ...headlessCommand(prompt)]` (y no ejecuta en host); que `syncHarnessConfig` copia a los directorios reales del box (destinos de las ops `copy`).
- **Seam secundario — transforms puros**: el módulo de recetas se prueba unitario con funciones puras: dado un `opencode.json` con `ask` y `deny`, `applyYolo` convierte solo los `ask` y preserva los `deny`; `applyNoYolo` añade el catch-all `"*": "ask"`; los payloads de claude y codex producen el contenido esperado; archivo ausente → se crea; JSONC → omisión con aviso.
- **Prior art**: `create.test.ts` (fakes + `runCli` + asserts sobre ops del provider y registry), `config.test.ts` (wizard y claves de config), `run.test.ts` y `list.test.ts` (asserts de ops y columnas), y `provider/fake.ts` como registro de ops.

## Out of Scope

- **Modificar la config del harness en el host**: nunca se escribe en `~/.config/opencode`, `~/.claude`, `~/.codex` ni equivalentes del host.
- **Cambios en agentbox**: no se toca el paquete npm; el conflicto de claude con la flag `--dangerously-skip-permissions` de agentbox (cuando él lanza el agente) se documenta como limitación, no se resuelve aquí.
- **Flags de yolo en `sander run`**: run hereda el modo del box; no gana `--yolo`/`--no-yolo` propios.
- **Adapter headless/interactive de codex**: la receta de config aplica, pero `sander run`/`attach` de codex siguen sin adaptador (ya está fuera de alcance de specs previos).
- **Re-afirmación del yolo en el ciclo de vida** (`attach`/`start`): solo se inyecta al crear.
- **Wizard**: no se añade pregunta de yolo.
- **JSONC**: no se transforman archivos JSONC (se omite con aviso).
- **Soporte de más harnesses**: solo opencode, claude y codex en v0; el mapa permite añadir más.

## Further Notes

- El criterio de aceptación transversal: en un box yolo, el agente no pregunta salvo que la acción esté explícitamente denegada; en un box no-yolo, pregunta. Y la config del harness del host queda intacta en todos los casos.
- opencode es permissivo por defecto sin config: la receta yolo solo es relevante cuando la config del host (sincronizada al box) trae restricciones `ask`; en ese caso las convierte en `allow`.
- El conocimiento de "dónde lee cada harness su config dentro del box" vive en un único módulo compartido por `syncHarnessConfig` y la inyección de yolo, para que no vuelvan a divergir.
- Este spec continúa la línea de `sander-config` y `sander-providers` (config en capas con precedencia, wizard propio, seam CLI con fakes).
- Idioma de la conversación y de los mensajes de la CLI: español.
