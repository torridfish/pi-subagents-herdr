import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childExtension from "../herdr/child.ts";

const { buildPiArgs, DEFAULT_INHERIT } = await import("../index.ts");

const agent = { name: "probe", description: "", tools: ["read"], model: "test/model", thinking: "medium", systemPrompt: "", filePath: "" };

// A child that can be resumed is the precondition for every other part of the
// ping protocol: `--no-session` would leave nothing to restart from.
test("a pi child writes its conversation to a session file inside its run directory", async () => {
  const { args, tempDir, sessionPath } = await buildPiArgs(agent, "task", process.cwd(), DEFAULT_INHERIT);
  try {
    assert.equal(args.includes("--no-session"), false, "an ephemeral child cannot be resumed");
    assert.equal(sessionPath, path.join(tempDir, "session.jsonl"));
    assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", sessionPath]);
    // Pi treats a `--session` argument as a path (rather than a session id to
    // look up) only when it looks like one, and creates the file on first use.
    assert.ok(sessionPath!.includes("/") || sessionPath!.includes("\\"));
    assert.equal(fs.existsSync(sessionPath!), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** Load the child extension against a run directory, as a child process does. */
function loadChild(directory: string | undefined) {
  const old = process.env.PI_SUBAGENT_RUN_DIR;
  if (directory === undefined) delete process.env.PI_SUBAGENT_RUN_DIR;
  else process.env.PI_SUBAGENT_RUN_DIR = directory;
  const tools = new Map<string, any>();
  try {
    childExtension({ on() {}, registerTool: (t: any) => tools.set(t.name, t) } as any);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENT_RUN_DIR; else process.env.PI_SUBAGENT_RUN_DIR = old;
  }
  return tools;
}

test("caller_ping leaves a question in the run directory and stops the child", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ping-test-"));
  try {
    const ping = loadChild(directory).get("caller_ping");
    let shutdowns = 0;
    const ctx = { shutdown: () => shutdowns++ } as any;

    const result = await ping.execute("call-1", { question: "  Which database?  " }, undefined, undefined, ctx);

    const sidecar = JSON.parse(fs.readFileSync(path.join(directory, "ping.json"), "utf8"));
    assert.equal(sidecar.type, "ping");
    assert.equal(sidecar.question, "Which database?");
    assert.ok(sidecar.at > 0);
    // Nothing half-written is left behind for the parent to trip over.
    assert.deepEqual(fs.readdirSync(directory), ["ping.json"]);
    // The child must not keep working while its caller composes an answer.
    assert.equal(shutdowns, 1);
    assert.match(result.content[0].text, /Stop now/);

    // One question per pause: the parent answers the ping it can see, so a
    // second would silently replace a question already asked.
    await assert.rejects(
      () => ping.execute("call-2", { question: "And which region?" }, undefined, undefined, ctx),
      /already asked/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "ping.json"), "utf8")).question, "Which database?");

    await assert.rejects(() => ping.execute("call-3", { question: "   " }, undefined, undefined, ctx), /requires a question/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The same file is on the user's disk as part of an installed package. Loaded
// outside a subagent run it must register nothing at all.
test("caller_ping does not exist outside a subagent run", () => {
  assert.equal(loadChild(undefined).size, 0);
});
