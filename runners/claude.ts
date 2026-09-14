/**
 * Claude Code runner — prototype. `process` backend only.
 *
 * Runs an agent as a headless `claude -p --output-format stream-json` child and
 * adapts its event stream onto the same `AgentProgress`/`AgentResult` shapes the
 * pi runner produces, so the renderer, the concurrency semaphore, cancellation
 * and truncation all work unchanged.
 *
 * Not supported here, deliberately:
 *  - The herdr backend. Pane children report back through `herdr/child.ts`, which
 *    is a *pi extension*; only a pi process can load it. A claude child in a pane
 *    would have no result channel.
 *  - Nested delegation. Claude Code's `Task` tool spawns its own agent types, not
 *    the ones registered here, so mapping `subagent` onto it would be a lie.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, InheritConfig } from "../index.ts";
import { extractToolArgsPreview, proseSummary, type LineHandlerDeps, type RunnerArgs } from "./shared.ts";

export interface ClaudeRunnerConfig {
	/** Executable to invoke. Default `claude` (resolved on PATH). */
	command?: string;
	/** Passed through as `--permission-mode`. Omitted by default, which leaves
	 *  Claude Code on its own default. Declared tools are pre-approved regardless
	 *  (see `--allowedTools` below), so this is only for widening past them. */
	permissionMode?: string;
	/** Passed through as `--max-budget-usd`. A hard ceiling per child. */
	maxBudgetUsd?: number;
}

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

	const args = [
		config.command ?? "claude",
		"-p",
		"--output-format", "stream-json",
		"--verbose", // stream-json requires it under --print
		"--no-session-persistence",
	];

	// `--disable-slash-commands` is Claude Code's "no skills". Extension
	// inheritance has no exact analogue: the closest lever is refusing the user's
	// MCP servers, which is what isolation means for a Claude Code child.
	if (!inherit.skills) args.push("--disable-slash-commands");
	if (!inherit.extensions) args.push("--strict-mcp-config");

	// Two separate jobs. `--tools` decides which tools EXIST in the child — the
	// real analogue of pi's `--tools` allowlist. `--allowedTools` pre-approves
	// them so a headless child never stops on a permission prompt. Pairing them
	// with `--permission-prompts none` means anything outside the declared set is
	// denied outright rather than hanging forever waiting for a human.
	args.push("--permission-prompts", "none");
	if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
	if (tools.length > 0) {
		args.push("--tools", ...tools);
		args.push("--allowedTools", ...tools);
	} else {
		args.push("--tools", ""); // documented spelling for "no tools at all"
	}

	const model = resolveClaudeModel(agent.model);
	if (model) args.push("--model", model);
	const effort = EFFORT_LEVELS[agent.thinking];
	if (effort) args.push("--effort", effort);
	if (agent.systemPrompt.trim()) args.push("--append-system-prompt", agent.systemPrompt);
	if (config.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(config.maxBudgetUsd));

	// The task goes in on stdin, not as a positional. `--tools` and
	// `--allowedTools` are variadic, so a trailing prompt argument would be
	// parsed as one more tool name and the run would die with "Input must be
	// provided either through stdin or as a prompt argument".
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("PI_SUBAGENT_")) delete childEnv[key];
	}

	return { args, tempDir, childEnv, stdin: `Task: ${task}` };
}

/**
 * Adapt Claude Code's stream-json events onto the progress model.
 *
 * The stream carries no explicit tool start/end events the way pi's does:
 * a `tool_use` block inside an `assistant` message opens a call, and the
 * matching `tool_result` block inside the following `user` message closes it.
 */
export function makeClaudeLineHandler(deps: LineHandlerDeps): (line: string) => void {
	const { progress, result, fireUpdate, startTime } = deps;

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
