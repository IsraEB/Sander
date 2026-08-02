---
title: Spec v0 — sander
label: ready-for-agent
---

## Problem Statement

Correr un agente de IA (harness) en un entorno aislado y reproducible para probar código sin ensuciar el repo ni la máquina es posible hoy, pero el flujo completo queda repartido entre herramientas que no se hablan: no existe una sola que cree el sandbox con la config del proyecto ya instalada, ejecute un prompt dentro, permita entrar/salir estilo docker, y deje que el agente empuje su trabajo a GitHub. Enlazar agentbox + `gh issue develop` + `opencode run`/`claude -p` a mano cubre los pedazos, pero el pegamento y la ergonomía no existen: no hay un solo comando, no hay un id que refiera a un sandbox, no hay inyección de token ni de `.env`, y no hay una forma de cambiar de provider/harness sin re-aprender todo.

## Solution

`sander` es un CLI que gestiona sandboxes de agentes de IA: crea un sandbox (box vía agentbox con el proyecto teleportado y su config del harness sincronizada), ejecuta prompts dentro de forma headless, y permite entrar y controlarlo al estilo docker (attach/exec). Al crear, ejecuta un agente de arranque (el propio harness en headless) que genera `.sander/install.sh` y `.sander/start.sh`, y un supervisor propiedad de Sander arranca y reinicia el servicio del proyecto; si el arranque falla, `create` revierte sin dejar box. Inyecta el GitHub token y las variables de entorno en el sandbox para que el agente empuje su rama —creada por Sander con el id del sandbox— sin más fricción. Está construido sobre seams estrechos (provider, harness) para que cambiar o mejorar Sander no toque el resto.

## User Stories

1. Como usuario, quiero ejecutar `sander create --harness opencode --name mi-sandbox`, para que Sander cree un sandbox aislado con el proyecto actual dentro y la config de opencode ya instalada.
2. Como usuario, quiero que `create` elija el harness por flag, para poder lanzar opencode, claude code o codex sin cambiar de herramienta.
3. Como usuario, quiero que `create` elija el provider por flag, para poder cambiar el proveedor de sandbox cuando haga falta.
4. Como usuario, quiero que `create` copie mi proyecto dentro del sandbox respetando `.gitignore`, para que el entorno refleje mi working dir sin arrastrar basura.
5. Como usuario, quiero que las dependencias pesadas (node_modules) estén presentes en el sandbox, para no esperar una instalación desde cero cada vez.
6. Como usuario, quiero que las dependencias y los archivos persistan entre paradas y arranques del sandbox, para no perder el trabajo del agente.
7. Como usuario, quiero que la config global de mi harness se sincronice dentro del sandbox sin ensuciar el repo, para que el agente funcione con mis settings y skills.
8. Como usuario, quiero que `create` inyecte el GitHub token en el sandbox, para que el agente pueda hacer push de su rama y usar `gh`.
9. Como usuario, quiero que el token se resuelva con la precedencia flag del comando > config global > config workspace > `gh auth token` (con confirmación), para usar la fuente correcta sin exponer credenciales por error.
10. Como usuario, quiero poder sobreescribir el token en el comando, para usar una credencial distinta en un sandbox concreto.
11. Como usuario, quiero que Sander pida confirmación antes de usar `gh auth token` como fallback, para no usar un token sin mi consentimiento.
12. Como usuario, quiero que `create` inyecte mis variables de entorno en el sandbox sin que toquen el disco, para que los secretos vivan solo en el proceso.
13. Como usuario, quiero que un archivo `.env.sander` de mi proyecto se copie como `.env` dentro del sandbox, para los casos donde el harness o el servicio exigen leer `.env` como archivo.
14. Como usuario, quiero ejecutar `sander run <id> "prompt"` para que el harness del sandbox ejecute el prompt de forma headless, para disparar trabajo sin abrir una sesión interactiva.
15. Como usuario, quiero ejecutar `sander attach <id>` para entrar en una sesión interactiva dentro del sandbox, para lanzar y seguir al agente a mano.
16. Como usuario, quiero que `attach` sea una pseudo-TTY real (pass-through), para que las TUIs del harness (opencode/claude code) y de agentbox funcionen dentro.
17. Como usuario, quiero ejecutar `sander exec <id> <comando>` sin separador `--`, para correr un comando único dentro del sandbox estilo `docker exec`.
18. Como usuario, quiero referirme al sandbox por su id posicional en los comandos (`sander run <id>`, `sander attach <id>`), para no escribir flags verbosos.
19. Como usuario, quiero poder usar `--sandbox <id>` como alternativa al id posicional, para comandos donde la forma posicional no encaje.
20. Como usuario, quiero que `run`/`attach`/`exec` funcionen también si el id posicional va en otra posición (flag largo), para flexibilidad de sintaxis.
21. Como usuario, quiero `sander stop <id>`, `sander start <id>` y `sander rm <id>`, para el ciclo de vida del sandbox sin perder su estado.
22. Como usuario, quiero que reiniciar el sandbox conserve el trabajo del agente, para que el servicio se reinicie dentro del box y el sandbox nunca se recree.
23. Como usuario, quiero `sander list`, para ver los sandboxes existentes del proyecto con su estado.
24. Como usuario, quiero `sander logs <id>`, para ver la salida de un sandbox sin entrar en él.
25. Como usuario, quiero que `sander create` ejecute, cuando falten `.sander/install.sh` y `.sander/start.sh` en el worktree del box, un agente de arranque (el propio harness en modo headless, con un prompt interno fijo) que inspeccione el proyecto y genere ambos artefactos, para que el sandbox nazca aprovisionado y un fallo del arranque revierta `create` sin dejar box.
26. Como usuario, quiero que Sander guarde su estado (registry de sandboxes) en un archivo JSON en `~/.config/sander/`, para poder ver qué sandboxes existen aunque cambie de directorio.
27. Como usuario, quiero que la estructura de archivos de config global sirva de plantilla para la futura config workspace, para que el workspace añada/reemplace sin reescribir.
28. Como usuario, quiero que Sander funcione sin necesidad de GitHub issues ni PRs, para que el agente haga su flujo GitHub con el token inyectado sin orquestación de Sander.
29. Como usuario, quiero que Sander no dibuje una TUI propia, para mantener v0 simple y delegar la vista bonita a agentbox.
30. Como usuario, quiero que el provider y el harness sean seams intercambiables, para poder mejorar o cambiar Sander sin tocar el resto del código.

## Implementation Decisions

- **Arquitectura híbrida**: Sander delega en agentbox (provider) lo que ya hace bien — crear el box, teleport del proyecto (gitignore-aware), sync de config global del harness, attach/shell/cp, y persistencia de deps en el volumen upper. Sander implementa lo que falta: `run` headless, inyección de token, inyección de env, y el CLI de ciclo de vida.
- **Seam `provider`**: interfaz estrecha de operaciones estilo docker — `create`, `attach`, `exec`, `cp`, `stop`, `start`, `remove`, más las consultas para `list`/`logs`. Implementación única en v0: adaptador sobre el CLI de agentbox (los comandos `agentbox` se envuelven; no se usa SDK). Todo acceso a docker/agentbox pasa por este seam.
- **Seam `harness`**: sabe lanzar el harness de forma interactiva (para `attach`) y de forma headless (para `run`) dentro de un box dado, y conoce su config-dir. Adaptadores en v0: opencode (`opencode run`, `OPENCODE_CONFIG_DIR`) y claude code (`claude -p`, `CLAUDE_CONFIG_DIR`); codex queda soportado vía agentbox sin adaptador propio.
- **Seam `tracker` (reducido)**: no hay orquestación de issues ni PRs. Sander resuelve e inyecta el GitHub token en el sandbox y crea la rama del sandbox (rama-worktree nombrada con el id del sandbox); el agente empuja esa rama con el token inyectado. El token se resuelve con precedencia: flag del comando > config global > config workspace (futura) > `gh auth token` con confirmación del usuario.
- **Superficie de comandos v0**: `create [--harness X] [--provider agentbox] [--name <id>]`, `run "<prompt>" <id>`, `attach <id>`, `exec <id> <cmd>` (sin `--`), `stop <id>`, `start <id>`, `rm <id>`, `list`, `logs <id>`. El id del sandbox es posicional en los comandos que lo usan; `--sandbox <id>` existe como alternativa.
- **Contenido del sandbox**: proyecto teleportado por agentbox (deps presentes y persistentes). La provisión de Sander añade: variables de entorno inyectadas como env del box (sin tocar disco) y, si existe `.env.sander` en el proyecto, copiarlo como `.env` dentro del box.
- **Arranque configurado por el agente (bootstrap)**: si en el worktree del box faltan `.sander/install.sh` o `.sander/start.sh`, `create` ejecuta un agente de arranque — el propio harness en modo headless (el mismo camino de lanzamiento que `run`, config-dir ya sincronizado, cwd = worktree del box), con un prompt interno fijo, no del usuario — que genera el/los artefacto(s) faltante(s) conservando los existentes, y los commitea a la rama del sandbox (commit limpio con solo `.sander/`, con `git add` explícito aunque el proyecto los ignore). Ambos existen → no se ejecuta agente. `install.sh` es idempotente y consciente del entorno; `start.sh` es un proceso foreground de larga duración.
- **Supervisor (propiedad de Sander)**: script genérico de Sander desplegado dentro del box (nohup + pidfile) que ejecuta `start.sh` tras `install.sh` y en cada `start` (nunca re-ejecuta `install.sh`), observa el worktree y reinicia `start.sh` en cada cambio de archivos, y vuelca la salida a `.sander/start.log`. `stop` mata el servicio vía el supervisor/pidfile; `logs` lee `.sander/start.log` (no los logs del contenedor). Sin systemd/supervisord dentro del box.
- **Fallo → rollback**: si `install.sh` falla (exit != 0) o el agente de arranque no deja ambos artefactos (o no son ejecutables), `create` falla mostrando el error y hace rollback completo — se eliminan box, worktree y rama; no queda entrada en el registry.
- **Semántica de restart**: el servicio se reinicia dentro del box vivo; el sandbox nunca se recrea. `start` tras `stop` reanuda el mismo box con su estado.
- **Config**: JSON en `~/.config/sander/` (capa global). Estructura de archivos idéntica a la futura capa workspace (`<repo>/.sander/`), que añadirá/reemplazará a la global; v0 implementa solo la global pero con el formato y la estructura listos para el overlay. Presets y el comando `config` quedan diferidos.
- **TUI**: no hay TUI propia en v0; `attach` es una PTY real (pass-through) para que las TUIs internas (harness/agentbox) funcionen.

## Testing Decisions

- **Qué hace un buen test aquí**: verificar el comportamiento externo de la CLI (qué hace `sander create`, qué entrega `list`, cómo responde `exec`) y la orquestación pura (qué operación del provider se invoca y con qué argumentos, en qué orden), no la implementación interna de cada adaptador.
- **Seam principal de pruebas: la superficie CLI, black-box.** Se ejecuta el binario `sander ...` (o su punto de entrada) y se verifican salidas, errores y efectos observables. Es el seam más alto disponible y el único.
- **Fakes detrás de los seams**: los tests de comandos usan un **provider fake** (in-memory, registra las operaciones recibidas) y un **harness fake**, de modo que la orquestación se prueba sin docker ni agentbox reales. El contrato del provider y el del harness se validan por separado.
- **Un solo test de humo real** contra agentbox (crear un box de verdad, teleport y attach/exec básico) para validar el adaptador real del provider; el resto de la suite usa fakes.
- **El token se prueba en el seam CLI**: tests que inyectan token vía flag, vía config global, y el fallback con confirmación, verificando cuál gana con la precedencia acordada.
- **La inyección de env y `.env.sander` se prueba en el seam CLI**: que el provider fake recibe las variables correctas y que `.env.sander` se copia como `.env`.
- **Prior art**: no hay tests previos en el repo (no hay código aún); el estilo a seguir es el de un CLI test-driven: primer red de un comportamiento, luego verde, luego refactor.

## Out of Scope

- **Presets y comando `config`** (`sander config set/get`, `create --preset`, guardar el script de arranque como preset reutilizable). Diferido a una versión posterior.
- **TUI propia de Sander**; la vista interactiva queda en manos de agentbox y de las TUIs del harness.
- **Leer issues, crear PRs desde Sander, o el flujo inverso "en base al issue X"**. Sander crea solo la rama del sandbox (con el id del sandbox) dentro de `create`; los PRs y el flujo GitHub del agente (push/PR) se hacen con el token inyectado; Sander no orquesta.
- **Providers más allá de agentbox/docker** (devpod, remoto, etc.). El seam existe; no hay otras implementaciones en v0.
- **Integración del túnel temporal dentro de Sander**; el asistente del humano levanta el túnel al puerto local.
- **Copiar la config completa de los harnesses del host al sandbox**; la provisión de config es vía SyncAgents.
- **Workspace config** (`<repo>/.sander/`): implementación diferida, aunque el formato queda preparado.
- **Codex como adaptador de harness propio**: soportado vía agentbox, sin adaptador dedicado.

## Further Notes

- Dominio y hechos locales (SyncAgents, túnel, semántica attach/exec, rama por sandbox) documentados en `docs/wayfinder/map.md`; decisiones ampliadas en los tickets cerrados: `El barrido de alternativas`, `La forma de sander` y `El veredicto: construir o no`.
- Idioma de la conversación y de los mensajes de la CLI: español.
- El repositorio aún no es git ni tiene código; esta spec es el punto de partida de la sesión de implementación.
