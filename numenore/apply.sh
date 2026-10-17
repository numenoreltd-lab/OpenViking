#!/usr/bin/env bash
#
# Apply the fork's transcript fixes (stream reading, catch-up cap, resume from a
# saved cursor) to the installed Codex and Claude Code memory plugins.
#
#   bash apply.sh            apply where it fits, skip where already applied,
#                            replace an earlier version of the patch (previous/)
#   bash apply.sh --check    only report, change nothing
#   bash apply.sh --revert   undo the patch where it was applied
#
# Safe to run any number of times. Plugin auto-updates replace the patched
# files, so run it again after an update. Once upstream ships the fix, every
# installed version reports "upstream" and this script has nothing left to do.
#
# Targets bash 3.2 (macOS /bin/bash) and Linux.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-apply}"
case "$MODE" in apply|--check|--revert) ;; *) echo "usage: $0 [--check|--revert]" >&2; exit 2 ;; esac

# harness | plugin cache root | patch | a file that only the fixed version imports from
TARGETS="
codex|$HOME/.codex/plugins/cache/openviking/openviking-memory|codex-memory-plugin.patch|scripts/ov-session.mjs
claude|$HOME/.claude/plugins/cache/openviking/openviking-memory|claude-code-memory-plugin.patch|scripts/auto-capture.mjs
"

command -v git >/dev/null || { echo "git is required (git apply)" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required to verify the patched files" >&2; exit 1; }

# The earlier patch (previous/) applied to this copy, if any.
previous_patch() {
  local p
  for p in "$HERE"/previous/"${2%.patch}".*.patch; do
    [ -f "$p" ] || continue
    if (cd "$1" && git apply --reverse --check "$p" 2>/dev/null); then echo "$p"; return 0; fi
  done
  return 1
}

# Apply, then check the hook parses and the new shared module loads; undo on failure.
apply_verified() {
  local dir="$1" patch="$2" probe="$3"
  (cd "$dir" && git apply "$HERE/$patch") || return 1
  if node --check "$dir/$probe" \
    && node --input-type=module -e "await import('$dir/scripts/shared/transcript-cursor.mjs')"; then
    return 0
  fi
  (cd "$dir" && git apply --reverse "$HERE/$patch")
  return 1
}

CC_INSTALLED="$HOME/.claude/plugins/installed_plugins.json"

failed=0
while IFS='|' read -r harness root patch probe; do
  [ -n "$harness" ] || continue
  if [ ! -d "$root" ]; then
    echo "$harness: not installed ($root)"
    continue
  fi
  for dir in "$root"/*/; do
    dir="${dir%/}"
    ver="$(basename "$dir")"
    [ -f "$dir/$probe" ] || continue
    # Claude Code keeps old versions in its cache; only the installed one runs.
    if [ "$harness" = claude ] && [ -f "$CC_INSTALLED" ] && ! grep -qF "\"$dir\"" "$CC_INSTALLED"; then
      echo "$harness $ver: not the installed version, skipped"; continue
    fi
    # git apply resolves paths against the enclosing repository, if any.
    if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "$harness $ver: inside a git work tree, skipped"; continue
    fi
    if (cd "$dir" && git apply --reverse --check "$HERE/$patch" 2>/dev/null); then
      state=applied
    elif grep -q 'readTurnsFromCursor' "$dir/$probe"; then
      state=upstream
    elif prev="$(previous_patch "$dir" "$patch")"; then
      state=previous
    elif grep -q 'readJsonlRecords' "$dir/$probe"; then
      state=outdated
    elif (cd "$dir" && git apply --check "$HERE/$patch" 2>/dev/null); then
      state=unpatched
    else
      state=mismatch
    fi

    case "$MODE:$state" in
      apply:previous)
        (cd "$dir" && git apply --reverse "$prev")
        if (cd "$dir" && git apply --check "$HERE/$patch" 2>/dev/null) && apply_verified "$dir" "$patch" "$probe"; then
          echo "$harness $ver: earlier patch replaced"
        else
          (cd "$dir" && git apply "$prev")
          echo "$harness $ver: new patch did not fit or load, kept the earlier one" >&2; failed=1
        fi ;;
      apply:unpatched)
        if apply_verified "$dir" "$patch" "$probe"; then
          echo "$harness $ver: patched"
        else
          echo "$harness $ver: patched files did not load, reverted" >&2; failed=1
        fi ;;
      --revert:applied)
        (cd "$dir" && git apply --reverse "$HERE/$patch")
        echo "$harness $ver: reverted" ;;
      --revert:previous)
        (cd "$dir" && git apply --reverse "$prev")
        echo "$harness $ver: reverted the earlier patch" ;;
      *:applied)   echo "$harness $ver: already patched" ;;
      *:previous)  echo "$harness $ver: has an earlier patch; run without --check to replace it" ;;
      *:upstream)  echo "$harness $ver: fix already shipped upstream, nothing to do" ;;
      *:unpatched) echo "$harness $ver: not patched" ;;
      *:mismatch)  echo "$harness $ver: patch does not fit this version, skipped" ;;
      *:outdated)  echo "$harness $ver: has an older version of the fix; reinstall this plugin version, then run again" ;;
    esac
  done
done <<EOF
$TARGETS
EOF
exit "$failed"
