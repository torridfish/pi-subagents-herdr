import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * What a subagent child loads that a normal Pi session does not.
 *
 * Two things, both keyed on `PI_SUBAGENT_RUN_DIR` so this file is inert
 * anywhere else:
 *
 *  - The sidecar event bridge (pane children only, `PI_SUBAGENT_BRIDGE`): real
 *    interactive Pi in the child pane, original JSON progress protocol in the
 *    parent. Never scrape terminal text for results.
 *  - `caller_ping`: the child's one way to talk back. Writing the sidecar is
 *    the whole mechanism — the run ends normally afterwards and the parent
 *    restarts it from its session file with the answer. There is no channel to
 *    block on, and deliberately so: a child waiting on a parent that is itself
 *    waiting on a model is a deadlock with a timeout attached.
 */
export default function (pi: ExtensionAPI) {
  const directory = process.env.PI_SUBAGENT_RUN_DIR;
  if (!directory) return;
  const pingPath = path.join(directory, "ping.json");

  pi.registerTool({
    name: "caller_ping",
    label: "Ask caller",
    description:
      "Ask the agent that dispatched you a question and pause until it answers. "
      + "Your session ends the moment you call this — everything you have done so far is kept, "
      + "and you are resumed with the answer delivered as your next message, so ask for exactly "
      + "what you need and nothing else.",
    promptSnippet: "Ask your caller a question when you are blocked, then pause for the answer",
    promptGuidelines: [
      "Use caller_ping only for a genuine blocker: a decision only your caller can make, a "
      + "credential or path you were not given, or a destructive step you should not take unasked.",
      "Never use caller_ping for progress reports, to confirm an assumption you could check "
      + "yourself, or to ask a question the brief already answers — finish the work instead.",
      "State the question in one self-contained paragraph. Your caller sees the question alone, "
      + "not your conversation, so include the context and the options you are choosing between.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "What you need to know, self-contained. Include the options you are weighing and what you will do with the answer." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = params.question?.trim();
      if (!question) throw new Error("caller_ping requires a question.");
      if (fs.existsSync(pingPath)) {
        throw new Error("You have already asked your caller a question this turn; it can only answer one. Stop here and wait.");
      }
      // Atomic: the parent polls for this file the moment the child exits, and
      // must never read a half-written one.
      fs.writeFileSync(pingPath + ".tmp", JSON.stringify({ type: "ping", question, at: Date.now() }), { mode: 0o600 });
      fs.renameSync(pingPath + ".tmp", pingPath);
      // No-op in print mode, where the process exits once the turn is done, and
      // deferred to idle in a pane — either way the tool result is persisted to
      // the session file first, so the resumed run reads back a complete turn.
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Question sent to your caller. Stop now: end your turn without calling another tool and without guessing an answer. You will be resumed with the reply." }],
        details: { question },
      };
    },
  });

  // Only a pane child needs the event bridge: it has no stdout its parent can
  // read. `runner.mjs` sets this flag, so the process backend loads the same
  // extension and gets everything except the journal.
  const bridged = process.env.PI_SUBAGENT_BRIDGE === "1";
  const emit = (event: unknown) => fs.appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  let started = false;
  pi.on("session_start", () => {
    if (bridged) emit({ type: "bridge_ready" });
    // Descendants must not write into their parent's run directory.
    delete process.env.PI_SUBAGENT_RUN_DIR;
    delete process.env.PI_SUBAGENT_BRIDGE;
  });
  if (!bridged) return;
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
