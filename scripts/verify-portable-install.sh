#!/usr/bin/env bash

set -euo pipefail

ARCHIVE_PATH=""
PORTABLE_ROOT=""
TEMP_DIR=""

usage() {
  cat <<'EOF'
Usage:
  scripts/verify-portable-install.sh --archive <path/to/tar.gz>
  scripts/verify-portable-install.sh --root <path/to/portable-root>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_PATH="${2:-}"
      shift 2
      ;;
    --root)
      PORTABLE_ROOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -r "$TEMP_DIR"
  fi
}

if [[ -z "$ARCHIVE_PATH" && -z "$PORTABLE_ROOT" ]]; then
  usage
  exit 1
fi

if [[ -n "$ARCHIVE_PATH" ]]; then
  TEMP_DIR="$(mktemp -d)"
  trap cleanup EXIT
  tar -xzf "$ARCHIVE_PATH" -C "$TEMP_DIR"
  extracted_count="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  if [[ "$extracted_count" -ne 1 ]]; then
    echo "Expected archive to contain exactly one top-level directory"
    exit 1
  fi
  PORTABLE_ROOT="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi

if [[ ! -d "$PORTABLE_ROOT/bin" || ! -d "$PORTABLE_ROOT/libexec" ]]; then
  echo "Portable layout missing bin/ or libexec/: $PORTABLE_ROOT"
  exit 1
fi
if [[ ! -x "$PORTABLE_ROOT/bin/mobilebuildmcp" ]]; then
  echo "Missing executable wrapper: $PORTABLE_ROOT/bin/mobilebuildmcp"
  exit 1
fi
if [[ ! -x "$PORTABLE_ROOT/bin/mobilebuildmcp-doctor" ]]; then
  echo "Missing executable wrapper: $PORTABLE_ROOT/bin/mobilebuildmcp-doctor"
  exit 1
fi
if [[ ! -x "$PORTABLE_ROOT/libexec/mobilebuildmcp" ]]; then
  echo "Missing executable binary: $PORTABLE_ROOT/libexec/mobilebuildmcp"
  exit 1
fi
if [[ ! -d "$PORTABLE_ROOT/libexec/manifests" ]]; then
  echo "Missing manifests directory under libexec"
  exit 1
fi
if [[ ! -f "$PORTABLE_ROOT/libexec/schemas/structured-output/_defs/common.schema.json" ]]; then
  echo "Missing structured output common schema under libexec"
  exit 1
fi
if [[ ! -f "$PORTABLE_ROOT/libexec/schemas/structured-output/mobilebuildmcp.output.session-defaults/1.schema.json" ]]; then
  echo "Missing session defaults structured output schema under libexec"
  exit 1
fi
if [[ ! -x "$PORTABLE_ROOT/libexec/bundled/axe" ]]; then
  echo "Missing bundled axe binary under libexec"
  exit 1
fi
if [[ ! -d "$PORTABLE_ROOT/libexec/bundled/Frameworks" ]]; then
  echo "Missing bundled Frameworks under libexec"
  exit 1
fi
if [[ ! -d "$PORTABLE_ROOT/libexec/skills" ]]; then
  echo "Missing skills directory under libexec"
  exit 1
fi

HOST_ARCH="$(uname -m)"
NODE_RUNTIME="$PORTABLE_ROOT/libexec/node-runtime"
if [[ ! -x "$NODE_RUNTIME" ]]; then
  echo "Missing executable Node runtime under libexec"
  exit 1
fi

RUNTIME_ARCHS="$(lipo -archs "$NODE_RUNTIME" 2>/dev/null || true)"
if [[ -z "$RUNTIME_ARCHS" ]]; then
  if file "$NODE_RUNTIME" | grep -q "x86_64"; then
    RUNTIME_ARCHS="x86_64"
  elif file "$NODE_RUNTIME" | grep -q "arm64"; then
    RUNTIME_ARCHS="arm64"
  fi
fi

NORMALIZED_HOST_ARCH="$HOST_ARCH"
if [[ "$HOST_ARCH" == "aarch64" ]]; then
  NORMALIZED_HOST_ARCH="arm64"
fi

CAN_EXECUTE="false"
for runtime_arch in $RUNTIME_ARCHS; do
  if [[ "$runtime_arch" == "$NORMALIZED_HOST_ARCH" ]]; then
    CAN_EXECUTE="true"
    break
  fi
done

if [[ "$CAN_EXECUTE" == "true" ]]; then
  "$PORTABLE_ROOT/bin/mobilebuildmcp" --help >/dev/null
  "$PORTABLE_ROOT/bin/mobilebuildmcp-doctor" --help >/dev/null
  "$PORTABLE_ROOT/bin/mobilebuildmcp" init --print >/dev/null
else
  echo "Skipping binary execution checks: host arch ($HOST_ARCH) not in runtime archs ($RUNTIME_ARCHS)"
fi

echo "Portable install verification passed for: $PORTABLE_ROOT"
