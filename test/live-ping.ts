// Explicit opt-in: launches a real Pi child and incurs model usage. Read-only.
//
//   PI_TEST_MODEL=provider/model-id npx tsx test/live-ping.ts
//
// Checks the waiting loop end to end against real Pi: a child that cannot
// finish without an answer calls `caller_ping`, its session stays open instead
// of ending, and `subagent_message` reaches that same live child with the
// answer. Run it inside Herdr to exercise the pane path (interactive child,
// sidecar journal, typed-in answer) as well as the process one.
import assert from "node:assert/strict";
import extension, { registerAgent } from "../index.ts";

const model = process.env.PI_TEST_MODEL;
if (!model?.includes("/")) throw new Error("Set PI_TEST_MODEL=provider/model (uses real credentials)");
const [provider, ...ids] = model.split("/");

const tools = new Map<string, any>();
const handlers = new Map<string, Array<(...args: any[]) => any>>();
const steers: any[] = [];
extension({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {},
  on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  getAllTools: () => [],
  registerMessageRenderer() {},
  sendMessage(message: any) { steers.push(message); },
} as any);
for (const fn of handlers.get("session_start") ?? []) fn({}, { ui: { setWidget() {} } });

// Registered rather than configured, so the check does not depend on the local
// config.json. Note that it declares no `caller_ping` — every child gets it.
registerAgent({
  name: "probe-ping", description: "live check", tools: ["read"], model, thinking: "low", filePath: "",
  systemPrompt: "You are a careful assistant. You never guess at a requirement you were not given.",
});

const TASK = "Write a one-line greeting for this project's README, in the language the project uses. "
  + "You have not been told which language that is, and you must not choose one yourself: ask your caller. "
  + "When you know, reply with GREETING: followed by the line itself.";
const ANSWER = "Use Traditional Chinese. Include the passphrase BLUEBIRD-42 verbatim in the greeting line.";

const ctx = { cwd: process.cwd(), model: { provider, id: ids.join("/") }, modelRegistry: { find: () => undefined } };

async function until(what: string, predicate: () => boolean, ms = 300000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

try {
  const ack = await tools.get("subagent").execute("live", { agent: "probe-ping", task: TASK, cwd: process.cwd() },
    AbortSignal.timeout(600000), undefined, ctx);
  const handle = ack.details.dispatched;
  const run = ack.details.results[0];

  await until("the child to ask its caller a question", () => run.progress.status === "waiting" || run.progress.status === "failed");
  assert.equal(run.progress.status, "waiting", `the run never waited: ${run.progress.error ?? run.output}`);
  assert.ok(run.question, "waiting with no question");
  assert.equal(run.exitCode, -1, "the child exited instead of staying open");
  assert.equal(steers.at(-1)?.customType, "subagent_question");
  const toolsAtPause = run.progress.toolCount, turnsAtPause = run.usage.turns;
  console.log(`WAITING ${handle} after ${turnsAtPause} turns: ${JSON.stringify(run.question)}`);

  await tools.get("subagent_message").execute("live", { handle, message: ANSWER }, AbortSignal.timeout(600000), undefined, ctx);
  await until("the answered child to finish", () => run.progress.status === "completed" || run.progress.status === "failed");
  assert.equal(run.progress.status, "completed", `the answered run failed: ${run.progress.error}`);

  // The answer reached the child, and the child that received it is the one
  // that asked — a fresh process would have neither the question nor the task.
  assert.match(run.output, /GREETING:/);
  assert.match(run.output, /BLUEBIRD-42/);
  assert.ok(run.usage.turns > turnsAtPause, "the answered leg added no turns");
  assert.ok(run.progress.toolCount >= toolsAtPause, "the tool log was reset by the answer");
  assert.equal(steers.at(-1)?.customType, "subagent_result");
  assert.equal(steers.length, 2, `expected one question and one result, got ${steers.map((s) => s.customType).join(", ")}`);

  console.log(`PASS ${handle} model=${run.model} turns=${run.usage.turns} ${JSON.stringify(run.output.slice(0, 120))}`);
  console.log("PASS: a child can wait on a question, and be answered in the same live session");
} finally {
  for (const fn of handlers.get("session_shutdown") ?? []) await fn();
}
