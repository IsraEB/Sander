---
title: El barrido de alternativas
type: wayfinder:research
status: closed
assignee: sesión de charting
blocked-by:
blocks: La forma de sander
---

## Resolution

No existe herramienta que cumpla el listón alto (end-to-end pluggeable: harness elegido + sandbox + prompt headless + attach/exec + rama-issue + token). El listón de conformidad (docker + opencode + claude code) tampoco lo cumple nadie directamente, pero **agentbox** es el más cercano: docker local, opencode/claude/codex, sync automático de config global del harness y attach/shell estilo docker; le faltan el prompt headless dedicado y la orquestación issue→rama→token. El "camino sin sander" sería agentbox (o devcontainer CLI/devpod) + `gh issue develop` + `opencode run` / `claude -p`. Hallazgos completos con checklist por candidato en `docs/wayfinder/research/alternativas.md`.

## Question

¿Existe ya una herramienta que cubra el flujo que describe `sander`, total o parcialmente?

Criterios de barrido (dos niveles):

- **Listón alto** — cubre el flujo end-to-end: crear un sandbox con un harness elegido, ejecutar un prompt dentro, y attach/exec estilo docker — con provider y harness pluggeables.
- **Listón de conformidad** — usa docker como sandbox y soporta opencode y claude code como harness → podría bastar.

Checklist por candidato:

1. Clona el repo actual con sus dependencias pesadas (node_modules) ya presentes.
2. Instala la config global del harness en el sandbox (vía SyncAgents u otro mecanismo) sin ensuciar el repo.
3. Rama git por sandbox atada a un ticket/issue.
4. Ejecuta un prompt de forma headless.
5. Attach/exec interactivo estilo docker.
6. Usa un token de GitHub para issues.

Resultado esperado: si algo cubre el listón alto → el veredicto tiende a "no construir, adaptar/usar". Si nada lo cubre → construimos.

Hallazgos: `docs/wayfinder/research/alternativas.md`.
