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

    // And every run directory goes when the session that owns them does.
    await shutdownAll();
    assert.equal(fs.existsSync(commands[0].dir), false, "a run directory outlived its session");
  } finally {
    // Unconditional: a live child outlives a failed assertion and would keep
    // the test runner itself from exiting.
    await shutdownAll();
    pi.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ── The same loop, under the claude runner ────────────────────────────
//
// A stand-in for Claude Code's headless streaming mode: user messages in on
// stdin as JSON lines, its event stream out on stdout. Its run directory comes
// from the `--mcp-config` it was handed, because a claude child gets none of
// the PI_SUBAGENT_* variables a pi child does. First turn it asks and keeps the
// floor; after that it answers and waits for its stdin to be closed — it has no
// way to end its own session, which is the whole difference from the pi child
// above.
const FAKE_CLAUDE = `
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]);
const dir = mcp.mcpServers.pi_subagents.env.PI_SUBAGENT_RUN_DIR;
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
    const text = command.message.content.map((c) => c.text).join("");
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ dir, argv, text }) + "\\n");
    emit({ type: "system", subtype: "init", model: "claude-sonnet-5" });
    const asked = path.join(dir, "asked");
    if (!fs.existsSync(asked)) {
      fs.writeFileSync(asked, "");
      emit({ type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "mcp__pi_subagents__caller_ping", input: { question: "Postgres or SQLite?" } },
      ] } });
      emit({ type: "result", subtype: "success", result: "I need to know which database." });
      return;                        // still alive, parked on the question
    }
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done: " + text }] } });
    emit({ type: "result", subtype: "success", result: "Done: " + text });
    // No exit: a claude child holds the floor until its caller closes stdin.
  }
});
`;

/** The values a variadic flag was given, in the order argv carries them. */
function valuesAfter(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) out.push(args[i]);
  return out;
}

/** Put the stand-in on PATH as `claude`, and give it somewhere to report. */
function stubClaude(directory: string) {
  const entry = path.join(directory, "fake-claude.mjs");
  fs.writeFileSync(entry, FAKE_CLAUDE);
  const shim = path.join(directory, "claude");
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${entry} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH, oldLog = process.env.FAKE_CLAUDE_LOG;
  process.env.PATH = `${directory}:${process.env.PATH}`;
  process.env.FAKE_CLAUDE_LOG = path.join(directory, "messages.jsonl");
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, "");
  return {
    messages: () => fs.readFileSync(path.join(directory, "messages.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    restore: () => {
      process.env.PATH = oldPath;
      if (oldLog === undefined) delete process.env.FAKE_CLAUDE_LOG; else process.env.FAKE_CLAUDE_LOG = oldLog;
    },
  };
}

test("a claude child asks, parks, and is answered on the same channel", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-waiting-test-"));
  const claude = stubClaude(directory);
  let shutdownAll = async () => {};
  try {
    const { tools, handlers, steers, paint } = load();
    shutdownAll = async () => { await handlers.get("session_shutdown")(); };
    const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "pick a store", runner: "claude" }, undefined, undefined, ctx);
    const handle = ack.details.dispatched;
    const result = ack.details.results[0];
    await until("the run to start waiting", () => result.progress.status === "waiting");

    // Everything the parent knows about the question it read off the child's
    // own event stream: the ask tool has no channel back here.
    assert.equal(result.question, "Postgres or SQLite?");
    assert.equal(result.exitCode, -1, "a parked run is not a finished one");
    assert.equal(steers[0].customType, "subagent_question");
    assert.match(steers[0].content, /Postgres or SQLite\?/);
    assert.match(paint(), /1 subagent: 0 running, 1 waiting on an answer/);

    await tools.get("subagent_message").execute("m", { handle, message: "Postgres" }, undefined, undefined, ctx);
    await until("the answered run to finish", () => result.progress.status === "completed");

    const messages = claude.messages();
    assert.equal(messages.length, 2, "the child was restarted instead of spoken to");
    assert.equal(messages[0].dir, messages[1].dir, "the second message went to a different child");
    assert.match(messages[1].text, /Your caller answered: Postgres/);
    assert.equal(result.output, "Done: " + messages[1].text);
    assert.equal(steers[1].customType, "subagent_result");

    // The ask tool runs in its own process and cannot see any of this, so the
    // parent leaves it the one fact it needs: the question has been answered.
    const answers = fs.readFileSync(path.join(messages[0].dir, "answers.jsonl"), "utf-8").trim().split("\n");
    assert.equal(answers.length, 1);

    // A claude session is an id in the user's own store rather than a file in
    // the run directory, and picking the child back up means joining it.
    const loadout = JSON.parse(fs.readFileSync(path.join(messages[0].dir, "loadout.json"), "utf-8"));
    assert.equal(loadout.runner, "claude");
    assert.match(loadout.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(loadout.sessionPath, undefined);
    assert.deepEqual(valuesAfter(messages[0].argv, "--session-id"), [loadout.sessionId]);

    await tools.get("subagent_message").execute("m", { handle, message: "one more thing" }, undefined, undefined, ctx);
    await until("the follow-up to finish", () => result.progress.status === "completed" && claude.messages().length > 2);
    const followUp = claude.messages()[2];
    assert.match(followUp.text, /Your caller has more for you: one more thing/);
    assert.deepEqual(valuesAfter(followUp.argv, "--resume"), [loadout.sessionId]);
    assert.ok(!followUp.argv.includes("--session-id"), "a resumed child asked for a new session under the same id");
  } finally {
    await shutdownAll();
    claude.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// ── Telling a stop from a failure ─────────────────────────────────────
//
// A child stops for four reasons and they are not the same news. The two that
// matter most look identical from inside the child — both arrive as an abort —
// and the one that matters most of all cannot be seen from here at all: a
// parent that went away without saying so is reported by the pane watcher,
// which is the only thing still running to notice.
test("a run stopped on purpose is not reported as a run that failed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-test-"));
  const pi = stubPi(directory);
  let shutdownAll = async () => {};
  try {
    const { tools, handlers, steers, paint } = load();
    shutdownAll = async () => { await handlers.get("session_shutdown")(); };
    const turn = new AbortController();
    const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "something long" }, turn.signal, undefined, ctx);
    const result = ack.details.results[0];
    await until("the run to start waiting", () => result.progress.status === "waiting");

    // The user interrupting the turn is an abort with nobody's reason on it.
    turn.abort();
    await until("the stopped run to settle", () => result.progress.status === "failed");
    assert.equal(result.progress.stoppedBy, "user");
    assert.match(result.progress.error, /Stopped by the user/);
    // A settled run leaves the roster, so the mark to check is the one on the
    // steered result below, not the widget.
    assert.equal(paint(), "");

    const steer = steers.at(-1);
    assert.equal(steer.customType, "subagent_result");
    assert.doesNotMatch(steer.content, /failed/, "a deliberate stop was reported to the model as a failure");
    assert.match(steer.content, /was stopped after/);
    // Without this the model's next move is to dispatch the same thing again.
    assert.match(steer.content, /Do not dispatch it again unless they ask/);
  } finally {
    await shutdownAll();
    pi.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the session ending under a run says so, rather than blaming the user", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stop-session-test-"));
  const pi = stubPi(directory);
  try {
    const { tools, handlers, steers } = load();
    const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "something long" }, undefined, undefined, ctx);
    const result = ack.details.results[0];
    await until("the run to start waiting", () => result.progress.status === "waiting");

    await handlers.get("session_shutdown")();
    assert.equal(result.progress.stoppedBy, "session");
    assert.match(result.progress.error, /the session that dispatched it ended/);
    // Nobody reads this one — the session is over — but the record is the
    // record, and a run directory may outlive the process that wrote it.
    assert.match(steers.at(-1).content, /was stopped after/);
  } finally {
    pi.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
