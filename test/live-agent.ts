// Explicit opt-in: launches real Pi and incurs model usage. No file mutations requested.
import assert from "node:assert/strict";
import extension from "../index.ts";
import { request } from "../herdr/layout.ts";
const model = process.env.PI_TEST_MODEL;
if (!model?.includes("/")) throw new Error("Set PI_TEST_MODEL=provider/model (uses real credentials)");
if (process.env.HERDR_ENV !== "1") throw new Error("Run inside Herdr");
const nested = process.env.PI_TEST_NESTED === "1";
if (nested && !process.env.PI_TEST_WEB_EXTENSION) throw new Error("Nested worker smoke requires PI_TEST_WEB_EXTENSION=/path/to/pi-web-access/index.ts");
const tools = new Map<string, any>();
const handlers = new Map<string, Array<(...args: any[]) => any>>();
const [provider, ...ids] = model.split("/");
extension({
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {},
  on(name: string, fn: any) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
  getAllTools: () => process.env.PI_TEST_WEB_EXTENSION ? ["web_search", "fetch_content"].map(name => ({ name, sourceInfo: { source: "package", path: process.env.PI_TEST_WEB_EXTENSION } })) : [],
} as any);
const before = await request("pane.layout", { pane_id: process.env.HERDR_PANE_ID });
try {
  const result = await tools.get("subagent").execute("smoke", {
    agent: nested ? "worker" : "scout",
    task: nested ? "Call the subagent tool twice in parallel, both with agent scout. First task: reply exactly CHILD_A_OK without using tools. Second task: reply exactly CHILD_B_OK without using tools. After both succeed reply exactly HERDR_SMOKE_OK. Do not use any other tools or modify any files."
      : "Reply exactly HERDR_SMOKE_OK. Do not use any tools.", cwd: process.cwd(),
  }, AbortSignal.timeout(120000), (update: any) => console.log("progress", update.details.results[0].progress.status), {
    cwd: process.cwd(), model: { provider, id: ids.join("/") }, modelRegistry: { find: () => undefined },
  });
  assert.match(result.content[0].text, /HERDR_SMOKE_OK/);
  assert.equal(result.details.results[0].progress.status, "completed");
  if (nested) {
    const children = result.details.results[0].progress.recentTools.filter((t: any) => t.tool === "subagent").flatMap((t: any) => t.children ?? []);
    assert.equal(children.length, 2);
    assert.ok(children.every((c: any) => c.progress.status === "completed"));
  }
  const after = await request("pane.layout", { pane_id: process.env.HERDR_PANE_ID });
  assert.deepEqual(after.layout.panes.map((p: any) => p.pane_id), before.layout.panes.map((p: any) => p.pane_id));
  console.log("PASS: real interactive Pi, event bridge, result, pane cleanup", result.content[0].text);
} finally {
  for (const fn of handlers.get("session_shutdown") ?? []) await fn();
}
