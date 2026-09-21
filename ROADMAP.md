# Roadmap — pi-web-ui (fork Tachikoma) 🕸️

Fork de [xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) para servir como **consola web de Tachikoma** (pi-coding-agent), complementaria a Discord/picord.

## Contexto y principios

- **No tocar picord/Discord**: la consola es una ruta adicional, no un reemplazo.
- **Acceso privado**: solo Tailscale + autenticación propia; nunca expuesto a Internet público.
- **Config centralizada**: los modelos, MCP, skills y settings provienen de `pi-global-harness` (paquete global; `core-agent-library` está archivado y eliminado).
- **Licencia MIT** (upstream): nuestro fork mantiene los cambios como commits/PRs versionados, revisables y re-vinculables a upstream (`git rebase upstream/main`).

## Decisiones de arquitectura

| Decisión | Elección |
|---|---|
| Engine | `pi` (por defecto; el engine `dsh` de DeepSeek Harness queda deshabilitado) |
| pi SDK | la versión que embeba el fork (`^0.87.0`), servicio **separado** del contenedor Discord (0.80.7, congelado por `AuthStorage`) |
| Sesiones | JSONL nativos de pi (fork/tree/resume) como fuente de verdad |
| Identidad | multi-usuario (M2): cada usuario con su propio espacio de config y API keys |

## Milestones

### M0 — Fundación ✅
- [x] Fork `Sarony11/pi-web-ui` + remoto `upstream`.
- [x] Sincronización con `upstream/main`.
- [ ] Pin de versión y CI en el fork.

### M1 — Tachikoma personal (POC operativo)
- [ ] Integrar config de `pi-global-harness` (jerarquía workspace → global, vía el `.pi/` del workspace).
- [ ] UI de variables de entorno y secrets (core + workspace).
- [ ] PWA instalable (manifest + service worker + iconos) para Android/PC.
- [ ] Autenticación (login + cookie/sesión) sobre loopback.
- [ ] Despliegue con Tailscale (bind a tailnet + TLS + reverse proxy).
- [ ] Vista visual del árbol de forks/sesiones (get_tree + fork/clone/resume).

### M2 — Multi-usuario / trabajo en equipo
- [ ] Cuentas de usuario (registro, login, aislamiento de datos).
- [ ] API keys / auth **por usuario** con los modelos de pi (cada usuario configura su propio *harness*).
- [ ] Compartir sesiones y workspaces entre usuarios (lectura/escritura).
- [ ] Roles y permisos (owner/member/guest).

### M3 — UX y robustez
- [ ] Pulido móvil (input bar táctil, teclas modificadoras, IME).
- [ ] Inbox/outbox por sesión (subida/descarga de artefactos con límites y TTL).
- [ ] Notificaciones PWA (sesión necesita input / idle).

## Vinculación con la librería agéntica

- El RFC/ADR correspondiente se mantiene en `core-docs/adr/` (los ADRs se migraron desde
  `core-agent-library/docs/adr/` el 2026-09-15).
- Los MCP/skills/agentes que use la consola son los mismos de `pi-global-harness`.
