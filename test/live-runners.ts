// Explicit opt-in: launches real Pi and real Claude Code children and incurs
// model usage on both. Read-only — each child is a scout with file tools only.
//
//   PI_TEST_MODEL=provider/model-id [CLAUDE_TEST_MODEL=sonnet] npx tsx test/live-runners.ts
import assert from "node:assert/strict";
import extension, { registerAgent } from "../index.ts";

const piModel = process.env.PI_TEST_MODEL;
if (!piModel?.includes("/")) throw new Error("Set PI_TEST_MODEL=provider/model (uses real credentials)");
const claudeModel = process.env.CLAUDE_TEST_MODEL ?? "sonnet";
const [provider, ...ids] = piModel.split("/");

const tools = new Map<string, any>();
const handlers = new Map<string, Array<(...args: any[]) => any>>();
const arrived = new Map<unknown, () => void>();
extension({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {},
  on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  getAllTools: () => [],
  registerMessageRenderer() {},
  // The steer carries the same live record the dispatch handed back, so waiters
  // key on object identity rather than parsing the message text.
  sendMessage(message: any) { arrived.get(message.details?.results?.[0])?.(); },
} as any);

// Registered rather than configured so the check does not depend on the local
// config.json. Neither agent pins a runner in its own definition.
const base = { description: "live check", tools: ["read", "grep", "find", "ls"], thinking: "low",
  systemPrompt: "You are a scout. Use your file tools, then answer in one line.", filePath: "" };
registerAgent({ ...base, name: "probe-pi", model: piModel });
registerAgent({ ...base, name: "probe-claude", model: `anthropic/${claudeModel}` });

const TASK = "List the .ts files directly inside the runners/ directory of the current working directory. "
  + "Reply with exactly RUNNER_SMOKE_OK followed by how many there are.";

// Dispatch is async now: the call acks, and the run is only finished once its
// result has been steered back. This waits for that, then returns the record —
// the same object the ack carried, mutated in place by the run.
async function dispatch(agent: string, runner?: string) {
  const ack = await tools.get("subagent").execute("smoke", { agent, task: TASK, cwd: process.cwd(), ...(runner ? { runner } : {}) },
    AbortSignal.timeout(240000), undefined,
    { cwd: process.cwd(), model: { provider, id: ids.join("/") }, modelRegistry: { find: () => undefined } });
  const record = ack.details.results[0];
  assert.match(ack.details.dispatched, /^probe-(pi|claude)-\d+$/);
  assert.equal(record.exitCode, -1, "the ack should land while the run is still open");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ack.details.dispatched} never steered back`)), 240000);
    arrived.set(record, () => { clearTimeout(timer); resolve(); });
  });
  return record;
}

try {
  // ── Default dispatch: no runner anywhere, so it must be pi ──────────
  const viaPi = await dispatch("probe-pi");
  assert.match(viaPi.output, /RUNNER_SMOKE_OK/);
  assert.equal(viaPi.progress.status, "completed");
  assert.ok(viaPi.progress.toolCount > 0, "pi child called no tools");
  assert.ok(viaPi.progress.recentTools.every((t: any) => t.status === "done"), "pi tool calls left open");
  // A claude child could never report this model id back.
  assert.ok(!/^claude-/.test(viaPi.model), `expected the pi runner by default, got model ${viaPi.model}`);
  console.log(`PASS pi (default)    model=${viaPi.model} tools=${viaPi.progress.toolCount} turns=${viaPi.usage.turns} ${JSON.stringify(viaPi.output.slice(0, 60))}`);

  // ── Same tool, one explicit flag, a Claude Code child instead ───────
  const viaClaude = await dispatch("probe-claude", "claude");
  assert.match(viaClaude.output, /RUNNER_SMOKE_OK/);
  assert.equal(viaClaude.progress.status, "completed");
  assert.ok(viaClaude.progress.toolCount > 0, "claude child called no tools");
  assert.ok(viaClaude.progress.recentTools.every((t: any) => t.status === "done"), "claude tool calls left open");
  assert.match(viaClaude.model, /^claude-/, `expected a Claude Code model, got ${viaClaude.model}`);
  assert.ok(viaClaude.usage.turns > 0 && viaClaude.usage.cost > 0, `usage not bridged: ${JSON.stringify(viaClaude.usage)}`);
  console.log(`PASS claude (on ask) model=${viaClaude.model} tools=${viaClaude.progress.toolCount} turns=${viaClaude.usage.turns} ${JSON.stringify(viaClaude.output.slice(0, 60))}`);

  console.log("PASS: async dispatch works on both runners; pi is the default; a per-call runner flips it");
} finally {
  for (const fn of handlers.get("session_shutdown") ?? []) await fn();
}
