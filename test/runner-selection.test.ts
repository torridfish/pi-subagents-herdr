import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import extension, { registerAgent } from "../index.ts";

// Which runner was chosen is observable without spawning anything: an agent
// declaring a tool neither runner can supply fails during argv construction, and
// each runner words that refusal differently.
const PI_REFUSAL = /requires unavailable tool/;
const CLAUDE_REFUSAL = /no Claude Code equivalent/;

const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localConfig = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(EXT_DIR, "config.json"), "utf-8")); } catch { return {}; }
})();
// config.json outranks frontmatter, so a local override would legitimately
// change the answer for the two lowest-precedence cases.
const configPins = Object.keys(localConfig.runners ?? {}).length > 0;

const tools = new Map<string, any>(), handlers = new Map<string, any>();
extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {},
  on: (n: string, fn: any) => handlers.set(n, fn), getAllTools: () => [],
  registerMessageRenderer() {}, sendMessage() {} } as any);
const ctx = { cwd: process.cwd(), model: { provider: "vllm", id: "some-model" },
  modelRegistry: { find: () => undefined }, ui: { notify() {} } };

const base = { description: "", tools: ["definitely-not-a-real-tool"], model: "vllm/some-model",
  thinking: "low", systemPrompt: "", filePath: "" };
registerAgent({ ...base, name: "unpinned" });
registerAgent({ ...base, name: "pinned-claude", runner: "claude" });

const call = (agent: string, runner?: string) =>
  tools.get("subagent").execute("t", { agent, task: "t", ...(runner ? { runner } : {}) }, undefined, undefined, ctx);

test("dispatch defaults to the pi runner", { skip: configPins && "config.json pins runners locally" }, async () => {
  await assert.rejects(call("unpinned"), PI_REFUSAL);
});

test("frontmatter can pin an agent to the claude runner", { skip: configPins && "config.json pins runners locally" }, async () => {
  await assert.rejects(call("pinned-claude"), CLAUDE_REFUSAL);
});

test("an explicit runner on the call outranks everything else", async () => {
  // This is the lever a conversational instruction pulls: "send that one to
  // claude" does not require editing config.json and reloading.
  await assert.rejects(call("unpinned", "claude"), CLAUDE_REFUSAL);
  await assert.rejects(call("pinned-claude", "pi"), PI_REFUSAL);
});

test("an unknown runner is refused by name, not silently ignored", async () => {
  await assert.rejects(call("unpinned", "codex"), /Unknown runner: codex\. Available runners: pi, claude\./);
});

test.after(async () => { await handlers.get("session_shutdown")(); });

// ── Provider-backed agents (stage: the claude-code provider as a model) ──
//
// An agent whose model is `claude-code/*` is not a claude-runner dispatch: the
// child is an ordinary pi process whose model happens to be the provider. The
// runner stays pi and the model id passes through verbatim — pinning that so a
// future runner-selection change cannot silently route provider models into
// the dedicated claude runner (or mangle the id).

test("a claude-code/* model stays with the pi runner and passes through verbatim", async () => {
	const { prepareSubagent, DEFAULT_INHERIT } = await import("../index.ts");
	const agent = {
		name: "provider-scout", description: "", tools: ["read"],
		model: "claude-code/claude-opus-5", thinking: "low", systemPrompt: "", filePath: "",
	};
	const prepared = await prepareSubagent(agent, "t", process.cwd(), DEFAULT_INHERIT, {}, false);
	assert.equal(prepared.runner, "pi");
	const modelAt = prepared.args.indexOf("--model");
	assert.ok(modelAt !== -1, "the child is told its model");
	assert.equal(prepared.args[modelAt + 1], "claude-code/claude-opus-5");
	// And the claude runner's argv builder was never touched.
	assert.equal(prepared.protocol, "pi-rpc");
	assert.equal(prepared.sessionId, undefined);
});
