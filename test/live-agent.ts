// Explicit opt-in: launches real Pi and incurs model usage. No file mutations requested.
//
//   PI_TEST_MODEL=provider/model-id npx tsx test/live-agent.ts
//
// Checks the async contract end to end inside Herdr: two children dispatched in
// one go, both acking before either finishes, both steering their own result
// back, and the pane layout restored afterwards.
import assert from "node:assert/strict";
import extension from "../index.ts";
import { request } from "../herdr/layout.ts";

const model = process.env.PI_TEST_MODEL;
if (!model?.includes("/")) throw new Error("Set PI_TEST_MODEL=provider/model (uses real credentials)");
if (process.env.HERDR_ENV !== "1") throw new Error("Run inside Herdr");
const [provider, ...ids] = model.split("/");

const tools = new Map<string, any>();
const handlers = new Map<string, Array<(...args: any[]) => any>>();
const steers: any[] = [];
const arrived = new Map<unknown, () => void>();
let widget: ((tui: unknown, theme: any) => any) | undefined;

extension({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {},
  on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  getAllTools: () => [],
  registerMessageRenderer() {},
  sendMessage(message: any) {
    steers.push(message);
    // The steer carries the same live record the dispatch handed back, so the
    // waiter is keyed on object identity rather than on parsing the text.
    arrived.get(message.details?.results?.[0])?.();
  },
} as any);

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
for (const fn of handlers.get("session_start") ?? []) {
  fn({}, { ui: { setWidget: (_key: string, content: any) => { widget = content; } } });
}

const ctx = { cwd: process.cwd(), model: { provider, id: ids.join("/") }, modelRegistry: { find: () => undefined } };
const signal = AbortSignal.timeout(180000);

const dispatch = (task: string) =>
  tools.get("subagent").execute("smoke", { agent: "scout", task, cwd: process.cwd() }, signal, undefined, ctx);

/** Resolve when this run's result is steered back, or reject on timeout. */
function landing(ack: any, ms: number): Promise<void> {
  const record = ack.details.results[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ack.details.dispatched} never steered back within ${ms}ms`)), ms);
    arrived.set(record, () => { clearTimeout(timer); resolve(); });
  });
}

const before = await request("pane.layout", { pane_id: process.env.HERDR_PANE_ID });
try {
  const a = await dispatch("Reply exactly HERDR_SMOKE_A. Do not use any tools.");
  const b = await dispatch("Reply exactly HERDR_SMOKE_B. Do not use any tools.");

  // The whole point of the change: both calls returned while both children are
  // still alive. A regression to awaiting inside execute() fails right here.
  assert.equal(steers.length, 0, "a dispatch waited for its child before returning");
  assert.match(a.details.dispatched, /^scout-\d+$/);
  assert.notEqual(a.details.dispatched, b.details.dispatched);

  // Two panes open, and the roster says so.
  const painted = widget?.(null, theme).render(80).join("\n") ?? "";
  console.log(painted);
  assert.match(painted, /2 subagents running/);

  await Promise.all([landing(a, 180000), landing(b, 180000)]);

  assert.equal(steers.length, 2, `expected two steers, got ${steers.length}`);
  const outputs = steers.map((m) => m.content).join("\n");
  assert.match(outputs, /HERDR_SMOKE_A/);
  assert.match(outputs, /HERDR_SMOKE_B/);
  for (const message of steers) {
    assert.equal(message.customType, "subagent_result");
    assert.equal(message.details.results[0].progress.status, "completed");
  }

  // Nothing in flight, so the roster clears itself.
  assert.equal(widget, undefined, "the roster outlived the last run");

  const after = await request("pane.layout", { pane_id: process.env.HERDR_PANE_ID });
  assert.deepEqual(after.layout.panes.map((p: any) => p.pane_id), before.layout.panes.map((p: any) => p.pane_id));
  console.log("PASS: two real Pi children dispatched async, both steered back, panes cleaned up");
} finally {
  for (const fn of handlers.get("session_shutdown") ?? []) await fn();
}
