# Provenance and redistribution

## Base code

- Repository: https://github.com/amosblomqvist/pi-subagents
- Base commit: `1f541897588b995144f0bb8e71a335d1c85b1e62`
- Original Git history is retained; the original README is preserved in `docs/UPSTREAM-README.md`.
- `index.ts`, `tools/safe-bash.ts`, and bundled agent definitions are derived from this base.
- No LICENSE file was present in that upstream checkout, and GitHub reported its license as null. Public availability is not a blanket redistribution license. Do not publish this derivative publicly or claim it is MIT-licensed without permission from the base author or a subsequently supplied applicable license.

## Reference project

- Repository: https://github.com/0xRichardH/pi-herdr-subagents
- Reviewed commit: `7180d986a712e7627986a147ca8e5d5a4e0265da`
- Reference project license: MIT.
- Consulted for Herdr pane execution, explicit-ID/no-focus behavior, and structured child lifecycle concepts. Its async orchestration implementation was not transplanted.

## New implementation

`herdr/` implements a new local socket client, owned master/stack layout management, interactive child event bridge, and runner transport. The layout is inspired by Hyprland's master/stack behavior; no Hyprland source code is included and Hyprland is not a dependency.

This repository is private and `package.json` sets `private: true` to prevent accidental npm publication. Neither measure substitutes for obtaining redistribution permission.
