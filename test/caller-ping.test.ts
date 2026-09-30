import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childExtension from "../herdr/child.ts";

// Pinned before the extension loads, for the same reason async-dispatch.test.ts
// does it: a unit test must not open panes in the terminal it runs from.
process.env.PI_SUBAGENT_BACKEND = "process";
// Pinned for the same reason, and a stronger one: without it these tests write
// handles into the developer's own ~/.pi and read back the ones their last run
// left there, so the suite's result depends on how many times it has been run.
process.env.PI_SUBAGENT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-state-"));
const { buildPiArgs, DEFAULT_INHERIT, default: extension } = await import("../index.ts");

const agent = { name: "probe", description: "", tools: ["read"], model: "test/model", thinking: "medium", systemPrompt: "", filePath: "" };

// A child that outlives its own turn is the precondition for everything else:
// `--no-session` would leave nothing to pick back up, and print mode would exit
// the moment the first turn settled, question or no question.
test("a pi child keeps a session file and a command channel", async () => {
  const { args, tempDir, sessionPath, openingPrompt } = await buildPiArgs(agent, "task", process.cwd(), DEFAULT_INHERIT);
  try {
    assert.equal(args.includes("--no-session"), false, "an ephemeral child cannot be picked back up");
    assert.equal(sessionPath, path.join(tempDir, "session.jsonl"));
    assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", sessionPath]);
    assert.equal(fs.existsSync(sessionPath!), false, "pi creates the session file itself, on the first assistant turn");

    // RPC, not print mode: print mode exits when it runs out of prompts, so a
    // child that asked a question would be gone before the answer arrived.
    assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "rpc"]);
    assert.equal(args.includes("-p"), false);
    // The task goes over the wire rather than in argv, so nothing has to be
    // written to a file to get past an argument-length limit.
    assert.equal(openingPrompt, "Task: task");
    assert.equal(args.at(-1)?.startsWith("Task:"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// A pane child is a real interactive Pi driven through a terminal, so it takes
// the opposite shape: no stdin channel, task in argv.
test("a pane child is built for a terminal instead", async () => {
  const { args, tempDir, openingPrompt } = await buildPiArgs(agent, "task", process.cwd(), DEFAULT_INHERIT, true);
  try {
    assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "json"]);
    assert.ok(args.includes("-p"));
    assert.equal(openingPrompt, undefined);
    assert.equal(args.at(-1), "Task: task");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** Load the child extension against a run directory, as a child process does. */
function loadChild(directory: string | undefined) {
  const old = process.env.PI_SUBAGENT_RUN_DIR;
  if (directory === undefined) delete process.env.PI_SUBAGENT_RUN_DIR;
  else process.env.PI_SUBAGENT_RUN_DIR = directory;
  const tools = new Map<string, any>(), handlers = new Map<string, any>();
  try {
    childExtension({ on: (n: string, fn: any) => handlers.set(n, fn), registerTool: (t: any) => tools.set(t.name, t) } as any);
  } finally {
    if (old === undefined) delete process.env.PI_SUBAGENT_RUN_DIR; else process.env.PI_SUBAGENT_RUN_DIR = old;
  }
  return { tools, handlers };
}

test("caller_ping parks the session instead of ending it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ping-test-"));
  try {
    const { tools, handlers } = loadChild(directory);
    const ping = tools.get("caller_ping");
    let shutdowns = 0;
    const ctx = { shutdown: () => shutdowns++ } as any;
    handlers.get("agent_start")();

    const result = await ping.execute("call-1", { question: "  Which database?  " }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Stop now/);
    assert.equal(result.details.question, "Which database?");
    // The question travels as the tool call itself — the parent reads it off
    // the event stream — so nothing is written to the run directory.
    assert.deepEqual(fs.readdirSync(directory), []);

    // The whole point: a turn that settles with a question outstanding leaves
    // the session alive, holding its context, waiting to be answered.
    handlers.get("agent_settled")({}, ctx);
    assert.equal(shutdowns, 0, "the child shut down while waiting for an answer");

    // One question at a time, because that is what a caller can answer.
    await assert.rejects(
      () => ping.execute("call-2", { question: "And which region?" }, undefined, undefined, ctx),
      /already asked/,
    );
    await assert.rejects(() => ping.execute("call-3", { question: "   " }, undefined, undefined, ctx), /requires a question/);

    // The answer arrives as input; the next settle is an ordinary end of work.
    handlers.get("input")();
    handlers.get("agent_settled")({}, ctx);
    assert.equal(shutdowns, 1, "the answered child never finished");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// The same file is on the user's disk as part of an installed package. Loaded
// outside a subagent run it must register nothing at all.
test("caller_ping does not exist outside a subagent run", () => {
  assert.equal(loadChild(undefined).tools.size, 0);
});

// ── The whole loop, end to end ────────────────────────────────────────
//
// A stand-in for pi that speaks its RPC protocol: commands in on stdin, events
// out on stdout. `resolvePiBinary` takes the entry point from `process.argv[1]`,
// which a test can point elsewhere. On its first prompt it asks a question and
// stays alive — exactly what a real child does — and on the next it finishes.
const FAKE_PI = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.PI_SUBAGENT_RUN_DIR;
fs.appendFileSync(path.join(dir, "session.jsonl"), JSON.stringify({ type: "session" }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let buf = "";
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ dir, ...command }) + "\\n");
    emit({ type: "agent_start" });
    // Asking is a property of the run, not of the process: a child picked back
    // up later has already asked its one question.
    const asked = path.join(dir, "asked");
    if (!fs.existsSync(asked)) {
      fs.writeFileSync(asked, "");
      emit({ type: "tool_execution_start", toolName: "caller_ping", toolCallId: "t1", args: { question: "Postgres or SQLite?" } });
      emit({ type: "tool_execution_end", toolName: "caller_ping", toolCallId: "t1" });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I need to know which database." }] } });
      emit({ type: "agent_settled" });
      return;                        // still alive, parked on the question
    }
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done: " + command.message }] } });
    emit({ type: "agent_settled" });
    process.exit(0);                 // a real child shuts itself down here
  }
});
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
  process.env.FAKE_PI_LOG = path.join(directory, "commands.jsonl");
  fs.writeFileSync(process.env.FAKE_PI_LOG, "");
  return {
    commands: () => fs.readFileSync(path.join(directory, "commands.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    restore: () => { process.argv[1] = argv; if (log === undefined) delete process.env.FAKE_PI_LOG; else process.env.FAKE_PI_LOG = log; },
  };
}

test("a child that asks a question waits, alive, until it is answered", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-test-"));
  const pi = stubPi(directory);
  let shutdownAll = async () => {};
  try {
    const { tools, handlers, steers, paint } = load();
    shutdownAll = async () => { await handlers.get("session_shutdown")(); };
    const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "pick a store" }, undefined, undefined, ctx);
    const handle = ack.details.dispatched;
    const result = ack.details.results[0];
    await until("the run to start waiting", () => result.progress.status === "waiting");

    assert.equal(result.question, "Postgres or SQLite?");
    // Waiting is not finished: the run is still open and the child still alive,
    // so nothing has been decided about how it ended.
    assert.equal(result.exitCode, -1);
    assert.equal(steers.length, 1);
    assert.equal(steers[0].customType, "subagent_question");
    assert.match(steers[0].content, /Postgres or SQLite\?/);
    assert.match(steers[0].content, new RegExp(`subagent_message\\(handle: "${handle}"`));

    // The roster is where the user finds out somebody is waiting on them.
    const painted = paint();
    assert.match(painted, /1 subagent: 0 running, 1 waiting on an answer/);
    assert.match(painted, /Postgres or SQLite\?/);

    // A wrong handle and an empty message are the two mistakes a model makes
    // here; both have to fail the call that made them.
    await assert.rejects(
      () => tools.get("subagent_message").execute("m", { handle: "scout-99", message: "Postgres" }, undefined, undefined, ctx),
      new RegExp(`Unknown subagent handle: scout-99. Dispatched this session: ${handle} \\(waiting\\)`),
    );
    await assert.rejects(
      () => tools.get("subagent_message").execute("m", { handle, message: "  " }, undefined, undefined, ctx),
      /needs something to say/,
    );

    // Answering reaches the same live child: no second process, no new handle.
    const answered = await tools.get("subagent_message").execute("m", { handle, message: "Postgres" }, undefined, undefined, ctx);
    assert.equal(answered.details.dispatched, handle);
    assert.equal(answered.details.results[0], result);
    assert.equal(result.question, undefined, "the answered question was left on the record");

    await until("the answered run to finish", () => result.progress.status === "completed");
    const commands = pi.commands();
    assert.deepEqual(commands.map((c: any) => c.type), ["prompt", "prompt"], "the child was restarted instead of spoken to");
    assert.equal(commands[0].dir, commands[1].dir, "the second command went to a different child");
    assert.match(commands[1].message, /Your caller answered: Postgres/);
    assert.equal(result.output, "Done: " + commands[1].message);
    assert.equal(steers.length, 2);
    assert.equal(steers[1].customType, "subagent_result");
    assert.equal(paint(), "", "the roster outlived the finished run");

    // The handle stays addressable after the run ends: the session file is
    // still there, so there is still a child to pick back up — as what it was,
    // which is what the loadout snapshot beside it is for.
    assert.ok(fs.existsSync(path.join(commands[0].dir, "session.jsonl")));
    const loadout = JSON.parse(fs.readFileSync(path.join(commands[0].dir, "loadout.json"), "utf-8"));
    assert.equal(loadout.agent, "scout");
    assert.equal(loadout.pane, false);
    assert.equal(loadout.sessionPath, path.join(commands[0].dir, "session.jsonl"));
    assert.ok(loadout.args.includes("--tools"));
    // The child's environment is the user's environment. Only what this
    // extension puts there may be written to a file in /tmp.
    assert.deepEqual(Object.keys(loadout.env).filter((k) => !k.startsWith("PI_SUBAGENT_")), []);
    await tools.get("subagent_message").execute("m", { handle, message: "one more thing" }, undefined, undefined, ctx);
    await until("the follow-up to finish", () => result.progress.status === "completed" && pi.commands().length > 2);
    assert.match(pi.commands()[2].message, /Your caller has more for you: one more thing/);

    // The run directory no longer goes when the session does — that is what
    // made a handle worthless the moment the parent restarted.
    await shutdownAll();
    assert.equal(fs.existsSync(commands[0].dir), true, "the run directory was reclaimed with its session");
  } finally {
    // Unconditional: a live child outlives a failed assertion and would keep
    // the test runner itself from exiting.
    await shutdownAll();
    pi.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

