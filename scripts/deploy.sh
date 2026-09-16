#!/usr/bin/env bash
# Atomic deploy: build -> renamed copy -> client id rewrite, one transaction.
# INVARIANT (violation = whole client bundle fails = full GUI white screen):
#   client.js registration id MUST equal the deployed copy package.json name.
# Usage: deploy.sh <mount-name> <copy-dir>
set -euo pipefail

MOUNT="${1:?usage: deploy.sh <mount-name> <copy-dir>}"
LIVE="${2:?usage: deploy.sh <mount-name> <copy-dir>}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "[deploy] build $SRC"
bash "$SRC/scripts/build.sh" >/dev/null

echo "[deploy] copy -> $LIVE (mount=$MOUNT)"
rm -rf "$LIVE"; mkdir -p "$LIVE"
cp "$SRC/package.json" "$LIVE/package.json"
cp -R "$SRC/lib" "$LIVE/lib"
cp -R "$SRC/assets" "$LIVE/assets" 2>/dev/null || true
ln -s "$SRC/node_modules" "$LIVE/node_modules"
printf "export * from './lib/index.js'\n" > "$LIVE/index.js"
cp "$LIVE/lib/client.js" "$LIVE/client.js"

python3 - "$LIVE" "$MOUNT" <<'PY'
import json, sys, re
live, mount = sys.argv[1], sys.argv[2]
p = live + "/package.json"
d = json.load(open(p)); d["name"] = mount
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
for f in (live + "/lib/client.js", live + "/client.js"):
    s = open(f).read()
    s2 = re.sub(r'id: "@dsh-external/dsh-agent-billing[^"]*"', 'id: "%s"' % mount, s, count=1)
    assert s2 != s, "client id rewrite failed"
    open(f, "w").write(s2)
print("[deploy] name and client id synced =", mount)
PY

pkg=$(python3 -c "import json;print(json.load(open('$LIVE/package.json'))['name'])")
cid=$(grep -o 'id: "[^"]*"' "$LIVE/lib/client.js" | head -1 | sed 's/id: "//;s/"//')
[ "$pkg" = "$cid" ] || { echo "[deploy] FAIL invariant pkg=$pkg cid=$cid" >&2; exit 2; }
echo "[deploy] OK invariant holds ($pkg) - mount with dev_inject_plugin dir=$LIVE"
