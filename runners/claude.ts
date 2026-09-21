/**
 * Claude Code runner. `process` backend only.
 *
 * Runs an agent as a headless `claude -p --output-format stream-json` child and
 * adapts its event stream onto the same `AgentProgress`/`AgentResult` shapes the
 * pi runner produces, so the renderer, the concurrency semaphore, cancellation
 * and truncation all work unchanged.
 *
 * The child is driven over streaming input (`--input-format stream-json`)
 * rather than being handed a prompt and left to exit, for the same reason the
 * pi runner uses `--mode rpc`: a child that asks its caller a question has to
 * still be there when the answer comes back. Stdin stays open as a message
 * channel, and the parent — not the child — decides when the run is over, by
 * closing it once a turn settles with nothing outstanding.
 *
 * Not supported here, deliberately:
 *  - The herdr backend. Pane children report back through `herdr/child.ts`, which
 *    is a *pi extension*; only a pi process can load it. A claude child in a pane
 *    would have no result channel.
 *  - Nested delegation. Claude Code's `Task` tool spawns its own agent types, not
 *    the ones registered here, so mapping `subagent` onto it would be a lie.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, InheritConfig } from "../index.ts";
import { delegationNote, extractToolArgsPreview, proseSummary, type LineHandlerDeps, type RunnerArgs } from "./shared.ts";

/** The MCP server that carries `caller_ping` into a claude child, and the name
 *  the child therefore sees the tool under. Claude Code namespaces every MCP
 *  tool as `mcp__<server>__<tool>`, so the mangled name is what has to appear
 *  in `--allowedTools` and what the parent matches on in the event stream. */
const ASK_SERVER = "pi_subagents";
export const CLAUDE_ASK_TOOL = `mcp__${ASK_SERVER}__caller_ping`;
const ASK_SERVER_PATH = fileURLToPath(new URL("./claude-ask.mjs", import.meta.url));

export interface ClaudeRunnerConfig {
	/** Executable to invoke. Default `claude` (resolved on PATH). */
	command?: string;
	/** Passed through as `--permission-mode`. Omitted by default, which leaves
	 *  Claude Code on its own default. Declared tools are pre-approved regardless
	 *  (see `--allowedTools` below), so this is only for widening past them. */
	permissionMode?: string;
	/** Passed through as `--max-budget-usd`. A hard ceiling per child. */
	maxBudgetUsd?: number;
	/** What a claude child runs when nothing upstream resolves a model it can
	 *  use. Default `claude-opus-5`. */
	model?: string;
}

/**
 * The model a claude child falls back to.
 *
 * Leaving `--model` off is not the neutral choice it looks like: Claude Code
 * then picks its own default, which is the top of the range (Fable 5.1, at
 * 2x Opus 5's per-token price) — so a child dispatched from a session running
 * any non-Anthropic model would silently be the most expensive thing in the
 * fleet. Naming one makes the cost of a subagent a decision rather than a
 * side effect. It is a full id rather than the `opus` alias on purpose: an
 * alias moves under you when a new Opus ships.
 */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5";

/**
 * pi tool name → Claude Code built-in tool name.
 *
 * This table is load-bearing, not cosmetic: `--tools` silently DROPS names it
 * does not recognise (`--tools LS Read` yields just `Read`), so an unmapped name
 * would produce an agent quietly missing a capability it declared. Everything
 * not in this table or in UNSUPPORTED below is rejected before spawning.
 *
 * `ls` folds into `Glob` because current Claude Code has no LS tool; Glob covers
 * the directory-listing job a read-only scout needs it for.
 */
export const CLAUDE_TOOL_NAMES: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
	web_search: "WebSearch",
	web_fetch: "WebFetch",
	fetch_content: "WebFetch",
};

/** Declared tools that have no honest Claude Code equivalent, with the reason
 *  surfaced to whoever configured the agent. */
export const CLAUDE_UNSUPPORTED_TOOLS: Record<string, string> = {
	safe_bash: "Claude Code has no filtered shell; declare `bash` instead if a raw shell is acceptable",
	subagent: "Claude Code's Task tool spawns its own agent types, not the ones registered here",
};

/** Claude Code tool name → the pi name the renderer already formats previews
 *  for, so a claude child's tool rows look like every other child's. */
const DISPLAY_NAMES: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Bash: "bash",
	Grep: "grep",
	Glob: "find",
	WebSearch: "web_search",
	WebFetch: "web_fetch",
	[CLAUDE_ASK_TOOL]: "caller_ping",
};

/** pi `--thinking` level → Claude Code `--effort` level. Claude Code has no
 *  "off", so the floor is `low`. */
const EFFORT_LEVELS: Record<string, string> = {
	off: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/**
 * Resolve the `--model` value, or `undefined` to let Claude Code pick its own.
 *
 * Agent models arrive as pi's `provider/model-id`, defaulting to whatever the
 * parent session runs. A non-Anthropic parent (`openai/gpt-…`) has no meaning
 * here, so we drop it rather than pass something Claude Code would reject.
 */
export function resolveClaudeModel(model: string): string | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash === -1) return model; // already a Claude Code alias or full id
	return model.slice(0, slash) === "anthropic" ? model.slice(slash + 1) : undefined;
}

export async function buildClaudeArgs(
	agent: AgentConfig,
	task: string,
	_cwd: string,
	inherit: Required<InheritConfig>,
	config: ClaudeRunnerConfig = {},
): Promise<RunnerArgs> {
	const tools: string[] = [];
	for (const tool of agent.tools) {
		const unsupported = CLAUDE_UNSUPPORTED_TOOLS[tool];
		if (unsupported) throw new Error(`Agent ${agent.name} declares ${tool}, which the claude runner cannot provide: ${unsupported}`);
		const mapped = CLAUDE_TOOL_NAMES[tool];
		if (!mapped) throw new Error(`Agent ${agent.name} declares ${tool}, which has no Claude Code equivalent; map it in CLAUDE_TOOL_NAMES or run this agent under the pi runner`);
		if (!tools.includes(mapped)) tools.push(mapped);
	}

	// Nothing is written here; the directory exists so the caller's cleanup path
	// is identical for both runners.
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-sub-"));

	// The id is assigned rather than read back off the `init` event: a run that
	// is picked up again resumes by id, and knowing it before the child speaks
	// means the loadout is complete the moment it is written. Session
	// persistence is left ON for the same reason — `--no-session-persistence`
	// would make a finished child unresumable.
	const sessionId = crypto.randomUUID();

	const args = [
		config.command ?? "claude",
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose", // stream-json requires it under --print
		"--session-id", sessionId,
	];

	// `--disable-slash-commands` is Claude Code's "no skills". Extension
	// inheritance has no exact analogue: the closest lever is refusing the user's
	// MCP servers, which is what isolation means for a Claude Code child.
	if (!inherit.skills) args.push("--disable-slash-commands");
	if (!inherit.extensions) args.push("--strict-mcp-config");

	// The ask tool, always, exactly as the pi runner always adds `caller_ping`
	// to its allowlist: any child can find itself blocked on something only its
	// caller knows, and the one that was configured without a way to ask fails
	// precisely then — silently, by inventing an answer. `--strict-mcp-config`
	// above drops the user's own servers but keeps this one, because it is
	// passed here rather than discovered.
	args.push("--mcp-config", JSON.stringify({
		mcpServers: {
			[ASK_SERVER]: {
				command: process.execPath,
				args: [ASK_SERVER_PATH],
				// The run directory is how the tool tells an answered question from
				// an outstanding one; it is passed explicitly rather than inherited,
				// because the child's own PI_SUBAGENT_* variables are stripped below.
				env: { PI_SUBAGENT_RUN_DIR: tempDir },
			},
		},
	}));

	// Two separate jobs. `--tools` decides which tools EXIST in the child — the
	// real analogue of pi's `--tools` allowlist. `--allowedTools` pre-approves
	// them so a headless child never stops on a permission prompt. Pairing them
	// with `--permission-prompts none` means anything outside the declared set is
	// denied outright rather than hanging forever waiting for a human.
	args.push("--permission-prompts", "none");
	if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
	if (tools.length > 0) {
		args.push("--tools", ...tools);
	} else {
		args.push("--tools", ""); // documented spelling for "no tools at all"
	}
	// `--tools` governs the built-in set only, so the ask tool is pre-approved
	// here and nowhere else — an MCP tool that is not in `--allowedTools` is
	// denied outright under `--permission-prompts none`.
	args.push("--allowedTools", ...tools, CLAUDE_ASK_TOOL);

	// Precedence, highest first: the agent's own model when Claude Code can use
	// it (config.models → frontmatter → the parent session's), then the runner's
	// configured fallback, then ours.
	args.push("--model", resolveClaudeModel(agent.model) ?? config.model ?? CLAUDE_DEFAULT_MODEL);
	const effort = EFFORT_LEVELS[agent.thinking];
	if (effort) args.push("--effort", effort);
	// The delegation note goes to every agent, with or without a prompt of its
	// own: the tool description alone is the weaker of the two instructions for
	// a smaller model, and an agent file that says "report X" and never mentions
	// asking is what it would otherwise be read against.
	const appended = [agent.systemPrompt.trim(), delegationNote(CLAUDE_ASK_TOOL)].filter(Boolean).join("\n\n");
	args.push("--append-system-prompt", appended);
	if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));

	// The task goes in over the stdin channel, not as a positional: `--tools`
	// and `--allowedTools` are variadic, so a trailing prompt argument would be
	// parsed as one more tool name.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("PI_SUBAGENT_")) delete childEnv[key];
	}

	return { args, tempDir, childEnv, sessionId, openingPrompt: `Task: ${task}`, protocol: "claude-stream" };
}

/**
 * Adapt Claude Code's stream-json events onto the progress model.
 *
 * The stream carries no explicit tool start/end events the way pi's does:
 * a `tool_use` block inside an `assistant` message opens a call, and the
 * matching `tool_result` block inside the following `user` message closes it.
 */
export function makeClaudeLineHandler(deps: LineHandlerDeps): (line: string) => void {
	const { progress, result, fireUpdate, startTime, onQuestion, onTurnEnd } = deps;

	return (line: string) => {
		if (!line.trim()) return;
		let evt: any;
		try {
			evt = JSON.parse(line);
		} catch {
			return; // non-JSON lines are expected
		}
		progress.durationMs = Date.now() - startTime;

		if (evt.type === "system" && evt.subtype === "init") {
			if (evt.model) result.model = evt.model;
			return;
		}

		if (evt.type === "assistant" && evt.message) {
			const u = evt.message.usage;
			if (u) {
				const input = u.input_tokens || 0;
				const output = u.output_tokens || 0;
				const cacheRead = u.cache_read_input_tokens || 0;
				const cacheWrite = u.cache_creation_input_tokens || 0;
				result.usage.input += input;
				result.usage.output += output;
				result.usage.cacheRead += cacheRead;
				result.usage.cacheWrite += cacheWrite;
				// Context-window gauge: a snapshot of the LATEST turn, not a running
				// sum. Same reasoning as the pi path — each turn re-sends the whole
				// conversation, so one message already represents the context size.
				progress.tokens = input + output + cacheRead + cacheWrite;
			}
			if (evt.message.model) result.model = evt.message.model;
			for (const block of evt.message.content ?? []) {
				if (block.type === "tool_use") {
					progress.toolCount++;
					progress.recentTools.push({
						tool: DISPLAY_NAMES[block.name] ?? block.name,
						args: extractToolArgsPreview(normalizeToolInput(block.name, block.input)),
						toolCallId: block.id,
						status: "running",
					});
					// The question is the tool call. The ask tool has no channel back
					// to us and needs none — every tool call is already on this stream.
					if (block.name === CLAUDE_ASK_TOOL) {
						const asked = typeof block.input?.question === "string" ? block.input.question.trim() : "";
						if (asked) onQuestion?.(asked);
					}
				} else if (block.type === "text" && block.text?.trim()) {
					result.output = block.text;
					const summary = proseSummary(block.text);
					if (summary) progress.lastMessage = summary;
				}
			}
			fireUpdate();
			return;
		}

		if (evt.type === "user" && evt.message) {
			for (const block of evt.message.content ?? []) {
				if (block.type !== "tool_result" || !block.tool_use_id) continue;
				const hit = progress.recentTools.find((t) => t.toolCallId === block.tool_use_id);
				if (hit) hit.status = "done";
			}
			fireUpdate();
			return;
		}

		if (evt.type === "result") {
			// The final `result` string is the child's answer; prefer it over the
			// last assistant text block, which can be a mid-turn aside.
			if (typeof evt.result === "string" && evt.result.trim()) result.output = evt.result;
			if (typeof evt.total_cost_usd === "number") result.usage.cost = evt.total_cost_usd;
			if (typeof evt.num_turns === "number") result.usage.turns = evt.num_turns;
			for (const tool of progress.recentTools) tool.status = "done";

			const denied = Array.isArray(evt.permission_denials) ? evt.permission_denials : [];
			if (evt.is_error || (evt.subtype && evt.subtype !== "success")) {
				progress.error ||= describeResultError(evt, denied);
			} else if (denied.length > 0) {
				// The run "succeeded" but the model was blocked from something it
				// asked for, which usually explains a thin answer. Say so.
				progress.lastMessage = `${denied.length} tool call(s) denied: ${denialNames(denied)}`;
			}
			fireUpdate();
			// One `result` per turn, not one per run: the child stays up as long as
			// its stdin does. Whether this was the last turn is the parent's call.
			onTurnEnd?.();
		}
	};
}

/** Reshape a Claude Code tool input into the keys the shared preview formatter
 *  reads. Claude Code's file tools key their path as `file_path` where pi's use
 *  `path`; Glob carries both a `pattern` and a directory to scope it to, which
 *  the formatter would otherwise reduce to the far less informative directory. */
function normalizeToolInput(name: string, input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object") return {};
	const { file_path, ...rest } = input as Record<string, unknown>;
	if (name === "Glob" && rest.pattern) {
		const { path: scope, ...glob } = rest;
		return { ...glob, pattern: scope ? `${String(scope).replace(/\/$/, "")}/${rest.pattern}` : rest.pattern };
	}
	return file_path === undefined ? rest : { path: file_path, ...rest };
}

function denialNames(denied: any[]): string {
	return [...new Set(denied.map((d) => d?.tool_name || d?.toolName || "?"))].join(", ");
}

function describeResultError(evt: any, denied: any[]): string {
	if (typeof evt.result === "string" && evt.result.trim()) return evt.result.trim();
	if (evt.api_error_status) return `Claude Code API error ${evt.api_error_status}`;
	if (denied.length > 0) return `Claude Code denied ${denied.length} tool call(s): ${denialNames(denied)}`;
	return `Claude Code exited with ${evt.subtype || "an error"}`;
}
