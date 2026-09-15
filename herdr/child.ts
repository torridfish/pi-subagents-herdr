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
  /** Set by `caller_ping`, cleared by the answer. While it is set, a settled
   *  turn parks the session instead of ending it. */
  let awaitingAnswer = false;

  pi.registerTool({
    name: "caller_ping",
    label: "Ask caller",
    description:
      "Ask the agent that dispatched you a question, and pause until it answers. Use it when the brief "
      + "is ambiguous, when a choice would materially change what you produce, or when you need something "
      + "only your caller has — prefer asking over guessing. Your session pauses rather than ends: "
      + "everything you have done is kept, the answer arrives as your next message, and you carry on from "
      + "there. One question per call.",
    promptSnippet:
      "Ask your caller one clarifying, missing-requirement or decision question instead of guessing, then pause for the answer",
    // Ordered deliberately: what to use it FOR comes first, what not to use it
    // for comes last. A tool introduced by its restrictions is a tool a smaller
    // model never reaches for — the same lesson `buildPromptSurface` records
    // for `subagent` itself.
    promptGuidelines: [
      "Prefer caller_ping over guessing whenever the brief leaves open something that changes what you "
      + "produce: which of several valid approaches to take, a value or path you were not given, or "
      + "whether to take a step that cannot be undone.",
      "Use caller_ping when more than one answer is defensible and the right one depends on what your "
      + "caller intended — that is a decision to hand back, not one to make on their behalf.",
      "Put everything you need into one question: your session pauses on the first caller_ping, and a "
      + "second call in the same turn is refused.",
      "After calling caller_ping, stop. End your turn without another tool call and without assuming an answer.",
      "Give the question enough context to be answered on its own — your caller sees the question, not "
      + "your conversation — and name the options you are choosing between.",
      "Do not use caller_ping for progress reports, to confirm something you could establish by reading, "
      + "or to ask what the brief already answers.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "What you need to know, self-contained. Include the options you are weighing and what you will do with the answer." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const question = params.question?.trim();
      if (!question) throw new Error("caller_ping requires a question.");
      if (awaitingAnswer) {
        throw new Error("You have already asked your caller a question and are still waiting on it; it answers one at a time. Stop here.");
      }
      // The tool call itself is the message: the parent reads the question off
      // this session's own event stream, where every tool call already goes.
      // All this does is the other half — suppress the shutdown that would
      // otherwise end the session when this turn settles, so the session is
      // still alive when the answer arrives. Nothing is written, nothing torn down.
      awaitingAnswer = true;
      return {
        content: [{ type: "text", text: "Question sent to your caller. Stop now: end your turn without calling another tool and without guessing an answer. Your session stays open and the answer arrives as your next message." }],
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
  pi.on("agent_start", () => { started = true; });
  // Whatever arrives is the answer — steered into a running turn, or prompted
  // into a parked session. Pi emits `input` for both, which is why this is not
  // hung off `agent_start`.
  pi.on("input", () => { awaitingAnswer = false; });
  if (bridged) {
    pi.on("tool_execution_start", event => { emit(event); });
    pi.on("tool_execution_update", event => { emit(event); });
    pi.on("tool_execution_end", event => { emit(event); });
    pi.on("message_end", event => { emit(event); });
  }
  /**
   * The session ends here, and only here: when a turn settles with nothing
   * outstanding. A turn that settles while a question is in flight parks
   * instead — idle, holding its context, until the caller replies. That is the
   * whole difference between "finished" and "waiting", and the parent reads it
   * off the same event stream rather than being told separately.
   */
  pi.on("agent_settled", (_event, ctx) => {
    if (!started) return;
    if (bridged) emit({ type: "agent_settled" });
    if (awaitingAnswer) return;
    if (bridged) emit({ type: "bridge_complete" });
    ctx.shutdown();
  });
}
