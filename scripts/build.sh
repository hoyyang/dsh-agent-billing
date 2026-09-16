#!/bin/bash
# dsh-agent-billing build: host (tsc) + 依赖链接。
# 本机现实：无源码 checkout，DSH 以 npm 安装版存在（node_modules 内含 @types/node 与官方依赖包）。
# devDeps（typescript/tsdown）在插件目录 npm install（带缓存判定，已装则跳过）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 1. 定位 DSH 安装（env → 源码 checkout → npm 全局安装版）──
DSHPKG="${DSH_CHECKOUT:-}"
if [ -z "$DSHPKG" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then DSHPKG="$candidate"; break; fi
  done
fi
if [ -z "$DSHPKG" ] || [ ! -d "$DSHPKG/node_modules/@deepseek-ai" ]; then
  for candidate in "~/.npm-global/lib/node_modules/@deepseek-ai/dsh" "$(npm root -g 2>/dev/null)/@deepseek-ai/dsh"; do
    if [ -n "$candidate" ] && [ -d "$candidate/node_modules/@deepseek-ai" ]; then DSHPKG="$candidate"; break; fi
  done
fi
if [ -z "$DSHPKG" ] || [ ! -d "$DSHPKG/node_modules/@deepseek-ai" ]; then
  echo "build: cannot locate the dsh installation (set DSH_CHECKOUT)" >&2
  exit 1
fi
echo "=== DSH install: $DSHPKG ==="

# ── 2. devDeps（typescript / tsdown / @types/node）：缺才装 ──
if [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/tsdown ]; then
  echo "=== Installing devDependencies (typescript, tsdown) ==="
  npm install --legacy-peer-deps --no-audit --no-fund --loglevel=error
fi

# ── 3. 链接编译期依赖（官方包 + @types/node；源码 checkout 用 packages/*，npm 版用 node_modules/*）──
echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai
link_pkg() {
  local link="node_modules/$1"
  local target="$DSHPKG/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  if [ -e "$link" ] && [ "$(readlink "$link" 2>/dev/null)" = "$target" ]; then return 0; fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$link" "$target"
}
link_pkg cordis node_modules/@deepseek-ai/cordis
link_pkg cosmokit node_modules/@deepseek-ai/cosmokit
link_pkg schemastery node_modules/@deepseek-ai/schemastery
link_pkg @deepseek-ai/dsh-llm node_modules/@deepseek-ai/dsh-llm
link_pkg @types/node node_modules/@types/node

# ── 4. 编译 host（src/index.ts → lib/index.js + lib/types）──
echo "=== Compiling host (tsc) ==="
node_modules/.bin/tsc -p tsconfig.json
# 内置官方规则库随包分发（Catalog 全量计费规则快照）
cp assets/official-rules.json lib/official-rules.json
echo "=== Host build complete ==="
