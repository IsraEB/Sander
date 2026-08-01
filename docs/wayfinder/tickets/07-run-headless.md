---
title: "`sander run`: ejecución headless"
type: wayfinder:task
status: open
assignee:
blocked-by:
- "`sander create`: box, teleport y config de harness"
- "`sander create`: token y entorno"
blocks:
---

## What to build

- `sander run <id> "prompt"` ejecuta el prompt de forma headless dentro del sandbox, con el harness configurado en ese box.
- Modo headless del seam `harness`: adaptadores para opencode (`opencode run`, config vía `OPENCODE_CONFIG_DIR`) y claude code (`claude -p`, config vía `CLAUDE_CONFIG_DIR`).
- Funciona con el id posicional o con `--sandbox`.
- El agente corre con el token y las variables de entorno inyectados, de modo que pueda empujar su rama a GitHub sin más fricción.

## Acceptance criteria

- [ ] `sander run <id> "prompt"` dispara el harness headless dentro del box y reporta el resultado.
- [ ] El harness fake recibe la invocación correcta; los adaptadores opencode y claude code invocan el comando adecuado con su config-dir.
- [ ] El agente corre con el token y el entorno inyectados (puede hacer push de su rama).

## Blocked by

- `sander create`: box, teleport y config de harness
- `sander create`: token y entorno
