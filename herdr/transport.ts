import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { MasterLayout, request } from "./layout.ts";

export interface PaneLaunch {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  directory: string; name: string; signal?: AbortSignal;
  /** Who writes the journal. `pi` means the child does, through the extension
   *  it loads; `claude` means `claude-pane.mjs` does, wrapped around a headless
   *  child that knows nothing about any of this. */
  bridge: "pi" | "claude";
  /** The task, for a bridged child: it arrives over the channel rather than in
   *  argv, so the pane has to be told what to open with. */
  openingPrompt?: string;
  onLine: (line: string) => void;
  /** The pane this child was given, as soon as it exists. A pane child has no
   *  stdin its parent can write to, so this is the only way to talk to it. */
  onPane?: (paneId: string) => void;
}

/**
 * The `herdr` executable to shell out to.
 *
 * Herdr hands every pane a `HERDR_BIN_PATH` taken from its server's own
 * `/proc/self/exe`. When the binary is replaced in place — any upgrade — Linux
 * starts reporting that link with a literal `" (deleted)"` suffix, and a server
 * that has been running across the upgrade passes the suffixed string on to
 * every pane it opens afterwards. Spawning it fails with ENOENT, which reads
 * like a broken subagent rather than like a stale server.
 *
 * So the suffix is stripped, and a path that still is not there falls back to
 * whatever `herdr` is on PATH. The fallback is safe precisely because an
 * upgrade replaces the same path: PATH resolves to the new build. Looked up per
 * call rather than cached, so a session that outlives an upgrade recovers on
 * its own.
 */
export function herdrBin(): string {
  const declared = process.env.HERDR_BIN_PATH?.replace(/ \(deleted\)$/, "").trim();
  return declared && existsSync(declared) ? declared : "herdr";
}

/**
 * Type a message to an interactive child and press Enter.
 *
 * The same door a human at that pane would use — which is the point: a pane
 * child is a real Pi session, so it is steered the way one is. Newlines are
 * flattened because the first one would submit the message half-written.
 */
export async function sendToPane(paneId: string, message: string): Promise<void> {
  const text = message.replace(/\s*\n+\s*/g, " ").trim();
  if (!text) return;
  await promisify(execFile)(herdrBin(), ["pane", "run", paneId, text], { timeout: 10000 });
}
const here = path.dirname(fileURLToPath(import.meta.url));
export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
/**
 * Turn a headless pi invocation into the interactive one a pane wants.
 *
 * Only pi's. A bridged child stays exactly as headless as it was built —
 * `claude-pane.mjs` is driving it over the same stream-json channel the
 * process backend uses, and stripping `-p` would take that channel away.
 */
export function interactiveArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") { i++; continue; }
    if (args[i] === "-p") continue;
    result.push(args[i]);
  }
  // `child.ts` is not added here: `buildPiArgs` loads it for every pi child, so
  // a pane child would otherwise be handed the same extension twice.
  return result;
}

export async function runInPane(layout: MasterLayout, spec: PaneLaunch): Promise<{ code: number; error?: string }> {
  spec.signal?.throwIfAborted();
  // Keep Node's entrypoint before Pi flags.
  const entry = spec.args[0]?.match(/\.(?:mjs|cjs|js)$/) ? spec.args.slice(0, 1) : [];
  const args = spec.bridge === "claude"
    ? spec.args
    : [...entry, ...interactiveArgs(spec.args.slice(entry.length))];
  await fs.writeFile(path.join(spec.directory, "launch.json"), JSON.stringify({
    command: spec.command, args, cwd: spec.cwd, env: spec.env,
    bridge: spec.bridge, openingPrompt: spec.openingPrompt,
  }), { mode: 0o600 });
  await fs.writeFile(path.join(spec.directory, "heartbeat"), "", { mode: 0o600 });
  await fs.writeFile(path.join(spec.directory, "events.jsonl"), "", { mode: 0o600 });
  // A resumed run reuses its directory, so the previous leg's verdict is still
  // sitting there. Left in place it would be read as this launch's exit before
  // the pane has even started.
  await fs.rm(path.join(spec.directory, "exit.json"), { force: true });
  await fs.rm(path.join(spec.directory, "cancel"), { force: true });
  const pane = await layout.create(spec.name, spec.cwd);
  spec.onPane?.(pane);
  let offset = 0, pending = "", ready = false, complete = false;
  let cancelledAt = 0;
  const start = Date.now();
  const cancel = () => { cancelledAt ||= Date.now(); void fs.writeFile(path.join(spec.directory, "cancel"), "", { mode: 0o600 }).catch(() => {}); };
  spec.signal?.addEventListener("abort", cancel, { once: true });
  const readEvents = async () => {
    const file = await fs.open(path.join(spec.directory, "events.jsonl"), "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        // Preserve split UTF-8 characters by buffering bytes until newline.
        bytes = Buffer.concat([bytes, buffer.subarray(0, bytesRead)]);
        let end: number;
        while ((end = bytes.indexOf(10)) >= 0) {
          pending = bytes.subarray(0, end).toString("utf8"); bytes = bytes.subarray(end + 1);
          const event = JSON.parse(pending);
          if (event.type === "bridge_ready") ready = true;
          if (event.type === "bridge_complete") complete = true;
          spec.onLine(pending);
        }
      }
    } finally { await file.close(); }
  };
  let bytes: Buffer = Buffer.alloc(0);
  try {
    // Wait for the actual shell foreground process, rather than sending into shell startup.
    while (true) {
      spec.signal?.throwIfAborted();
      const { process_info: info } = await request("pane.process_info", { pane_id: pane });
      if (info.foreground_processes?.some((p: any) => p.pid === info.shell_pid)) break;
      if (Date.now() - start > 15000) throw new Error("Child shell did not become ready");
      await delay(100);
    }
    await delay(300);
    spec.signal?.throwIfAborted();
    const command = [process.execPath, path.join(here, "runner.mjs"), spec.directory].map(shellQuote).join(" ");
    await promisify(execFile)(herdrBin(), ["pane", "run", pane, command], { timeout: 10000 });
    let lastInspection = 0;
    while (true) {
      await readEvents();
      try {
        const exit = JSON.parse(await fs.readFile(path.join(spec.directory, "exit.json"), "utf8"));
        await readEvents();
        if (exit.code === 0 && !complete) return { code: 1, error: "Child exited before completing its task" };
        return exit;
      } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      if (!ready && Date.now() - start > 60000) throw new Error("Child Pi did not start within 60 seconds");
      if (spec.signal?.aborted) cancel();
      if (cancelledAt && Date.now() - cancelledAt > 8000) throw new Error("Subagent cancelled");
      if (Date.now() - lastInspection > 2000) {
        await request("pane.get", { pane_id: pane });
        lastInspection = Date.now();
      }
      await fs.utimes(path.join(spec.directory, "heartbeat"), new Date(), new Date());
      await delay(100);
    }
  } finally {
    spec.signal?.removeEventListener("abort", cancel);
    // Closing only an owned pane also terminates a failed/stalled launch.
    await layout.release(pane);
  }
}
