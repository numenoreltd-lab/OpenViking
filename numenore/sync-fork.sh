#!/usr/bin/env bash
#
# Bring the fork up to date with volcengine/OpenViking.
#
#   main                          = upstream main, unchanged
#   fix/stream-large-transcripts  = upstream main + the fix commit (the PR branch)
#   numenore                      = that + this numenore/ folder (what machines install)
#
# Works in a throwaway clone, runs the plugin tests, and pushes only if they
# pass. Needs push access to the fork (FORK_PUSH_URL).
#
#   bash sync-fork.sh            sync and push
#   bash sync-fork.sh --dry-run  sync and test, push nothing

set -euo pipefail

FORK_PUSH_URL="${FORK_PUSH_URL:-git@github.com-numenoreltd-260719:numenoreltd-lab/OpenViking.git}"
UPSTREAM_URL="https://github.com/volcengine/OpenViking.git"
FIX_BRANCH="fix/stream-large-transcripts"
DIST_BRANCH="numenore"
DRY_RUN=0; [ "${1:-}" = "--dry-run" ] && DRY_RUN=1

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
git clone -q --filter=blob:none "$FORK_PUSH_URL" "$work/ov"
cd "$work/ov"
git remote add upstream "$UPSTREAM_URL"
git fetch -q upstream main
git fetch -q origin "$FIX_BRANCH" "$DIST_BRANCH"
base="$(git rev-parse upstream/main)"
echo "upstream main: $(git log -1 --format='%h %cd %s' --date=short "$base")"

# The fix: replay it on upstream main. If upstream already has it, nothing is left.
git checkout -q -B "$FIX_BRANCH" "origin/$FIX_BRANCH"
git rebase -q upstream/main
fix_commits="$(git rev-list --count upstream/main..HEAD)"
if [ "$fix_commits" = "0" ]; then
  echo "The fix is in upstream main now. Switch machines back with: bash numenore/use-fork.sh --upstream"
fi
node examples/memory-plugin-shared/sync.mjs >/dev/null
if [ -n "$(git status --porcelain)" ]; then
  echo "sync.mjs changed vendored files after the rebase; commit them by hand" >&2; git status --short >&2; exit 1
fi
node --test examples/memory-plugin-shared/jsonl-file.test.mjs >/dev/null 2>&1 || [ "$fix_commits" = "0" ] || { echo "jsonl-file tests failed" >&2; exit 1; }
node --test examples/codex-memory-plugin/scripts/*.test.mjs >/dev/null 2>&1 || { echo "codex plugin tests failed" >&2; exit 1; }
node --test examples/claude-code-memory-plugin/scripts/*.test.mjs examples/claude-code-memory-plugin/scripts/lib/*.test.mjs >/dev/null 2>&1 || { echo "claude plugin tests failed" >&2; exit 1; }
fix_head="$(git rev-parse HEAD)"

# The distribution branch: the fix plus this folder, with patches regenerated
# against the new base.
git checkout -q -B "$DIST_BRANCH" "$fix_head"
git checkout -q "origin/$DIST_BRANCH" -- numenore
git diff "$base" "$fix_head" --relative=examples/codex-memory-plugin > numenore/codex-memory-plugin.patch
git diff "$base" "$fix_head" --relative=examples/claude-code-memory-plugin > numenore/claude-code-memory-plugin.patch
git add numenore
git -c user.name="Numenore" -c user.email="numenoreltd@gmail.com" commit -q -m "chore(numenore): fork tooling on $(git log -1 --format=%h "$base")"

if [ "$DRY_RUN" = "1" ]; then echo "dry run: tests passed, nothing pushed"; exit 0; fi
git push -q origin "$base:refs/heads/main"
git push -q --force-with-lease="$FIX_BRANCH" origin "$FIX_BRANCH"
git push -q --force-with-lease="$DIST_BRANCH" origin "$DIST_BRANCH"
echo "pushed: main=$(git rev-parse --short "$base") $FIX_BRANCH=$(git rev-parse --short "$fix_head") $DIST_BRANCH=$(git rev-parse --short HEAD)"
echo "Machines pick it up on Codex's next marketplace refresh, or: codex plugin marketplace upgrade openviking"
