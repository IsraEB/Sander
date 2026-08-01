---
label: wayfinder:map
---

# Mapa: sander — gestor de sandboxes para agentes de IA

> **Estado: mapa completo.** Los tres tickets están cerrados; el destino (decisión + forma v0) está alcanzado y listo para una sesión de implementación.

## Destination

Una **decisión**: ¿construir `sander`, un CLI para gestionar sandboxes de agentes de IA — crear un sandbox (harness elegido, provider elegido), ejecutar prompts dentro, y entrar/controlarlo al estilo docker (attach/exec) — agnóstico a provider/harness/tracker, o **no**? Y si sí, **con qué forma**. El destino no es la spec completa ni el código: es el sí/no con su forma, listo para una sesión de implementación si el veredicto es construir.

## Notes

- Idioma del humano: español.
- Tracker local: `docs/wayfinder/` — ver `README.md` para convenciones. Migrar a GitHub cuando el proyecto exista de verdad.
- Dominio: `sander` gestiona **sandboxes** (entornos aislados donde corre un **harness** = agente de IA: opencode, claude code, codex) sobre un **provider** (docker vía agentbox primero, agnóstico), e inyecta un **token GitHub** para que el agente haga push/use `gh` — sin leer issues ni crear PRs.
- Hechos locales ya verificados:
  - **SyncAgents** (`../SyncAgents`) unifica la config de harnesses (opencode, claude, codex). `syncagents sync --here` **ensucia el repo** — para el sandbox la provisión es: copiar el config-dir fuente → `npx syncagents config` → `npx syncagents sync` (instala en *global* del sandbox).
  - El **túnel temporal** lo levanta el asistente del humano (ngrok/cloudflared) al puerto local; no es pieza de `sander` (ver Out of scope).
- **Control estilo docker**: `attach` = sesión interactiva dentro del sandbox (ahí se lanza el harness; PTY real para las TUIs internas), `exec` = ejecutar un comando único.
- **Rama por sandbox**: el agente, en su configuración inicial dentro del box, crea la rama y elige su nombre; Sander solo inyecta el token. Sin flujo de issues.
- Habilidades a consultar por sesión: `/grilling`, `/domain-modeling`, `/research`, `/prototype`.

## Decisions so far

<!-- el índice — una línea por ticket cerrado -->

- [El barrido de alternativas](tickets/01-el-barrido-de-alternativas.md) — nadie cumple el listón alto ni el de conformidad; **agentbox** es el candidato más cercano (docker + opencode/claude/codex + config global sync + attach/shell), le faltan prompt headless e issue→rama→token. Sin sander, el camino sería agentbox (o devcontainer/devpod) + `gh issue develop` + `opencode run`/`claude -p`.
- [La forma de sander](tickets/02-la-forma-de-sander.md) — forma v0: **híbrida**, Sander envuelve agentbox (box/teleport/config-sync/attach) y añade lo que falta; tres seams (provider=agentbox, harness=opencode+claude code, tracker reducido a inyectar token + el agente crea su rama); superficie create/run/attach/exec/stop/start/rm/list/logs con id posicional; env inyectado + `.env.sander`→`.env`; restart dentro del box sin recrearlo; config JSON global en `~/.config/sander/` (workspace futura, misma estructura); token: flag > global > workspace > `gh auth token` con confirmación; arranque configurado por el agente (script + nombre de rama); sin TUI propia, attach = PTY.
- [El veredicto: construir o no](tickets/03-el-veredicto-construir-o-no.md) — **sí, construir `sander`** con la forma v0. Destino alcanzado: decisión + forma listas para una sesión de implementación.
- [Esqueleto del CLI, registry y sander list](tickets/04-esqueleto-cli-registry-list.md) — base implementada: esqueleto Go del CLI (9 subcomandos v0 registrados, ayuda en español, `sander list` funcional), registry JSON en `~/.config/sander/`, seams `provider`/`harness` con fakes, regla de id posicional/`--sandbox`, y tests black-box verdes.

## Not yet specified

- **Providers** más allá de docker/agentbox (cuáles, cómo se eligen). El seam existe; agentbox es la única implementación en v0.

<!-- "Invocación headless del harness" salió de la niebla: resuelto por el barrido (opencode run / claude -p, config vía OPENCODE_CONFIG_DIR / CLAUDE_CONFIG_DIR) — pasó a hecho para La forma de sander. -->

## Out of scope

- **Integración del túnel temporal dentro de `sander`** — el asistente del humano levanta el túnel al puerto local. Puerta abierta a un esfuerzo futuro; la forma de `sander` debe exponer el puerto local.
- **Copiar la config completa de los harnesses del host al sandbox** — rompe la agnosticidad al harness; la provisión de config es vía SyncAgents.
