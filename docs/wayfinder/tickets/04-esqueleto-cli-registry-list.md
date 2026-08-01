---
title: "Esqueleto del CLI, registry y `sander list`"
type: wayfinder:task
status: closed
assignee: sesión de implementación (ticket 04)
blocked-by:
blocks:
- "`sander create`: box, teleport y config de harness"
- "`sander create`: token y entorno"
- "`sander run`: ejecución headless"
- "`sander attach`: sesión interactiva PTY"
- "`sander exec`: comando único"
- "Ciclo de vida: `sander stop` / `start` / `rm`"
- "`sander logs`"
---

## What to build

- Binario `sander` con los subcomandos v0 registrados (`create`, `run`, `attach`, `exec`, `stop`, `start`, `rm`, `list`, `logs`) y ayuda en español.
- Config global en `~/.config/sander/` con el registry de sandboxes (id, provider, harness, estado, timestamps), con una estructura lista para el overlay de la futura capa workspace.
- `sander list` muestra los sandboxes existentes con su estado, incluso con un registry vacío.
- Seams `provider` y `harness` declarados: el provider como interfaz estrecha de operaciones estilo docker (`create`, `attach`, `exec`, `cp`, `stop`, `start`, `remove` más las consultas para `list`/`logs`); el harness con sus modos interactivo/headless y su config-dir. Con fakes para pruebas.
- Regla compartida de id posicional con `--sandbox` como alternativa, válida para todos los comandos que usan id.
- Infraestructura de tests black-box sobre la superficie de la CLI (seam principal de pruebas), con fakes detrás de los seams.

## Acceptance criteria

- [ ] `sander list` funciona y refleja el registry, incluso cuando está vacío.
- [ ] El registry persiste en `~/.config/sander/` y sigue visible al cambiar de directorio.
- [ ] Los seams `provider` y `harness` están declarados y sus fakes son usables por los demás comandos.
- [ ] Todos los comandos con id aceptan la forma posicional y `--sandbox`.
- [ ] Los tests black-box de la CLI corren verdes.

## Blocked by

None — can start immediately.

## Resolution

Cerrado por la sesión de implementación. Queda establecido el esqueleto Go del CLI que seguirán los tickets 05-11:

- **Stack y convenciones**: Go 1.26 (módulo `sander`), estructura `cmd/sander` + `internal/{cli,config,registry,provider,harness}`. Sin dependencias externas; parser de flags mínimo propio. Mensajes y errores de la CLI en español; identificadores y doc-comments breves en español. Códigos de salida: 0 éxito, 1 error. Tests por paquete + black-box sobre el punto de entrada `cli.Main` y sobre el binario real con `HOME` temporal.
- **Subcomandos v0 registrados** (create, run, attach, exec, stop, start, rm, list, logs) con ayuda en español; todos salvo `list` devuelven "no implementado" tras aplicar la regla de id.
- **Registry**: JSON en `~/.config/sander/registry.json` (versión 1) con id, provider, harness, status y timestamps; `config.Layer` preparada para el overlay de la futura capa workspace (`<repo>/.sander/`).
- **Seams**: `provider.Provider` (create/attach/exec/copy/stop/start/remove/list/logs) y `harness.Harness` (ConfigDir/Interactive/Headless + Factory), con fakes exportados para pruebas; el binario real aún no tiene adaptadores (tickets 05 y 07).
- **Regla de id**: posicional o `--sandbox <id>`, compartida por todos los comandos con id.
- **Tests verdes**: `go test ./...` y `go test -race ./...` (black-box de la CLI + binario real con HOME).
