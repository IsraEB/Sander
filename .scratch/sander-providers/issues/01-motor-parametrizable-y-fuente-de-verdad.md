# 01 — Motor agentbox parametrizable + fuente de verdad única + factory de providers

**What to build:** Prefactor sin cambio de comportamiento visible. Introduce la maquinaria que habilita el resto: una única fuente de verdad con los 5 providers soportados (`docker`, `daytona`, `hetzner`, `vercel`, `e2b`), la marca de los que "requieren setup" (los cloud), el alias legacy `agentbox` → `docker` y el default `docker`. El motor agentbox deja de fijar docker en código: recibe el nombre del provider y lo pasa como `--provider <nombre>` a agentbox tanto en `create` como en `prepare`. Un factory `createProvider(nombre)` resuelve el motor a partir del nombre (en v0 todos los providers resuelven al motor agentbox; el alias legacy `agentbox` resuelve a docker). `create` construye su motor vía ese factory con el provider ya resuelto, y el objeto de deps del CLI expone el factory como seam inyectable para los tests. Se mantiene intacto el comportamiento actual: `agentbox` sigue siendo un valor válido en config y en el registry (se aliasa a docker internamente), de modo que ningún usuario existente se rompe.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] El argv que sander pasa a agentbox en `create` incluye `--provider <nombre>` con el provider resuelto (hoy no lo incluía); el argv de `prepare`/imagen base usa `--provider <nombre>` en vez del docker fijo.
- [ ] `createProvider('agentbox')` produce el motor docker y `createProvider('vercel')` produce el motor agentbox con `--provider vercel`; los 5 nombres son aceptados.
- [ ] `sander config set provider agentbox` sigue funcionando y persistiendo `agentbox` (sin cambio de comportamiento en este ticket).
- [ ] `sander create` con config `provider: agentbox` crea la box igual que hoy y el registry la guarda como `agentbox`.
- [ ] La lista de providers soportados vive en un único módulo compartido por config, create y wizard; desaparecen las listas duplicadas.
- [ ] El factory es inyectable en el seam de deps del CLI (los tests pueden sustituirlo por el fake existente).
