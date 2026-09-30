import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import extension, { registerAgent } from "../index.ts";

// The runner choice is observable without spawning anything: an agent
// declaring a tool the runner cannot supply fails during argv construction.
const PI_REFUSAL = /requires unavailable tool/;
// `claude` was a runner once; refusing it is a migration message now.
const CLAUDE_MIGRATION = /claude runner was removed.*claude-code\/<model-id>/s;

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

const call = (agent: string, runner?: string) =>
  tools.get("subagent").execute("t", { agent, task: "t", ...(runner ? { runner } : {}) }, undefined, undefined, ctx);

test("dispatch defaults to the pi runner", { skip: configPins && "config.json pins runners locally" }, async () => {
  await assert.rejects(call("unpinned"), PI_REFUSAL);
});

test("runner: claude is refused with the migration message", async () => {
  // This is the lever a conversational instruction pulls: "send that one to
  // claude" used to dispatch the dedicated runner. The refusal has to say
  // what replaced it, in words that survive being read back to the model.
  await assert.rejects(call("unpinned", "claude"), CLAUDE_MIGRATION);
});

test("an unknown runner is refused by name, not silently ignored", async () => {
  await assert.rejects(call("unpinned", "codex"), /unknown runner codex \(expected pi\)/);
});

test.after(async () => { await handlers.get("session_shutdown")(); });

// ── Provider-backed agents (the claude-code provider as a model) ──
//
// An agent whose model is `claude-code/*` is not a runner dispatch at all: the
// child is an ordinary pi process whose model happens to be the provider. The
// runner stays pi and the model id passes through verbatim — pinning that so a
// runner-selection change cannot mangle the id.

test("a claude-code/* model stays with the pi runner and passes through verbatim", async () => {
	const { prepareSubagent, DEFAULT_INHERIT } = await import("../index.ts");
	const agent = {
		name: "provider-scout", description: "", tools: ["read"],
		model: "claude-code/claude-opus-5", thinking: "low", systemPrompt: "", filePath: "",
	};
	const prepared = await prepareSubagent(agent, "t", process.cwd(), DEFAULT_INHERIT, false);
	assert.equal(prepared.runner, "pi");
	const modelAt = prepared.args.indexOf("--model");
	assert.ok(modelAt !== -1, "the child is told its model");
	assert.equal(prepared.args[modelAt + 1], "claude-code/claude-opus-5");
	assert.equal(prepared.protocol, "pi-rpc");
});

// ── Model semantics for provider-backed agents ────────────────────────

test("a claude-code model with inherit.extensions off is refused before spawning", async () => {
	const { prepareSubagent } = await import("../index.ts");
	const agent = { name: "no-inherit", description: "", tools: ["read"],
		model: "claude-code/opus", thinking: "low", systemPrompt: "", filePath: "" };
	await assert.rejects(
		prepareSubagent(agent, "t", process.cwd(), { extensions: false, skills: false }, false),
		/claude-code provider loaded in the child/,
	);
});
