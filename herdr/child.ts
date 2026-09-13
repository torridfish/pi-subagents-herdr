import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Sidecar event bridge: real interactive Pi in the child pane, original JSON
 * progress protocol in the parent. Never scrape terminal text for results. */
export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_SUBAGENT_RUN_DIR;
  if (!directory) return;
  const emit = (event: unknown) => fs.appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  let started = false;
  pi.on("session_start", () => {
    emit({ type: "bridge_ready" });
    // Descendants must not write into their parent's event journal.
    delete process.env.PI_SUBAGENT_RUN_DIR;
  });
  pi.on("agent_start", () => { started = true; });
  pi.on("tool_execution_start", event => { emit(event); });
  pi.on("tool_execution_update", event => { emit(event); });
  pi.on("tool_execution_end", event => { emit(event); });
  pi.on("message_end", event => { emit(event); });
  pi.on("agent_settled", (_event, ctx) => {
    if (!started) return;
    emit({ type: "bridge_complete" });
    ctx.shutdown();
  });
}
