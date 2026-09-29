import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { attachClaudeBridge } from "../herdr/claude-pane.mjs";

/**
 * A stand-in for the spawned `claude` and for the pane's own terminal.
 *
 * The bridge is the one piece of the pane path that can be tested without a
 * Herdr: it is a function over two pipes and a directory. What it cannot cover
 * is whether Herdr delivers keystrokes to it — that is what the live test is
 * for.
 */
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pane-test-"));
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const written: string[] = [];
  child.stdin.on("data", (d: Buffer) => written.push(...d.toString().split("\n").filter(Boolean)));
  let ended = false;
  const realEnd = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...args: any[]) => { ended = true; return realEnd(...args); };

  // The pane's stdin. Replaced for the length of the test, because the bridge
  // reads the terminal it is running in.
  const paneInput = new PassThrough();
  const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  Object.defineProperty(process, "stdin", { value: paneInput, configurable: true });
  const out: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any) => { out.push(String(chunk)); return true; }) as any;

  return {
    directory, child, paneInput,
    /** What the parent would read off the journal. */
    journal: () => fs.readFileSync(path.join(directory, "events.jsonl"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    answers: () => (fs.existsSync(path.join(directory, "answers.jsonl"))
      ? fs.readFileSync(path.join(directory, "answers.jsonl"), "utf-8").trim().split("\n").filter(Boolean) : []),
    /** What was sent to the child, as the texts it would have seen. */
    sent: () => written.map((l) => JSON.parse(l).message.content.map((c: any) => c.text).join("")),
    painted: () => out.join(""),
    stdinEnded: () => ended,
    emit: (event: unknown) => child.stdout.write(JSON.stringify(event) + "\n"),
    settle: () => new Promise((r) => setImmediate(r)),
    restore: () => {
      Object.defineProperty(process, "stdin", realStdin);
      process.stdout.write = realWrite;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const ASK = "mcp__pi_subagents__caller_ping";

test("the bridge journals every event and opens with the task", async () => {
  const h = harness();
  try {
    attachClaudeBridge(h.child, h.directory, "Task: map the auth module");
    await h.settle();
    assert.deepEqual(h.sent(), ["Task: map the auth module"]);
    assert.deepEqual(h.journal(), [{ type: "bridge_ready" }], "the parent has no way to know the pane came up");

    h.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.ts" } }] } });
    await h.settle();
    // Verbatim, whatever it is: the parent runs the same event adapter over
    // this journal that it runs over stdout on the process backend.
    assert.equal(h.journal().length, 2);
    assert.equal(h.journal()[1].message.content[0].name, "Read");
    assert.match(h.painted(), /Read.*src\/auth\.ts/);
  } finally { h.restore(); }
});

// The whole reason the bridge exists rather than a plain `stdio: inherit`:
// a claude child cannot end its own session, so somebody has to decide.
test("a turn that settles with nothing outstanding ends the child", async () => {
  const h = harness();
  try {
    attachClaudeBridge(h.child, h.directory, "Task: t");
    h.emit({ type: "assistant", message: { content: [{ type: "text", text: "All done." }] } });
    h.emit({ type: "result", subtype: "success", result: "All done." });
    await h.settle();
    assert.equal(h.stdinEnded(), true, "the child was left holding the floor forever");
    assert.match(h.painted(), /All done\./);
  } finally { h.restore(); }
});

test("a turn that settles on a question parks, and typing into the pane answers it", async () => {
  const h = harness();
  try {
    attachClaudeBridge(h.child, h.directory, "Task: pick a store");
    h.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: ASK, input: { question: "Postgres or SQLite?" } }] } });
    h.emit({ type: "result", subtype: "success" });
    await h.settle();
    assert.equal(h.stdinEnded(), false, "the child was killed while waiting for an answer");
    assert.match(h.painted(), /Postgres or SQLite\?/);
    assert.match(h.painted(), /waiting for an answer/);

    // Typed by the person in the pane, or by the parent through `sendToPane`
    // — the same keystrokes either way.
    h.paneInput.write("Postgres\n");
    await h.settle();
    assert.deepEqual(h.sent(), ["Task: pick a store", "Postgres"]);
    // The ask tool is a separate process with no channel to this one; the file
    // is how it learns its question was answered and it may ask again.
    assert.equal(h.answers().length, 1);

    // And now the next settled turn is the end of the run, not another park.
    h.emit({ type: "result", subtype: "success", result: "Postgres it is." });
    await h.settle();
    assert.equal(h.stdinEnded(), true);
  } finally { h.restore(); }
});

test("the parent is told the run completed, not just that the pane died", async () => {
  const h = harness();
  try {
    attachClaudeBridge(h.child, h.directory, "Task: t");
    h.child.emit("close", 0);
    await h.settle();
    // `runInPane` reports "exited before completing its task" without this,
    // however clean the exit code looks.
    assert.deepEqual(h.journal().at(-1), { type: "bridge_complete" });
  } finally { h.restore(); }
});
