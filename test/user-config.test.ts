import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The user-level config layer, observed the only way it can be without spawning
// anything: what model an unpinned dispatch ack reports. No real child runs
// here — the same stand-in pattern as `async-dispatch.test.ts`, where the pi
// entry point resolves to this runner.

process.env.PI_SUBAGENT_BACKEND = "process";
process.env.PI_SUBAGENT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-"));

// Pinned before any extension instance loads: the developer running this suite
// has a real user-level config (~/.pi/agent/subagents-herdr.json) whose content
// would otherwise be the answer, making the suite's result depend on their
// setup. The layer is pointed at a temp dir owned by this file.
const userConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-config-"));
const userConfigPath = path.join(userConfigDir, "subagents-herdr.json");
const { default: extension, registerAgent, setUserConfigPathForTest } = await import("../index.ts");
setUserConfigPathForTest(userConfigPath);

const ctx = { cwd: process.cwd(), model: { provider: "vllm", id: "some-model" },
  modelRegistry: { find: () => undefined }, ui: { notify() {} } };

// One handler map per instance: a shared map would keep only the last
// instance's `session_shutdown`, orphaning the runs its predecessors launched
// and keeping this file's event loop alive after the suite.
const shutdowns: Array<() => Promise<void>> = [];

/** A fresh extension instance, because `loadConfig` runs once per load — which
 *  is also true when pi starts, so this mirrors production. */
const freshExtension = () => {
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {},
    on: (n: string, fn: any) => handlers.set(n, fn), getAllTools: () => [],
    registerMessageRenderer() {}, sendMessage() {} } as any);
  shutdowns.push(() => handlers.get("session_shutdown")());
  // The load resets the registry to the file-defined agents only, so the probe
  // is re-registered through the same global bridge.
  registerAgent({ name: "modelfree", description: "", tools: [], model: "", thinking: "low", systemPrompt: "", filePath: "" });
  return tools;
};

// An agent with no model pinned anywhere: whatever its ack reports is what the
// fallback chain resolved, and that is what each test reads.
registerAgent({ name: "modelfree", description: "", tools: [], model: "", thinking: "low", systemPrompt: "", filePath: "" });

const write = (config: unknown) => fs.writeFileSync(userConfigPath, JSON.stringify(config));
const forget = () => { try { fs.unlinkSync(userConfigPath); } catch { /* already gone */ } };

test.after(async () => {
  for (const shutdown of shutdowns) await shutdown();
  setUserConfigPathForTest(undefined);
  fs.rmSync(userConfigDir, { recursive: true, force: true });
});

test("the user-level config's models block is the fallback the dispatch lands on", async () => {
  write({ models: { default: "opengo/glm" } });
  const ack = await freshExtension().get("subagent").execute("t", { agent: "modelfree", task: "t" }, undefined, undefined, ctx);
  assert.equal(ack.details.results[0].model, "opengo/glm");
  forget();
});

test("a per-agent pin outranks the user-level default", async () => {
  write({ models: { modelfree: "zai/glm", default: "opengo/glm" } });
  const ack = await freshExtension().get("subagent").execute("t", { agent: "modelfree", task: "t" }, undefined, undefined, ctx);
  assert.equal(ack.details.results[0].model, "zai/glm");
  forget();
});

test("the user-level layer replaces a top-level key wholesale, not recursively", async () => {
  // The repo copy pins nothing here, but the rule matters anyway: a user
  // `models` block must not inherit the repo's entries from inside the key.
  write({ models: { default: "opengo/glm" } });
  const ack = await freshExtension().get("subagent").execute("t", { agent: "modelfree", task: "t" }, undefined, undefined, ctx);
  assert.equal(ack.details.results[0].model, "opengo/glm");
  forget();
});

test("a broken user-level config fails at load with its path, not silently", async () => {
  fs.writeFileSync(userConfigPath, "{ not json");
  // assert.throws stringifies the thrown Error as `${name}: ${message}`.
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.throws(() => extension({ registerTool() {}, registerCommand() {}, on() {},
    getAllTools: () => [], registerMessageRenderer() {}, sendMessage() {} } as any),
    new RegExp(escape(`Invalid ${userConfigPath}`)));
  forget();
});
