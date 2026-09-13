import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type LayoutNode = { type: "pane"; pane_id: string } | {
  type: "split"; direction: "right" | "down"; ratio: number;
  first: LayoutNode; second: LayoutNode;
};
export type Request = (method: string, params: Record<string, unknown>) => Promise<any>;

/** Herdr's local, newline-delimited JSON API. Never use UI focus as a target. */
export const request: Request = (method, params) => new Promise((resolve, reject) => {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) {
    reject(new Error("Herdr requires HERDR_ENV=1 and HERDR_SOCKET_PATH")); return;
  }
  const id = randomUUID();
  const socket = net.createConnection(process.env.HERDR_SOCKET_PATH);
  let buffer = "";
  const fail = (error: Error) => { socket.destroy(); reject(error); };
  socket.setTimeout(10000, () => fail(new Error(`Herdr ${method} timed out`)));
  socket.on("error", fail);
  socket.on("end", () => reject(new Error(`Herdr ${method}: connection ended before response`)));
  socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
  socket.on("data", chunk => {
    buffer += chunk.toString();
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error("Herdr response too large")); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        if (response.id !== id) continue;
        socket.destroy();
        if (response.error) reject(new Error(`Herdr ${method}: ${JSON.stringify(response.error)}`));
        else resolve(response.result);
      } catch (error) { fail(error as Error); }
    }
  });
});

export function leaves(node: LayoutNode): string[] {
  return node.type === "pane" ? [node.pane_id] : [...leaves(node.first), ...leaves(node.second)];
}

/** Only resize vertical subtrees wholly owned by this subagent group. */
export function balancePlan(root: LayoutNode, owned: Set<string>, route: boolean[] = []): Array<{ path: boolean[]; ratio: number }> {
  if (root.type === "pane") return [];
  const first = leaves(root.first), second = leaves(root.second);
  const own = [...first, ...second].every(id => owned.has(id));
  const plan = own && root.direction === "down"
    ? [{ path: route, ratio: first.length / (first.length + second.length) }] : [];
  return [...plan, ...balancePlan(root.first, owned, [...route, false]), ...balancePlan(root.second, owned, [...route, true])];
}

interface State { master: string; panes: string[] }

/** Shared directory is inherited by nested workers, so the entire tree uses one stack.
 * mkdir is an atomic cross-process lock; an abandoned lock fails closed, never steals ownership.
 */
export class MasterLayout {
  constructor(readonly directory: string, readonly master: string, readonly ratio = 0.6,
    readonly minRows = 8, private api: Request = request) {}

  private async locked<T>(fn: (state: State) => Promise<T>): Promise<T> {
    const lock = path.join(this.directory, "lock");
    const until = Date.now() + 30000;
    while (true) {
      try { await fs.mkdir(lock); break; }
      catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() > until) throw new Error("Herdr layout lock timed out; restart the parent session if its owner crashed");
        await delay(40);
      }
    }
    try {
      let state: State;
      try { state = JSON.parse(await fs.readFile(path.join(this.directory, "state.json"), "utf8")); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; state = { master: this.master, panes: [] }; }
      return await fn(state);
    } finally { await fs.rmdir(lock); }
  }
  private async save(state: State) {
    const file = path.join(this.directory, "state.json");
    await fs.writeFile(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
    await fs.rename(file + ".tmp", file);
  }
  private async rebalance(state: State) {
    const { layout } = await this.api("layout.export", { pane_id: state.master });
    for (const change of balancePlan(layout.root, new Set(state.panes))) {
      await this.api("layout.set_split_ratio", { tab_id: layout.tab_id, ...change });
    }
  }
  async create(name: string, cwd: string): Promise<string> {
    return this.locked(async state => {
      const { layout } = await this.api("pane.layout", { pane_id: state.master });
      const live = new Set<string>(layout.panes.map((p: any) => p.pane_id));
      if (!live.has(state.master)) throw new Error("Master pane is no longer in this tab");
      state.panes = state.panes.filter(id => live.has(id));
      const masterRect = layout.panes.find((p: any) => p.pane_id === state.master).rect;
      if (masterRect.height / (state.panes.length + 1) < this.minRows) {
        throw new Error(`Herdr stack is full (minimum ${this.minRows} rows per child); wait for an agent to finish`);
      }
      // Reject user-modified stack geometry instead of resizing their unrelated panes.
      if (state.panes.length) {
        const owned = layout.panes.filter((p: any) => state.panes.includes(p.pane_id));
        if (owned.some((p: any) => p.rect.x !== masterRect.x + masterRect.width || p.rect.width !== owned[0].rect.width)
          || owned.reduce((n: number, p: any) => n + p.rect.height, 0) !== masterRect.height) {
          throw new Error("Herdr stack was rearranged manually; finish existing children before spawning more");
        }
        state.panes = owned.sort((a: any, b: any) => a.rect.y - b.rect.y).map((p: any) => p.pane_id);
      }
      const target = state.panes.at(-1) ?? state.master;
      const response = await this.api("pane.split", {
        target_pane_id: target, direction: state.panes.length ? "down" : "right",
        ratio: state.panes.length ? 0.5 : this.ratio, cwd, focus: false,
      });
      const pane = response.pane?.pane_id;
      if (typeof pane !== "string") throw new Error("Herdr split returned no pane ID");
      state.panes.push(pane);
      await this.save(state);
      try {
        await this.rebalance(state);
        await this.api("pane.rename", { pane_id: pane, label: name });
        return pane;
      } catch (error) {
        await this.api("pane.close", { pane_id: pane }).catch(() => {});
        state.panes = state.panes.filter(id => id !== pane); await this.save(state);
        throw error;
      }
    });
  }
  async release(pane: string) {
    await this.locked(async state => {
      if (!state.panes.includes(pane)) return;
      const { layout } = await this.api("pane.layout", { pane_id: state.master });
      // A manually moved pane is no longer ours to close.
      if (layout.panes.some((p: any) => p.pane_id === pane)) await this.api("pane.close", { pane_id: pane });
      state.panes = state.panes.filter(id => id !== pane);
      await this.save(state);
      await this.rebalance(state);
    });
  }
}
