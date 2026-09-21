# pi-subagents-herdr

[amosblomqvist/pi-subagents](https://github.com/amosblomqvist/pi-subagents), extended with real [Herdr](https://herdr.dev) child panes and a **Hyprland-inspired master/stack layout**.

```text
One child                 Three children
┌──────────────┬─────────┐ ┌──────────────┬─────────┐
│              │         │ │              │ scout   │
│   main Pi    │  scout  │ │   main Pi    ├─────────┤
│  master 60%  │         │ │  master 60%  │ worker  │
│              │         │ │              ├─────────┤
│              │         │ │              │ research│
└──────────────┴─────────┘ └──────────────┴─────────┘
```

Each child's pane is labelled with its handle (`researcher-2`), not its agent type, so a stack of three researchers is three distinguishable panes. The first child splits **right** of the caller. Subsequent children append **down** in the stack; owned stack splits are rebalanced to equal heights. The master never becomes another shrinking stack pane. Child completion closes its pane and rebalances the remainder. The final child closing restores the original caller region.

- Keeps upstream's `subagent({ agent, task, cwd? })`, isolated contexts, and per-process concurrency limit.
- Real interactive Pi TUI in every child pane; structured event sidecars return results to the parent. No screen scraping or duplicate model runs.
- **Asynchronous dispatch**: `subagent` returns a handle (`scout-1`) as soon as the child starts, so the parent session stays interactive while children run. Each finished run is steered back as its own message, which wakes the parent and starts a turn. Results arrive independently, in whatever order they finish.
- **Children can ask**: a child that hits a decision only its caller can make calls `caller_ping` instead of guessing. Its run goes *paused* rather than finished, holding its session; `subagent_message(handle, answer)` puts the same child back to work from exactly where it stopped.
- A pinned widget above the editor lists every run still in flight, with its current tool call and elapsed time. When a run lands, its report arrives in the same shell pi draws around a tool call — a padded block on the tool background, titled with the handle, holding the tool log, prose, the report itself, usage and context gauge, with `Ctrl+O` for the rest. The ground says what became of the run: success, error, or pending while it waits on an answer. A subagent's words are never mistaken for the main agent's.
- Never focuses a child, creates another tab/workspace, or rearranges unrelated existing panes. A pre-existing multipane tab uses the caller's region, not the entire tab.
- **Flat topology**: no bundled agent carries the `subagent` tool, so every child is dispatched by the main session. The nesting machinery (`subagent_agents`, `PI_SUBAGENT_ALLOWED`, the cross-process layout lock) is still in place and dormant — granting `subagent` in an agent's frontmatter turns it back on, but a child that dispatches asynchronously and then settles will shut down before its own children finish.
- Parent cancellation/shutdown cleans up owned children. A runner heartbeat terminates a child after loss of its parent. Manual topology changes fail safely instead of rearranging unrelated panes.
- Outside Herdr, `auto` uses upstream-style headless JSON subprocesses. A Herdr failure is reported, never silently rerun in a second backend.
- Pluggable **runners**: an agent runs as a Pi child by default, or as a headless Claude Code child (`runner: claude`, process backend only). Both feed the same progress display, concurrency limit, cancellation and question loop.

## Install

Requires current Pi (`@earendil-works`, tested with **0.85.1**), Node **22+**, and Herdr with `layout.export` / `layout.set_split_ratio` (tested against API protocol **22**).

```bash
pi install git:github.com/torridfish/pi-subagents-herdr
# Private repository: Git must already be authenticated.
```

Or install a development checkout without copying it:

```bash
pi install /absolute/path/to/pi-subagents-herdr
```

Run `/reload` in an existing Pi session, or restart Pi. Do not install another extension registering `subagent` alongside this one.

Researcher/worker require **pi-web-access**, which supplies `web_search` and `fetch_content`:

```bash
pi install npm:pi-web-access
```

Children inherit your own Pi setup: extension discovery stays on, so they read the same `settings.json`, the same `web-search.json`, and load the same renderers, themes and commands you use in the parent. Tool access is still pinned by Pi's `--tools` allowlist, which applies to built-in, extension and custom tools alike — inheriting your extensions does not let an agent call anything it did not declare. Tools whose extension the child cannot rediscover (this repo's `safe_bash`, anything pinned via `toolExtensions`) are resolved from Pi's `sourceInfo.path` and passed with `--extension`. Missing declared tools cause an actionable error before launching. Set `inherit.extensions` to `false` for the old stock-Pi isolation.

## Usage

Ask Pi to delegate, for example:

> 用兩個 scout 同時探索 auth 與 database 模組，最後整合結果。

Tool call:

```json
{ "agent": "scout", "task": "Map the authentication module; report relevant file paths." }
```

`runner` is an optional third field; see [Runners](#runners).

| Agent | Purpose | Allowed tools |
|---|---|---|
| scout | Codebase exploration | read, grep, find, ls |
| researcher | Sourced web research | web_search, fetch_content |
| worker | Isolated implementation | read, write, edit, safe_bash, web_search, fetch_content |

No bundled agent can delegate: all three are dispatched by the main session and none carries `subagent`. Every Pi child additionally gets `caller_ping`, which no agent declares — see [Asking, and answering](#asking-and-answering). Include all task context explicitly; conversation history is not copied.

The call returns immediately with a handle rather than the answer:

```
→ scout-1 dispatched, running in background
```

While it runs, the widget above the editor shows it. When it lands, its report arrives as a `subagent_result` message that wakes the session — there is nothing to wait on or poll.

## Asking, and answering

Every Pi child gets one tool it never has to declare: `caller_ping`. A child that cannot make progress without a decision its caller owns — an ambiguous requirement, a credential it was not given, a destructive step it should not take unasked — asks for it rather than guessing.

The run then goes **waiting**, not finished:

```
? scout-1 asks: Should the migration drop the legacy column, or leave it?   1m4s
```

The child is still there while that line is on screen. **A subagent session ends only when its task is actually done** — a turn that settles with a question outstanding parks the session instead of shutting it down, holding its context, its findings and its place in the work, doing nothing and costing nothing until somebody replies.

The question is steered to the parent as a `subagent_question` message naming the handle, and `subagent_message` answers it:

```json
{ "handle": "scout-1", "message": "Leave it in place; a later migration removes it." }
```

It is one run throughout — one process, one handle, one roster row, one accumulating tool log and usage total, one report at the end. A run may ask and continue any number of times. If the answer is the user's to give, the parent is told to ask them rather than answer on their behalf.

### subagent_message

The same tool covers every way a parent has something more to say, dispatched by what the child is doing:

| Child is | What happens |
| --- | --- |
| **waiting** | The answer is delivered and it carries on from where it stopped |
| **running** | The message is steered into the turn in flight, landing between tool calls — for correcting a child you can see heading the wrong way |
| **finished** | Its session is started again from the file it wrote, with the message as the next thing it hears. Same context, same loadout, same handle |

Run directories therefore live as long as the Pi session that owns them, not as long as the child: a finished subagent is still addressable, and picking it back up is cheaper than dispatching a fresh one that would have to rediscover everything.

### How a message actually reaches a child

Two transports, because the two backends are different animals, and nothing above this line knows which is in play:

- **Process backend** — the child runs as `pi --mode rpc`, whose stdin is a JSONL command channel and whose stdout is the very same event stream print mode emitted. A message is a `prompt` command when the child is parked and a `steer` command when a turn is in flight; pi rejects the wrong one rather than papering over it, so which is which is tracked.
- **Herdr backend** — the child is a real interactive Pi in a pane, with no stdin its parent can write to. The message is typed into that pane and submitted, exactly as the human sitting in front of it would (newlines flattened, since the first one would submit the message half-written).

Neither is a blocking channel: the child is never waiting on a synchronous call into the parent, which would be a deadlock with a timeout attached the moment the parent was itself waiting on a model. A parked child is idle, and idle is cheap.

The question itself needs no sidecar file — it *is* the `caller_ping` tool call, and both backends already carry every tool call to the parent.

### Does a child actually ask?

Whether a child *reaches for* the tool is a prompt-surface question, not a plumbing one, so it is measured rather than argued about: `test/eval-ping.ts` gives a child a task it cannot finish honestly without asking, never tells it to ask, and counts. On `vllm/GLM-5.3-Flash-EXL3` the rate went from **1/6 to 5/6** when the guidelines were reordered to lead with "prefer asking over guessing" instead of with the restrictions, and a short delegation note was appended to every child's system prompt (n=6 per arm, Fisher p≈0.08 — a direction, not a proof). The same lesson `buildPromptSurface` already records for `subagent` itself: a tool introduced by its restrictions is a tool a smaller model never picks up.

A child that does not ask simply guesses, which is what it did before the feature existed — the floor is the old behaviour, not a worse one.

Both runners have it, by different plumbing. A pi child gets `caller_ping` from the child extension it already loads; Claude Code has no extensions, so a claude child gets the same tool from an MCP server (`runners/claude-ask.mjs`) passed in with `--mcp-config`, and sees it under the name its host gives it — `mcp__pi_subagents__caller_ping`. Neither one needs a channel home: the question is the tool call, and the parent is already reading every tool call off the child's stdout.

What differs is what keeps the child alive between turns. A pi child is driven over `--mode rpc` and shuts its own session down when the task is done. Claude Code's streaming input (`--input-format stream-json`) parks the same way, but a claude child cannot end its own session — so the parent closes its stdin once a turn settles with nothing outstanding. And where a pi run is picked back up from a session file in its run directory, a claude run is picked back up by id: `--session-id` at launch, `--resume` afterwards, against the conversation in your own session store.

## Runners

A **runner** is the child process that executes an agent. `pi` is the default and the only one the Herdr backend can drive. `claude` runs the agent as a headless `claude -p --output-format stream-json` process instead, and is **process-backend only**.

Select one per agent in `config.json`, or with `runner:` in an agent's frontmatter:

```json
{ "runners": { "scout": "claude" }, "models": { "scout": "anthropic/claude-sonnet-5" } }
```

A single call can also override both, which is how a conversational instruction reaches it — "send that one to claude" needs no config edit or `/reload`:

```json
{ "agent": "scout", "task": "Map the auth module.", "runner": "claude" }
```

Precedence: explicit `runner` on the call → per-agent config → `default` config → frontmatter → `pi`. An unrecognised name is refused instead of silently falling back. Under `backend: auto` a claude agent silently uses the process backend even inside Herdr; under an explicit `backend: herdr` it is refused with an error rather than opening a pane that can never report back. The reason is structural: a pane child returns its results through `herdr/child.ts`, which is itself a Pi extension, so only a Pi process can load it.

Everything downstream of the child is shared — the in-flight widget, the steered result and its `Ctrl+O` progress block, the concurrency semaphore, cancellation, and output truncation all work the same for both runners.

**Tool mapping.** Declared tools are translated to Claude Code's built-in names, and anything unmappable fails before the child is spawned. This check is load-bearing: `--tools` silently *drops* names Claude Code does not recognise, so an unvalidated mapping would produce an agent quietly missing a capability it declared.

| Declared | Claude Code | Declared | Claude Code |
|---|---|---|---|
| read | `Read` | web_search | `WebSearch` |
| write | `Write` | web_fetch | `WebFetch` |
| edit | `Edit` | fetch_content | `WebFetch` |
| bash | `Bash` | find | `Glob` |
| grep | `Grep` | ls | `Glob` |

`safe_bash` and `subagent` are rejected, so **worker cannot run under the claude runner**: Claude Code has no filtered shell, and its `Task` tool spawns its own agent types rather than the ones registered here. Scout and researcher map cleanly. `ls` folds into `Glob` because current Claude Code has no `LS` tool.

**Permissions.** The declared tools are passed as both `--tools` (what exists in the child) and `--allowedTools` (pre-approved, so a headless child never stops on a prompt), alongside `--permission-prompts none` so anything outside that set is denied instead of hanging forever. Pre-approving `bash`, `write` or `edit` is a real grant — the child runs them without asking. Denied calls are reported in the parent's transcript even when the run otherwise succeeds.

**Differences worth knowing.** `inherit.skills` maps to `--disable-slash-commands`; `inherit.extensions` has no exact analogue, and setting it to `false` only refuses your MCP servers (`--strict-mcp-config`) — a claude child still reads your `CLAUDE.md`, settings and hooks. Models are given as pi's `provider/model-id`; an `anthropic/` prefix is stripped and a bare alias (`sonnet`) passes through, while a non-Anthropic parent model is dropped so Claude Code picks its own default. `thinking` maps to `--effort`, with `off` floored at `low`. A claude child re-sends its own full system prompt, so a short task costs noticeably more than the same task on a pi child. Session persistence is left on, because it is what makes a finished child resumable: a claude child's conversation lands in your own session store rather than in its run directory, and so outlives the run directory that the end of a session reclaims.

A Pi child exits when its task is done — not when a turn ends, which is the difference that lets it wait on a question (see [Asking, and answering](#asking-and-answering)). Each keeps a session file and a loadout snapshot in its own temporary run directory, so the same child can be spoken to again later; none of it is written to your session store, and the whole directory goes when the Pi session that owns it ends. Results and live progress remain in the parent's tool transcript. `safe_bash` is a heuristic command filter, **not a security sandbox**; workers have normal file access.

## Configuration

Copy `config.json.example` to `config.json` beside `index.ts` (gitignored):

```json
{
  "backend": "auto",
  "maxConcurrency": 4,
  "masterRatio": 0.6,
  "minPaneRows": 8,
  "models": {},
  "toolExtensions": {},
  "inherit": { "extensions": true, "skills": false }
}
```

- `backend`: `auto`, `herdr`, or `process`.
- `masterRatio`: left/master share, 0.2–0.8. Only applied when opening the first child.
- `maxConcurrency`: positive integer, per parent process, default 4.
- `minPaneRows`: minimum rows per child, default 8. If the shared stack is full, the next call fails with a capacity message rather than creating an unreadable pane. Nested agents count toward this geometry limit, but have their own execution semaphore.
- `runners`: agent name → `pi` (default) or `claude`; `default` is an optional fallback. See [Runners](#runners).
- `claude`: settings for the claude runner — `command` (default `claude`, resolved on PATH), `permissionMode` (passed to `--permission-mode`; declared tools are pre-approved regardless), and `maxBudgetUsd` (passed to `--max-budget-usd`, a hard per-child ceiling). Ignored by pi-run agents.
- `models`: agent name → exact `provider/model-id`; `default` is an optional fallback. Precedence: per-agent config → default config → agent frontmatter → parent model. Bundled agents inherit the parent's current model; no Anthropic credentials are assumed.
- `toolExtensions`: optional tool name → absolute extension file path; overrides automatic discovery. A pinned tool is always handed to the child explicitly.
- `inherit.extensions`: load your installed Pi packages in children, default `true`. `false` restores the previous `--no-extensions` isolation, where a child runs stock Pi plus only the extensions backing its declared tools — and therefore ignores whatever those packages read from your configuration.
- `inherit.skills`: load your skills in children, default `false`. Skills cost context in every child and any tool one registers is filtered out by the allowlist anyway, so turn this on only for an agent that declares that tool.

Session-only backend selection:

```text
/subagents-herdr status
/subagents-herdr herdr
/subagents-herdr process
/subagents-herdr auto
```

The command selects the transport; it does not launch a new Herdr server. Start Pi inside Herdr to use pane mode.

Custom agent registration retains upstream's `globalThis.__pi_subagents` bridge; see [upstream documentation](docs/UPSTREAM-README.md#registering-agents-from-other-extensions). Its old hardcoded web-tool installation and model defaults are superseded by the settings above. This fork does not add project-local agent discovery.

## Development and verification

```bash
npm install
npm test
npm run typecheck

# Explicit opt-in: briefly creates four panes in the calling tab, then cleans up.
npx tsx test/live-layout.ts

# Explicit opt-in: invokes a real model using your existing Pi credentials.
PI_TEST_MODEL=provider/model-id npx tsx test/live-agent.ts

# Also exercise worker → two parallel scouts in the same stack:
PI_TEST_MODEL=provider/model-id PI_TEST_NESTED=1 \
  PI_TEST_WEB_EXTENSION=/absolute/path/to/pi-web-access/index.ts \
  npx tsx test/live-agent.ts
```

```bash
# Explicit opt-in: runs a real Pi child AND a real Claude Code child (read-only
# scouts), and incurs usage on both.
PI_TEST_MODEL=provider/model-id CLAUDE_TEST_MODEL=sonnet npx tsx test/live-runners.ts

# Explicit opt-in: a real Pi child that pauses on a question and is resumed.
# Run it inside Herdr to exercise the pane path as well as the process one.
PI_TEST_MODEL=provider/model-id npx tsx test/live-ping.ts

# The same loop under the claude runner, plus picking the child back up by
# session id once it has exited. Defaults to haiku.
CLAUDE_TEST_MODEL=haiku npx tsx test/live-claude-ping.ts

# Explicit opt-in: N real children, measuring how often one asks rather than
# guesses. An A/B harness for the prompt surface, not a pass/fail test.
PI_TEST_MODEL=provider/model-id EVAL_N=6 npx tsx test/eval-ping.ts
```

The live layout test checks four equal-height children, preserved focus, and rebalancing after middle-pane removal. The live agent test checks actual interactive Pi startup, event bridging, final output, and cleanup. The live runners test dispatches the same task twice through the real `subagent` tool: once with nothing specified, asserting it went to Pi, and once with `runner: "claude"`, asserting a real headless Claude Code child ran it. Both are checked for tool-call bridging, usage accounting and a completed result. The live ping test makes a child ask a question it cannot answer itself, then resumes it with a passphrase and asserts the passphrase comes back in the finished report — which only holds if the same child, with the context it had built, received the answer. The live claude ping test makes the same claim of a real Claude Code child, and adds the leg only that runner has: picking the child back up by session id after it has already exited, and asking it what the passphrase was. Unit tests cover ownership boundaries, cross-process-manager serialization, capacity, argument conversion, shell quoting, runner selection and its precedence, the claude tool mapping, its argv shape, its stream-json event adapter, and the pause loop end to end against a stand-in child.

Herdr configuration and server versions are never modified. API calls are bounded by a timeout. Temporary task/event/environment files are private (directory 0700, files 0600) and removed after completion. Abrupt parent death can leave its temporary files and shell pane behind; the heartbeat stops the child process, but does not delete state owned by a dead parent.

## Provenance

Based directly on upstream history at `1f541897588b995144f0bb8e71a335d1c85b1e62`. Herdr execution UX was informed by [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents), while layout and transport code here are newly implemented. See [PROVENANCE.md](PROVENANCE.md) before redistribution: the base repository supplied no LICENSE, so this repository is private and is not represented as MIT-licensed.
