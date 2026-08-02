---
title: "`sander rm` borra la rama git por defecto"
type: wayfinder:task
status: open
assignee:
blocked-by:
blocks:
---

## Why

Es muy complicado borrar ramas desde el host ("es muy complicado borrar ramas desde el host"), así que `sander rm` debe borrar SIEMPRE la rama git del sandbox por defecto. La rama solo se conserva con las nuevas flags de opt-out `--dont-delete-branch` y su sinónimo `--no-delete-branch`.

## What to build

- Cambiar `runRm` para que borre la rama git por defecto (después de eliminar el worktree), salvo con `--dont-delete-branch` / `--no-delete-branch`.
- Mantener `--delete-branch` como no-op deprecado por compatibilidad con invocaciones existentes.
- Actualizar la ayuda en español de `rm` (compartida por destroy/delete/remove).
- Añadir un comentario en el código con la razón verbatim.
- Invertir y ampliar los tests de `src/cli/commands/lifecycle.test.ts`.

## Acceptance criteria

- [ ] `sander rm <id>` elimina el worktree y la rama git por defecto, en ese orden.
- [ ] `sander rm --dont-delete-branch <id>` y `sander rm --no-delete-branch <id>` conservan la rama.
- [ ] `--delete-branch` sigue aceptándose (no-op deprecado) sin romper scripts.
- [ ] La ayuda de `rm`/`destroy`/`delete`/`remove` documenta el nuevo comportamiento.
- [ ] Tests verdes (`npm test`) y `npm run typecheck` sin errores.

## Blocked by

(none)
