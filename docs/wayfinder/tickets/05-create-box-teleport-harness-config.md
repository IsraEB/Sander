---
title: "`sander create`: box, teleport y config de harness"
type: wayfinder:task
status: open
assignee: sesión de implementación (ticket 05)
blocked-by:
- "Esqueleto del CLI, registry y `sander list`"
blocks:
- "`sander create`: token y entorno"
- "`sander run`: ejecución headless"
- "`sander attach`: sesión interactiva PTY"
- "`sander exec`: comando único"
- "Ciclo de vida: `sander stop` / `start` / `rm`"
- "`sander logs`"
---

## What to build

- `sander create --harness X --provider agentbox --name <id>` crea un sandbox aislado con el proyecto actual dentro y la config del harness elegido ya instalada.
- El proyecto se teleporta dentro del box respetando `.gitignore`, con las dependencias pesadas presentes y persistentes entre paradas y arranques.
- La config global del harness elegido se sincroniza dentro del box (vía SyncAgents) sin ensuciar el repo.
- El sandbox queda registrado en el registry con su estado.
- Adaptador real del seam `provider` sobre el CLI de agentbox (todo acceso a docker/agentbox pasa por el seam; no se usa SDK), con su test de humo contra agentbox real: crear un box, teleport y exec básico.

## Acceptance criteria

- [ ] `sander create --harness opencode` crea un box con el proyecto dentro y la config de opencode instalada.
- [ ] El teleport respeta `.gitignore` y deja las dependencias presentes en el box.
- [ ] La config del harness se sincroniza dentro del box sin ensuciar el repo.
- [ ] El sandbox aparece en `sander list` con su estado.
- [ ] El test de humo contra agentbox real corre verde.

## Blocked by

- Esqueleto del CLI, registry y `sander list`
