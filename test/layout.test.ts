import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { balancePlan, leaves, MasterLayout, type LayoutNode } from "../herdr/layout.ts";
const pane = (pane_id: string): LayoutNode => ({ type: "pane", pane_id });
const down = (first: LayoutNode, second: LayoutNode): LayoutNode => ({ type: "split", direction: "down", ratio: 0.5, first, second });

test("three and four children get equal shares; master and unrelated panes are untouched", () => {
  const stack = down(pane("a"), down(pane("b"), down(pane("c"), pane("d"))));
  const root: LayoutNode = { type: "split", direction: "right", ratio: 0.6, first: pane("master"), second: stack };
  assert.deepEqual(balancePlan(root, new Set(["a", "b", "c", "d"])), [
    { path: [true], ratio: 1 / 4 }, { path: [true, true], ratio: 1 / 3 }, { path: [true, true, true], ratio: 1 / 2 },
  ]);
  assert.deepEqual(balancePlan(down(pane("unrelated"), stack), new Set(["a", "b", "c", "d"])).map(p => p.path), [[true], [true, true], [true, true, true]]);
  assert.deepEqual(leaves(root), ["master", "a", "b", "c", "d"]);
});

test("single owned pane does not resize an unrelated split", () => {
  assert.deepEqual(balancePlan(down(pane("a"), pane("unrelated")), new Set(["a"])), []);
});

test("concurrent creators share the stack and only release their own panes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-test-"));
  let root: LayoutNode = pane("master"), next = 0;
  const calls: Array<[string, any]> = [];
  const replace = (node: LayoutNode, id: string, replacement: LayoutNode): LayoutNode => node.type === "pane"
    ? node.pane_id === id ? replacement : node
    : { ...node, first: replace(node.first, id, replacement), second: replace(node.second, id, replacement) };
  const remove = (node: LayoutNode, id: string): LayoutNode | undefined => {
    if (node.type === "pane") return node.pane_id === id ? undefined : node;
    const first = remove(node.first, id), second = remove(node.second, id);
    return first && second ? { ...node, first, second } : first ?? second;
  };
  const api = async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === "pane.layout") {
      const ids = leaves(root).filter(id => id !== "master");
      return { layout: { panes: [{ pane_id: "master", rect: { x: 0, y: 0, width: 60, height: 48 } }, ...ids.map((id, i) => ({ pane_id: id, rect: { x: 60, width: 40, y: i * 48 / ids.length, height: 48 / ids.length } }))] } };
    }
    if (method === "layout.export") return { layout: { root, tab_id: "tab" } };
    if (method === "pane.split") {
      const id = `child-${++next}`;
      root = replace(root, params.target_pane_id, { type: "split", direction: params.direction, ratio: params.ratio, first: pane(params.target_pane_id), second: pane(id) });
      return { pane: { pane_id: id } };
    }
    if (method === "pane.close") root = remove(root, params.pane_id)!;
    return {};
  };
  try {
    const a = new MasterLayout(dir, "master", 0.6, 8, api);
    const b = new MasterLayout(dir, "master", 0.6, 8, api);
    const ids = await Promise.all([a.create("scout", dir), b.create("worker", dir), a.create("scout", dir)]);
    const splits = calls.filter(([m]) => m === "pane.split").map(([, p]) => p);
    assert.deepEqual(splits.map(s => s.direction), ["right", "down", "down"]);
    assert.ok(splits.every(s => s.focus === false && s.cwd === dir));
    assert.deepEqual(splits.map(s => s.target_pane_id), ["master", "child-1", "child-2"]);
    await a.release("master");
    assert.equal(calls.filter(([m]) => m === "pane.close").length, 0);
    for (const id of ids) await a.release(id);
    assert.deepEqual(root, pane("master"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("capacity guard creates nothing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-capacity-"));
  try {
    const layout = new MasterLayout(dir, "master", 0.6, 8, async method => {
      assert.equal(method, "pane.layout");
      return { layout: { panes: [{ pane_id: "master", rect: { height: 4 } }] } };
    });
    await assert.rejects(layout.create("scout", dir), /stack is full/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
