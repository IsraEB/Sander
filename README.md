# sander

AI-agent sandbox manager CLI. Crea sandboxes aislados y reproducibles para agentes de IA (opencode, claude code, codex) sobre agentbox/docker: teleporta el proyecto actual dentro de un box respetando `.gitignore`, sincroniza la config global del harness, inyecta el GitHub token y el `.env`, y arranca el servicio del proyecto con un supervisor.

## Requisitos

- Node.js 18+
- Docker (Docker Desktop con integración WSL 2 activada)
- [agentbox](https://github.com/madarco/agentbox) (se instala abajo)

Verificar que el daemon de Docker está corriendo:

```bash
docker info
```

Si falla, arrancar Docker Desktop (desde WSL):

```bash
"/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe" &
```

## Instalación

Clonar el repo y exponer el binario:

```bash
npm install && npm run build && npm link
```

Instalar el provider agentbox:

```bash
npm -g i @madarco/agentbox && agentbox install
```

## Uso rápido

Desde la raíz de cualquier proyecto:

```bash
sander create tmp
```

Crea el sandbox `tmp`: box aislado con el proyecto teleportado, config de opencode sincronizada, rama git del sandbox creada, `.sander/install.sh` ejecutado y el supervisor del servicio arrancado.

## Comandos

| Comando | Descripción |
| --- | --- |
| `sander create [<id>]` | Crear un sandbox para el proyecto actual |
| `sander setup` | Generar los scripts bootstrap (`.sander/install.sh`, `.sander/start.sh`) |
| `sander run <id> "prompt"` | Ejecutar un prompt dentro del sandbox (headless) |
| `sander attach <id>` | Sesión interactiva dentro del sandbox |
| `sander exec <id> <comando>` | Comando único dentro del sandbox (estilo `docker exec`) |
| `sander stop <id>` / `sander start <id>` | Detener / reanudar un sandbox conservando su estado |
| `sander rm <id>` | Eliminar un sandbox |
| `sander list` | Listar los sandboxes del proyecto |
| `sander logs <id>` | Ver la salida del servicio del sandbox |

## Notas

- El sandbox se refiere por su id posicional (`sander create tmp`); el id es un nombre válido de rama git.
- El token de GitHub se resuelve con precedencia `--token` → config global → `gh auth token` (con confirmación) y se inyecta como variable de entorno sin tocar disco.
- Si existe `.env.sander` en el proyecto, se copia como `.env` dentro del box.
- `create` ejecuta `install.sh` una vez y el supervisor reinicia `start.sh` ante cada cambio del worktree; el trabajo del agente persiste entre paradas y arranques.
