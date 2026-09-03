#!/usr/bin/env bash
# ==============================================================================
# Upstream Security Audit & Verification Script for pi-web-ui
# ==============================================================================
# Run this before merging any upstream synchronization PR (`chore: sync upstream`)
# ==============================================================================
set -euo pipefail

echo "🔍 === 1. Verificando vulnerabilidades en dependencias (npm audit) ==="
npm audit --audit-level=high

echo ""
echo "📦 === 2. Verificando que todos los paquetes vengan del registro oficial ==="
INVALID_SOURCES=$(grep -o '"resolved": "[^"]*"' package-lock.json | grep -vc "registry.npmjs.org" || true)
if [ "$INVALID_SOURCES" -gt 0 ]; then
  echo "❌ ERROR: Se detectaron paquetes resueltos desde URLs no oficiales de npm."
  exit 1
else
  echo "✓ Todos los paquetes provienen de registry.npmjs.org"
fi

echo ""
echo "🔎 === 3. Buscando patrones peligrosos (eval, Function dinámicas) ==="
DANGEROUS_EVAL=$(grep -rn "eval(\|new Function(" server/ web/src/ extensions/ bin/ 2>/dev/null | grep -v "\.test\.\|test/" || true)
if [ -n "$DANGEROUS_EVAL" ]; then
  echo "⚠️ ALERTA: Se detectaron llamadas dinámicas peligrosas:"
  echo "$DANGEROUS_EVAL"
else
  echo "✓ No se detectaron patrones de eval() o Function() dinámicas."
fi

echo ""
echo "🧪 === 4. Ejecutando Typecheck, Build y Tests ==="
npm run typecheck
npm run build
npx vitest run

echo ""
echo "✅ Auditoría de seguridad previa al merge completada con éxito."
