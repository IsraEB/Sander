# 02 — Módulo puro `planSync` (plan por path, sin I/O)

**What to build:** El núcleo de decisión de la sync como módulo puro, sin I/O ni dependencias de box/provider (estilo de las funciones puras de `teleport.ts`). `planSync` recibe los manifests de ambos lados derivados de `git status --porcelain -uall` — un map `relPath → status` por lado, donde `M` y `??` (untracked) se tratan igual, ausente = limpio — más el hash de contenido de cada path presente (sucio) en ambos lados, que calcula la capa que sí hace I/O. Devuelve un plan ordenado de ops por path: copiar host→box, pull box→host, borrar en box, borrar en host, o conflicto. Las reglas: un path sucio en un solo lado → se transfiere ese lado al otro; sucio en ambos con hash idéntico → no-op; sucio en ambos con hash distinto → conflicto (backup de la versión local como `.sander/<rel>.sander-<lado>` y aplicar el otro lado); `D` en un lado y limpio en el otro → propagar el borrado; `D` vs modificado → conflicto. Los borrados de archivos untracked no se detectan en v1 (limitación conocida y documentada).

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Path solo en host (M o `??`) → op copiar host→box; path solo en box → op pull box→host.
- [ ] Path sucio en ambos lados con hash idéntico → no-op; con hash distinto → op conflicto que preserva la versión local como backup `.sander/<rel>.sander-<lado>` y aplica el otro lado.
- [ ] `D` en un lado y limpio en el otro → op borrar en el otro lado; `D` en ambos → no-op; `D` en un lado y M/`??` en el otro → op conflicto.
- [ ] Los paths untracked se planifican igual que los modificados; no hay op de borrado para untracked (limitación v1 documentada en la ayuda).
- [ ] Las funciones son puras: mismo input → mismo plan, sin I/O (probado unitariamente con manifests sintéticos que cubren solo-host, solo-box, ambos-iguales, ambos-distintos, `D` vs limpio, `D` vs modificado y untracked).
- [ ] El plan se expone de forma que la capa de ejecución pueda aplicarlo con `copy`/`pull`/`rm` y backups, e imprimir un resumen (copiados box→host, host→box, conflictos).
