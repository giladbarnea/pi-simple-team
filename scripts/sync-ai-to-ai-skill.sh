#!/usr/bin/env bash
set -euo pipefail

source_directory="/Users/giladbarnea/.agents/plugins/interaction/skills/ai-to-ai"
repository_root="$(git rev-parse --show-toplevel)"
destination_directory="$repository_root/skills/ai-to-ai"

rm -rf "$destination_directory"
mkdir -p "$(dirname "$destination_directory")"
cp -R "$source_directory" "$destination_directory"
