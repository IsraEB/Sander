---
title: "`sander attach`: sesión interactiva PTY"
type: wayfinder:task
status: open
assignee:
blocked-by:
- "`sander create`: box, teleport y config de harness"
blocks:
---

## What to build

- `sander attach <id>` abre una sesión interactiva dentro del sandbox para lanzar y seguir al agente a mano.
- La sesión es una pseudo-TTY real (pass-through), de modo que las TUIs del harness (opencode/claude code) y de agentbox funcionen dentro sin que Sander dibuje una TUI propia.
- Lanzamiento interactivo del harness (modo interactivo del seam `harness`).
- Funciona con el id posicional o con `--sandbox`.

## Acceptance criteria

- [ ] `sander attach <id>` entra en el box y permite lanzar y seguir al agente a mano.
- [ ] La sesión es una PTY real: las TUIs internas se dibujan y responden correctamente.

## Blocked by

- `sander create`: box, teleport y config de harness
