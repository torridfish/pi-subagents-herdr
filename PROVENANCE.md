# Provenance and redistribution

## Base code

- Repository: https://github.com/amosblomqvist/pi-subagents
- Base commit: `1f541897588b995144f0bb8e71a335d1c85b1e62`
- Original Git history is retained; the original README is preserved in `docs/UPSTREAM-README.md`.
- `index.ts`, `tools/safe-bash.ts`, and bundled agent definitions are derived from this base.
- No LICENSE file was present in that upstream checkout, and GitHub reported its license as null.

## Publication

This repository is published as a GitHub fork of the base repository, with the original history and authorship intact (see `git log`). The fork relationship is what makes public availability legitimate here: GitHub's Terms of Service cover use of forked content on GitHub — the same basis every other public fork of the base repository stands on. Nothing in this repository is represented as MIT-licensed, and redistribution outside GitHub still requires the base author's permission.

## Reference project

- Repository: https://github.com/0xRichardH/pi-herdr-subagents
- Reviewed commit: `7180d986a712e7627986a147ca8e5d5a4e0265da`
- Reference project license: MIT.
- Consulted for Herdr pane execution, explicit-ID/no-focus behavior, and structured child lifecycle concepts. Its async orchestration implementation was not transplanted.

## Reference projects for the question/answer loop

Both repositories below are one lineage, and the attribution matters more than the link: the project that was read is not the project that designed the thing.

**Origin — [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)** (Daniel Griesser, MIT). Originated `caller_ping` itself, in commit `7f0d5dd` (2026-04-12): a child writes `{type:"ping", name, message}` to a `${sessionFile}.exit` sidecar, shuts its session down, and the parent resumes it with the answer. That exit-then-resume design is what this repository shipped first, down to the tool name; the sidecar-in-the-run-directory variant here was written independently, but the idea is Daniel's. The `0xRichardH/pi-herdr-subagents` repository cited above is a fork of this one — 153 of its 235 commits are Daniel's, and its `caller_ping` is the same commit — so the attribution in the section above should be read the same way.

**The four designs adopted later are Amos Blomqvist's**, authored in his port of the subagents work into that project, and read here through a downstream fork of it:

| Design | Commit | Date |
| --- | --- | --- |
| `subagent_message` — one name-addressed tool collapsing `subagent_interrupt` + `subagent_resume` | `39b1f85` | 2026-06-27 |
| A question stops ending the session: `awaitingAnswer` parks it instead, and `caller_ping` becomes `ask_question` | `20332d8` | 2026-06-28 |
| Prompt framing that leads with "Prefer asking over guessing" rather than with restrictions | `20332d8` | 2026-06-28 |
| Snapshotting the resolved loadout so a resumed child is the same sandbox | `a541b3d` | 2026-07-06 |

Amos Blomqvist is also the author of this repository's own base (`amosblomqvist/pi-subagents`, above), though the two histories share no commits. One further fix of his was arrived at independently here and is worth naming because it is subtle: clearing the waiting flag on `input` rather than only on `agent_start`, so a reply steered into a turn already running is not left marking the child as still waiting (`865648c`).

**What was taken, and what was not.** No code was transplanted from any of them. The transports differ: those projects are tmux/cmux-based and type an answer into a live pane, while this one drives a headless child over a stdin channel on the process backend — pi's RPC protocol, or Claude Code's streaming input for a claude child — and types into the pane only on the Herdr backend. What was taken is the design judgement — that a question should park a session rather than end it, that one message tool beats a separate resume tool, that a loadout worth restoring is worth snapshotting, and that a tool introduced by its restrictions is one a smaller model never reaches for (measured here in `test/eval-ping.ts`: 1/6 → 5/6).

## New implementation

`herdr/` implements a new local socket client, owned master/stack layout management, interactive child event bridge, and runner transport. The layout is inspired by Hyprland's master/stack behavior; no Hyprland source code is included and Hyprland is not a dependency.

This repository is private and `package.json` sets `private: true` to prevent accidental npm publication. Neither measure substitutes for obtaining redistribution permission.
