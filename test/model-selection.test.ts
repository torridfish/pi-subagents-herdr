import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The per-call `model` argument, observed at the only place the chain is
// observable without spawning anything: the dispatch ack (`details.results[0]
// .model`, set from the agent actually being launched). No real child runs
// here — the same stand-in pattern as `async-dispatch.test.ts`, where the pi
// entry point resolves to this runner.

process.env.PI_SUBAGENT_BACKEND = "process";
process.env.PI_SUBAGENT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-"));

// Pinned before the extension is imported: the developer's real user-level
// config (~/.pi/agent/subagents-herdr.json) would otherwise answer the fallback
// test, making the suite's result depend on their setup. The layer is pointed
// at an empty temp dir, so the chain bottoms out where each test says it does.
const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-config-"));
const { default: extension, registerAgent, setUserConfigPathForTest } = await import("../index.ts");
setUserConfigPathForTest(path.join(userConfigDir, "subagents-herdr.json"));

const tools = new Map<string, any>(), handlers = new Map<string, any>();
extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {},
  on: (n: string, fn: any) => handlers.set(n, fn), getAllTools: () => [],
  registerMessageRenderer() {}, sendMessage() {} } as any);
const ctx = { cwd: process.cwd(), model: { provider: "vllm", id: "some-model" },
  modelRegistry: { find: () => undefined }, ui: { notify() {} } };

// An agent with no model of its own anywhere: whatever it reports is what
// fallback resolved, and that is what each test reads.
registerAgent({ name: "modelfree", description: "", tools: [], model: "", thinking: "low", systemPrompt: "", filePath: "" });

const call = (params: Record<string, unknown>) =>
  tools.get("subagent").execute("t", { agent: "modelfree", task: "t", ...params }, undefined, undefined, ctx);

test.after(async () => {
  await handlers.get("session_shutdown")();
  setUserConfigPathForTest(undefined);
  fs.rmSync(userConfigDir, { recursive: true, force: true });
});

test("an explicit model on the dispatch outranks everything", async () => {
  const ack = await call({ model: "claude-code/opus" });
  assert.equal(ack.details.results[0].model, "claude-code/opus");
});

test("an unpinned agent falls back to the caller's own model", async () => {
  // The user-level layer is pointed at an empty dir, the agent pins nothing,
  // so the chain bottoms out at the parent session's model.
  const ack = await call({});
  assert.equal(ack.details.results[0].model, "vllm/some-model");
});

test("a malformed per-call model is refused by name, in the call itself", async () => {
  await assert.rejects(call({ model: "opus" }), /not a provider\/model-id pair[\s\S]*opus[\s\S]*drop the argument/);
});
