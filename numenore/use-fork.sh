#!/usr/bin/env bash
#
# Point this machine's OpenViking memory plugins (Codex, Claude Code) at the
# numenoreltd-lab fork, so every re-download keeps the fork's fixes.
#
#   bash use-fork.sh               switch to the fork and update
#   bash use-fork.sh --check       report where each plugin comes from
#   bash use-fork.sh --upstream    switch back to volcengine/OpenViking main
#
# Run it from a checkout of the fork's `numenore` branch (see README.md).
# Targets bash 3.2 (macOS /bin/bash) and Linux. Needs git, node, python3.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FORK_URL="${OPENVIKING_FORK_URL:-https://github.com/numenoreltd-lab/OpenViking.git}"
FORK_REF="${OPENVIKING_FORK_REF:-numenore}"
UPSTREAM_URL="https://github.com/volcengine/OpenViking.git"
UPSTREAM_REF="main"

MODE="${1:-fork}"
case "$MODE" in
  fork|--fork) URL="$FORK_URL"; REF="$FORK_REF" ;;
  --upstream)  URL="$UPSTREAM_URL"; REF="$UPSTREAM_REF" ;;
  --check)     URL=""; REF="" ;;
  *) echo "usage: $0 [--check|--upstream]" >&2; exit 2 ;;
esac

CODEX_CONFIG="${CODEX_CONFIG_FILE:-$HOME/.codex/config.toml}"
CODEX_MKT="$HOME/.codex/.tmp/marketplaces/openviking"
CC_MANIFEST="$HOME/.openviking/marketplaces/openviking-claude/.claude-plugin/marketplace.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

# ---- Codex: [marketplaces.openviking] source/ref in config.toml -------------
codex_now() {
  python3 - "$CODEX_CONFIG" <<'EOF'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r'^\[marketplaces\.openviking\]\n(.*?)(?=^\[|\Z)', s, re.S | re.M)
if not m: print("not-installed"); sys.exit()
src = re.search(r'^source = "([^"]*)"', m.group(1), re.M)
ref = re.search(r'^ref = "([^"]*)"', m.group(1), re.M)
print(f'{src.group(1) if src else "?"} @ {ref.group(1) if ref else "?"}')
EOF
}

codex_switch() {
  cp -p "$CODEX_CONFIG" "$CODEX_CONFIG.bak-$STAMP-openviking"
  python3 - "$CODEX_CONFIG" "$URL" "$REF" <<'EOF'
import re, sys
path, url, ref = sys.argv[1:4]
s = open(path).read()
m = re.search(r'^\[marketplaces\.openviking\]\n(.*?)(?=^\[|\Z)', s, re.S | re.M)
block = m.group(1)
block = re.sub(r'^source = "[^"]*"', f'source = "{url}"', block, flags=re.M)
if re.search(r'^ref = ', block, re.M):
    block = re.sub(r'^ref = "[^"]*"', f'ref = "{ref}"', block, flags=re.M)
else:
    block = block.replace(f'source = "{url}"', f'source = "{url}"\nref = "{ref}"', 1)
open(path, "w").write(s[:m.start(1)] + block + s[m.end(1):])
EOF
  codex plugin marketplace upgrade openviking
}

# ---- Claude Code: the directory marketplace the OpenViking installer wrote --
cc_now() {
  [ -f "$CC_MANIFEST" ] || { echo "not-installed"; return; }
  python3 - "$CC_MANIFEST" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
src = next(p["source"] for p in d["plugins"] if p["name"] == "openviking-memory")
print(f'{src.get("url")} @ {src.get("ref")}')
EOF
}

cc_switch() {
  cp -p "$CC_MANIFEST" "$CC_MANIFEST.bak-$STAMP"
  python3 - "$CC_MANIFEST" "$URL" "$REF" <<'EOF'
import json, sys
path, url, ref = sys.argv[1:4]
d = json.load(open(path))
d["description"] = f"OpenViking plugins for Claude Code (remote: {url} @ {ref})."
for p in d["plugins"]:
    if p["name"] == "openviking-memory":
        p["source"]["url"] = url; p["source"]["ref"] = ref
with open(path, "w") as f: json.dump(d, f, indent=2); f.write("\n")
EOF
  claude plugin marketplace update openviking
  claude plugin update openviking-memory@openviking
}

# ---- run ---------------------------------------------------------------------
echo "codex:  $( [ -f "$CODEX_CONFIG" ] && codex_now || echo not-installed )"
echo "claude: $(cc_now)"
[ "$MODE" = "--check" ] && { bash "$HERE/apply.sh" --check; exit 0; }

if [ -f "$CODEX_CONFIG" ] && [ "$(codex_now)" != "not-installed" ]; then
  if command -v codex >/dev/null; then codex_switch; echo "codex:  -> $(codex_now)"
  else echo "codex: config found but the codex CLI is not on PATH, skipped" >&2; fi
fi
if [ "$(cc_now)" != "not-installed" ]; then
  if command -v claude >/dev/null; then cc_switch; echo "claude: -> $(cc_now)"
  else echo "claude: marketplace found but the claude CLI is not on PATH, skipped" >&2; fi
fi

# Cap a catch-up backlog for every harness (plugin-level key in ovcli.conf).
CATCH_UP_MAX_TURNS="${OPENVIKING_CAPTURE_CATCH_UP_MAX_TURNS_DEFAULT:-1000}"
OVCLI="${OPENVIKING_CLI_CONFIG_FILE:-$HOME/.openviking/ovcli.conf}"
if [ "$MODE" != "--upstream" ] && [ -f "$OVCLI" ]; then
  python3 - "$OVCLI" "$CATCH_UP_MAX_TURNS" "$STAMP" <<'PY'
import json, shutil, sys
path, turns, stamp = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.load(open(path))
plugin = d.setdefault("plugin", {})
if plugin.get("captureCatchUpMaxTurns") != turns:
    shutil.copy2(path, f"{path}.bak-{stamp}")
    plugin["captureCatchUpMaxTurns"] = turns
    with open(path, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False); f.write("\n")
print(f"ovcli.conf: plugin.captureCatchUpMaxTurns = {turns}")
PY
fi

# Claude Code downloads only when the version number changes, so a version it
# already has stays on the old source until the next release. Patch that copy
# in place; the next release then comes from the fork by itself.
if [ "$MODE" != "--upstream" ]; then bash "$HERE/apply.sh"; fi
echo "Restart open Claude Code / Codex sessions to load the plugin they now have."
