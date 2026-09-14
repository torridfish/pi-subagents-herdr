import { test } from "node:test";
import assert from "node:assert/strict";

// Pinned before the extension is imported, because it reads the backend once at
// load. Without it this test opens real Herdr panes whenever the developer
// happens to be running inside Herdr — a unit test must not touch the terminal
// it is run from, and must not behave differently depending on where that is.
process.env.PI_SUBAGENT_BACKEND = "process";
const { default: extension } = await import("../index.ts");

// The async contract, observed at the only two points that are actually part of
// it: what `subagent` hands back, and what arrives later.
//
// No real agent runs here. Under `tsx --test` the resolved pi entry point is the
// test runner itself, so the child starts and dies almost immediately — which is
// all this needs. The question is never whether the child succeeded, it is
// whether the call returned without waiting for it and whether the outcome was
// steered back afterwards.

const tools = new Map<string, any>(), handlers = new Map<string, any>();
const steers: any[] = [];
let steered = false;
// Whatever was last handed to setWidget: a factory while runs are in flight,
// undefined once the roster empties.
let widget: ((tui: unknown, theme: any) => any) | undefined;
let widgetSet = false;

// Enough of a theme to drive the renderer. Colour is not what can break here —
// the width arithmetic around truncation is.
const stubTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
const paint = (width = 80): string =>
  widget ? widget(null, stubTheme).render(width).join("\n") : "";

extension({
  registerTool: (t: any) => tools.set(t.name, t),
  registerCommand() {},
  on: (n: string, fn: any) => handlers.set(n, fn),
  getAllTools: () => [],
  registerMessageRenderer() {},
  sendMessage: (message: any) => { steered = true; steers.push(message); },
} as any);

// The widget only exists once a session does, so the roster is dead code until
// session_start hands the extension a ctx to draw into.
const uiCtx = { ui: { setWidget: (_key: string, content: any) => { widget = content; widgetSet = true; } } };

const ctx = { cwd: process.cwd(), model: { provider: "vllm", id: "some-model" },
  modelRegistry: { find: () => undefined }, ui: { notify() {} } };

test("dispatch returns a handle, not an answer, and steers the result later", async () => {
  handlers.get("session_start")({}, uiCtx);
  const ack = await tools.get("subagent").execute("t", { agent: "scout", task: "t" }, undefined, undefined, ctx);

  // The call resolved. Nothing may have been steered yet — that is the whole
  // point of the change, and asserting it here is what would catch a regression
  // back to awaiting the child inside execute().
  assert.equal(steered, false, "execute() waited for the child before returning");

  assert.match(ack.details.dispatched, /^scout-\d+$/);
  assert.match(ack.content[0].text, /runs in the background/);
  // The ack must not read as a report. A model that sees output-shaped text here
  // will summarise it as though the child had answered.
  assert.ok(!/no output/i.test(ack.content[0].text), `ack looks like a result: ${ack.content[0].text}`);
  assert.equal(ack.details.results[0].exitCode, -1, "the run should still be open at ack time");

  // The pinned roster is the only place an in-flight run is visible, so a
  // renderer that throws or silently drops the handle is a real failure.
  const painted = paint();
  assert.match(painted, /1 subagent running/);
  assert.ok(painted.includes(ack.details.dispatched), `roster omits the handle:\n${painted}`);
  // Narrow terminals must still produce one line per run, never a crash or a
  // negative-width truncation.
  assert.ok(paint(24).split("\n").length >= 2, "roster collapsed at narrow width");

  // session_shutdown drains in-flight runs, which is also what delivers the
  // steer — so awaiting it is the honest way to wait for completion.
  await handlers.get("session_shutdown")();

  assert.equal(steers.length, 1, "the finished run was never steered back");
  const [message] = steers;
  assert.equal(message.customType, "subagent_result");
  assert.match(message.content, new RegExp(`^Subagent ${ack.details.dispatched} \\(scout\\)`));
  assert.equal(message.details.results[0], ack.details.results[0], "the steer should carry the same live record the widget rendered");
  assert.notEqual(message.details.results[0].exitCode, -1, "the record was steered while still marked open");

  // Nothing left in flight: the roster must clear itself rather than stick
  // around showing a finished run.
  assert.ok(widgetSet, "setWidget was never called");
  assert.equal(widget, undefined, "the roster outlived the last run");
});
