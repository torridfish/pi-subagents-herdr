import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

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
