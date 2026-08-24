#!/usr/bin/env bash
set -euo pipefail

plugin_skills_directory="/Users/giladbarnea/.agents/plugins/interaction/skills"
plugin_references_directory="/Users/giladbarnea/.agents/plugins/interaction/references"
repository_root="$(git rev-parse --show-toplevel)"

for skill_name in ai-to-leader ai-to-delegated; do
	source_directory="$plugin_skills_directory/$skill_name"
	destination_directory="$repository_root/skills/$skill_name"

	rm -rf "$destination_directory"
	mkdir -p "$(dirname "$destination_directory")"
	cp -R "$source_directory" "$destination_directory"

	# The skills link to roles.md and theory-of-mind.md at the plugin level,
	# outside the skill directory. Copy both in and rewrite the links so each
	# synced skill is self-contained.
	cp "$plugin_references_directory/roles.md" "$plugin_references_directory/theory-of-mind.md" "$destination_directory/references/"
	sed -i '' 's|(\.\./\.\./references/|(references/|g' "$destination_directory/SKILL.md"
	find "$destination_directory/references" -name '*.md' -exec sed -i '' 's|(\.\./\.\./\.\./references/|(|g' {} +
done
