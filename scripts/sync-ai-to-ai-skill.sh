#!/usr/bin/env bash
set -euo pipefail

source_directory="/Users/giladbarnea/.agents/plugins/interaction/skills/ai-to-ai"
repository_root="$(git rev-parse --show-toplevel)"
destination_directory="$repository_root/skills/ai-to-ai"

rm -rf "$destination_directory"
mkdir -p "$(dirname "$destination_directory")"
cp -R "$source_directory" "$destination_directory"

# SKILL.md links to theory-of-mind.md at the plugin level, outside the skill
# directory. Copy it in and rewrite the link so the synced skill is self-contained.
cp "$source_directory/../../references/theory-of-mind.md" "$destination_directory/references/theory-of-mind.md"
sed -i '' 's|(\.\./\.\./references/theory-of-mind\.md)|(references/theory-of-mind.md)|' "$destination_directory/SKILL.md"
