/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: scout, researcher, worker.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MasterLayout } from "./herdr/layout.ts";
import { runInPane } from "./herdr/transport.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { buildClaudeArgs, makeClaudeLineHandler, type ClaudeRunnerConfig } from "./runners/claude.ts";
import { extractToolArgsPreview, isRunner, proseSummary, RUNNERS, type RunnerArgs, type RunnerName } from "./runners/shared.ts";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	thinking: string;
	systemPrompt: string;
	filePath: string;
	/**
	 * If this agent has the `subagent` tool, restrict which agents it may spawn.
	 * Passed to the child pi process via `PI_SUBAGENT_ALLOWED` so the child's
	 * subagents extension filters its own registry before exposing it to the LLM.
	 * `undefined` means no restriction (child sees every registered agent).
	 */
	subagentAgents?: string[];
	/**
	 * Which child process executes this agent: `pi` (default) or `claude`.
	 * Set per agent in frontmatter, overridden by the `runners` config block.
	 * The claude runner is process-backend only — see `runners/claude.ts`.
	 */
	runner?: RunnerName;
}

export interface ToolEvent {
	tool: string;
	args: string;
	/** Matches the producing tool_execution_start/update/end event. */
	toolCallId?: string;
	/**
	 * "running" while between tool_execution_start and tool_execution_end; flipped
	 * to "done" on end. We store every in-flight call in recentTools (keyed by
	 * toolCallId) rather than a single current-tool slot, because pi-agent-core
	 * dispatches a turn's tool calls in parallel via Promise.all — a single slot
	 * would let the second start overwrite the first.
	 */
	status: "running" | "done";
	/**
	 * Live progress of subagents spawned by this tool call. Populated only for
	 * `subagent` tool calls, from the `partialResult.details.results` payload of
	 * `tool_execution_update` events (and refreshed once more from the end
	 * event's final results). Recursive: each child's own progress may carry
	 * further children via its `recentTools[i].children`.
	 */
	children?: AgentResult[];
}

export interface AgentProgress {
	agent: string;
	/** `paused` means the child asked its caller a question and exited to wait
	 *  for the answer. It is not a terminal state: the run still holds its
	 *  session file and resumes into `running`. */
	status: "pending" | "running" | "paused" | "completed" | "failed";
	task: string;
	/**
	 * Chronological log of tool calls — running and done interleaved. The
	 * renderer prefixes running entries with `▸` and done ones with `  `.
	 */
	recentTools: ToolEvent[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
}

export interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	contextWindow?: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	/** What the child asked on its way out, while `progress.status` is `paused`.
	 *  Cleared when the run is resumed. */
	question?: string;
}

interface Details {
	results: AgentResult[];
	/** Set on the `subagent` call's ack: the handle of the run it started. Absent
	 *  on the steered completion message, which carries the finished result. */
	dispatched?: string;
}

/**
 * One dispatched subagent, tracked from the `subagent` call's ack until its
 * result is steered back.
 *
 * `subagent` returns as soon as the child is dispatched, so the tool call is
 * gone from the conversation long before the run is. Everything the UI and the
 * steer need afterwards lives here rather than in the tool call's closure:
 * `result` is the same object `runSubagent` mutates in place, so the widget
 * always reads live state without a copy step.
 */
interface RunRecord {
	/** Short, readable handle (`scout-1`). Shown in the widget and named in the
	 *  steered result so the user and the model can refer to the same run. */
	id: string;
	agent: string;
	startedAt: number;
	result: AgentResult;
	/** The invocation that started it, kept for as long as the record lives: a
	 *  paused run owns a temp directory — its session file included — that only
	 *  a resume or the end of the session may reclaim. */
	prepared: PreparedRun;
}

/** A built child invocation, plus which runner built it. Produced before the
 *  `subagent` call returns, so an undispatchable agent fails the call itself
 *  instead of surfacing as a background failure minutes later. */
interface PreparedRun extends RunnerArgs {
	runner: RunnerName;
}

// ── Config ─────────────────────────────────────────────────────────────

interface ExtensionConfig {
	maxConcurrency?: number;
	backend?: "auto" | "herdr" | "process";
	masterRatio?: number;
	minPaneRows?: number;
	models?: Record<string, string>;
	/** Agent name → runner, plus an optional `default`. Same precedence shape as
	 *  `models`: per-agent config → default config → agent frontmatter → `pi`. */
	runners?: Record<string, string>;
	/** Settings for the claude runner. Ignored by pi-run agents. */
	claude?: ClaudeRunnerConfig;
	toolExtensions?: Record<string, string>;
	inherit?: InheritConfig;
}

/**
 * Which parts of the user's own Pi setup a child session keeps.
 *
 * Tool access is pinned by `--tools` regardless of these: Pi's allowlist applies
 * to built-in, extension and custom tools alike, so inheriting the user's
 * extensions does NOT widen what an agent may call. What it restores is
 * everything else the user configured — web-search settings and its providers,
 * renderers, themes, footers, slash commands — which `--no-extensions` had been
 * stripping, leaving children running stock Pi.
 */
export interface InheritConfig {
	/** Load the user's installed Pi packages in children. Default true. */
	extensions?: boolean;
	/** Load the user's skills in children. Default false: any tool a skill
	 *  registers is filtered out by the allowlist anyway, so they are usually
	 *  just context weight. */
	skills?: boolean;
}

export const DEFAULT_INHERIT: Required<InheritConfig> = { extensions: true, skills: false };

function resolveInherit(config: ExtensionConfig): Required<InheritConfig> {
	const inherit = config.inherit ?? {};
	for (const key of Object.keys(inherit)) {
		if (!(key in DEFAULT_INHERIT)) throw new Error(`Unknown inherit key: ${key}`);
	}
	for (const [key, value] of Object.entries(inherit)) {
		if (value !== undefined && typeof value !== "boolean") throw new Error(`inherit.${key} must be a boolean`);
	}
	return { ...DEFAULT_INHERIT, ...inherit };
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * The extension every pi child loads, whichever backend runs it.
 *
 * It carries two things a child needs and a standalone Pi session must not get:
 * the pane event bridge (herdr backend only, switched on by `PI_SUBAGENT_BRIDGE`)
 * and the `caller_ping` tool. Both are keyed on `PI_SUBAGENT_RUN_DIR`, so the
 * file is inert anywhere else.
 */
const CHILD_EXTENSION = path.join(EXT_DIR, "herdr", "child.ts");
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;

function loadConfig(): ExtensionConfig {
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
			return parsed as ExtensionConfig;
		}
	} catch (error) { throw new Error(`Invalid ${CONFIG_PATH}: ${error}`); }
	return {};
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/**
 * Tools the child extension registers in every pi child. They are added to the
 * allowlist rather than declared per agent, and they are skipped by the
 * declared-tool checks so an agent file that lists one anyway still loads.
 */
const CHILD_TOOLS = new Set(["caller_ping"]);

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(process.env.HOME || "~", ".pi", "agent", "extensions");
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	web_search: path.join(EXT_BASE, "web-search", "index.ts"),
	web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
	video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
	youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
	google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
	// `subagent` is the tool this very extension registers. Listing it here lets
	// a parent agent grant it to a child agent — the child pi process loads this
	// same index.ts via `--extension`, sees its own subagent tool, and (if
	// PI_SUBAGENT_ALLOWED is set) only registers the allowlisted agents.
	subagent: path.join(EXT_DIR, "index.ts"),
};

/**
 * Tool names whose extension this process found through Pi's own package
 * discovery (as opposed to the hardcoded map or `toolExtensions`). When a child
 * inherits extensions it runs the same discovery over the same settings.json,
 * so it loads these itself — passing `--extension` for them as well would load
 * the same file twice and re-register its tools.
 */
const DISCOVERED_TOOL_EXTENSIONS = new Set<string>(
	(process.env.PI_SUBAGENT_DISCOVERED_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];

// Read once at module load. If we're a child subagent process whose parent
// pinned an allowlist, we silently ignore any agent (built-in OR registered
// later by a third-party extension) that isn't in the list.
const SUBAGENT_ALLOWLIST: string[] | undefined = (() => {
	const raw = process.env.PI_SUBAGENT_ALLOWED;
	if (raw === undefined) return undefined;
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
})();

export function registerAgent(config: AgentConfig): void {
	if (SUBAGENT_ALLOWLIST && !SUBAGENT_ALLOWLIST.includes(config.name)) return;
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

function loadAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(AGENTS_DIR)) return agents;
	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		const tools = (frontmatter.tools || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const rawRunner = (frontmatter as Record<string, string>).runner?.trim();
		if (rawRunner && !isRunner(rawRunner)) throw new Error(`Agent ${frontmatter.name}: unknown runner ${rawRunner} (expected ${RUNNERS.join(" or ")})`);
		const rawSubagentAgents = (frontmatter as Record<string, string>).subagent_agents;
		const subagentAgents = rawSubagentAgents
			? rawSubagentAgents.split(",").map((t) => t.trim()).filter(Boolean)
			: undefined;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools,
			model: frontmatter.model || "",
			thinking: frontmatter.thinking || "medium",
			systemPrompt: body,
			filePath,
			subagentAgents,
			runner: rawRunner as RunnerName | undefined,
		});
	}
	return agents;
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
	if (!contextWindow) return `${formatTokens(tokens)} ctx`;
	const pct = (tokens / contextWindow) * 100;
	const maxStr = contextWindow >= 1_000_000 ? `${(contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(contextWindow / 1000)}k`;
	return `${pct.toFixed(1)}%/${maxStr}`;
}

function formatToolPreview(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
		case "safe_bash":
			return `$ ${((args.command as string) || "").slice(0, 80)}`;
		case "read":
			return `read ${(args.path as string) || ""}`;
		case "write":
			return `write ${(args.path as string) || ""}`;
		case "edit":
			return `edit ${(args.path as string) || ""}`;
		case "grep":
			return `grep ${(args.pattern as string) || ""}`;
		case "find":
			return `find ${(args.pattern as string) || ""}`;
		case "ls":
			return `ls ${(args.path as string) || "."}`;
		case "web_search":
			return `search "${(args.query as string) || ""}"`;
		case "web_fetch":
			return `fetch ${(args.url as string) || ""}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 60)}`;
		}
	}
}

function truncLine(text: string, maxWidth: number): string {
	// Collapse embedded newlines first so we render exactly one visible line.
	// We can't strip them inside `text` directly (would also touch ANSI escapes
	// like "\x1b[0m"), so we only target literal \r and \n outside of escapes.
	if (text.includes("\n") || text.includes("\r")) {
		text = text.replace(/\r?\n/g, "↵ ");
	}
	if (visibleWidth(text) <= maxWidth) return text;
	// Simple truncation - strip to fit
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip ANSI escape sequences
		if (ch === "\x1b") {
			const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) {
			return result + "…";
		}
		result += ch;
		width++;
	}
	return result;
}

// ── Subagent Execution ────────────────────────────────────────────────

/** Exported for tests: the child command line is the contract this extension keeps. */
export async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	cwd: string,
	inherit: Required<InheritConfig>,
): Promise<RunnerArgs> {
	for (const tool of agent.tools) {
		if (CHILD_TOOLS.has(tool)) continue;
		if (!BUILTIN_TOOLS.has(tool) && (!CUSTOM_TOOL_EXTENSIONS[tool] || !fs.existsSync(CUSTOM_TOOL_EXTENSIONS[tool]))) {
			throw new Error(`Agent ${agent.name} requires unavailable tool ${tool}; install its extension or configure toolExtensions`);
		}
	}
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, "system.md");
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	// A child keeps its conversation in its own run directory rather than in the
	// user's session store. `--no-session` would be tidier still, but a session
	// file is what makes a run resumable: a child that pings its caller exits,
	// and the answer is delivered by restarting pi against this very file.
	// `--session <path>` on a path that does not exist yet creates it.
	const sessionPath = path.join(tempDir, "session.jsonl");
	const args = [...piBin.baseArgs, "--mode", "json", "-p", "--session", sessionPath];
	if (!inherit.skills) args.push("--no-skills");

	// Separate builtin tools from custom tools. Both kinds share the same
	// --tools allowlist in pi; --no-tools would disable extension tools too.
	const allowlist: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of agent.tools) {
		if (CHILD_TOOLS.has(tool)) continue;
		if (BUILTIN_TOOLS.has(tool)) {
			allowlist.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			allowlist.push(tool);
			// Under inherited discovery the child loads this package itself.
			if (!(inherit.extensions && DISCOVERED_TOOL_EXTENSIONS.has(tool))) extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Not something an agent declares. Any child can find itself blocked on a
	// question only its caller can answer, and an agent file that forgot to list
	// the tool would fail exactly then — silently, by inventing an answer
	// instead. It needs no --extension of its own: the child extension added
	// below registers it.
	allowlist.push(...CHILD_TOOLS);

	// Isolation of *tools* is the allowlist's job, not `--no-extensions`. Keeping
	// discovery on lets the child read the user's own Pi configuration; only an
	// explicit opt-out strips it back to stock Pi plus the declared tools.
	if (!inherit.extensions) args.push("--no-extensions");

	// --tools is a unified allowlist that applies to built-in, extension, and
	// custom tools. It is never empty now, so `--no-tools` is gone: an agent that
	// declares no tools gets `--tools caller_ping`, which is the same isolation
	// with the one door out of it left open.
	args.push("--tools", allowlist.join(","));

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}
	// Unconditional, and unconditionally first: both backends get the same child
	// extension, so the ping sidecar has one code path rather than one per
	// transport. The herdr backend used to add it on its own when rewriting the
	// argv for a pane; doing it here covers the process backend too.
	args.push("--extension", CHILD_EXTENSION);

	args.push("--model", agent.model);
	args.push("--thinking", agent.thinking);
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	// If this agent is allowed to spawn subagents AND we want to restrict which
	// ones, pass the allowlist down via env. The child pi process loads this
	// extension and filters its agent registry before exposing tool descriptions
	// to the LLM — so the child literally cannot request an agent outside the
	// allowlist (the name isn't in its prompt).
	// PI_SUBAGENT_RUN_DIR is what switches the child extension on, and it is also
	// where the child leaves a ping for us. The herdr backend sets it from inside
	// the pane (it is the pane's own run directory, not this snapshot); here it is
	// the same temp directory either way.
	let childEnv: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_DISCOVERED_TOOLS: [...DISCOVERED_TOOL_EXTENSIONS].join(","), PI_SUBAGENT_RUN_DIR: tempDir };
	if (agent.tools.includes("subagent") && agent.subagentAgents !== undefined) {
		childEnv.PI_SUBAGENT_ALLOWED = agent.subagentAgents.join(",");
	}

	return { args: [piBin.command, ...args], tempDir, childEnv, sessionPath };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

/** Where a child leaves a question for its caller, inside its run directory. */
const PING_FILE = "ping.json";

/**
 * Read the question a child left on its way out, if it left one.
 *
 * Absent is the normal case — an ordinary run never writes the file — so a
 * missing or unreadable sidecar is not an error, it just means the run
 * finished rather than paused.
 */
function readPing(tempDir: string): string | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(tempDir, PING_FILE), "utf-8");
	} catch { return undefined; }
	try {
		const ping = JSON.parse(raw) as { type?: unknown; question?: unknown };
		if (ping.type !== "ping" || typeof ping.question !== "string") return undefined;
		return ping.question.trim() || undefined;
	} catch { return undefined; }
}

/**
 * Build a child invocation without starting it.
 *
 * Split out of `runSubagent` so that everything knowable to be wrong up front —
 * an agent declaring a tool this machine cannot supply, a model string no
 * runner can use — throws from `execute()` itself. Under the async contract the
 * run outlives the tool call, so an error raised after dispatch would reach the
 * model as a background failure with no call to attach it to. A caller mistake
 * should fail the call that made it.
 */
export async function prepareSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	inherit: Required<InheritConfig>,
	claudeConfig: ClaudeRunnerConfig,
): Promise<PreparedRun> {
	const runner: RunnerName = agent.runner ?? "pi";
	const built = runner === "claude"
		? await buildClaudeArgs(agent, task, cwd, inherit, claudeConfig)
		: await buildPiArgs(agent, task, cwd, inherit);
	return { ...built, runner };
}

/**
 * Run a prepared child to completion, mutating `result` in place as it streams.
 *
 * `result` belongs to the caller's `RunRecord` rather than being created here:
 * the widget renders it while the run is still in flight, and the steered
 * completion message renders the very same object once it lands.
 */
async function runSubagent(
	agent: AgentConfig,
	prepared: PreparedRun,
	result: AgentResult,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: () => void,
	layout?: MasterLayout,
): Promise<AgentResult> {
	const { runner, args, tempDir, childEnv, stdin } = prepared;
	// Defence in depth: execute() already refuses this combination with a better
	// message, but a pane child has no result channel for a non-pi runner.
	if (layout && runner !== "pi") throw new Error(`The ${runner} runner supports the process backend only`);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.();
	}, 150);

	let exitCode = 1;
	// Set when the child left a question behind. It makes this run paused rather
	// than finished, and its run directory has to survive the cleanup below.
	let question: string | undefined;
	try {
		// Inside the try, not above it: `prepare` created tempDir before this run
		// was queued, so an abort that lands while it waits for a semaphore slot
		// still has to unwind through the cleanup below.
		signal?.throwIfAborted();
		// Past the semaphore — this run is no longer queued.
		progress.status = "running";
		onUpdate?.();
		exitCode = await new Promise<number>((resolve) => {
		let buf = "";
		let stderrBuf = "";

		const processPiLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const evt = JSON.parse(line) as any;
				progress.durationMs = Date.now() - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.recentTools.push({
						tool: evt.toolName,
						args: extractToolArgsPreview((evt.args || {}) as Record<string, unknown>),
						toolCallId: evt.toolCallId,
						status: "running",
					});
					fireUpdate();
				}

				// Subagents emit `tool_execution_update` while their own subagent tool
				// runs — the partial result carries the live nested AgentResult[]. We
				// surface that as `children` on the in-flight ToolEvent so the renderer
				// can inline grandchild activity beneath the parent's tool row.
				if (evt.type === "tool_execution_update") {
					const partial = evt.partialResult as { details?: { results?: unknown } } | undefined;
					const nested = partial?.details?.results;
					if (evt.toolName === "subagent" && Array.isArray(nested) && evt.toolCallId) {
						const hit = progress.recentTools.find((t) => t.toolCallId === evt.toolCallId);
						if (hit) {
							hit.children = nested as AgentResult[];
							fireUpdate();
						}
					}
				}

				if (evt.type === "tool_execution_end") {
					const hit = evt.toolCallId
						? progress.recentTools.find((t) => t.toolCallId === evt.toolCallId)
						: undefined;
					if (hit) {
						hit.status = "done";
						// Prefer the end event's final results over the last throttled
						// update — throttling can drop the trailing update, leaving stale
						// children visible on a tool that has actually completed.
						const finalResult = evt.result as { details?: { results?: unknown } } | undefined;
						const finalChildren = finalResult?.details?.results;
						if (evt.toolName === "subagent" && Array.isArray(finalChildren)) {
							hit.children = finalChildren as AgentResult[];
						}
					}
					fireUpdate();
				}

				if (evt.type === "tool_result_end") {
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							// Context-window gauge: snapshot of the LATEST assistant turn's usage,
							// NOT a cumulative sum across turns. Each turn re-sends the whole
							// conversation as input + cacheRead, so one assistant message already
							// represents the current context size. Summing across N turns would
							// inflate the displayed % by roughly Nx (the bug this replaced).
							// Matches pi's `calculateContextTokens` in core/compaction/compaction.js:
							// prefer the provider-reported totalTokens, fall back to the 4-component sum.
							progress.tokens = (u as { totalTokens?: number }).totalTokens
								|| (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;
						if (evt.message.stopReason === "aborted" || evt.message.stopReason === "error") progress.error ||= `Child ${evt.message.stopReason}`;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							const summary = proseSummary(text);
							if (summary) progress.lastMessage = summary;
						}
					}

					fireUpdate();
				}
			} catch {
				// Non-JSON lines are expected
			}
		};

		const processLine = runner === "claude"
			? makeClaudeLineHandler({ progress, result, fireUpdate, startTime })
			: processPiLine;

		if (layout) {
			const env = { ...childEnv, PI_SUBAGENT_LAYOUT_DIR: layout.directory,
				PI_SUBAGENT_MASTER: layout.master, PI_SUBAGENT_BACKEND: "herdr",
				PI_SUBAGENT_TOOL_EXTENSIONS: JSON.stringify(CUSTOM_TOOL_EXTENSIONS) };
			void runInPane(layout, { command, args: spawnArgs, cwd, env, directory: tempDir,
				name: agent.name, signal, onLine: processLine }).then(exit => {
				if (exit.error) progress.error = exit.error;
				resolve(exit.code);
			}, error => { progress.error = String(error); resolve(1); });
			return;
		}
		// PI_SUBAGENT_* is how a pi child is told which transport and tool
		// extensions it inherited; it means nothing to any other runner.
		const env = runner === "pi"
			? { ...childEnv, PI_SUBAGENT_BACKEND: "process", PI_SUBAGENT_TOOL_EXTENSIONS: JSON.stringify(CUSTOM_TOOL_EXTENSIONS) }
			: childEnv;
		// A runner that supplies `stdin` takes its task that way rather than as an
		// argument — Claude Code's variadic `--tools`/`--allowedTools` would
		// otherwise swallow a trailing positional prompt as one more tool name.
		const proc = spawn(command, spawnArgs, { cwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env });
		if (stdin !== undefined && proc.stdin) {
			// A child that exits before reading gives us EPIPE; the close handler
			// already reports the real failure, so don't let it crash the parent.
			proc.stdin.on("error", () => {});
			proc.stdin.end(stdin);
		}
		let closed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			progress.error = "Subagent cancelled";
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => { if (!closed) proc.kill("SIGKILL"); }, 3000);
		};
		proc.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});

		proc.stderr?.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});

		proc.on("close", (code) => {
			closed = true;
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", kill);
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			}
			resolve(code ?? 1);
		});

		proc.on("error", error => { progress.error = error.message; resolve(1); });

		if (signal?.aborted) kill();
		else signal?.addEventListener("abort", kill, { once: true });
		});
		// A clean exit is not the same as a finished job: a child that called
		// `caller_ping` ends its turn normally and leaves the question here. A
		// failed run's ping is ignored — there is nothing dependable to resume.
		if (exitCode === 0 && !progress.error) question = readPing(tempDir);
	} finally {
		if (!question) fs.rmSync(tempDir, { recursive: true, force: true });
	}

	result.exitCode = exitCode;
	if (question) {
		result.question = question;
		progress.status = "paused";
	} else {
		progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
	}
	progress.durationMs = Date.now() - startTime;
	if (progress.error) result.output = result.output || `Error: ${progress.error}`;

	// Truncate output if very large
	if (Buffer.byteLength(result.output) > DEFAULT_MAX_BYTES || result.output.split("\n").length > DEFAULT_MAX_LINES) {
		const trunc = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		result.output = trunc.content;
		if (trunc.truncated) {
			result.output += "\n\n[Output truncated]";
		}
	}

	return result;
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) { clearTimeout(timer); timer = undefined; }
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

/**
 * Process-wide cap on simultaneous `runSubagent` calls. Each `execute()` of the
 * `subagent` tool is independent (pi runs LLM tool calls via `Promise.all`), so
 * we serialize at the `runSubagent` boundary. Per-process scope only — nested
 * subagent processes have their own semaphore, so the cap applies to direct
 * children, not the whole tree (which keeps things deadlock-free).
 */
class Semaphore {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((r) => this.waiters.push(r));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			const next = this.waiters.shift();
			if (next) next();
		}
	}
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
	depth: number = 0,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";
	const isPaused = prog.status === "paused";
	const nested = depth > 0;

	// Indent prefix for nested levels. ANSI escapes are zero-width so this works
	// with colored content. Children are visually offset by 2 spaces per depth.
	const indent = nested ? "  ".repeat(depth) : "";
	// Available width shrinks with indent so truncLine still fits one line.
	const innerW = Math.max(20, w - indent.length);

	// `line(content)`: emit one indented, optionally-truncated row.
	// In expanded mode we still indent but don't truncate — the Text component
	// wraps and we want every wrapped line to share the same left margin, so we
	// keep the indent as a hard prefix on the first line only (pi-tui Text
	// doesn't expose a per-line gutter). Wrapping at depth is rare anyway since
	// the lines that wrap (lastMessage, full output) only render at depth 0.
	const addLine = (content: string) => {
		if (expanded) {
			c.addChild(new Text(indent + content, 0, 0));
		} else {
			c.addChild(new Text(indent + truncLine(content, innerW), 0, 0));
		}
	};

	// Header: icon + agent + stats (always one line)
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: isPaused
				? theme.fg("warning", "?")
				: r.exitCode === 0
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatDuration(prog.durationMs)}`;
	const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
	addLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`);

	// NOTE: the task body used to be rendered here at depth 0 (truncated when
	// collapsed, full when expanded). It's now owned by `renderCall` above this
	// block in the same tool shell — the call header shows the truncated
	// preview when collapsed and the full streaming prompt when expanded — so
	// repeating it here would duplicate the prompt on screen. Nested children
	// never rendered Task in the first place; the parent's recentTools row
	// above each child already conveys the dispatch.

	// Helper for rendering one tool row + recursively rendering its children.
	const renderToolRow = (
		toolName: string,
		args: string,
		children: AgentResult[] | undefined,
		isCurrent: boolean,
	) => {
		const body = args ? `${toolName}: ${args}` : toolName;
		if (isCurrent) {
			addLine(theme.fg("warning", `▸ ${body}`));
		} else {
			addLine(theme.fg("muted", `  ${body}`));
		}
		if (children && children.length > 0) {
			for (const child of children) {
				c.addChild(renderAgentProgress(child, theme, expanded, w, depth + 1));
			}
		}
	};

	// Tool log — running and done interleaved in chronological order. Running
	// entries get the `▸` marker; done ones get a muted `  ` prefix. Children
	// (live subagent activity) render inline beneath each row.
	for (const t of prog.recentTools) {
		renderToolRow(t.tool, t.args, t.children, t.status === "running");
	}

	// Latest assistant message (prose "thinking"). Rendered at every depth so a
	// nested subagent's current thought sits at the bottom of its own indented
	// block, mirroring how the master box shows it under all tool rows. At depth
	// 0 we precede it with a blank line for visual separation from the tool log;
	// at depth>=1 we skip the spacer so the row stays grouped with the child's
	// tool list above and doesn't break the visual run between sibling children.
	if (prog.lastMessage) {
		if (!nested) c.addChild(new Spacer(1));
		addLine(theme.fg("text", prog.lastMessage));
	}

	// The question, when the run is paused on one. It is the whole point of the
	// block at that moment, so it goes last among the prose rows — closest to
	// wherever the reader's eye lands — and it stays visible when collapsed.
	if (isPaused && r.question) {
		if (!nested) c.addChild(new Spacer(1));
		addLine(theme.fg("warning", `Asks: ${r.question}`));
	}

	// Expanded final output — only at depth 0. Nested levels are summarized via
	// their own tool list; the master-level result block is enough context.
	if (!nested && !isRunning && !isPaused && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
	}

	// Usage line. Includes the context %/max gauge at every depth — each
	// subagent carries its own model/contextWindow and its own token count, so
	// the gauge is meaningful per-row even for nested children.
	if (!nested) c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.input) usageParts.push(theme.fg("dim", `↑${formatTokens(r.usage.input)}`));
	if (r.usage.output) usageParts.push(theme.fg("dim", `↓${formatTokens(r.usage.output)}`));
	if (r.usage.cacheRead) usageParts.push(theme.fg("dim", `R${formatTokens(r.usage.cacheRead)}`));
	if (r.usage.cacheWrite) usageParts.push(theme.fg("dim", `W${formatTokens(r.usage.cacheWrite)}`));
	if (r.usage.cost) usageParts.push(theme.fg("dim", `$${r.usage.cost.toFixed(3)}`));
	if (prog.tokens > 0) {
		const ctxStr = formatContextUsage(prog.tokens, r.contextWindow);
		const pct = r.contextWindow ? (prog.tokens / r.contextWindow) * 100 : 0;
		const coloredCtx = pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : theme.fg("dim", ctxStr);
		usageParts.push(coloredCtx);
	}
	if (usageParts.length) {
		addLine(usageParts.join(" "));
	}

	// Error
	if (prog.error) {
		addLine(theme.fg("error", `Error: ${prog.error}`));
	}

	return c;
}

/**
 * The in-flight roster, pinned above the editor.
 *
 * This is the async contract's main surface. A dispatched run's tool call
 * resolves immediately, and the result message that eventually lands gets
 * pushed up the transcript by whatever is said next — so "what is running right
 * now" has to live somewhere that does not scroll. One line per run, oldest
 * first, and the widget disappears entirely when nothing is in flight.
 */
function renderRunsWidget(records: RunRecord[], theme: Theme): Component {
	// One width-aware component rather than a Container of pre-built rows: a
	// widget is rendered at whatever width the TUI hands it, which is not the
	// terminal width, so laying rows out ahead of time wrapped the header rule
	// and left the activity column unbudgeted.
	return {
		invalidate() {},
		render(width: number): string[] {
			// A paused run is still in flight, but calling it "running" would be a
			// lie about who is waiting for whom: it is waiting for an answer.
			const waiting = records.filter((r) => r.result.progress.status === "paused").length;
			const label = waiting === 0
				? `${records.length} subagent${records.length === 1 ? "" : "s"} running`
				: `${records.length} subagent${records.length === 1 ? "" : "s"}: ${records.length - waiting} running, ${waiting} waiting on an answer`;
			const head = `── ${label} `;
			// Narrower than the label itself: drop the rule and clip, rather than
			// emitting an over-long line for the TUI to wrap.
			const lines = [theme.fg("dim", visibleWidth(head) >= width
				? truncLine(label, width)
				: head + "─".repeat(width - visibleWidth(head)))];

			for (const record of records) {
				const prog = record.result.progress;
				const queued = prog.status === "pending";
				const paused = prog.status === "paused";
				// What the child is doing *now*: its newest still-running tool call,
				// and only if none is running, its latest prose line. A finished tool
				// call says nothing about whether the run is still alive. A paused
				// run is doing nothing at all — it shows its question instead.
				const current = [...prog.recentTools].reverse().find((t) => t.status === "running");
				const activity = paused
					? `asks: ${record.result.question ?? "a question"}`
					: queued
						? "queued"
						: current
							? (current.args ? `${current.tool}: ${current.args}` : current.tool)
							: prog.lastMessage || "thinking…";

				const elapsed = formatDuration(Date.now() - record.startedAt);
				// icon + space + id + space, then the activity, then the elapsed time
				// flush right. Budget the activity so the clock never wraps the row.
				const gutter = 3 + visibleWidth(record.id);
				const room = width - gutter - elapsed.length - 1;
				const body = room > 4 ? truncLine(activity, room) : "";
				const pad = Math.max(1, width - gutter - visibleWidth(body) - elapsed.length);
				lines.push(
					theme.fg(queued ? "dim" : "warning", queued ? "○" : paused ? "?" : "⟳")
					+ " " + theme.fg("accent", record.id)
					+ " " + theme.fg("muted", body)
					+ " ".repeat(pad) + theme.fg("dim", elapsed),
				);
			}
			return lines;
		},
	};
}

// ── Prompt Surface ────────────────────────────────────────────────────

/**
 * What the model is told about `subagent`, derived from whichever agents are
 * actually registered.
 *
 * Building it from the registry rather than hardcoding it matters twice over: a
 * child process runs with a filtered registry (`PI_SUBAGENT_ALLOWED`), and a
 * third-party extension can register its own agents. Either way the model should
 * be told exactly what it can reach, and nothing it can't.
 */
export function buildPromptSurface(registry: AgentConfig[]): { snippet: string; description: string; guidelines: string[] } {
	const names = registry.map((a) => a.name);
	const roster = registry.length > 0
		? registry.map((a) => `- ${a.name}: ${a.description}${a.tools.length > 0 ? ` (tools: ${a.tools.join(", ")})` : ""}`).join("\n")
		: "(none registered)";

	// Per-agent triggers, emitted only for agents that exist. These answer the
	// question the model actually has — "is this one of those?" — which a bare
	// capability list does not.
	// Phrased as first-action rules, not advice. A conditional recommendation
	// ("consider dispatching a scout when…") measurably loses to read/grep: the
	// model keeps exploring because exploring is always locally reasonable.
	const triggers: Record<string, string[]> = {
		scout: [
			"When a request names an area of the codebase but not the files — \"how does X work\", \"fix the Y flow\", \"where is Z handled\" — your first action is a scout dispatch, not a read or grep of your own.",
			"If you are about to make a third read/grep call and still do not know where the relevant code lives, stop and dispatch a scout instead — that is the signal you are doing a subagent's job by hand.",
		],
		researcher: ["When a question needs several web sources triangulated rather than one page whose URL you already have, your first action is a researcher dispatch, not a search of your own."],
		worker: [
			"When a change is self-contained and you can specify it precisely, dispatch a worker rather than making the edits yourself.",
			"Give a worker the paths. It cannot delegate reading of its own, so an area-shaped brief makes it spend its context orienting instead of editing — scout first if you do not know them yet.",
		],
	};

	return {
		snippet: `Delegate a task to a background child agent with its own context window${names.length > 0 ? ` (${names.join(", ")})` : ""}`,
		description: [
			"Delegate a task to a subagent: a child agent that runs in its own fresh context window. Its tool calls, dead ends and intermediate reasoning never enter your context — you get back only its final report.",
			"",
			"Available agents:",
			roster,
			"",
			"This call is asynchronous. It returns as soon as the child is dispatched, handing you a short handle like `scout-1` — NOT the child's answer. When the child finishes, the harness automatically delivers its report to you as a new message that wakes you up and starts a turn. You do not have to do anything to receive it: there is nothing to poll, no status to check, and no way to wait.",
			"",
			"So do not stall on a dispatch. Finish whatever else the current turn needs, and end the turn once nothing is left that does not depend on the answer. If the user is waiting on that answer and nothing else is outstanding, say what you dispatched and stop — you will be woken when it lands.",
			"",
			"The subagent cannot see this conversation. Everything it needs — the goal, the constraints, the file paths you already know, the shape of the answer you want — has to be written into `task`.",
		].join("\n"),
		guidelines: [
			// Never name an agent that is not registered: a filtered child would
			// otherwise be told to dispatch something it cannot reach.
			...registry.flatMap((a) => triggers[a.name] ?? []),
			"Do the work yourself when you already have the path, need exact file bytes in order to edit, or it is a single lookup — a subagent costs a process start and a fresh system prompt.",
			"Write `task` as a standalone brief: the goal, the constraints, the paths you already know, and the output shape you want back. A subagent left to infer the context will infer it wrong.",
			"Emit several `subagent` calls in one turn for independent investigations; they run concurrently and their reports arrive separately, each waking you as it lands. Plain parallel read/grep/fetch calls already cover simple I/O — don't wrap those in subagents.",
			"The handle a dispatch returns is an acknowledgement, never an answer. Never summarise, assume or invent what a child found before its report has actually arrived.",
		],
	};
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const concurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("maxConcurrency must be a positive integer");
	if (config.masterRatio !== undefined && (!Number.isFinite(config.masterRatio) || config.masterRatio < 0.2 || config.masterRatio > 0.8)) throw new Error("masterRatio must be between 0.2 and 0.8");
	if (config.minPaneRows !== undefined && (!Number.isInteger(config.minPaneRows) || config.minPaneRows < 3)) throw new Error("minPaneRows must be an integer >= 3");
	for (const [agent, runner] of Object.entries(config.runners ?? {})) {
		if (!isRunner(runner)) throw new Error(`runners.${agent} must be one of ${RUNNERS.join(", ")}`);
	}
	const inherit = resolveInherit(config);
	const semaphore = new Semaphore(concurrency);
	let backend = (process.env.PI_SUBAGENT_BACKEND ?? config.backend ?? "auto") as "auto" | "herdr" | "process";
	if (!["auto", "herdr", "process"].includes(backend)) throw new Error("Invalid subagent backend");
	let layout: MasterLayout | undefined;
	let ownedLayoutDir: string | undefined;
	const shutdown = new AbortController();
	const running = new Set<Promise<unknown>>();
	// Dispatched runs, keyed by the handle the widget shows. A record is removed
	// the instant its result is steered, so `runs` is exactly "what is in flight".
	const runs = new Map<string, RunRecord>();
	let runSeq = 0;
	// Captured on session_start so the completion path — which has no ctx of its
	// own — can repaint the widget. Stays undefined outside interactive mode (and
	// under unit tests), which makes every widget call a silent no-op there.
	let uiCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const stopTicker = () => {
		if (ticker) { clearInterval(ticker); ticker = undefined; }
	};

	const updateWidget = () => {
		if (!uiCtx) return;
		if (runs.size === 0) {
			stopTicker();
			uiCtx.ui.setWidget("subagents", undefined);
			return;
		}
		// One repaint a second keeps the elapsed column moving while a child is
		// quiet. unref() so a stray timer can never hold the process open.
		if (!ticker) {
			ticker = setInterval(() => updateWidget(), 1000);
			ticker.unref?.();
		}
		uiCtx.ui.setWidget("subagents", (_tui, theme) => renderRunsWidget([...runs.values()], theme), { placement: "aboveEditor" });
	};

	/**
	 * Hand a finished run back to the model.
	 *
	 * `deliverAs: "steer"` is what makes the async contract work: the message is
	 * injected into the turn in progress if there is one and starts a fresh turn
	 * if there is not. Either way a result lands — whether the user is mid
	 * conversation or the session has been idle since the dispatch.
	 */
	const steerResult = (record: RunRecord) => {
		const r = record.result;
		const failed = r.exitCode !== 0 || !!r.progress.error;
		const elapsed = formatDuration(r.progress.durationMs);
		const content = failed
			? `Subagent ${record.id} (${record.agent}) failed after ${elapsed}: ${r.progress.error || r.output || `exited ${r.exitCode}`}`
			: `Subagent ${record.id} (${record.agent}) finished in ${elapsed}.\n\n${r.output || "(no output)"}`;
		pi.sendMessage<Details>(
			{ customType: "subagent_result", content, display: true, details: { results: [r] } },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	// The full progress block — tool log, prose, usage, context gauge — moves here
	// from the tool result. Under the sync contract it rendered under the call
	// that was still blocking on it; now the call is long gone and this steered
	// message is where the finished run gets read.
	pi.registerMessageRenderer<Details>("subagent_result", (message, options, theme) => {
		const result = message.details?.results?.[0];
		if (!result) return undefined;
		return renderAgentProgress(result, theme, options.expanded, getTermWidth() - 4);
	});

	Object.assign(CUSTOM_TOOL_EXTENSIONS, JSON.parse(process.env.PI_SUBAGENT_TOOL_EXTENSIONS || "{}"), config.toolExtensions);
	pi.on("session_start", (_event, ctx) => { uiCtx = ctx; updateWidget(); });
	pi.on("session_shutdown", async () => {
		shutdown.abort();
		await Promise.allSettled([...running]);
		stopTicker();
		// A paused run's directory is exempt from the usual cleanup because it is
		// waiting to be resumed. Once the session is over nothing can resume it,
		// so this is where those get reclaimed.
		for (const record of runs.values()) {
			if (record.result.progress.status === "paused") fs.rmSync(record.prepared.tempDir, { recursive: true, force: true });
		}
		if (ownedLayoutDir) fs.rmSync(ownedLayoutDir, { recursive: true, force: true });
	});
	pi.registerCommand("subagents-herdr", {
		description: "Subagent backend: auto, herdr, process, or status",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (["auto", "herdr", "process"].includes(value)) backend = value as typeof backend;
			else if (value && value !== "status") { ctx.ui.notify("Usage: /subagents-herdr [auto|herdr|process|status]", "warning"); return; }
			const inherited = [inherit.extensions && "extensions", inherit.skills && "skills"].filter(Boolean).join("+") || "nothing";
			const defaultRunner = config.runners?.default ?? "pi";
			ctx.ui.notify(`Subagents: ${backend}; ${defaultRunner} runner; master-left ${Math.round((config.masterRatio ?? 0.6) * 100)}%; stack-right; ${concurrency} concurrent; children inherit ${inherited}`, "info");
		},
	});
	agents = loadAgents();

	// If spawned as a child by a parent subagent process, PI_SUBAGENT_ALLOWED
	// pins which agents we're allowed to expose. Filter the registry now, before
	// any tool description sees the agent list — the child LLM should not even
	// know that other agents exist.
	if (SUBAGENT_ALLOWLIST) {
		agents = agents.filter((a) => SUBAGENT_ALLOWLIST.includes(a.name));
	}

	// Built after the registry is loaded and allowlist-filtered, so the model is
	// told about exactly the agents this process can actually dispatch.
	const prompt = buildPromptSurface(agents);
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: prompt.description,
		promptSnippet: prompt.snippet,
		promptGuidelines: prompt.guidelines,
		parameters: Type.Object({
			agent: Type.String({ description: `Which agent to dispatch: ${agents.map((a) => a.name).join(", ") || "(none registered)"}` }),
			task: Type.String({ description: "Self-contained brief for the subagent. It shares none of this conversation, so restate the goal, the constraints, any paths you already know, and the output shape you want back." }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
			runner: Type.Optional(Type.String({ description: `Which child process runs the agent: ${RUNNERS.join(" or ")}. Omit unless the user explicitly asked for one — the configured default (normally pi) is right otherwise.` })),
		}),

		// `onUpdate` is unused: streaming partial results into a tool call only
		// makes sense while the call is still open, and this one resolves at
		// dispatch. Live progress goes to the widget instead.
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;

			if (params.runner !== undefined && !isRunner(params.runner)) {
				throw new Error(`Unknown runner: ${params.runner}. Available runners: ${RUNNERS.join(", ")}.`);
			}
			if (!params.agent || !params.task) {
				throw new Error("`subagent` requires both `agent` and `task`. To fan out work, emit multiple `subagent` tool calls in the same turn — they run in parallel.");
			}

			const definition = agents.find((a) => a.name === params.agent);
			const agent = definition ? { ...definition,
				model: config.models?.[definition.name] ?? config.models?.default ?? (definition.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "")),
				runner: (params.runner ?? config.runners?.[definition.name] ?? config.runners?.default ?? definition.runner ?? "pi") as RunnerName,
			} : undefined;
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
			}

			for (const tool of pi.getAllTools()) {
				if (tool.sourceInfo.source === "builtin" || !fs.existsSync(tool.sourceInfo.path)) continue;
				CUSTOM_TOOL_EXTENSIONS[tool.name] = tool.sourceInfo.path;
				// "cli" means this very process was handed the file with `--extension`;
				// discovery would not find it again, so a child still needs it passed.
				if (tool.sourceInfo.source === "cli") DISCOVERED_TOOL_EXTENSIONS.delete(tool.name);
				else DISCOVERED_TOOL_EXTENSIONS.add(tool.name);
			}
			// A pinned path is loaded explicitly, so it is no longer discovery's job.
			for (const tool of Object.keys(config.toolExtensions ?? {})) DISCOVERED_TOOL_EXTENSIONS.delete(tool);
			Object.assign(CUSTOM_TOOL_EXTENSIONS, config.toolExtensions);
			// Only pi children can report back from a pane: the sidecar that bridges
			// their events (`herdr/child.ts`) is itself a pi extension. `auto` picks
			// the process backend for anything else; an explicit `herdr` says so.
			if (agent.runner !== "pi" && backend === "herdr") {
				throw new Error(`Agent ${agent.name} runs under the ${agent.runner} runner, which supports the process backend only. Select /subagents-herdr process or auto.`);
			}
			const useHerdr = agent.runner === "pi" && (backend === "herdr" || (backend === "auto" && process.env.HERDR_ENV === "1"));
			if (useHerdr && !layout) {
				if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Run Pi inside Herdr or select /subagents-herdr process");
				const directory = process.env.PI_SUBAGENT_LAYOUT_DIR ?? (ownedLayoutDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-master-")));
				layout = new MasterLayout(directory, process.env.PI_SUBAGENT_MASTER ?? process.env.HERDR_PANE_ID, config.masterRatio ?? 0.6, config.minPaneRows ?? 8);
			}
			const effectiveSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
			// A cancelled turn must not leave a child running in the background, and
			// the call that requested it should say so rather than acking a dispatch
			// that never happens.
			effectiveSignal.throwIfAborted();
			const slash = agent.model.indexOf("/");
			const provider = agent.model.slice(0, slash), modelId = agent.model.slice(slash + 1);
			const contextWindow = provider && modelId ? ctx.modelRegistry.find(provider, modelId)?.contextWindow : undefined;
			const runCwd = path.resolve(cwd, params.cwd ?? cwd);

			// Built before the ack so an agent this machine cannot actually launch
			// fails *this* call, with a message the model can act on immediately.
			const prepared = await prepareSubagent(agent, params.task, runCwd, inherit, config.claude ?? {});

			const id = `${agent.name}-${++runSeq}`;
			const result: AgentResult = {
				agent: params.agent,
				task: params.task,
				output: "",
				exitCode: -1,
				model: agent.model,
				contextWindow,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				// `pending` until the semaphore lets it start — a dispatch that is
				// still queued should not claim to be working.
				progress: { agent: params.agent, status: "pending" as const, task: params.task, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
			};
			const record: RunRecord = { id, agent: agent.name, startedAt: Date.now(), result, prepared };
			runs.set(id, record);
			updateWidget();

			// The run outlives this call. `running` is what session_shutdown drains,
			// and every rejection handler is attached right here: a run that settles
			// minutes after its tool call must never surface as an unhandled
			// rejection, and allSettled at shutdown would attach far too late.
			const settled = (async () => {
				try {
					await semaphore.run(() => runSubagent(agent, prepared, result, runCwd, effectiveSignal, updateWidget, useHerdr ? layout : undefined));
				} catch (error: unknown) {
					// runSubagent reports child failures through progress.error and a
					// non-zero exit; reaching here means the launch itself broke.
					if (result.exitCode === -1) result.exitCode = 1;
					result.progress.status = "failed";
					result.progress.error ||= error instanceof Error ? error.message : String(error);
				}
				// A paused run keeps its place in the roster and its run directory: it
				// has not finished, it is waiting for an answer.
				if (result.progress.status === "paused") {
					updateWidget();
					return;
				}
				runs.delete(id);
				updateWidget();
				steerResult(record);
			})();
			running.add(settled);
			// .finally() attaches a rejection handler to `settled` itself; .catch()
			// then swallows the derived promise's. Without both, a steer that throws
			// on a shutting-down session would crash the parent.
			settled.finally(() => running.delete(settled)).catch(() => {});

			return {
				content: [{ type: "text", text: `Dispatched ${agent.name} as ${id}. It runs in the background: its result will be delivered to you automatically as a new message when it finishes. Do not wait, poll, or re-dispatch — carry on with whatever else the turn needs.` }],
				details: { results: [result], dispatched: id },
			};
		},

		// ── Render: tool call header ──
		//
		// Two views, toggled by ctrl+o (pi flips `context.expanded` and re-invokes
		// this on every flip). pi-agent-core also re-invokes this on every streamed
		// args delta, so in the expanded branch the full task text grows token by
		// token while the master LLM is still writing the prompt — mirroring how
		// `write`/`edit` reveal their `content` field live.
		renderCall(args, theme, context) {
			// Collapsed view (default): single-line header + 60-char task preview.
			if (!context.expanded) {
				if (!args.agent) {
					return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
				}
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
					0, 0,
				);
			}

			// Expanded view: header + full streaming task body. Reuse the previous
			// Container so we don't allocate on every streamed token (same pattern
			// the built-in write/edit tools use via context.lastComponent).
			const c = context.lastComponent instanceof Container
				? (context.lastComponent.clear(), context.lastComponent)
				: new Container();
			const agentLabel = args.agent ? ` ${theme.fg("accent", args.agent)}` : "";
			const cwdLabel = args.cwd ? theme.fg("dim", ` (cwd: ${args.cwd})`) : "";
			c.addChild(new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${agentLabel}${cwdLabel}`, 0, 0));
			if (args.task) {
				c.addChild(new Spacer(1));
				// Plain Text wraps to terminal width. Markdown would also work but
				// the task prompt is the master's raw instruction text, not authored
				// markdown, and parsing partial markdown mid-stream looks jittery.
				c.addChild(new Text(theme.fg("text", args.task), 0, 0));
			}
			return c;
		},

		// ── Render: result ──
		//
		// One line. The call only ever reports that a child was dispatched — the
		// run's progress belongs to the pinned widget and its outcome to the
		// steered `subagent_result` message, both of which outlive this block.
		renderResult(result, _options, theme) {
			const details = result.details as Details | undefined;
			if (details?.dispatched) {
				return new Text(`${theme.fg("dim", "→")} ${theme.fg("accent", details.dispatched)} ${theme.fg("dim", "dispatched, running in background")}`, 0, 0);
			}
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "(no output)";
			return new Text(text.slice(0, 200), 0, 0);
		},
	});
}
