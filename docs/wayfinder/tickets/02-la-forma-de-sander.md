---
title: La forma de sander
type: wayfinder:grilling
status: closed
assignee: sesión wayfinder actual
blocked-by: El barrido de alternativas
blocks: El veredicto: construir o no
---

## Resolution

Forma v0 acordada por grilling con el humano:

- **Arquitectura**: híbrida — Sander delega en **agentbox** lo que ya hace bien (crear el box, teleport del repo gitignore-aware con deps persistentes en volumen upper, sync de config global del harness, attach/shell/cp); Sander implementa lo que le falta: `run` headless, inyección de token, env, y ciclo de vida.
- **Seams** (la modularidad pedida):
  - `provider`: interfaz estrecha (create/attach/exec/cp/stop/start...), **agentbox** única implementación en v0.
  - `harness`: launch interactivo + run headless + config-dir; adaptadores opencode y claude code en v0 (codex gratis vía agentbox).
  - `tracker`: **reducido** — Sander no lee issues ni crea PRs; solo inyecta un GitHub token y el agente crea su propia rama y empuja.
- **Superficie de comandos**: `create [--harness X] [--provider agentbox] [--name <id>]`, `run "<prompt>" <id>`, `attach <id>`, `exec <id> <cmd>` (sin `--`), `stop/start/rm <id>`, `list`, `logs`. Id posicional como forma corta (`--sandbox <id>` como alternativa). Sin `--issue` ni `--branch`.
- **Contenido del box**: teleport de agentbox; env inyectado como variables de entorno (no tocan disco) + `.env.sander` copiado como `.env` en la provisión.
- **Restart**: el servicio se reinicia **dentro** del box; el sandbox nunca se recrea (el trabajo del agente persiste).
- **Config**: JSON en `~/.config/sander/` (global); estructura idéntica a la futura workspace `.sander/` (que añade/reemplaza a la global). v0 implementa **solo global**; `config`/presets diferidos.
- **Token**, precedencia (corregida): flag del comando > config global > config workspace (futura) > `gh auth token` **con confirmación del usuario**.
- **Arranque "configurar con otro agente"**: el agente, en su configuración inicial dentro del box, genera el script de arranque **y elige el nombre de la rama**; guardarlo como preset queda para la versión con `config`.
- **TUI**: sin TUI propia en v0; `attach` es una PTY real (pass-through) para que las TUIs internas (harness/agentbox) funcionen.

## Question

Si construimos `sander`, ¿cuál es su forma v0?

Definir, en conversación con el humano (grilling):

- **Superficie de comandos**: `create` (con `--harness`, `--provider`, y opcionalmente `--issue`), `run "<prompt>" --sandbox <id>`, `attach` y `exec` estilo docker, `config` (presets reutilizables), y el flujo inverso "en base al issue X, corrígelo".
- **Modelo de contenido del sandbox**: clon exacto del repo actual (con node_modules pesados ya presentes), config del harness vía SyncAgents (copiar config-dir → `npx syncagents config` → `npx syncagents sync` en *global* del sandbox), GitHub token, y un script de arranque/reinicio generable por un agente.
- **Semántica attach/exec**: estilo docker (sesión interactiva / comando único), como primitivas que el provider implementa.
- **Abstracciones**: provider (docker primero, pluggeable), harness (opencode, claude code), tracker (GitHub primero, agnóstico).
- **Archivo de config**: formato y ubicación de presets.

Bloqueado por **El barrido de alternativas**: sus hallazgos deciden si la forma es greenfield o una envoltura delgada de algo existente.
