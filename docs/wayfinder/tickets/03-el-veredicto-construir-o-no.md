---
title: El veredicto: construir o no
type: wayfinder:grilling
status: closed
assignee: sesión wayfinder actual
blocked-by: La forma de sander
blocks:
---

## Resolution

**Sí, construir `sander`** con la forma v0 definida en **La forma de sander**. El barrido mostró que nada cubre el flujo end-to-end y que agentbox — lo más cercano — deja fuera justo lo que Sander añade (run headless, token, `.env.sander`, ciclo de vida con seams). El valor personal (sandbox con config del proyecto, control docker-like, arranque guiado por agente) queda cubierto por la forma v0 a un coste razonable: envuelve agentbox en vez de reinventar el sandbox. Destino alcanzado: la decisión con su forma está lista para una sesión de implementación.

## Question

Con **El barrido de alternativas** y **La forma de sander** sobre la mesa, ¿construimos `sander` o no? ¿Y con qué forma/MVP?

Criterios acordados:

- El listón alto del barrido (end-to-end pluggeable) vs el listón de conformidad (docker + opencode + claude code).
- Valor personal: sandbox con la config del proyecto ya instalada, rama por sandbox atada a tickets/specs, control docker-like (attach/exec), config guiada por otro agente.
- Coste de la forma definida en el ticket anterior.

Esto cierra el mapa: la respuesta es el destino.
