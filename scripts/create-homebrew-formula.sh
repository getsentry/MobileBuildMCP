#!/usr/bin/env bash

set -euo pipefail

VERSION=""
ARM64_SHA=""
X64_SHA=""
OUT_PATH=""
BASE_URL=""

usage() {
  cat <<'EOF'
Usage:
  scripts/create-homebrew-formula.sh --version <semver> --arm64-sha <sha256> --x64-sha <sha256> [--base-url <url>] [--out <path>]
EOF
}

require_arg_value() {
  local flag_name="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    echo "Error: $flag_name requires a value"
    usage
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      require_arg_value "--version" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --arm64-sha)
      require_arg_value "--arm64-sha" "${2:-}"
      ARM64_SHA="$2"
      shift 2
      ;;
    --x64-sha)
      require_arg_value "--x64-sha" "${2:-}"
      X64_SHA="$2"
      shift 2
      ;;
    --base-url)
      require_arg_value "--base-url" "${2:-}"
      BASE_URL="$2"
      shift 2
      ;;
    --out)
      require_arg_value "--out" "${2:-}"
      OUT_PATH="$2"
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

if [[ -z "$VERSION" || -z "$ARM64_SHA" || -z "$X64_SHA" ]]; then
  usage
  exit 1
fi

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="https://github.com/getsentry/MobileBuildMCP/releases/download/v$VERSION"
fi

FORMULA_CONTENT="$(cat <<EOF
class Mobilebuildmcp < Formula
  desc "Model Context Protocol server for Xcode project workflows"
  homepage "https://github.com/getsentry/MobileBuildMCP"
  license "MIT"
  version "$VERSION"

  on_arm do
    url "$BASE_URL/mobilebuildmcp-$VERSION-darwin-arm64.tar.gz"
    sha256 "$ARM64_SHA"
  end

  on_intel do
    url "$BASE_URL/mobilebuildmcp-$VERSION-darwin-x64.tar.gz"
    sha256 "$X64_SHA"
  end

  def install
    prefix.install Dir["*"]
  end

  test do
    assert_match "mobilebuildmcp", shell_output("#{bin}/mobilebuildmcp --help")
  end
end
EOF
)"

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  printf "%s\n" "$FORMULA_CONTENT" > "$OUT_PATH"
else
  printf "%s\n" "$FORMULA_CONTENT"
fi
