---
title: "`sander create`: token y entorno"
type: wayfinder:task
status: open
assignee:
blocked-by:
- "`sander create`: box, teleport y config de harness"
blocks:
- "`sander run`: ejecución headless"
---

## What to build

- Resolución del GitHub token con la precedencia acordada: flag del comando > config global > config workspace (futura) > `gh auth token` con confirmación del usuario.
- Inyección del token en el box para que el agente pueda hacer push de su rama y usar `gh`.
- Inyección de las variables de entorno en el box sin que toquen el disco (los secretos viven solo en el proceso).
- Si existe `.env.sander` en el proyecto, copiarlo como `.env` dentro del box para los casos donde el harness o el servicio exigen leer el archivo.
- Sobreescritura del token por flag del comando para usar una credencial distinta en un sandbox concreto.

## Acceptance criteria

- [ ] El token se resuelve con la precedencia acordada; los tests verifican cuál fuente gana.
- [ ] El fallback a `gh auth token` pide confirmación antes de usar el token.
- [ ] El provider recibe las variables de entorno correctas y estas no tocan el disco.
- [ ] `.env.sander` se copia como `.env` dentro del box.
- [ ] El flag del comando sobreescribe el token proveniente de otras fuentes.

## Blocked by

- `sander create`: box, teleport y config de harness
