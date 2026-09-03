#!/usr/bin/env bash
# Regenerate this plugin's own stylesheet (assets/plugin.css) from its content
# globs. Maintainer task — the generated CSS is committed, so end users / Docker
# / desktop builds never run this. Run it whenever you add Tailwind classes to
# screen.js / settings.html, and bump the plugin.json `version` so the injected
# <link>'s ?v= cache-buster fetches the fresh file.
#
# Pin the same Tailwind 3.x core uses so output stays diff-stable across
# rebuilds. Utilities only (corePlugins.preflight=false in tailwind.config.js) —
# core ships the one base reset.
set -euo pipefail
cd "$(dirname "$0")"
exec npx -y tailwindcss@3.4.19 \
    -c tailwind.config.js \
    -i _plugin.src.css \
    -o assets/plugin.css \
    --minify
