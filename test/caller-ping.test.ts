import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childExtension from "../herdr/child.ts";

// Pinned before the extension loads, for the same reason async-dispatch.test.ts
// does it: a unit test must not open panes in the terminal it runs from.
process.env.PI_SUBAGENT_BACKEND = "process";
const { buildPiArgs, DEFAULT_INHERIT, default: extension } = await import("../index.ts");

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

// ── The pause, end to end ─────────────────────────────────────────────
//
// A stand-in for pi: it is spawned exactly as a real child is (`resolvePiBinary`
// takes the entry point from `process.argv[1]`, which a test can point
// elsewhere), it records where it ran and what it was asked, and on its first
// launch it leaves a question behind the way `caller_ping` does.
const FAKE_PI = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.PI_SUBAGENT_RUN_DIR;
const prompt = process.argv[process.argv.length - 1];
fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ dir, prompt }) + "\\n");
const first = !fs.existsSync(path.join(dir, "asked"));
if (first) {
  fs.writeFileSync(path.join(dir, "asked"), "");
  fs.writeFileSync(path.join(dir, "ping.json"), JSON.stringify({ type: "ping", question: "Postgres or SQLite?", at: Date.now() }));
}
const text = first ? "I need to know which database." : "Done: used " + prompt;
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));
`;

const stubTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
const ctx = { cwd: process.cwd(), model: { provider: "vllm", id: "some-model" },
  modelRegistry: { find: () => undefined }, ui: { notify() {} } };

/** A fresh extension instance with its own runs, widget and steer log. */
function load() {
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  const steers: any[] = [];
  let widget: ((tui: unknown, theme: any) => any) | undefined;
  extension({
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand() {},
    on: (n: string, fn: any) => handlers.set(n, fn),
    getAllTools: () => [],
    registerMessageRenderer() {},
    sendMessage: (message: any) => steers.push(message),
  } as any);
  handlers.get("session_start")({}, { ui: { setWidget: (_k: string, content: any) => { widget = content; } } });
  return { tools, handlers, steers, paint: (width = 100) => widget ? widget(null, stubTheme).render(width).join("\n") : "" };
}

async function until(what: string, predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Point the child launcher at the stand-in, and give it somewhere to report. */
function stubPi(directory: string) {
  const entry = path.join(directory, "fake-pi.mjs");
  fs.writeFileSync(entry, FAKE_PI);
  const argv = process.argv[1], log = process.env.FAKE_PI_LOG;
  process.argv[1] = entry;
  process.env.FAKE_PI_LOG = path.join(directory, "launches.jsonl");
  fs.writeFileSync(process.env.FAKE_PI_LOG, "");
  return {
    launches: () => fs.readFileSync(path.join(directory, "launches.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    restore: () => { process.argv[1] = argv; if (log === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = log; },
  };
}

test("a child that asks a question pauses its run instead of finishing it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pause-test-"));
  const pi = stubPi(directory);
  try {
    const { tools, handlers, steers, paint } = load();
    const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "pick a store" }, undefined, undefined, ctx);
    const result = ack.details.results[0];
    await until("the run to pause", () => result.progress.status === "paused");

    assert.equal(result.question, "Postgres or SQLite?");
    // Paused is not finished: the run must not be reported as a result, and
    // must not be marked failed for having exited.
    assert.deepEqual(steers, []);
    assert.notEqual(result.progress.status, "failed");

    // The run directory is what makes the pause recoverable — the session file
    // lives there — so the usual end-of-run cleanup has to skip it.
    const [launch] = pi.launches();
    assert.ok(fs.existsSync(launch.dir), "the run directory was reclaimed while the run was still paused");
    assert.ok(fs.existsSync(path.join(launch.dir, "ping.json")));

    // The roster is where the user finds out somebody is waiting on them.
    const painted = paint();
    assert.match(painted, /1 subagent: 0 running, 1 waiting on an answer/);
    assert.match(painted, /Postgres or SQLite\?/);
    assert.ok(painted.includes(ack.details.dispatched));

    // Nothing can answer a question once the session is over, so that is when
    // an unanswered run's directory is finally reclaimed.
    await handlers.get("session_shutdown")();
    assert.equal(fs.existsSync(launch.dir), false, "an abandoned run directory outlived the session");
  } finally {
    pi.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
