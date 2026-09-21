import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import type { AgentConfig, AgentProgress, AgentResult } from "../index.ts";
import { buildClaudeArgs, CLAUDE_ASK_TOOL, CLAUDE_DEFAULT_MODEL, makeClaudeLineHandler, resolveClaudeModel } from "../runners/claude.ts";
import { DEFAULT_INHERIT } from "../index.ts";

const AGENT: AgentConfig = {
  name: "probe", description: "", tools: ["read", "grep", "find", "ls"],
  model: "anthropic/claude-sonnet-5", thinking: "medium", systemPrompt: "be brief", filePath: "",
  runner: "claude",
};

async function build(overrides: Partial<AgentConfig> = {}, inherit = DEFAULT_INHERIT, config = {}) {
  const built = await buildClaudeArgs({ ...AGENT, ...overrides }, "do the thing", process.cwd(), inherit, config);
  fs.rmSync(built.tempDir, { recursive: true, force: true });
  return built;
}

function valuesAfter(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
  return out;
}

test("declared tools map onto real Claude Code tool names, deduped", async () => {
  const { args } = await build();
  // `find` and `ls` both land on Glob — Claude Code has no LS tool.
  assert.deepEqual(valuesAfter(args, "--tools"), ["Read", "Grep", "Glob"]);
  // --tools decides what exists; --allowedTools stops a headless child
  // prompting, and carries the ask tool, which --tools does not govern.
  assert.deepEqual(valuesAfter(args, "--allowedTools"), ["Read", "Grep", "Glob", CLAUDE_ASK_TOOL]);
  assert.deepEqual(valuesAfter(args, "--permission-prompts"), ["none"]);
});

test("tools with no honest equivalent are refused before spawning", async () => {
  // Claude Code silently DROPS unknown --tools names, so an unmapped tool would
  // otherwise produce an agent quietly missing a capability it declared.
  await assert.rejects(build({ tools: ["safe_bash"] }), /no filtered shell/);
  await assert.rejects(build({ tools: ["subagent"] }), /Task tool spawns its own agent types/);
  await assert.rejects(build({ tools: ["video_extract"] }), /no Claude Code equivalent/);
  assert.deepEqual(valuesAfter((await build({ tools: [] })).args, "--tools"), [""]);
});

test("the task goes in over the stdin channel, never as a positional argument", async () => {
  const { args, openingPrompt, protocol } = await build();
  // --tools/--allowedTools are variadic: a trailing prompt would be parsed as
  // one more tool name and the run dies with "Input must be provided...".
  assert.equal(openingPrompt, "Task: do the thing");
  assert.equal(protocol, "claude-stream");
  assert.ok(!args.some((a) => a.includes("do the thing")));
  assert.deepEqual(args.slice(0, 7), ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(valuesAfter(args, "--model"), ["claude-sonnet-5"]);
  assert.deepEqual(valuesAfter(args, "--effort"), ["medium"]);
});

// Streaming input is what lets a claude child park on a question instead of
// exiting, and a persisted session is what lets a finished one be picked back
// up. `--no-session-persistence` would forfeit the second.
test("the child is launched on a resumable session it can be relaunched into", async () => {
  const { args, sessionId } = await build();
  assert.ok(!args.includes("--no-session-persistence"));
  assert.match(String(sessionId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(valuesAfter(args, "--session-id"), [sessionId]);
});

// The delegation note is the stronger of the two instructions for a smaller
// model, so it goes to every agent — with or without a prompt of its own.
test("every agent is told it has a caller, by the name its runner gives the tool", async () => {
  const withPrompt = valuesAfter((await build()).args, "--append-system-prompt");
  assert.equal(withPrompt.length, 1);
  assert.match(withPrompt[0], /^be brief\n\n## Your caller/);
  assert.ok(withPrompt[0].includes(CLAUDE_ASK_TOOL));

  const bare = valuesAfter((await build({ systemPrompt: "" })).args, "--append-system-prompt");
  assert.match(bare[0], /^## Your caller/);
});

// MCP is the only surface a headless claude child loads a tool from, and
// `--tools` does not govern MCP tools — so the ask tool is allowed by name or
// it is denied outright under `--permission-prompts none`.
test("the ask tool is carried in over MCP and pre-approved", async () => {
  const { args, tempDir } = await build();
  const config = JSON.parse(valuesAfter(args, "--mcp-config")[0]);
  const server = config.mcpServers.pi_subagents;
  assert.ok(server.args[0].endsWith("claude-ask.mjs"));
  assert.equal(server.env.PI_SUBAGENT_RUN_DIR, tempDir);
  assert.ok(valuesAfter(args, "--allowedTools").includes(CLAUDE_ASK_TOOL));
});

test("inheritance flags and runner settings are honoured", async () => {
  assert.ok((await build()).args.includes("--disable-slash-commands"));
  assert.ok(!(await build({}, { ...DEFAULT_INHERIT, skills: true })).args.includes("--disable-slash-commands"));
  assert.ok(!(await build()).args.includes("--strict-mcp-config"));
  assert.ok((await build({}, { ...DEFAULT_INHERIT, extensions: false })).args.includes("--strict-mcp-config"));

  const { args } = await build({}, DEFAULT_INHERIT, { command: "/opt/claude", permissionMode: "acceptEdits", maxBudgetUsd: 0.5 });
  assert.equal(args[0], "/opt/claude");
  assert.deepEqual(valuesAfter(args, "--permission-mode"), ["acceptEdits"]);
  assert.deepEqual(valuesAfter(args, "--max-budget-usd"), ["0.5"]);
});

test("only Anthropic models survive the pi provider/id spelling", () => {
  assert.equal(resolveClaudeModel("anthropic/claude-opus-5[1m]"), "claude-opus-5[1m]");
  assert.equal(resolveClaudeModel("sonnet"), "sonnet");
  // A non-Anthropic parent model means nothing here.
  assert.equal(resolveClaudeModel("openai/gpt-5"), undefined);
  assert.equal(resolveClaudeModel(""), undefined);
});

// Omitting --model is not the neutral choice it looks like: Claude Code then
// runs its own default, the top of the range, so a child dispatched from a
// session on any non-Anthropic model would quietly be the priciest one going.
test("a child whose model does not survive is named one anyway", async () => {
  const fallback = async (overrides = {}, config = {}) =>
    valuesAfter((await build({ model: "openai/gpt-5", ...overrides }, DEFAULT_INHERIT, config)).args, "--model");
  assert.deepEqual(await fallback(), [CLAUDE_DEFAULT_MODEL]);
  assert.deepEqual(await fallback({}, { model: "sonnet" }), ["sonnet"], "the configured fallback was ignored");
  assert.deepEqual(await fallback({ model: "anthropic/claude-haiku-4-5" }, { model: "sonnet" }), ["claude-haiku-4-5"],
    "the agent's own model lost to the fallback");
});

// ── Event adapter ─────────────────────────────────────────────────────

function harness() {
  const progress: AgentProgress = { agent: "probe", status: "running", task: "t", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" };
  const result: AgentResult = { agent: "probe", task: "t", output: "", exitCode: 0, progress, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
  const handle = makeClaudeLineHandler({ progress, result, fireUpdate: () => {}, startTime: Date.now() });
  return { progress, result, feed: (e: unknown) => handle(JSON.stringify(e)) };
}

test("stream-json maps onto the shared progress model", () => {
  const { progress, result, feed } = harness();
  feed({ type: "system", subtype: "init", model: "claude-sonnet-5", tools: ["Glob"] });
  assert.equal(result.model, "claude-sonnet-5");

  // A tool call opens inside an assistant message and closes in the next user one.
  feed({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "tool_use", id: "toolu_1", name: "Glob", input: { pattern: "*.conf", path: "/etc" } }],
    usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } });
  assert.equal(progress.toolCount, 1);
  // Glob's directory is folded into the pattern: the shared formatter prefers a
  // bare `path`, which would have shown "/etc" and lost what was being matched.
  assert.deepEqual(progress.recentTools.map((t) => [t.tool, t.args, t.status]), [["find", "/etc/*.conf", "running"]]);
  assert.equal(progress.tokens, 156);

  feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\nb" }] } });
  assert.equal(progress.recentTools[0].status, "done");

  feed({ type: "assistant", message: { content: [{ type: "text", text: "Found 327.\n```js\nx\n```" }],
    usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } } });
  assert.equal(progress.lastMessage, "Found 327.");
  // Latest-turn snapshot, not a running sum — one turn already carries the context.
  assert.equal(progress.tokens, 210);
  assert.deepEqual(result.usage, { input: 5, output: 11, cacheRead: 300, cacheWrite: 50, cost: 0, turns: 0 });

  feed({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.075, result: "327", permission_denials: [] });
  assert.equal(result.output, "327");
  assert.equal(result.usage.cost, 0.075);
  assert.equal(result.usage.turns, 2);
  assert.equal(progress.error, undefined);
});

test("file-tool paths render through the shared preview formatter", () => {
  const { progress, feed } = harness();
  feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/a/b.ts", offset: 1 } }] } });
  assert.deepEqual(progress.recentTools.map((t) => [t.tool, t.args]), [["read", "/a/b.ts"]]);
});

test("a failed or blocked run surfaces as an error, and stragglers are closed", () => {
  const { progress, feed } = harness();
  feed({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "rm -rf /" } }] } });
  feed({ type: "result", subtype: "error_during_execution", is_error: true, result: "",
    permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }] });
  assert.match(progress.error!, /denied 2 tool call\(s\): Bash/);
  // No tool_result arrived, but the run is over — nothing may stay "running".
  assert.equal(progress.recentTools[0].status, "done");
});

test("denials on an otherwise successful run are still reported", () => {
  const { progress, result, feed } = harness();
  feed({ type: "result", subtype: "success", is_error: false, result: "partial", permission_denials: [{ tool_name: "WebFetch" }] });
  assert.equal(progress.error, undefined);
  assert.equal(result.output, "partial");
  assert.match(progress.lastMessage, /1 tool call\(s\) denied: WebFetch/);
});

// ── Backend guard ─────────────────────────────────────────────────────

test("the herdr backend refuses a claude-run agent instead of opening a dead pane", async () => {
  const { default: extension, registerAgent } = await import("../index.ts");
  const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, any>();
  extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c),
    on: (n: string, fn: any) => handlers.set(n, fn), getAllTools: () => [],
    registerMessageRenderer() {}, sendMessage() {} } as any);
  const ctx = { cwd: process.cwd(), model: { provider: "anthropic", id: "claude-sonnet-5" },
    modelRegistry: { find: () => undefined }, ui: { notify() {} } };
  try {
    registerAgent({ ...AGENT, name: "claude-probe", tools: ["read"] });
    const call = () => tools.get("subagent").execute("test", { agent: "claude-probe", task: "t" }, undefined, undefined, ctx);
    await commands.get("subagents-herdr").handler("herdr", ctx);
    // A pane child reports back through a pi extension, so a claude child in one
    // would have no result channel at all.
    await assert.rejects(call(), /claude runner, which supports the process backend only/);
  } finally { await handlers.get("session_shutdown")(); }
});
