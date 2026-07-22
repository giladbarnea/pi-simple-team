---
updated: 2026-07-17
status: implemented
---
# Support `max` teammate thinking

`team_spawn` now accepts `max` through each teammate's explicit `thinking` parameter.

The change is intentionally limited to the parameter schema and its matching local TypeScript type. The runtime already forwards the selected level unchanged to Pi's `--thinking` argument, so no additional execution branch was needed.

Model-suffix preflight behavior and the existing default of `xhigh` were left unchanged because they are separate from the requested parameter support.

Verification covered the registered tool schema, the extension's full Bun test suite, and a TypeScript no-emit check. All passed.

Pi's supported level set was confirmed in `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`.
