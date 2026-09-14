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

## Second reference project

- Repository: https://github.com/G36maid/pi-interactive-subagents
- Reviewed commit: `b0227d4018d458c0e578f73b3de6c3b588c4b1b4`
- Reference project license: MIT.
- Consulted for its `ask_question` and `subagent_message` tools while building `caller_ping`. Three of its design decisions were adopted after review, and are better than what they replaced here: a child that asks a question **parks its session rather than exiting**, so a subagent session ends only when its task is done; **one name-addressed message tool** covers answering, steering and picking a finished child back up, rather than a separate resume tool; and the **fully-resolved loadout is snapshotted** so a child restarted later is the same sandbox rather than whatever the config says at the time. Its prompt framing was adopted too — leading with "prefer asking over guessing" rather than with the restrictions — which measurably changes how often a smaller model uses the tool at all (`test/eval-ping.ts`, 1/6 → 5/6).
- No code was transplanted, and the transports differ: that project is tmux-only and types answers into a live pane, while this one drives a headless child over pi's RPC protocol on the process backend and types into the pane only on the Herdr backend.

## New implementation

`herdr/` implements a new local socket client, owned master/stack layout management, interactive child event bridge, and runner transport. The layout is inspired by Hyprland's master/stack behavior; no Hyprland source code is included and Hyprland is not a dependency.

This repository is private and `package.json` sets `private: true` to prevent accidental npm publication. Neither measure substitutes for obtaining redistribution permission.
