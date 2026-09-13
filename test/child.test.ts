import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import childBridge from "../herdr/child.ts";

test("bridge forwards structured events, guards early settle, and isolates descendants", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
  const old = process.env.PI_SUBAGENT_RUN_DIR;
  process.env.PI_SUBAGENT_RUN_DIR = directory;
  const handlers = new Map<string, any>();
  let shutdown = 0;
  try {
    childBridge({ on: (name: string, fn: any) => handlers.set(name, fn) } as any);
    handlers.get("session_start")();
    assert.equal(process.env.PI_SUBAGENT_RUN_DIR, undefined);
    handlers.get("agent_settled")({}, { shutdown: () => shutdown++ });
    assert.equal(shutdown, 0);
    handlers.get("agent_start")();
    const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "中文" }] } };
    handlers.get("message_end")(event);
    handlers.get("agent_settled")({}, { shutdown: () => shutdown++ });
    assert.equal(shutdown, 1);
    const events = (await fs.readFile(path.join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events, [{ type: "bridge_ready" }, event, { type: "bridge_complete" }]);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENT_RUN_DIR; else process.env.PI_SUBAGENT_RUN_DIR = old;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pane runner uses the real pane identity and publishes exit atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
  try {
    const target = path.join(directory, "actual.json");
    await fs.writeFile(path.join(directory, "launch.json"), JSON.stringify({
      command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(target)}, JSON.stringify({pane:process.env.HERDR_PANE_ID,stale:process.env.PI_SESSION_ID,run:process.env.PI_SUBAGENT_RUN_DIR}))`],
      cwd: directory, env: { ...process.env, HERDR_PANE_ID: "parent", PI_SESSION_ID: "stale" },
    }));
    await fs.writeFile(path.join(directory, "heartbeat"), "");
    const runner = spawn(process.execPath, [new URL("../herdr/runner.mjs", import.meta.url).pathname, directory], {
      env: { ...process.env, HERDR_PANE_ID: "real-child" }, stdio: "ignore",
    });
    const [code] = await once(runner, "close");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { pane: "real-child", run: directory });
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "exit.json"), "utf8")).code, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("runner stops a child when its parent heartbeat expires", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runner-orphan-"));
  let runner: ReturnType<typeof spawn> | undefined;
  try {
    await fs.writeFile(path.join(directory, "launch.json"), JSON.stringify({ command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000)"], cwd: directory, env: process.env }));
    await fs.writeFile(path.join(directory, "heartbeat"), "");
    await fs.utimes(path.join(directory, "heartbeat"), new Date(0), new Date(0));
    runner = spawn(process.execPath, [new URL("../herdr/runner.mjs", import.meta.url).pathname, directory], { stdio: "ignore" });
    const [code] = await once(runner, "close", { signal: AbortSignal.timeout(10000) });
    assert.equal(code, 130);
  } finally { runner?.kill(); await fs.rm(directory, { recursive: true, force: true }); }
});
