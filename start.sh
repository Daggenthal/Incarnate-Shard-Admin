#!/usr/bin/env bash
# Starts Incarnate Shard Admin: installs Electron the first time (npm install), then opens the window.
set -euo pipefail
if ! command -v node > /dev/null 2>&1; then
    for d in /opt/homebrew/opt/node/bin /usr/local/opt/node/bin /opt/homebrew/opt/node@*/bin /usr/local/opt/node@*/bin; do
        if [ -x "$d/node" ]; then export PATH="$d:$PATH"; break; fi
    done
fi
if ! command -v node > /dev/null 2>&1; then
    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then r=$'\e[31m'; o=$'\e[0m'; else r=; o=; fi
    printf '%sNode.js not found.%s Install it with "brew install node" (macOS) or your package manager.\n' "$r" "$o" >&2
    exit 1
fi
cd "$(dirname "$0")"
if [ ! -d node_modules/electron ]; then
    echo "Shard Admin: first run, installing Electron (npm install)"
    npm install --no-audit --no-fund
fi
exec npm start --silent
