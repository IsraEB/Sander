---
title: "`sander exec`: comando único"
type: wayfinder:task
status: open
assignee:
blocked-by:
- "`sander create`: box, teleport y config de harness"
blocks:
---

## What to build

- `sander exec <id> <comando>` ejecuta un comando único dentro del sandbox, estilo `docker exec`, sin necesidad de separador `--`.
- Funciona con el id posicional o con `--sandbox`.

## Acceptance criteria

- [ ] `sander exec <id> <comando>` corre el comando dentro del box y devuelve su salida.
- [ ] No hace falta `--` entre el id y el comando.

## Blocked by

- `sander create`: box, teleport y config de harness
