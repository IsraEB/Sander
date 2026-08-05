# 01 — Seam `Provider.pull` (box→host) + `--yes` no-interactivo en transferencias

**What to build:** Prefactor sin cambio de comportamiento visible en la CLI. El seam bidireccional de transferencia queda completo: el `Provider` gana `pull(id, source, destination)`, el inverso de `copy` en sentido box→host, implementado sobre `agentbox cp` con el source en la forma `<box>:<ruta>` y el destino como ruta completa del host. Todas las invocaciones de `agentbox cp` que haga la ruta de sync deben ser no-interactivas, así que `pull` incluye `--yes` y `copy` gana un flag aditivo y retrocompatible para pasarlo también. Antes de fijar el formato de argv conviene verificar la semántica exacta de `agentbox cp` con un único source y el tope `box.cpMaxBytes` (100 MB) en sentido box→host (`agentbox cp --help`); el tope se maneja desde sander con un error claro. `FakeProvider` registra las ops `pull` y el flag `yes` de `copy` para poder testear la capa CLI después.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `Provider` expone `pull(id, source, destination)`; `AgentboxProvider.pull` invoca `agentbox cp` con source `<box>:<ruta>` y `--yes`, destino = ruta completa (formato verificado contra `agentbox cp --help`; el tope `cpMaxBytes`/100 MB produce un error claro, no un prompt ni una transferencia silenciosa).
- [ ] `AgentboxProvider.copy` acepta un flag aditivo opcional para pasar `--yes` y lo incluye en el argv cuando se pide; sin el flag, el argv actual de `copy` no cambia (retrocompatible).
- [ ] `FakeProvider.pull` registra `{ op: 'pull', id, source, destination }` y respeta `nextError`/`copyError`; `FakeProvider.copy` registra el flag `yes` cuando se pasa.
- [ ] Test de argv (estilo `agentbox.test.ts`): `pull` produce `['cp', '--yes', '<box>:<src>', '<dst>']` (u orden exacto según `--help`) y `copy` con el flag añade `--yes`.
- [ ] Test de fake: `pull` aparece en `ops` y el flag `yes` de `copy` queda registrado para poder aseverarlo desde los tests de comandos.
