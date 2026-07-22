#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
git -C "$repository_root" config core.hooksPath .githooks
printf 'Git hooks enabled for %s\n' "$repository_root"
