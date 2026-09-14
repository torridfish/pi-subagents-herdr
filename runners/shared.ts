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

/** What a runner's argv builder returns. `stdin`, when set, is written to the
 *  child and the pipe is closed — the claude runner passes its task that way
 *  because Claude Code's variadic options would otherwise swallow a positional
 *  prompt. `args[0]` is the command; the rest are its arguments. */
export interface RunnerArgs {
	args: string[];
	tempDir: string;
	childEnv: NodeJS.ProcessEnv | undefined;
	stdin?: string;
	/** Where this child persists its conversation, when its runner can be resumed
	 *  from one. Set by the pi runner; a run whose child has already exited is
	 *  restarted from this file with the new message as its next prompt. */
	sessionPath?: string;
	/** The opening prompt for a child driven over pi's RPC protocol, sent as a
	 *  `prompt` command once it is up rather than passed as an argument. The
	 *  pane transport puts the task in argv instead, because an interactive Pi
	 *  has no stdin to speak to. */
	rpcPrompt?: string;
}

/** Everything a runner's line handler mutates. The handler is called once per
 *  line of child stdout and returns nothing; progress reaches the UI through
 *  `fireUpdate`, which the caller throttles. */
export interface LineHandlerDeps {
	progress: AgentProgress;
	result: AgentResult;
	fireUpdate: () => void;
	startTime: number;
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
