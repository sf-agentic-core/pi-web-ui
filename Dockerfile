# syntax=docker/dockerfile:1
# pi-web-ui — multi-stage build. Builds the server (tsc) + frontend (vite),
# then runs a slim runtime image. `docker compose up -d` = one-command deploy
# with auto-restart on boot (`restart: unless-stopped`).
# ------------------------------------------------------------------------------
# Base compartida del agente
# ------------------------------------------------------------------------------
# ⚠️ El ARG va ANTES del primer FROM a propósito: un ARG declarado dentro de una
# etapa NO es visible para el `FROM` de una etapa posterior. Declarado aquí, es
# global y sí se puede usar en el `FROM` del runtime.
#
# El valor por defecto permite `docker build .` en local. En CI lo sobreescribe
# el build-arg del workflow (que es el pin real).
# ------------------------------------------------------------------------------
ARG BASE_IMAGE=rg.fr-par.scw.cloud/sf-agentic-core/agent-base:5f0c7e440a4cabe9c8fb96f09f9a3ce0a78701f1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Etapa de runtime: DERIVA de la base compartida del agente -----------
#
# Antes esta etapa duplicaba ~55 líneas de toolchain (apt, gh, gcloud,
# azure-cli, kubectl, terraform, gh/helm/uv...) que YA viven en agent-base.
# Esa duplicación es justo la deriva que se eliminó al separar la base:
# la imagen del bot tenía MCPs y Chromium, y esta no.
#
# Ahora se hereda todo, así que añadir un MCP o actualizar el toolchain se
# hace en UN sitio. La etapa `build` de arriba sigue usando node sin tocar,
# porque ahí solo se compila TypeScript/Vite.
FROM ${BASE_IMAGE}

# La base deja WORKDIR en /home/tachikoma; aquí trabajamos en /app, que es
# donde el stage `build` deja los artefactos y donde apunta el volumen.
WORKDIR /app
ENV NODE_ENV=production

# DSH engine (PI_WEB_ENGINE=dsh) needs the full @deepseek-ai/dsh runtime tree
# (nested ~196 packages) as a subprocess — global install is the canonical way.
# Skipped implicitly when the image never enables the dsh engine (just unused).
RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
ENV PI_WEB_PORT=8787
EXPOSE 8787
# Session data (per-client chat history) lives here — mount a volume.
VOLUME ["/app/.pi-web"]
# La base renombra el usuario `node` a `tachikoma` (mismo uid 1000).
USER tachikoma
CMD ["node", "dist/server/index.js"]