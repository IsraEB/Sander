---
title: "Ciclo de vida: `sander stop` / `start` / `rm`"
type: wayfinder:task
status: open
assignee:
blocked-by:
- "`sander create`: box, teleport y config de harness"
blocks:
---

## What to build

- `sander stop <id>`, `sander start <id>` y `sander rm <id>` para el ciclo de vida del sandbox sin perder su estado.
- `start` tras `stop` reanuda el mismo box con su estado: el sandbox nunca se recrea, el servicio se reinicia dentro del box y el trabajo del agente y las dependencias persisten.

## Acceptance criteria

- [ ] `stop`, `start` y `rm` funcionan sobre un sandbox y su estado se refleja en `sander list`.
- [ ] Reiniciar conserva el trabajo del agente: el sandbox nunca se recrea, solo se reinicia el servicio dentro del box.

## Blocked by

- `sander create`: box, teleport y config de harness
