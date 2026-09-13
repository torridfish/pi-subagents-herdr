import { test } from "node:test";
import assert from "node:assert/strict";
import extension, { registerAgent } from "../index.ts";

test("extension registers its tool and backend command, rejects bad requests before spawning", async () => {
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, fn: any) => handlers.set(name, fn), getAllTools: () => [],
  } as any);
  const ctx = { cwd: process.cwd(), model: { provider: "test", id: "model" },
    modelRegistry: { find: () => undefined }, ui: { notify() {} } };
  try {
    assert.ok(tools.has("subagent"));
    await commands.get("subagents-herdr").handler("process", ctx);
    const call = (params: any, signal?: AbortSignal) => tools.get("subagent").execute("test", params, signal, undefined, ctx);
    await assert.rejects(call({ agent: "unknown", task: "test" }), /Unknown agent/);
    await assert.rejects(call({ agent: "scout", task: "" }), /requires both/);
    await assert.rejects(call({ agent: "scout", task: "test" }, AbortSignal.abort()), /abort/i);
    registerAgent({ name: "missing-tool", description: "test", tools: ["uninstalled-tool"], model: "", thinking: "off", systemPrompt: "", filePath: "" });
    await assert.rejects(call({ agent: "missing-tool", task: "test" }), /requires unavailable tool uninstalled-tool/);
  } finally { await handlers.get("session_shutdown")(); }
});
