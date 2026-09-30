/**
 * Pieces the runner needs.
 *
 * A "runner" is the child process that actually executes an agent. `pi` is
 * the only one: an agent that should run on Claude Code gets a `claude-code/*`
 * model instead, and the claude-code provider drives the harness behind pi's
 * interface (see the pi-claude-code-provider README). The runner owns how the
 * argv is built and how the stdout stream maps onto the `AgentProgress`/
 * `AgentResult` shapes the renderer understands.
 */
import type { AgentProgress, AgentResult } from "../index.ts";

export type RunnerName = "pi";

export const RUNNERS: RunnerName[] = ["pi"];

export function isRunner(value: string): value is RunnerName {
	return (RUNNERS as string[]).includes(value);
}

/** Why a runner name is refused. `claude` was a runner once; its replacement
 *  is a model, and the message has to say so rather than read as a typo. */
export function runnerRefusal(value: string): string {
	if (value === "claude") {
		return "the claude runner was removed: give the agent a `claude-code/<model-id>` model instead and leave it on the pi runner — the claude-code provider runs the harness behind pi's interface (see README, \"Provider-model agents\")";
	}
	return `unknown runner ${value} (expected ${RUNNERS.join(" or ")})`;
}

/** What a runner's argv builder returns. `args[0]` is the command; the rest are
 *  its arguments. */
export interface RunnerArgs {
	args: string[];
	tempDir: string;
	childEnv: NodeJS.ProcessEnv | undefined;
	/** Where this child persists its conversation: a run whose child has
	 *  already exited is restarted from this file with the new message as its
	 *  next prompt. */
	sessionPath?: string;
	/** The opening prompt for a child driven over a stdin channel, sent once the
	 *  child is up rather than passed as an argument. The pane transport puts the
	 *  task in argv instead, because an interactive Pi has no stdin to speak to. */
	openingPrompt?: string;
	/** How to speak on that channel: pi's command protocol, line-delimited JSON
	 *  over stdin, kept open for the life of the run — which is what a parked
	 *  child needs. */
	protocol?: ChannelProtocol;
}

/** pi's command channel (`--mode rpc`). */
export type ChannelProtocol = "pi-rpc";

/** Everything a runner's line handler mutates. The handler is called once per
 *  line of child stdout and returns nothing; progress reaches the UI through
 *  `fireUpdate`, which the caller throttles. */
export interface LineHandlerDeps {
	progress: AgentProgress;
	result: AgentResult;
	fireUpdate: () => void;
	startTime: number;
	/** The child asked its caller something. Reported as the tool call happens;
	 *  what makes the run *waiting* is this question still being unanswered when
	 *  the turn settles. */
	onQuestion?: (question: string) => void;
	/** A turn settled. For a child on a stdin channel this is where its fate is
	 *  decided: park with a question outstanding, or be let go. */
	onTurnEnd?: () => void;
}

/** Collapse any whitespace run (incl. newlines) into a single space. Used to
 *  keep tool-arg previews to one renderable line in collapsed view. */
export function flatten(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// Per-event hard cap on stored arg previews. Even in expanded view we don't
// want a 50KB bash heredoc sitting in memory per tool call across last-20
// `recentTools` slots per agent across N agents. A few KB covers any realistic
// command; anything longer is almost certainly a generated payload the user
// doesn't need to read inline anyway.
const MAX_ARG_PREVIEW = 4000;

export function extractToolArgsPreview(args: Record<string, unknown>): string {
	const cap = (s: string) => (s.length > MAX_ARG_PREVIEW ? s.slice(0, MAX_ARG_PREVIEW) + "…" : s);
	if (args.command) return cap(flatten(String(args.command)));
	if (args.path) return cap(flatten(String(args.path)));
	if (args.query) return `"${cap(flatten(String(args.query)))}"`;
	if (args.url) return cap(flatten(String(args.url)));
	if (args.pattern) return cap(flatten(String(args.pattern)));
	// `subagent` tool args: show which agent(s) it's calling, not the full task body.
	if (args.agent) return flatten(String(args.agent));
	if (Array.isArray(args.tasks)) {
		const names = (args.tasks as Array<{ agent?: string }>)
			.map((t) => t?.agent || "?")
			.join(", ");
		return `parallel(${names})`;
	}
	return cap(flatten(JSON.stringify(args)));
}

/** One-line "what is it doing right now" summary of an assistant message:
 *  prose only, code fences dropped, first three lines joined. */
export function proseSummary(text: string): string {
	const proseLines: string[] = [];
	let inCodeBlock = false;
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			continue;
		}
		if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
	}
	return proseLines.slice(0, 3).join(" ");
}

/**
 * Appended to every child's system prompt, under its own agent role.
 *
 * Its job is to make the child's situation concrete — somebody dispatched this,
 * that somebody is still there, and they can answer — because a role prompt
 * written for autonomous work otherwise reads as "you are on your own".
 *
 * The tool is named rather than assumed: whichever surface the child reaches
 * it through, this name is the one its caller answers on.
 */
export function delegationNote(askTool: string): string {
	return [
		"## Your caller",
		"",
		"You were dispatched by another agent to do this one task. It cannot see your session and you cannot see its conversation, but it is there while you work and it can answer you.",
		"",
		`When the brief does not settle something that changes what you produce — which of several valid approaches to take, a value or path you were not given, whether to take a step that cannot be undone — ask with \`${askTool}\` rather than picking on their behalf. Your session pauses, the answer arrives as your next message, and you continue with everything you have already done. Ask what you cannot establish yourself; find out the rest by reading.`,
	].join("\n");
}
