#!/bin/bash
set -e

# GitHub Release Creation Script
# This script handles only the GitHub release creation.
# Building and NPM publishing are handled by GitHub workflows.
#
# Usage: ./scripts/release.sh [VERSION|BUMP_TYPE] [OPTIONS]
# Run with --help for detailed usage information
FIRST_ARG=$1
DRY_RUN=false
VERSION=""
BUMP_TYPE=""

# Function to show help
show_help() {
  cat << 'EOF'
📦 GitHub Release Creator

Creates releases with automatic semver bumping. Only handles GitHub release
creation - building and NPM publishing are handled by workflows.

USAGE:
    [VERSION|BUMP_TYPE] [OPTIONS]

ARGUMENTS:
    VERSION         Explicit version (e.g., 1.5.0, 2.0.0-beta.1)
    BUMP_TYPE       major | minor [default] | patch

OPTIONS:
    --dry-run       Preview without executing
    -h, --help      Show this help

EXAMPLES:
    (no args)       Interactive minor bump
    major           Interactive major bump
    1.5.0           Use specific version
    patch --dry-run Preview patch bump

EOF

  local highest_version=$(get_highest_version)
  if [[ -n "$highest_version" ]]; then
    echo "CURRENT: $highest_version"
    echo "NEXT: major=$(bump_version "$highest_version" "major") | minor=$(bump_version "$highest_version" "minor") | patch=$(bump_version "$highest_version" "patch")"
  else
    echo "No existing version tags found"
  fi
  echo ""
}

# Function to get the highest version from git tags
get_highest_version() {
  git tag | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sed 's/^v//' | sort -V | tail -1
}

# Function to parse version components
parse_version() {
  local version=$1
  echo "$version" | sed -E 's/^([0-9]+)\.([0-9]+)\.([0-9]+)(-.*)?$/\1 \2 \3 \4/'
}

# Function to bump version based on type
bump_version() {
  local current_version=$1
  local bump_type=$2

  local parsed=($(parse_version "$current_version"))
  local major=${parsed[0]}
  local minor=${parsed[1]}
  local patch=${parsed[2]}
  local prerelease=${parsed[3]:-""}

  # Remove prerelease for stable version bumps
  case $bump_type in
    major)
      echo "$((major + 1)).0.0"
      ;;
    minor)
      echo "${major}.$((minor + 1)).0"
      ;;
    patch)
      echo "${major}.${minor}.$((patch + 1))"
      ;;
    *)
      echo "❌ Unknown bump type: $bump_type" >&2
      exit 1
      ;;
  esac
}

# Function to validate version format
validate_version() {
  local version=$1
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
    echo "❌ Invalid version format: $version"
    echo "Version must be in format: x.y.z or x.y.z-prerelease (e.g., 1.4.0, 1.4.0-beta, 1.4.0-beta.3)"
    return 1
  fi
  return 0
}

# Function to compare versions (returns 1 if first version is greater, 0 if equal, -1 if less)
compare_versions() {
  local version1=$1
  local version2=$2

  local v1_base=${version1%%-*}
  local v2_base=${version2%%-*}
  local v1_pre=""
  local v2_pre=""

  [[ "$version1" == *-* ]] && v1_pre=${version1#*-}
  [[ "$version2" == *-* ]] && v2_pre=${version2#*-}

  # When base versions match, a stable release outranks any prerelease
  if [[ "$v1_base" == "$v2_base" ]]; then
    if [[ -z "$v1_pre" && -n "$v2_pre" ]]; then
      echo 1
      return
    elif [[ -n "$v1_pre" && -z "$v2_pre" ]]; then
      echo -1
      return
    elif [[ "$version1" == "$version2" ]]; then
      echo 0
      return
    fi
  fi

  # Fallback to version sort for differing bases or two prereleases
  local sorted=$(printf "%s\n%s" "$version1" "$version2" | sort -V)
  if [[ "$(echo "$sorted" | head -1)" == "$version1" ]]; then
    echo -1
  else
    echo 1
  fi
}

# Function to ask for confirmation
ask_confirmation() {
  local suggested_version=$1
  echo ""
  echo "🚀 Suggested next version: $suggested_version"
  read -p "Do you want to use this version? (y/N): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    return 0
  else
    return 1
  fi
}

# Function to get version interactively
get_version_interactively() {
  echo ""
  echo "Please enter the version manually:"
  while true; do
    read -p "Version: " manual_version
    if validate_version "$manual_version"; then
      local highest_version=$(get_highest_version)
      if [[ -n "$highest_version" ]]; then
        local comparison=$(compare_versions "$manual_version" "$highest_version")
        if [[ $comparison -le 0 ]]; then
          echo "❌ Version $manual_version is not newer than the highest existing version $highest_version"
          continue
        fi
      fi
      VERSION="$manual_version"
      break
    fi
  done
}

# Check for help flags first
for arg in "$@"; do
  if [[ "$arg" == "-h" ]] || [[ "$arg" == "--help" ]]; then
    show_help
    exit 0
  fi
done

# Check for arguments and set flags
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=true
  fi
done

# Determine version or bump type (ignore --dry-run flag)
if [[ -z "$FIRST_ARG" ]] || [[ "$FIRST_ARG" == "--dry-run" ]]; then
  # No argument provided, default to minor bump
  BUMP_TYPE="minor"
elif [[ "$FIRST_ARG" == "major" ]] || [[ "$FIRST_ARG" == "minor" ]] || [[ "$FIRST_ARG" == "patch" ]]; then
  # Bump type provided
  BUMP_TYPE="$FIRST_ARG"
else
  # Version string provided
  if validate_version "$FIRST_ARG"; then
    VERSION="$FIRST_ARG"
  else
    exit 1
  fi
fi

# If bump type is set, calculate the suggested version
if [[ -n "$BUMP_TYPE" ]]; then
  HIGHEST_VERSION=$(get_highest_version)
  if [[ -z "$HIGHEST_VERSION" ]]; then
    echo "❌ No existing version tags found. Please provide a version manually."
    get_version_interactively
  else
    SUGGESTED_VERSION=$(bump_version "$HIGHEST_VERSION" "$BUMP_TYPE")

    if ask_confirmation "$SUGGESTED_VERSION"; then
      VERSION="$SUGGESTED_VERSION"
    else
      get_version_interactively
    fi
  fi
fi

# Final validation and version comparison
if [[ -z "$VERSION" ]]; then
  echo "❌ No version determined"
  exit 1
fi

HIGHEST_VERSION=$(get_highest_version)
if [[ -n "$HIGHEST_VERSION" ]]; then
  COMPARISON=$(compare_versions "$VERSION" "$HIGHEST_VERSION")
  if [[ $COMPARISON -le 0 ]]; then
    echo "❌ Version $VERSION is not newer than the highest existing version $HIGHEST_VERSION"
    exit 1
  fi
fi

# Detect current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Enforce branch policy - only allow releases from main
if [[ "$BRANCH" != "main" ]]; then
  echo "❌ Error: Releases must be created from the main branch."
  echo "Current branch: $BRANCH"
  echo "Please switch to main and try again."
  exit 1
fi

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
    return 0
  fi

  "$@"
}

# Portable in-place sed (BSD/macOS vs GNU/Linux)
# - macOS/BSD sed requires: sed -i '' -E 's/.../.../' file
# - GNU sed requires:       sed -i -E 's/.../.../' file
sed_inplace() {
  local expr="$1"
  local file="$2"

  if sed --version >/dev/null 2>&1; then
    # GNU sed
    sed -i -E "$expr" "$file"
  else
    # BSD/macOS sed
    sed -i '' -E "$expr" "$file"
  fi
}

prepare_changelog_for_release_notes() {
  local source_path="$1"
  local destination_path="$2"
  local target_version="$3"

  node - "$source_path" "$destination_path" "$target_version" <<'NODE'
const fs = require('fs');

const [sourcePath, destinationPath, targetVersion] = process.argv.slice(2);
const versionHeadingRegex = /^##\s+\[([^\]]+)\](?:\s+-\s+.*)?\s*$/;
const normalizeVersion = (value) => value.trim().replace(/^v/, '');

try {
  const changelog = fs.readFileSync(sourcePath, 'utf8');
  const lines = changelog.split(/\r?\n/);
  const normalizedTargetVersion = normalizeVersion(targetVersion);
  let firstHeadingIndex = -1;
  let firstHeadingLabel = '';

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(versionHeadingRegex);
    if (!match) {
      continue;
    }

    const label = match[1].trim();
    if (normalizeVersion(label) === normalizedTargetVersion) {
      process.exit(3);
    }

    if (firstHeadingIndex === -1) {
      firstHeadingIndex = index;
      firstHeadingLabel = label;
    }
  }

  if (firstHeadingIndex === -1 || firstHeadingLabel !== 'Unreleased') {
    process.exit(3);
  }

  lines[firstHeadingIndex] = lines[firstHeadingIndex].replace('[Unreleased]', `[${targetVersion}]`);
  fs.writeFileSync(destinationPath, `${lines.join('\n')}\n`, 'utf8');
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Failed to prepare changelog for release notes: ${message}`);
  process.exit(1);
}
NODE
}

# Ensure we're in the project root (parent of scripts directory)
cd "$(dirname "$0")/.."

# Files this script modifies and commits as part of the release
RELEASE_MANAGED_FILES=(
  "CHANGELOG.md"
  "package.json"
  "package-lock.json"
  "server.json"
)

has_unmanaged_changes() {
  local exclude_args=()
  for f in "${RELEASE_MANAGED_FILES[@]}"; do
    exclude_args+=(":(exclude)$f")
  done
  ! git diff-index --quiet HEAD -- . "${exclude_args[@]}"
}

has_release_managed_changes() {
  ! git diff --quiet HEAD -- "${RELEASE_MANAGED_FILES[@]}"
}

# Check if working directory is clean outside release-managed files
if ! $DRY_RUN; then
  if has_unmanaged_changes; then
    echo "❌ Error: Working directory has uncommitted changes outside release-managed files."
    echo "Please commit or stash those changes before creating a release."
    exit 1
  fi
else
  if has_unmanaged_changes; then
    echo "⚠️  Dry-run: working directory has unmanaged changes (continuing)."
  fi
fi

CHANGELOG_PATH="CHANGELOG.md"
CHANGELOG_FOR_VALIDATION="$CHANGELOG_PATH"
CHANGELOG_VALIDATION_TEMP=""
CHANGELOG_RENAMED_ON_DISK=false

if $DRY_RUN; then
  CHANGELOG_VALIDATION_TEMP=$(mktemp "${TMPDIR:-/tmp}/mobilebuildmcp-changelog-validation.XXXXXX")
  if prepare_changelog_for_release_notes "$CHANGELOG_PATH" "$CHANGELOG_VALIDATION_TEMP" "$VERSION"; then
    CHANGELOG_FOR_VALIDATION="$CHANGELOG_VALIDATION_TEMP"
    echo "ℹ️  Dry-run: prepared release changelog from [Unreleased] in a temp file."
  else
    PREPARE_STATUS=$?
    if [[ $PREPARE_STATUS -eq 3 ]]; then
      rm "$CHANGELOG_VALIDATION_TEMP"
      CHANGELOG_VALIDATION_TEMP=""
    else
      rm "$CHANGELOG_VALIDATION_TEMP"
      exit $PREPARE_STATUS
    fi
  fi
else
  if prepare_changelog_for_release_notes "$CHANGELOG_PATH" "$CHANGELOG_PATH" "$VERSION"; then
    CHANGELOG_RENAMED_ON_DISK=true
    echo "📝 Renamed CHANGELOG heading [Unreleased] -> [$VERSION]"
  else
    PREPARE_STATUS=$?
    if [[ $PREPARE_STATUS -ne 3 ]]; then
      exit $PREPARE_STATUS
    fi
  fi
fi

echo ""
echo "🧾 Validating CHANGELOG release notes for v$VERSION..."
RELEASE_NOTES_TMP=$(mktemp "${TMPDIR:-/tmp}/mobilebuildmcp-release-notes.XXXXXX")
node scripts/generate-github-release-notes.mjs --version "$VERSION" --changelog "$CHANGELOG_FOR_VALIDATION" --out "$RELEASE_NOTES_TMP"
rm "$RELEASE_NOTES_TMP"
if [[ -n "$CHANGELOG_VALIDATION_TEMP" ]]; then
  rm "$CHANGELOG_VALIDATION_TEMP"
fi
echo "✅ CHANGELOG entry found and release notes generated."

# Check if package.json already has this version (from previous attempt)
CURRENT_PACKAGE_VERSION=$(node -p "require('./package.json').version")
if [[ "$CURRENT_PACKAGE_VERSION" == "$VERSION" ]]; then
  echo "📦 Version $VERSION already set in package.json"
  SKIP_VERSION_UPDATE=true
else
  SKIP_VERSION_UPDATE=false
fi

if [[ "$SKIP_VERSION_UPDATE" == "false" ]]; then
  NPM_TAG="latest"
  if [[ "$VERSION" == *"-"* ]]; then
    PRERELEASE_TAG="${VERSION#*-}"
    PRERELEASE_LABEL="${PRERELEASE_TAG%%.*}"
    if [[ "$PRERELEASE_LABEL" == "alpha" ]]; then
      NPM_TAG="alpha"
    elif [[ "$PRERELEASE_LABEL" == "beta" ]]; then
      NPM_TAG="beta"
    fi
  fi

  # Version update
  echo ""
  echo "🔧 Setting version to $VERSION..."
  run npm version "$VERSION" --no-git-tag-version

  # server.json update
  echo ""
  if [[ -f server.json ]]; then
    echo "📝 Updating server.json version to $VERSION..."
    run node -e "const fs=require('fs');const f='server.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='${VERSION}';if(Array.isArray(j.packages)){j.packages=j.packages.map(p=>({...p,version:'${VERSION}'}));}fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"
  else
    echo "⚠️  server.json not found; skipping update"
  fi

  # Git operations
  echo ""
  echo "📦 Committing version changes..."
  if [[ -f server.json ]]; then
    run git add package.json package-lock.json CHANGELOG.md server.json
  else
    run git add package.json package-lock.json CHANGELOG.md
  fi
  run git commit -m "Release v$VERSION"
else
  echo "⏭️  Skipping version update (already done)"
  # Ensure server.json still matches the desired version (in case of a partial previous run)
  if [[ -f server.json ]]; then
    CURRENT_SERVER_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('server.json','utf8')).version||'')")
    if [[ "$CURRENT_SERVER_VERSION" != "$VERSION" ]]; then
      echo "📝 Aligning server.json to $VERSION..."
      run node -e "const fs=require('fs');const f='server.json';const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='${VERSION}';if(Array.isArray(j.packages)){j.packages=j.packages.map(p=>({...p,version:'${VERSION}'}));}fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');"
    fi
  fi

  if has_release_managed_changes; then
    echo "📦 Committing release-managed changes..."
    run git add "${RELEASE_MANAGED_FILES[@]}"
    run git commit -m "Release v$VERSION"
  fi
fi

# Create or recreate tag at current HEAD
echo "🏷️  Creating tag v$VERSION..."
run git tag -f "v$VERSION"

echo ""
echo "🚀 Pushing to origin..."
run git push origin "$BRANCH"
RELEASE_HEAD_SHA=$(git rev-parse HEAD)
WORKFLOW_SEARCH_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
run git push origin "v$VERSION"

# In dry-run, stop here (don't monitor workflows, and don't claim a release happened).
if $DRY_RUN; then
  echo ""
  echo "ℹ️  Dry-run: skipping GitHub Actions workflow monitoring."
  exit 0
fi

# Monitor the workflow and handle failures
echo ""
echo "⏳ Monitoring GitHub Actions workflow..."
echo "This may take a few minutes..."

# Poll for the workflow run triggered by this tag (may take a few seconds to appear)
RUN_ID=""
for i in $(seq 1 12); do
  RUN_ID=$(gh run list --workflow=release.yml --branch="v$VERSION" --limit=20 --json databaseId,headSha,createdAt --jq "[.[] | select(.headSha == \"$RELEASE_HEAD_SHA\" and .createdAt >= \"$WORKFLOW_SEARCH_STARTED_AT\")] | .[0].databaseId // \"\"")
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    break
  fi
  echo "  Waiting for workflow to appear... (attempt $i/12)"
  sleep 5
done

if [[ -n "$RUN_ID" ]]; then
  echo "📊 Workflow run ID: $RUN_ID"
  echo "🔍 Watching workflow progress..."
  echo "(Press Ctrl+C to detach and monitor manually)"
  echo ""

  # Watch the workflow with exit status
  WATCH_EXIT=0
  gh run watch "$RUN_ID" --exit-status || WATCH_EXIT=$?
  if [[ $WATCH_EXIT -eq 0 ]]; then
    echo ""
    echo "✅ Release v$VERSION completed successfully!"
    echo "📦 View on NPM: https://www.npmjs.com/package/mobilebuildmcp/v/$VERSION"
    echo "🎉 View release: https://github.com/getsentry/MobileBuildMCP/releases/tag/v$VERSION"
    # MCP Registry verification link
    echo "🔎 Verify MCP Registry: https://registry.modelcontextprotocol.io/v0/servers?search=io.github.getsentry/mobilebuildmcp&version=latest"
  else
    echo ""
    echo "❌ CI workflow monitoring failed!"
    echo "ℹ️  This may be a transient API error. The workflow may still be running."
    echo "   Check manually: gh run view $RUN_ID"
    echo ""
    RUN_STATUS=$(gh run view "$RUN_ID" --json status --jq '.status' || echo "unknown")
    if [[ "$RUN_STATUS" != "completed" ]]; then
      echo "⚠️  Workflow is still '$RUN_STATUS'. Keeping tag v$VERSION."
      echo "   Re-run monitoring manually: gh run watch $RUN_ID --exit-status"
      exit $WATCH_EXIT
    fi

    # Prefer job state: if the primary 'release' job succeeded, treat as success.
    RELEASE_JOB_CONCLUSION=$(gh run view "$RUN_ID" --json jobs --jq '.jobs[] | select(.name=="release") | .conclusion')
    if [ "$RELEASE_JOB_CONCLUSION" = "success" ]; then
      echo "⚠️ Workflow reported failure, but primary 'release' job concluded SUCCESS."
      echo "✅ Treating release as successful. Tag v$VERSION is kept."
      echo "📦 Verify on NPM: https://www.npmjs.com/package/mobilebuildmcp/v/$VERSION"
      exit 0
    fi
    echo "🧹 Cleaning up tags only (keeping version commit)..."

    # Delete remote tag
    echo "  - Deleting remote tag v$VERSION..."
    git push origin :refs/tags/v$VERSION 2>/dev/null || true

    # Delete local tag
    echo "  - Deleting local tag v$VERSION..."
    git tag -d v$VERSION

    echo ""
    echo "✅ Tag cleanup complete!"
    echo ""
    echo "ℹ️  The version commit remains in your history."
    echo "📝 To retry after fixing issues:"
    echo "   1. Fix the CI issues"
    echo "   2. Commit your fixes"
    echo "   3. Run: ./scripts/release.sh $VERSION"
    echo ""
    echo "🔍 To see what failed: gh run view $RUN_ID --log-failed"
    exit 1
  fi
else
  echo "⚠️  Could not find workflow run. Please check manually:"
  echo "https://github.com/getsentry/MobileBuildMCP/actions"
fi
