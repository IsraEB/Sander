# 03 — Resolución del motor por box + compatibilidad legacy del registry

**What to build:** Los comandos que operan sobre sandboxes ya creadas (`attach`, `exec`, `run`, `stop`, `start`, `rm`, `logs`, `list`) resuelven el motor desde el provider grabado en el registry (`registry.boxes[id].provider`) vía el factory, en vez de usar un único provider singleton: así cada box usa el motor correcto y el modelo deja de asumir un solo proveedor. Los boxes existentes grabados como `agentbox` se interpretan como `docker`: `sander list` muestra `docker` en la columna PROVIDER y `attach`/`exec`/`run`/`stop`/`start`/`rm`/`logs` siguen funcionando sobre ellos sin perder el trabajo ya creado. La sección que tolera el valor legacy `agentbox` lleva un comentario de retrocompatibilidad que indica que se elimine cuando no quede ningún box con ese valor, y que un agente que la encuentre y no haya boxes `agentbox` debe eliminar el alias. El hint que `attach` imprime al usuario se reformula para no mencionar "agentbox".

**Blocked by:** 01 — Motor agentbox parametrizable + fuente de verdad única + factory de providers

**Status:** ready-for-agent

- [ ] Con un box legacy `provider: agentbox` en el registry, `sander list` muestra `docker` en la columna PROVIDER.
- [ ] `attach`, `exec`, `run`, `stop`, `start`, `rm` y `logs` funcionan sobre un box legacy `agentbox` (resuelven el motor docker).
- [ ] Los boxes con providers reales (`docker`, `vercel`, …) se resuelven por su nombre y operan correctamente.
- [ ] Ningún comando usa ya el provider singleton; todos resuelven el motor desde el registry vía factory.
- [ ] El código de compatibilidad legacy lleva el comentario de retrocompatibilidad acordado (eliminar cuando no queden boxes `agentbox`; si un agente la encuentra sin boxes `agentbox`, lo elimina).
- [ ] `attach` no muestra "agentbox" al usuario en sus mensajes.
