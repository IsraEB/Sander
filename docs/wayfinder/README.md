# Wayfinder — tracker local

Mapa y tickets viven como markdown local dentro de este proyecto (sin issue tracker externo por ahora).

## Estructura

```
docs/wayfinder/
├── README.md            ← este archivo, convenciones del tracker
├── map.md               ← el mapa (label `wayfinder:map`)
├── research/            ← hallazgos de tickets de investigación
│   └── <slug>.md
└── tickets/
    └── <NN>-<slug>.md   ← un ticket por archivo
```

## Convenciones

Cada ticket es un archivo con frontmatter YAML:

```yaml
---
title: <nombre legible — se usa para referirse al ticket, nunca el id>
type: wayfinder:<research|prototype|grilling|task>
status: open|closed
assignee: <quién lo trabaja; vacío = sin reclamar>
blocked-by: <nombres de tickets que lo bloquean>
blocks: <nombres de tickets a los que bloquea>
---
```

- **Claim**: asignar `assignee` a la sesión que lo trabaja, *antes* de trabajar.
- **Frontier**: tickets `open`, sin assignee, y cuyos `blocked-by` estén todos `closed`.
- **Bloqueo**: por nombre (los archivos no tienen ids estables), primero crear los tickets, después cablear `blocked-by`/`blocks`.
- **Resolución**: al cerrar, añadir sección `## Resolution` al ticket (la respuesta), poner `status: closed`, y añadir una línea-gist en el mapa (Decisions so far) con el nombre del ticket como enlace.
- **Out of scope**: si un ticket resulta estar más allá del destino, cerrarlo y dejar una línea en la sección Out of scope del mapa.
- **Research**: los hallazgos se escriben en `research/<slug>.md` y se enlazan desde el ticket.

En toda narración al humano se usan los **nombres** de los tickets, nunca ids ni slugs.
