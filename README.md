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

The first child splits **right** of the caller. Subsequent children append **down** in the stack; owned stack splits are rebalanced to equal heights. The master never becomes another shrinking stack pane. Child completion closes its pane and rebalances the remainder. The final child closing restores the original caller region.

- Keeps upstream's `subagent({ agent, task, cwd? })`, streamed tool/usage display, `Ctrl+O`, isolated contexts, and per-process concurrency limit.
- Real interactive Pi TUI in every child pane; structured event sidecars return results to the parent. No screen scraping or duplicate model runs.
- **Task-scoped, synchronous tool semantics**: calls wait for results; multiple tool calls run concurrently. This is **not** the async notification/resume/planner system from `pi-herdr-subagents`.
- Never focuses a child, creates another tab/workspace, or rearranges unrelated existing panes. A pre-existing multipane tab uses the caller's region, not the entire tab.
- Nested worker → scout/researcher calls inherit a shared, cross-process-locked stack. They do not split their worker into miniature columns.
- Parent cancellation/shutdown cleans up owned children. A runner heartbeat terminates a child after loss of its parent. Manual topology changes fail safely instead of rearranging unrelated panes.
- Outside Herdr, `auto` uses upstream-style headless JSON subprocesses. A Herdr failure is reported, never silently rerun in a second backend.

## Install

Requires current Pi (`@earendil-works`, tested with **0.85.1**), Node **22+**, and Herdr with `layout.export` / `layout.set_split_ratio` (tested against API protocol **22**).

```bash
pi install git:github.com/torrid-fish/pi-subagents-herdr
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

| Agent | Purpose | Allowed tools |
|---|---|---|
| scout | Codebase exploration | read, grep, find, ls |
| researcher | Sourced web research | web_search, fetch_content |
| worker | Isolated implementation | read, write, edit, safe_bash, web_search, fetch_content, subagent |

Worker may spawn only scout/researcher. They cannot delegate further. Include all task context explicitly; conversation history is not copied.

Child Pi sessions automatically exit when the task settles; these are not persistent handoff/resume sessions. Results and live progress remain in the parent's tool transcript. `safe_bash` is a heuristic command filter, **not a security sandbox**; workers have normal file access.

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

The live layout test checks four equal-height children, preserved focus, and rebalancing after middle-pane removal. The live agent test checks actual interactive Pi startup, event bridging, final output, and cleanup. Unit tests cover ownership boundaries, cross-process-manager serialization, capacity, argument conversion, and shell quoting.

Herdr configuration and server versions are never modified. API calls are bounded by a timeout. Temporary task/event/environment files are private (directory 0700, files 0600) and removed after completion. Abrupt parent death can leave its temporary files and shell pane behind; the heartbeat stops the child process, but does not delete state owned by a dead parent.

## Provenance

Based directly on upstream history at `1f541897588b995144f0bb8e71a335d1c85b1e62`. Herdr execution UX was informed by [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents), while layout and transport code here are newly implemented. See [PROVENANCE.md](PROVENANCE.md) before redistribution: the base repository supplied no LICENSE, so this repository is private and is not represented as MIT-licensed.
