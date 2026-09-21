/**
 * Pieces both runners need.
 *
 * A "runner" is the child process that actually executes an agent: `pi` (the
 * default, and the only one the herdr backend can drive) or `claude`. Each one
 * owns two things — how its argv is built, and how its stdout stream maps onto
 * the `AgentProgress`/`AgentResult` shapes the renderer already understands.
 * Everything downstream of that mapping is runner-agnostic.
 */
import type { AgentProgress, AgentResult } from "../index.ts";

export type RunnerName = "pi" | "claude";

export const RUNNERS: RunnerName[] = ["pi", "claude"];

export function isRunner(value: string): value is RunnerName {
	return (RUNNERS as string[]).includes(value);
}

/** What a runner's argv builder returns. `args[0]` is the command; the rest are
 *  its arguments. */
export interface RunnerArgs {
	args: string[];
	tempDir: string;
	childEnv: NodeJS.ProcessEnv | undefined;
	/** Where this child persists its conversation, when its runner resumes from a
	 *  file. Set by the pi runner; a run whose child has already exited is
	 *  restarted from this file with the new message as its next prompt. */
	sessionPath?: string;
	/** The conversation this child persists under, when its runner resumes by id
	 *  rather than by path. Set by the claude runner, which is handed the id at
	 *  launch (`--session-id`) and relaunches with `--resume`. */
	sessionId?: string;
	/** The opening prompt for a child driven over a stdin channel, sent once the
	 *  child is up rather than passed as an argument. The pane transport puts the
	 *  task in argv instead, because an interactive Pi has no stdin to speak to. */
	openingPrompt?: string;
	/** How to speak on that channel. Both protocols are line-delimited JSON over
	 *  stdin and both keep the child alive between turns, which is what a parked
	 *  child needs; only the envelope differs. */
	protocol?: ChannelProtocol;
}

/** `pi-rpc` is pi's command channel (`--mode rpc`); `claude-stream` is Claude
 *  Code's streaming input (`--input-format stream-json`). */
export type ChannelProtocol = "pi-rpc" | "claude-stream";

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
 * The tool is named rather than assumed: the pi runner registers it as
 * `caller_ping`, while a claude child reaches it through an MCP server and sees
 * the mangled name its host gives it.
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
