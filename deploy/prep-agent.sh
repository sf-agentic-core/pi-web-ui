#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Preparar directorio de estado dedicado para pi-web-ui
# ==============================================================================
# Crea /opt/tachikoma/state/pi-web con la estructura necesaria y enlaza la
# configuración core sin colisionar con las sesiones de Discord.
# ==============================================================================

TARGET_DIR="/opt/tachikoma/state/pi-web"
REPOS_DIR="/opt/tachikoma/repos"
CORE_LIB="$REPOS_DIR/core/core-agent-library"

echo "🕸️ Inicializando estado dedicado para pi-web-ui en $TARGET_DIR..."

mkdir -p "$TARGET_DIR/agent"
mkdir -p "$TARGET_DIR/agent/sessions"
mkdir -p "$TARGET_DIR/data"

# Permisos para el usuario node (UID 1000 / tachikoma)
chown -R 1000:1000 "$TARGET_DIR"

echo "🔗 Vinculando configuración desde core-agent-library..."

link_file() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$dst")"
  rm -f "$dst"
  ln -sf "$src" "$dst"
  echo "  ✓ $(basename "$dst") → $src"
}

if [ -d "$CORE_LIB" ]; then
  link_file "$CORE_LIB/config/settings.json" "$TARGET_DIR/agent/settings.json"
  link_file "$CORE_LIB/config/models.json" "$TARGET_DIR/agent/models.json"
  link_file "$CORE_LIB/mcp-global.json" "$TARGET_DIR/agent/mcp.json"
  link_file "$CORE_LIB/config/web-search.json" "$TARGET_DIR/agent/web-search.json"
  link_file "$CORE_LIB/layers/global.md" "$TARGET_DIR/agent/AGENTS.md"

  # auth.json propio y escribible para pi-web-ui.
  # Se inicializa solo si aún no existe o está vacío; después queda
  # independiente para que OAuth (GitHub Copilot) pueda actualizarlo.
  AUTH_SOURCE="/opt/tachikoma/state/agent/auth.json"
  AUTH_TARGET="$TARGET_DIR/agent/auth.json"
  if [ -s "$AUTH_SOURCE" ] && [ ! -s "$AUTH_TARGET" ]; then
    install -o 1000 -g 1000 -m 600 "$AUTH_SOURCE" "$AUTH_TARGET"
    echo "  ✓ auth.json inicializado (copia independiente y escribible)"
  elif [ -s "$AUTH_TARGET" ]; then
    chmod 600 "$AUTH_TARGET"
    chown 1000:1000 "$AUTH_TARGET"
  fi
fi

chown -R 1000:1000 "$TARGET_DIR"
echo "✅ Estado de pi-web-ui preparado correctamente."
