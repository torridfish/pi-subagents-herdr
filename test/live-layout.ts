// Explicit opt-in: creates and closes four owned panes in the calling tab.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MasterLayout, request } from "../herdr/layout.ts";
if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Run inside Herdr");
const master = process.env.HERDR_PANE_ID;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-live-layout-"));
const manager = new MasterLayout(directory, master);
const ids: string[] = [];
const before = await request("pane.layout", { pane_id: master });
try {
  for (let i = 0; i < 4; i++) ids.push(await manager.create(`layout-test-${i + 1}`, process.cwd()));
  const { layout } = await request("pane.layout", { pane_id: master });
  const children = layout.panes.filter((p: any) => ids.includes(p.pane_id));
  console.log(JSON.stringify(layout, null, 2));
  assert.equal(children.length, 4);
  const heights = children.map((p: any) => p.rect.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, `Unequal heights: ${heights}`);
  assert.ok(children.every((p: any) => p.rect.x === children[0].rect.x));
  assert.equal(layout.focused_pane_id, before.layout.focused_pane_id);
  await manager.release(ids.splice(1, 1)[0]);
  const next = await request("pane.layout", { pane_id: master });
  const remainingHeights = next.layout.panes.filter((p: any) => ids.includes(p.pane_id)).map((p: any) => p.rect.height);
  assert.ok(Math.max(...remainingHeights) - Math.min(...remainingHeights) <= 1);
  console.log("PASS: four equal stack panes, focus preserved, middle removal rebalanced");
} finally {
  for (const id of ids.reverse()) await manager.release(id);
  await fs.rm(directory, { recursive: true, force: true });
}
