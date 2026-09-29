/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: scout, researcher, worker.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MasterLayout } from "./herdr/layout.ts";
import { runInPane, sendToPane } from "./herdr/transport.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { buildClaudeArgs, makeClaudeLineHandler, type ClaudeRunnerConfig } from "./runners/claude.ts";
import { delegationNote, extractToolArgsPreview, isRunner, proseSummary, RUNNERS, type RunnerArgs, type RunnerName } from "./runners/shared.ts";
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
	/** `waiting` means the child asked its caller a question and parked: its
	 *  session is still open and holding everything it has done, doing nothing
	 *  until an answer arrives. It is not a terminal state. */
	status: "pending" | "running" | "waiting" | "completed" | "failed";
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
	/**
	 * Why the run ended early, when something ended it rather than the child
	 * finishing. A failure and a stop are not the same news: a model told its
	 * child "failed" reaches for a retry, which is the wrong move when the
	 * answer is that somebody pressed Ctrl+C.
	 */
	stoppedBy?: StopReason;
}

/** `user` interrupted the turn, `session` ended under the run, and `parent`
 *  means this process stopped answering and the child's pane watcher put it
 *  down — the only one of the three that is nobody's decision. */
export type StopReason = "user" | "session" | "parent";

/** What each stop is called, to the model and in the roster. Worded as
 *  statements of fact rather than as errors: none of them is the child's
 *  doing, and two of them are somebody's deliberate decision. */
export const STOP_MESSAGES: Record<StopReason, string> = {
	user: "Stopped by the user, who interrupted the turn it was dispatched in",
	session: "Stopped because the session that dispatched it ended",
	parent: "Stopped because the session that dispatched it went away without saying so",
};

export interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	contextWindow?: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	/** What the child is waiting to hear, while `progress.status` is `waiting`.
	 *  Cleared the moment an answer is sent. */
	question?: string;
}

interface Details {
	results: AgentResult[];
	/** Set on the `subagent` call's ack: the handle of the run it started. Absent
	 *  on the steered completion message, which carries the finished result. */
	dispatched?: string;
	/** Set on a steered message: which run it is about. The block renders under
	 *  this name, so a report can be told apart from the three other subagents'
	 *  reports as well as from the main agent's own prose. */
	handle?: string;
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
	 *  a resume or the end of the session may reclaim. Its trailing prompt is
	 *  rewritten on resume; everything else is launched again verbatim. */
	prepared: PreparedRun;
	/** The rest of what a relaunch needs. Resolved once at dispatch, because by
	 *  the time an answer arrives the tool call that worked them out is long
	 *  gone — and the config it read may have been changed since. */
	definition: AgentConfig;
	cwd: string;
	layout?: MasterLayout;
	/** How to speak to this child while it is alive. Replaced on every launch,
	 *  and replaced by a throwing stub once the child exits, so a stale handle
	 *  says so instead of writing into a closed pipe. */
	send?: Sender;
	/** Adopted from a previous session at startup rather than dispatched by
	 *  this one. Its child is long gone; what is left is a conversation. */
	restored?: boolean;
}

/** A built child invocation, plus which runner built it. Produced before the
 *  `subagent` call returns, so an undispatchable agent fails the call itself
 *  instead of surfacing as a background failure minutes later. */
interface PreparedRun extends RunnerArgs {
	runner: RunnerName;
}

/** Delivers a message to a child that is still alive. */
type Sender = (message: string) => void;

/**
 * What a run was launched as, written into its own run directory.
 *
 * A finished child can be picked back up, and what it gets picked back up as
 * has to be what it was: the same model, the same tool allowlist, the same
 * system prompt, the same session. Rebuilding that from whatever the extension
 * happens to hold in memory later is how a second process quietly becomes a
 * laxer one — the config it was resolved from can have been edited since, and
 * a record can have been mutated by anything that touched it.
 *
 * The child's environment is deliberately NOT snapshotted wholesale: it is the
 * user's environment, API keys included, and this file sits in a temp
 * directory. Only the variables this extension sets are kept.
 */
interface Loadout {
	version: 1;
	agent: string;
	runner: RunnerName;
	model: string;
	pane: boolean;
	cwd: string;
	args: string[];
	/** Exactly one of these is set, and which one is the runner's business: pi
	 *  resumes from a session file it was given, claude from an id it was
	 *  assigned. Either way it is what makes a finished child resumable. */
	sessionPath?: string;
	sessionId?: string;
	env: Record<string, string>;
}

function writeLoadout(prepared: PreparedRun, agent: AgentConfig, cwd: string, pane: boolean): void {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(prepared.childEnv ?? {})) {
		if (key.startsWith("PI_SUBAGENT_") && typeof value === "string") env[key] = value;
	}
	const loadout: Loadout = {
		version: 1, agent: agent.name, runner: prepared.runner, model: agent.model,
		pane, cwd, args: prepared.args, sessionPath: prepared.sessionPath, sessionId: prepared.sessionId, env,
	};
	fs.writeFileSync(path.join(prepared.tempDir, "loadout.json"), JSON.stringify(loadout, null, 2), { mode: 0o600 });
}

/**
 * The handles that outlive this process.
 *
 * A run directory already describes its run completely — the loadout beside
 * the session is enough to launch the same child again. What did not survive a
 * restart was knowing the directory existed: the handle lived in a Map in the
 * parent, and `session_shutdown` deleted every directory on the way out.
 *
 * So the index is small on purpose. It is a list of run directories and what
 * they were, kept outside them, in the user's own state directory rather than
 * in the repository or in the run's own temp directory. Everything else is
 * still read from the loadout at the moment it is needed.
 *
 * What this does NOT do is reattach to a live child, because after the parent
 * goes there is never one: a process child loses the pipe its stdin was on and
 * exits on EOF, and a pane child is put down by its own watcher once the
 * heartbeat goes stale. A restored handle is a conversation to pick back up.
 */
interface RunIndexEntry {
	version: 1;
	handle: string;
	agent: string;
	task: string;
	tempDir: string;
	endedAt: number;
	stoppedBy?: StopReason;
}

/** Overridable so a test never writes into the user's own state directory —
 *  and so someone can point it at a disk they have chosen deliberately, given
 *  what a kept run directory contains. */
const RUN_INDEX_DIR = process.env.PI_SUBAGENT_STATE_DIR || path.join(os.homedir(), ".pi", "subagents-herdr");

/** One index per project, keyed by the directory the session runs in: handles
 *  are only meaningful next to the code they were dispatched against. */
function runIndexPath(cwd: string): string {
	return path.join(RUN_INDEX_DIR, `${crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`);
}

function readRunIndex(cwd: string): RunIndexEntry[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(runIndexPath(cwd), "utf-8"));
		return Array.isArray(parsed) ? parsed.filter((e) => e?.version === 1 && typeof e.tempDir === "string") : [];
	} catch { return []; }
}

function writeRunIndex(cwd: string, entries: RunIndexEntry[]): void {
	try {
		fs.mkdirSync(RUN_INDEX_DIR, { recursive: true, mode: 0o700 });
		const target = runIndexPath(cwd);
		fs.writeFileSync(target + ".tmp", JSON.stringify(entries, null, 2), { mode: 0o600 });
		fs.renameSync(target + ".tmp", target);
	} catch { /* a lost index costs a handle, not a run */ }
}

/**
 * Drop what is too old to keep, and what is no longer there.
 *
 * The retention decision is deliberate and it is a privacy decision as much as
 * a disk one: a kept run directory holds the child's whole transcript. The
 * default is a week, and it is enforced here — at startup, on the way to
 * restoring — rather than by anything having to remember to tidy up.
 */
function pruneRunIndex(cwd: string, retainMs: number): RunIndexEntry[] {
	const cutoff = Date.now() - retainMs;
	const kept: RunIndexEntry[] = [];
	for (const entry of readRunIndex(cwd)) {
		if (entry.endedAt >= cutoff && fs.existsSync(entry.tempDir)) { kept.push(entry); continue; }
		fs.rmSync(entry.tempDir, { recursive: true, force: true });
	}
	writeRunIndex(cwd, kept);
	return kept;
}

function readLoadout(tempDir: string): Loadout | undefined {
	try {
		const loadout = JSON.parse(fs.readFileSync(path.join(tempDir, "loadout.json"), "utf-8")) as Loadout;
		return loadout.version === 1 && Array.isArray(loadout.args) ? loadout : undefined;
	} catch { return undefined; }
}

/**
 * What the dispatcher wants to know while a run is in flight.
 *
 * A run is no longer a promise that resolves once: a child can park on a
 * question and carry on, several times, inside one `runSubagent` call. These
 * are the moments the roster and the model have to hear about before it ends.
 */
interface RunHooks {
	onUpdate?: () => void;
	/** The child asked something and parked. */
	onWaiting?: (question: string) => void;
	/** Handed the way to talk to this child, once, as it starts. */
	onSender?: (send: Sender) => void;
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
	/** How long a finished run stays addressable after the session that
	 *  dispatched it ends, in hours. Default 168 (a week); 0 keeps nothing,
	 *  which is what this did before handles survived a restart. Its run
	 *  directory holds the child's whole transcript, so this is a privacy
	 *  setting as much as a disk one. */
	retainRunsHours?: number;
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
	/** Built for a Herdr pane, which runs a real interactive Pi and takes its
	 *  task as an argument. Everything else is driven over pi's RPC protocol. */
	pane = false,
): Promise<RunnerArgs> {
	for (const tool of agent.tools) {
		if (CHILD_TOOLS.has(tool)) continue;
		if (!BUILTIN_TOOLS.has(tool) && (!CUSTOM_TOOL_EXTENSIONS[tool] || !fs.existsSync(CUSTOM_TOOL_EXTENSIONS[tool]))) {
			throw new Error(`Agent ${agent.name} requires unavailable tool ${tool}; install its extension or configure toolExtensions`);
		}
	}
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file.
	//
	// The delegation note is appended to every agent's own prompt rather than
	// written into the agent files: a third-party agent gets it too, and there is
	// one place to change it. `caller_ping`'s own guidelines already reach the
	// child's Guidelines section, but an agent file that says "you are a scout,
	// report X" and never mentions asking is the stronger instruction of the two
	// for a smaller model — this is what keeps them from contradicting.
	const promptPath = path.join(tempDir, "system.md");
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, `${agent.systemPrompt}\n\n${delegationNote("caller_ping")}`, { encoding: "utf-8", mode: 0o600 });
	});

	// A child keeps its conversation in its own run directory rather than in the
	// user's session store. `--no-session` would be tidier still, but a session
	// file is what makes a run resumable: a child that pings its caller exits,
	// and the answer is delivered by restarting pi against this very file.
	// `--session <path>` on a path that does not exist yet creates it.
	const sessionPath = path.join(tempDir, "session.jsonl");
	// RPC rather than print mode, for one reason: print mode exits when it runs
	// out of prompts, and a child that asks its caller a question has to still
	// be there when the answer comes back. RPC keeps stdin open as a command
	// channel and streams the very same events print mode did, so nothing
	// downstream of the parser changes. A pane child stays in print-derived
	// interactive mode — `interactiveArgs` strips these two flags — because it
	// is driven by a human-shaped terminal, not by stdin.
	const args = [...piBin.baseArgs, "--mode", pane ? "json" : "rpc"];
	if (pane) args.push("-p");
	args.push("--session", sessionPath);
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

	// An RPC child is handed its task over the wire, where length is not an
	// issue. Only an argv-carried task needs the file indirection.
	let openingPrompt: string | undefined;
	if (!pane) {
		openingPrompt = `Task: ${task}`;
	} else if (task.length > TASK_LIMIT) {
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

	return { args: [piBin.command, ...args], tempDir, childEnv, sessionPath, openingPrompt,
		protocol: pane ? undefined : "pi-rpc" };
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

/** Above this many characters a prompt is handed over as a file rather than as
 *  an argument, for the task at dispatch and for the answer on resume alike. */
const TASK_LIMIT = 8000;

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
	pane = false,
): Promise<PreparedRun> {
	const runner: RunnerName = agent.runner ?? "pi";
	const built = runner === "claude"
		? await buildClaudeArgs(agent, task, cwd, inherit, claudeConfig)
		: await buildPiArgs(agent, task, cwd, inherit, pane);
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
	/** The run's handle (`researcher-2`). Names the child's pane, so a stack of
	 *  three researchers is three distinguishable panes rather than three panes
	 *  called "researcher". */
	handle: string,
	prepared: PreparedRun,
	result: AgentResult,
	cwd: string,
	signal: AbortSignal | undefined,
	hooks: RunHooks = {},
	layout?: MasterLayout,
): Promise<AgentResult> {
	const { runner, args, tempDir, childEnv, openingPrompt, protocol } = prepared;
	const onUpdate = hooks.onUpdate;
	// Defence in depth: execute() already refuses this combination with a better
	// message, but only pi and claude have a way to report out of a pane.
	if (layout && runner !== "pi" && runner !== "claude") throw new Error(`The ${runner} runner supports the process backend only`);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.();
	}, 150);

	let exitCode = 1;
	/**
	 * Record that something stopped this run, and say what.
	 *
	 * The abort that reaches here is `AbortSignal.any([<the turn>, <the
	 * session>])`, so the two are told apart by the reason the aborter passed:
	 * the extension tags its own, and anything else is the turn being
	 * interrupted — which in practice means the user.
	 */
	const stopped = (reason?: unknown) => {
		const tagged = (reason as { subagentStop?: StopReason } | undefined)?.subagentStop;
		progress.stoppedBy = tagged ?? "user";
		progress.error = STOP_MESSAGES[progress.stoppedBy];
	};
	// The question a `caller_ping` call is waiting on, read off the child's own
	// event stream. Cleared by `deliver`, which is the only thing that answers.
	let question: string | undefined;
	// Whether a turn is in flight. Decides how a message reaches the child: a
	// running agent is steered, a parked one is prompted.
	let busy = false;
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

				if (evt.type === "agent_start") { busy = true; }

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.recentTools.push({
						tool: evt.toolName,
						args: extractToolArgsPreview((evt.args || {}) as Record<string, unknown>),
						toolCallId: evt.toolCallId,
						status: "running",
					});
					// The question is the tool call: there is no sidecar and nothing to
					// poll for. What makes the run *waiting* is this call still being
					// unanswered when the turn settles, below.
					if (evt.toolName === "caller_ping") {
						const asked = typeof evt.args?.question === "string" ? evt.args.question.trim() : "";
						if (asked) question = asked;
					}
					fireUpdate();
				}

				// A settled turn is where a run's fate is decided. With a question
				// outstanding the child parks — alive, idle, holding its context —
				// and this is the parent's cue to go and get an answer. Otherwise the
				// child shuts itself down and the process close below ends the run.
				if (evt.type === "agent_settled") {
					busy = false;
					if (question && progress.status !== "waiting") {
						progress.status = "waiting";
						result.question = question;
						progress.durationMs = Date.now() - startTime;
						onUpdate?.();
						hooks.onWaiting?.(question);
					}
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

		/** A message has gone out: the child is working again, not waiting. */
		const delivered = () => {
			question = undefined;
			result.question = undefined;
			if (progress.status === "waiting") progress.status = "running";
			onUpdate?.();
		};

		/** A turn settled with nothing outstanding: the child has said its piece
		 *  and the run is over. A pi child reaches this state by shutting itself
		 *  down; a claude child has to be let go, because its stdin is what keeps
		 *  it alive. Set once the channel exists. */
		let finish: (() => void) | undefined;

		const processLine = runner === "claude"
			? makeClaudeLineHandler({
				progress, result, fireUpdate, startTime,
				onQuestion: (asked) => { question = asked; },
				// Same decision the pi path makes on `agent_settled`, in the same
				// order: park on an unanswered question, otherwise let the child go.
				onTurnEnd: () => {
					busy = false;
					if (question) {
						if (progress.status !== "waiting") {
							progress.status = "waiting";
							result.question = question;
							progress.durationMs = Date.now() - startTime;
							onUpdate?.();
							hooks.onWaiting?.(question);
						}
						return;
					}
					finish?.();
				},
			})
			: processPiLine;

		if (layout) {
			// PI_SUBAGENT_* is how a pi child is told which transport and tool
			// extensions it inherited. A claude child is told none of it: the pane
			// it runs in is the bridge's business, not its own.
			const env = runner === "pi"
				? { ...childEnv, PI_SUBAGENT_LAYOUT_DIR: layout.directory,
					PI_SUBAGENT_MASTER: layout.master, PI_SUBAGENT_BACKEND: "herdr",
					PI_SUBAGENT_TOOL_EXTENSIONS: JSON.stringify(CUSTOM_TOOL_EXTENSIONS) }
				: (childEnv ?? process.env);
			// A pane child has no stdin its parent can write to, so it is typed to —
			// the same door the user sitting at that pane would use. Same contract as
			// the RPC sender, different mechanism.
			let paneId: string | undefined;
			hooks.onSender?.((message) => {
				if (!paneId) throw new Error("the child's pane is not ready yet");
				void sendToPane(paneId, message).catch(error => { progress.error ||= `Could not reach the child's pane: ${error}`; });
				delivered();
			});
			void runInPane(layout, { command, args: spawnArgs, cwd, env, directory: tempDir,
				name: handle, signal, onLine: processLine, onPane: id => { paneId = id; },
				bridge: runner === "claude" ? "claude" : "pi", openingPrompt }).then(exit => {
				// The pane watcher knows something this process cannot: whether this
				// process was still there. A run it ended because the heartbeat went
				// stale was not cancelled by anyone — it was orphaned.
				if (exit.stop === "parent") stopped({ subagentStop: "parent" });
				else if (exit.stop === "cancelled") stopped(signal?.reason);
				else if (exit.error) progress.error = exit.error;
				resolve(exit.code);
			}, error => { progress.error = String(error); resolve(1); });
			return;
		}
		// PI_SUBAGENT_* is how a pi child is told which transport and tool
		// extensions it inherited; it means nothing to any other runner.
		const env = runner === "pi"
			? { ...childEnv, PI_SUBAGENT_BACKEND: "process", PI_SUBAGENT_TOOL_EXTENSIONS: JSON.stringify(CUSTOM_TOOL_EXTENSIONS) }
			: childEnv;
		// stdin is a channel, not a one-shot argument: both runners keep it open
		// for the life of the run, because that is how an answer reaches a parked
		// child. Only the envelope differs — pi takes RPC commands, Claude Code
		// takes the same user messages it would take from a terminal.
		const proc = spawn(command, spawnArgs, { cwd, stdio: [openingPrompt !== undefined ? "pipe" : "ignore", "pipe", "pipe"], env });
		// A child that exits before reading gives us EPIPE; the close handler
		// already reports the real failure, so don't let it crash the parent.
		proc.stdin?.on("error", () => {});
		if (openingPrompt !== undefined) {
			const write = (payload: Record<string, unknown>) => {
				if (!proc.stdin || proc.stdin.destroyed || proc.exitCode !== null) throw new Error("the child is no longer running");
				proc.stdin.write(JSON.stringify(payload) + "\n");
			};
			/**
			 * Say something to this child.
			 *
			 * Over RPC, `steer` lands between the tool calls of a turn already in
			 * flight and `prompt` starts a fresh turn in a parked session; pi
			 * rejects the wrong one of the two rather than papering over it, which
			 * is why `busy` is tracked at all. Claude Code's streaming input has no
			 * such split — a user message is queued if a turn is running and starts
			 * one if not — so the same call covers both.
			 */
			const say = protocol === "claude-stream"
				? (message: string) => write({ type: "user", message: { role: "user", content: [{ type: "text", text: message }] } })
				: (message: string) => write(busy ? { type: "steer", message } : { type: "prompt", message });

			// What the ask tool reads to tell an answered question from an
			// outstanding one. It runs in its own process with no channel to this
			// one, so the run directory is the only thing they share.
			const recordDelivery = () => {
				if (protocol !== "claude-stream") return;
				try {
					fs.appendFileSync(path.join(tempDir, "answers.jsonl"), JSON.stringify({ at: Date.now() }) + "\n", { mode: 0o600 });
				} catch { /* the refusal check degrades to allowing the ask */ }
			};

			const deliver: Sender = (message) => {
				recordDelivery();
				say(message);
				delivered();
			};
			hooks.onSender?.(deliver);
			// A claude child holds the floor until its stdin closes. Nothing else
			// ends the run: the child cannot shut its own session down the way a pi
			// child does, so this is the parent's half of the same contract.
			finish = () => { try { proc.stdin?.end(); } catch { /* already gone */ } };
			say(openingPrompt);
		}
		let closed = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const kill = () => {
			stopped(signal?.reason);
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
			if (process.env.PI_SUBAGENT_STDERR_DEBUG) fs.appendFileSync("/tmp/subagent-child-stderr.log", d.toString());
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
	} finally {
		// The run directory is not reclaimed here. It holds the session file, and
		// a finished child can still be spoken to — `subagent_message` restarts it
		// from that file. The extension clears every run directory when the
		// session that owns them ends.
		hooks.onSender?.(() => { throw new Error("child has exited"); });
	}

	// A child that exits while a question is outstanding was killed or crashed:
	// it parks rather than exits on its own, so this is a failure however clean
	// the exit code looks.
	result.exitCode = exitCode;
	result.question = undefined;
	if (question && exitCode === 0 && !progress.error) progress.error = "Child exited while waiting for an answer";
	progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
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

/** How much of a finished subagent's report the collapsed block shows. Source
 *  lines, not screen lines: they wrap, and a report that opens with a wall of
 *  prose should not push the rest of the transcript off the screen. */
const COLLAPSED_REPORT_LINES = 8;

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
	const isWaiting = prog.status === "waiting";
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

	/** Prose that must survive the collapsed view intact — the question, the
	 *  report — wraps instead of being cut off at the right margin. A tool log
	 *  line reads fine truncated; half a sentence does not. */
	const addWrapped = (content: string) => { c.addChild(new Text(indent + content, 0, 0)); };

	// Header: icon + agent + stats (always one line)
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: isWaiting
				? theme.fg("warning", "?")
				: prog.stoppedBy
					// Not a failure mark: nothing went wrong with the child.
					? theme.fg("dim", "⊘")
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

	// The question, while the run is waiting on one. It is the whole point of the
	// block at that moment, so it goes last among the prose rows — closest to
	// wherever the reader's eye lands — and it stays visible when collapsed.
	if (isWaiting && r.question) {
		if (!nested) c.addChild(new Spacer(1));
		addWrapped(theme.fg("warning", `Asks: ${r.question}`));
	}

	// The report — only at depth 0. Nested levels are summarized via their own
	// tool list; the master-level result block is enough context.
	//
	// Shown in both views, not just the expanded one: this is what the subagent
	// was dispatched to produce, and a block that hides it behind ctrl+o leaves
	// the reader with a tool log and no answer. Collapsed gets the head of it,
	// which is where a well-behaved agent puts its conclusion.
	if (!nested && !isRunning && !isWaiting && r.output) {
		c.addChild(new Spacer(1));
		if (expanded) {
			c.addChild(new Markdown(r.output, 0, 0, getMarkdownTheme()));
		} else {
			const lines = r.output.split("\n").filter((line, i, all) => line.trim() || (i > 0 && all[i - 1].trim()));
			for (const line of lines.slice(0, COLLAPSED_REPORT_LINES)) addWrapped(theme.fg("text", line));
			const rest = lines.length - COLLAPSED_REPORT_LINES;
			if (rest > 0) addLine(theme.fg("dim", `… ${rest} more line${rest === 1 ? "" : "s"} — ctrl+o`));
		}
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
 * Draw a run the way pi draws a tool call.
 *
 * A subagent's report arrives as a message in the transcript, where by default
 * it looks exactly like something the main agent said — same column, same
 * colours, no seam. Tool output already has a seam the reader has learned:
 * a padded block on a tinted ground. This is that block, assembled the way
 * pi's own `ToolExecutionComponent` assembles it — a leading blank line, then
 * a `Box(1, 1)` painted with one of the three tool backgrounds — so a child's
 * answer reads as machinery reporting rather than as the assistant talking.
 *
 * The tone carries the same meaning it does everywhere else in the transcript:
 * pending while the child waits on an answer, error when it failed, success
 * when it finished.
 */
type ToolTone = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

function toolBlock(title: string, inner: Component, theme: Theme, tone: ToolTone): Component {
	const box = new Box(1, 1, (text) => theme.bg(tone, text));
	box.addChild(new Text(title, 0, 0));
	box.addChild(inner);
	const c = new Container();
	c.addChild(new Spacer(1));
	c.addChild(box);
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
			const waiting = records.filter((r) => r.result.progress.status === "waiting").length;
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
				const waiting = prog.status === "waiting";
				// What the child is doing *now*: its newest still-running tool call,
				// and only if none is running, its latest prose line. A finished tool
				// call says nothing about whether the run is still alive. A paused
				// run is doing nothing at all — it shows its question instead.
				const current = [...prog.recentTools].reverse().find((t) => t.status === "running");
				const activity = waiting
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
					theme.fg(queued ? "dim" : "warning", queued ? "○" : waiting ? "?" : "⟳")
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
			"So do not stall on a dispatch. Finish whatever else the current turn needs, and end the turn once nothing is left that does not depend on the answer. If the user is waiting on that answer and nothing else is outstanding, say what you dispatched and stop — you will be woken when it lands. Rewriting a brief you have already sent is not \"whatever else the turn needs\": it dispatches a second child, it does not improve the first.",
			"",
			"The subagent cannot see this conversation. Everything it needs — the goal, the constraints, the file paths you already know, the shape of the answer you want — has to be written into `task`.",
			"",
			"A child that gets stuck on something only you can decide can pause and ask, instead of guessing. That arrives as a question naming its handle; answer it with `subagent_message` and the child carries on from exactly where it stopped.",
		].join("\n"),
		guidelines: [
			// Never name an agent that is not registered: a filtered child would
			// otherwise be told to dispatch something it cannot reach.
			...registry.flatMap((a) => triggers[a.name] ?? []),
			"Do the work yourself when you already have the path, need exact file bytes in order to edit, or it is a single lookup — a subagent costs a process start and a fresh system prompt.",
			"Write `task` as a standalone brief: the goal, the constraints, the paths you already know, and the output shape you want back. A subagent left to infer the context will infer it wrong.",
			// The child cannot see the conversation, so nothing carries the user's
			// language across but this. Observed: a Chinese request dispatched as
			// an English brief, answered in English, translated back by hand.
			"Write `task` in the language the conversation is in, and say which language the report should come back in. The child cannot see the conversation, so a brief you translated is a report you will have to translate back.",
			// Observed: the user asked for one runner by name, the dispatch was
			// refused for an unrelated reason, and the retry dropped the argument.
			"When the user names a runner, pass it as `runner`. If that dispatch is then refused, say so and let them choose — never re-send with `runner` dropped, which quietly runs their work somewhere they did not ask for.",
			// Observed: two children given the same question 21 seconds apart,
			// the second one's brief merely worded better.
			"A dispatch you have already made is still running. Sending the same brief again does not replace or improve it — you get two children doing one job and two reports. Steer the one you have with `subagent_message` instead.",
			// The mirror of what every child is told about its caller. The parent
			// is the one guessing here, and it has somebody to ask too.
			"Ask the user before dispatching, not after, when the request itself is ambiguous — a term you cannot place, a scope you are guessing at. A child handed a guess comes back confident about the wrong thing, and a whole run is how you find out.",
			"When a brief leaves a decision that is yours rather than the subagent's — which approach to take, a value you have not settled, anything irreversible — say so in `task`. A child told which decisions are yours asks you about them instead of picking one and building on it.",
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
	/** Distinguishes the two aborts that reach a child, which are otherwise one
	 *  signal by the time `runSubagent` sees them (`AbortSignal.any` below).
	 *  `AbortSignal.any` forwards the reason of whichever fired. */
	const SESSION_ENDED = { subagentStop: "session" as StopReason };
	const running = new Set<Promise<unknown>>();
	// Dispatched runs, keyed by the handle the widget shows. A record is removed
	// the instant its result is steered, so `runs` is exactly "what is in flight".
	const runs = new Map<string, RunRecord>();
	let runSeq = 0;
	const projectDir = process.cwd();
	const retainMs = Math.max(0, config.retainRunsHours ?? 168) * 3600_000;

	/** Note a settled run in the index, so its handle is still addressable from
	 *  the next session. Rewritten rather than appended: a run can settle twice
	 *  (picked back up, settles again) and the index holds one row per handle. */
	const rememberRun = (record: RunRecord) => {
		if (retainMs === 0) return;
		const entry: RunIndexEntry = {
			version: 1, handle: record.id, agent: record.agent, task: record.result.task,
			tempDir: record.prepared.tempDir, endedAt: Date.now(),
			stoppedBy: record.result.progress.stoppedBy,
		};
		writeRunIndex(projectDir, [...readRunIndex(projectDir).filter((e) => e.handle !== entry.handle), entry]);
	};

	/**
	 * Take back the handles of the previous session, and prune what has aged out.
	 *
	 * A restored run is a finished one by definition — whatever was in flight
	 * when the parent went away is not running now. It is restored so that its
	 * handle still means something: `subagent_message` can pick the same child
	 * back up from the session the loadout names.
	 */
	const restoreRuns = () => {
		for (const entry of pruneRunIndex(projectDir, retainMs)) {
			if (runs.has(entry.handle)) continue;
			const loadout = readLoadout(entry.tempDir);
			if (!loadout) continue;
			const progress: AgentProgress = { agent: entry.agent, status: "completed", task: entry.task,
				recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "",
				stoppedBy: entry.stoppedBy, error: entry.stoppedBy ? STOP_MESSAGES[entry.stoppedBy] : undefined };
			const result: AgentResult = { agent: entry.agent, task: entry.task, output: "", exitCode: 0,
				model: loadout.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, progress };
			// Rebuilt from the loadout, which is the only description of this run
			// that survived. `definition` is a stub: the relaunch path reads the
			// loadout, never today's config, and that is the point of having one.
			const prepared: PreparedRun = {
				runner: loadout.runner, args: loadout.args, tempDir: entry.tempDir,
				childEnv: { ...process.env, ...loadout.env },
				sessionPath: loadout.sessionPath, sessionId: loadout.sessionId,
				protocol: loadout.runner === "claude" ? "claude-stream" : (loadout.pane ? undefined : "pi-rpc"),
			};
			runs.set(entry.handle, {
				id: entry.handle, agent: entry.agent, startedAt: entry.endedAt, result, prepared,
				definition: { name: entry.agent, description: "", tools: [], model: loadout.model,
					thinking: "medium", systemPrompt: "", filePath: "", runner: loadout.runner },
				cwd: loadout.cwd, restored: true,
			});
			// Handles are unique within a session and must stay unique across one:
			// a restored `scout-3` and a fresh `scout-3` are different children.
			const suffix = Number(entry.handle.slice(entry.handle.lastIndexOf("-") + 1));
			if (Number.isFinite(suffix)) runSeq = Math.max(runSeq, suffix);
		}
	};
	// Captured on session_start so the completion path — which has no ctx of its
	// own — can repaint the widget. Stays undefined outside interactive mode (and
	// under unit tests), which makes every widget call a silent no-op there.
	let uiCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	const stopTicker = () => {
		if (ticker) { clearInterval(ticker); ticker = undefined; }
	};

	/** Runs that have not ended. A finished record stays in `runs` so its handle
	 *  keeps working, but the roster is about what is happening now. */
	const inFlight = () => [...runs.values()].filter((r) => r.result.progress.status !== "completed" && r.result.progress.status !== "failed");

	const updateWidget = () => {
		if (!uiCtx) return;
		if (inFlight().length === 0) {
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
		uiCtx.ui.setWidget("subagents", (_tui, theme) => renderRunsWidget(inFlight(), theme), { placement: "aboveEditor" });
	};

	/**
	 * Run a record's child to completion in the background, and deal with
	 * whatever it comes back as.
	 *
	 * Shared by dispatch and resume, which differ only in the prompt the child is
	 * handed: a run can pause and continue any number of times, and each leg has
	 * to be wired up the same way — into `running` so shutdown drains it, with
	 * its rejection handler attached here rather than at shutdown, when it would
	 * be far too late.
	 */
	const launch = (record: RunRecord, signal: AbortSignal) => {
		const result = record.result;
		const settled = (async () => {
			try {
				await semaphore.run(() => runSubagent(record.definition, record.id, record.prepared, result, record.cwd, signal, {
					onUpdate: updateWidget,
					// Mid-run, not at the end: the child is still alive and parked, so
					// the model hears the question while the run is open.
					onWaiting: () => { updateWidget(); steerQuestion(record); },
					onSender: (send) => { record.send = send; },
				}, record.layout));
			} catch (error: unknown) {
				// runSubagent reports child failures through progress.error and a
				// non-zero exit; reaching here means the launch itself broke.
				if (result.exitCode === -1) result.exitCode = 1;
				result.progress.status = "failed";
				result.progress.error ||= error instanceof Error ? error.message : String(error);
			}
			// The record is not removed: its handle stays addressable, and
			// `subagent_message` can start the child up again from its session file.
			// Only the roster forgets it, because it is no longer in flight.
			updateWidget();
			rememberRun(record);
			steerResult(record);
		})();
		running.add(settled);
		// .finally() attaches a rejection handler to `settled` itself; .catch()
		// then swallows the derived promise's. Without both, a steer that throws
		// on a shutting-down session would crash the parent.
		settled.finally(() => running.delete(settled)).catch(() => {});
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
		const stop = r.progress.stoppedBy;
		const failed = !stop && (r.exitCode !== 0 || !!r.progress.error);
		const elapsed = formatDuration(r.progress.durationMs);
		// A stop is reported as what it is, and with what to do about it, because
		// "failed" is what makes a model try the same dispatch again — exactly the
		// wrong move when the reason is that somebody stopped it on purpose.
		const content = stop
			? `Subagent ${record.id} (${record.agent}) was stopped after ${elapsed}. ${STOP_MESSAGES[stop]}.`
				+ (stop === "user" ? " Do not dispatch it again unless they ask; say what it had got through, and wait." : "")
			: failed
				? `Subagent ${record.id} (${record.agent}) failed after ${elapsed}: ${r.progress.error || r.output || `exited ${r.exitCode}`}`
				: `Subagent ${record.id} (${record.agent}) finished in ${elapsed}.\n\n${r.output || "(no output)"}`;
		pi.sendMessage<Details>(
			{ customType: "subagent_result", content, display: true, details: { results: [r], handle: record.id } },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	/**
	 * Wake the model up with a child's question.
	 *
	 * Same delivery as a result — the run's outcome and its question are the same
	 * kind of event, something that lands when it lands — but it names the run
	 * and the tool that answers it, because a question the model reads and does
	 * not answer leaves a child paused forever.
	 */
	const steerQuestion = (record: RunRecord) => {
		const r = record.result;
		const content = `Subagent ${record.id} (${record.agent}) is waiting on you after ${formatDuration(r.progress.durationMs)}:\n\n`
			+ `${r.question}\n\n`
			+ `Its session is still open and holding everything it has done; it is doing nothing until you reply. Answer with `
			+ `subagent_message(handle: "${record.id}", message: …). If the answer is the user's to give rather than yours, ask them — `
			+ `the child waits, and costs nothing while it does.`;
		pi.sendMessage<Details>(
			{ customType: "subagent_question", content, display: true, details: { results: [r], handle: record.id } },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	};

	// The full progress block — tool log, prose, usage, context gauge — moves here
	// from the tool result. Under the sync contract it rendered under the call
	// that was still blocking on it; now the call is long gone and this steered
	// message is where the finished run gets read.
	const renderSteeredRun = (message: { details?: Details }, options: { expanded: boolean }, theme: Theme) => {
		const result = message.details?.results?.[0];
		if (!result) return undefined;
		// One column of box padding each side, then the margin the block already
		// assumed.
		const block = renderAgentProgress(result, theme, options.expanded, getTermWidth() - 4);
		const handle = message.details?.handle;
		// A run that is waiting has not failed, so it is checked first: its
		// exit code is the -1 of a child that is still alive.
		const tone: ToolTone = result.progress.status === "waiting"
			? "toolPendingBg"
			: result.exitCode === 0 && !result.progress.error
				? "toolSuccessBg"
				: "toolErrorBg";
		// Titled like the call that dispatched it — `subagent researcher-2` —
		// because that handle is what `subagent_message` is addressed to. The
		// agent behind it is named one line below, in the run's own header.
		const title = `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", handle ?? result.agent)}`;
		return toolBlock(title, block, theme, tone);
	};
	pi.registerMessageRenderer<Details>("subagent_result", renderSteeredRun);
	// A pause renders the same way a result does. It is the same run, read at a
	// different moment, and the block already knows how to show the question.
	pi.registerMessageRenderer<Details>("subagent_question", renderSteeredRun);

	Object.assign(CUSTOM_TOOL_EXTENSIONS, JSON.parse(process.env.PI_SUBAGENT_TOOL_EXTENSIONS || "{}"), config.toolExtensions);
	pi.on("session_start", (_event, ctx) => { uiCtx = ctx; restoreRuns(); updateWidget(); });
	pi.on("session_shutdown", async () => {
		shutdown.abort(SESSION_ENDED);
		await Promise.allSettled([...running]);
		stopTicker();
		// A run directory outlives its child, because a finished subagent can
		// still be picked back up from the session inside it — and now it
		// outlives this session too, for `retainRunsHours`. What is recorded
		// here is which directories those are; the next session prunes whatever
		// has aged out. With retention off, they go the way they always did.
		for (const record of runs.values()) {
			if (retainMs === 0) { fs.rmSync(record.prepared.tempDir, { recursive: true, force: true }); continue; }
			// A run adopted at startup and never touched keeps the timestamp it
			// already had. Re-recording it here would push its age back to zero
			// every time a session opens and closes, and a retention window that
			// resets whenever you start the editor is not a retention window.
			if (record.restored) continue;
			rememberRun(record);
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
			runner: Type.Optional(Type.String({ description: `Which child process runs the agent: ${RUNNERS.join(" or ")}. Pass it whenever the user names one, in whatever words and whatever language they used — naming it in passing is still naming it. Omit it only when they did not, and the configured default applies.` })),
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
			// Both runners can report back from a pane, by different bridges: a pi
			// child writes the journal itself through `herdr/child.ts`, and a claude
			// child is wrapped in `herdr/claude-pane.mjs`, which writes it for one.
			// Anything else has no way home from a pane.
			const paneCapable = agent.runner === "pi" || agent.runner === "claude";
			if (!paneCapable && backend === "herdr") {
				throw new Error(`Agent ${agent.name} runs under the ${agent.runner} runner, which supports the process backend only. Select /subagents-herdr process or auto.`);
			}
			const useHerdr = paneCapable && (backend === "herdr" || (backend === "auto" && process.env.HERDR_ENV === "1"));
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
			const prepared = await prepareSubagent(agent, params.task, runCwd, inherit, config.claude ?? {}, useHerdr);

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
			// Written before the child starts, so the run directory describes the run
			// even if nothing in this process survives to describe it.
			writeLoadout(prepared, agent, runCwd, useHerdr);
			const record: RunRecord = { id, agent: agent.name, startedAt: Date.now(), result, prepared,
				definition: agent, cwd: runCwd, layout: useHerdr ? layout : undefined };
			runs.set(id, record);
			updateWidget();

			// The run outlives this call, and may outlive several more before it is
			// done: `launch` owns everything that happens to it from here.
			launch(record, effectiveSignal);

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

	pi.registerTool({
		name: "subagent_message",
		label: "Message subagent",
		description:
			"Say something to a subagent you dispatched, addressed by its handle. Use it to answer one that is "
			+ "waiting on a question, to correct or redirect one that is still working, or to give a finished one "
			+ "more to do — the same child picks up with everything it already knows, rather than starting over. "
			+ "Like `subagent`, this returns immediately: whatever comes of it arrives as its own message later.",
		promptSnippet: "Answer, redirect, or follow up with a subagent you dispatched, by handle",
		promptGuidelines: [
			"A subagent waiting on a question is doing nothing until you answer. Answer it with subagent_message as "
			+ "soon as you know, and when the answer is the user's to give, ask them rather than deciding for them.",
			"Use subagent_message to correct a running subagent the moment you notice it is heading the wrong way, "
			+ "rather than letting it finish work you will throw away.",
			"Following up with a finished subagent beats dispatching a fresh one for the same area: it still has the "
			+ "context it built, and a new child would pay for all of it again.",
		],
		parameters: Type.Object({
			handle: Type.String({ description: "Which run to speak to, by the handle its dispatch returned (for example `scout-1`)." }),
			message: Type.String({ description: "What to say, written for someone who cannot see this conversation: the answer or instruction, plus anything it needs to act on it." }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const handle = params.handle?.trim();
			const record = handle ? runs.get(handle) : undefined;
			if (!record) {
				// Said separately because they are different things to the model: one
				// it dispatched and can still be holding a thread with, one it
				// inherited from a session it cannot see and can only pick back up.
				const known = [...runs.values()].filter((r) => !r.restored).map((r) => `${r.id} (${r.result.progress.status})`);
				const inherited = [...runs.values()].filter((r) => r.restored).map((r) => r.id);
				throw new Error(`Unknown subagent handle: ${params.handle}. ${known.length ? `Dispatched this session: ${known.join(", ")}.` : "Nothing has been dispatched this session."}`
					+ (inherited.length ? ` Still addressable from an earlier session: ${inherited.join(", ")}.` : ""));
			}
			const message = params.message?.trim();
			if (!message) throw new Error(`subagent_message needs something to say to ${record.id}.`);
			const status = record.result.progress.status;

			// Still alive: the child is spoken to where it stands. `send` steers a
			// running turn and prompts a parked one, and either way the run it
			// belongs to is the one already in flight — there is nothing to start.
			if (status === "running" || status === "waiting") {
				if (!record.send) throw new Error(`Subagent ${record.id} cannot be messaged on this backend yet.`);
				const answering = status === "waiting";
				record.send(answering ? `Your caller answered: ${message}\n\nCarry on from where you stopped.` : `Your caller says: ${message}`);
				updateWidget();
				return {
					content: [{ type: "text", text: `${answering ? "Answered" : "Message delivered to"} ${record.id}. It carries on in the background; its report arrives on its own. Do not wait or poll.` }],
					details: { results: [record.result], dispatched: record.id },
				};
			}
			if (status === "pending") {
				throw new Error(`Subagent ${record.id} is queued behind the concurrency limit and has not started yet. Try again once it is running.`);
			}

			// Finished: the child is gone, but its conversation is not. Start it
			// again from its own session file with this message as the next thing
			// it hears — the loadout it was dispatched with is reused verbatim, so
			// the second process is the same sandbox as the first.
			const { tempDir } = record.prepared;
			const loadout = readLoadout(tempDir);
			// A pi session is a file in the run directory, which the end of the
			// parent's session reclaims; a claude session is an id in the user's
			// own store, which outlives us. Both are checked the only way they can
			// be — the file for its existence, the id for having been recorded.
			const resumable = loadout?.runner === "claude"
				? Boolean(loadout.sessionId)
				: Boolean(loadout?.sessionPath && fs.existsSync(loadout.sessionPath));
			if (!loadout || !resumable) {
				throw new Error(`Subagent ${record.id} has finished and its session is gone, so it cannot be picked up again. Dispatch a fresh run with what you have learned.`);
			}
			// An interactive pi invocation is what a pane loadout holds, and it has
			// no stdin channel to put a prompt on. Its pane went with the session
			// that opened it, so there is nothing to type into either.
			if (loadout.pane && loadout.runner === "pi" && !record.layout) {
				throw new Error(`Subagent ${record.id} ran in a pane belonging to a session that has ended, so it cannot be picked back up from here. Dispatch a fresh run with what you have learned.`);
			}
			const effectiveSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
			effectiveSignal.throwIfAborted();

			// Rebuilt from the snapshot rather than from whatever is in memory: the
			// second process is the first one's sandbox, not today's config.
			const body = `Your caller has more for you: ${message}\n\nYou are picking up the session you already did work in. Carry on from there rather than starting over.`;
			let args = loadout.args;
			let openingPrompt: string | undefined;
			// A bridged pane child is driven over the same channel in a pane as it
			// is without one, so it takes its prompt the same way too. Only an
			// interactive pi child reads it out of argv.
			if (loadout.pane && loadout.runner !== "claude") {
				// A pane child takes its prompt in argv, where a long one has to go
				// through a file, exactly as the original task did.
				let prompt = body;
				if (body.length > TASK_LIMIT) {
					const messagePath = path.join(tempDir, `message-${Date.now()}.md`);
					await withFileMutationQueue(messagePath, async () => {
						await fs.promises.writeFile(messagePath, body, { encoding: "utf-8", mode: 0o600 });
					});
					prompt = `@${messagePath}`;
				}
				args = [...loadout.args.slice(0, -1), prompt];
			} else {
				openingPrompt = body;
				// `--session-id` asks for a new conversation under that id, which the
				// first launch already created. The second one joins it instead.
				if (loadout.runner === "claude" && loadout.sessionId) {
					args = loadout.args.map((arg) => (arg === "--session-id" ? "--resume" : arg));
				}
			}
			record.prepared = { ...record.prepared, args, openingPrompt,
				sessionPath: loadout.sessionPath, sessionId: loadout.sessionId,
				childEnv: { ...process.env, ...loadout.env } };
			record.restored = false; // touched: it is this session's run now
			record.result.question = undefined;
			record.result.exitCode = -1;
			record.result.progress.status = "pending";
			record.startedAt = Date.now();
			launch(record, effectiveSignal);

			return {
				content: [{ type: "text", text: `Picked ${record.id} back up. It is running again in the background: its report will be delivered to you automatically. Do not wait or poll — carry on with whatever else the turn needs.` }],
				details: { results: [record.result], dispatched: record.id },
			};
		},

		renderCall(args, theme) {
			const body = args.message ? ` ${theme.fg("dim", (args.message.length > 60 ? args.message.slice(0, 60) + "…" : args.message).replace(/\n/g, " "))}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_message"))} ${theme.fg("accent", args.handle ?? "")}${body}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as Details | undefined;
			if (details?.dispatched) {
				return new Text(`${theme.fg("dim", "→")} ${theme.fg("accent", details.dispatched)} ${theme.fg("dim", "message delivered")}`, 0, 0);
			}
			const t = result.content[0];
			return new Text((t?.type === "text" ? t.text : "(no output)").slice(0, 200), 0, 0);
		},
	});
}