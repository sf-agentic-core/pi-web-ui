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
CORE_LIB="$REPOS_DIR/core-agent-library"

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
  
  # Si existe auth.json global en el host, vincularlo para providers
  if [ -f "/opt/tachikoma/state/agent/auth.json" ]; then
    link_file "/opt/tachikoma/state/agent/auth.json" "$TARGET_DIR/agent/auth.json"
  fi
fi

chown -R 1000:1000 "$TARGET_DIR"
echo "✅ Estado de pi-web-ui preparado correctamente."
