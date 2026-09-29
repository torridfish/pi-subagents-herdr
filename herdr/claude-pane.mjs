/**
 * The claude child's half of the pane bridge. Runs inside the pane, under
 * `runner.mjs`, never in the parent.
 *
 * A pi child needs nothing like this: it loads `child.ts`, which writes the
 * journal the parent tails, and it owns the pane's terminal itself. Claude Code
 * loads no extension of ours and has no interactive mode we can read events
 * out of, so the bridge is a process rather than a plugin — this one. It holds
 * the headless child on both ends:
 *
 *   claude stdout ─┬─→ events.jsonl   (the journal the parent tails)
 *                  └─→ the pane        (rendered for whoever is watching)
 *   pane stdin ──────→ claude stdin    (as a stream-json user message)
 *
 * Which means a pane claude child is steerable the same two ways a pane pi
 * child is: the parent types into the pane with `sendToPane`, and so can the
 * person sitting in front of it.
 *
 * It also owns the decision the parent makes on the process backend — when the
 * run is over. A claude child cannot end its own session, so somebody has to
 * close its stdin once a turn settles with no question outstanding, and in a
 * pane that somebody is here.
 */
import fs from "node:fs";
import path from "node:path";

/** Claude Code namespaces MCP tools as `mcp__<server>__<tool>`; this is the
 *  ask tool as `runners/claude.ts` configures it. Duplicated rather than
 *  imported: this file is plain Node, spawned by a pane, with no build step. */
const ASK_TOOL = "mcp__pi_subagents__caller_ping";

const DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m", CYAN = "\x1b[36m";

/**
 * Wire a spawned headless `claude` into the pane it is running in.
 *
 * `child` must have been spawned with its stdin and stdout piped; stderr is
 * the pane's own, so Claude Code's own errors land where someone can read them.
 */
export function attachClaudeBridge(child, directory, openingPrompt) {
	const journal = path.join(directory, "events.jsonl");
	const answers = path.join(directory, "answers.jsonl");
	const append = (file, value) => {
		try { fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 }); } catch { /* the pane is going away */ }
	};
	const show = (line) => process.stdout.write(line + "\n");

	/** A question has been asked and not yet answered. While it is set, a
	 *  settled turn parks the child instead of ending it. */
	let waiting = false;

	const say = (text) => {
		if (!child.stdin || child.stdin.destroyed) return;
		child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
	};

	append(journal, { type: "bridge_ready" });

	// ── claude → the journal, and the pane ──────────────────────────
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += chunk.toString();
		const lines = out.split("\n");
		out = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			// Into the journal verbatim, whatever it is: the parent runs the same
			// event adapter over it that the process backend runs over stdout, so
			// anything this file fails to understand is still not lost.
			try { fs.appendFileSync(journal, line + "\n", { mode: 0o600 }); } catch { /* the pane is going away */ }
			let event;
			try { event = JSON.parse(line); } catch { continue; }
			render(event);
		}
	});

	function render(event) {
		if (event.type === "assistant") {
			for (const block of event.message?.content ?? []) {
				if (block.type === "tool_use") {
					if (block.name === ASK_TOOL) {
						waiting = true;
						show("");
						show(`${BOLD}${CYAN}? ${String(block.input?.question ?? "").trim()}${RESET}`);
						continue;
					}
					show(`${DIM}• ${block.name}${RESET} ${preview(block.input)}`);
				} else if (block.type === "text" && block.text?.trim()) {
					show(block.text.trim());
				}
			}
			return;
		}
		if (event.type !== "result") return;
		if (waiting) {
			// Parked. The prompt is for the person in the pane; the parent is
			// being told the same thing through the journal.
			show(`${DIM}  waiting for an answer — type one here, or answer from the parent session${RESET}`);
			return;
		}
		show("");
		show(`${DIM}— done${RESET}`);
		// Nothing outstanding, so the child is let go. It cannot do this itself.
		child.stdin?.end();
	}

	/** One line, short, for a tool row in the pane. */
	function preview(input) {
		if (!input || typeof input !== "object") return "";
		const first = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? input.query;
		const text = first === undefined ? JSON.stringify(input) : String(first);
		const flat = text.replace(/\s+/g, " ").trim();
		return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
	}

	// ── the pane → claude ───────────────────────────────────────────
	//
	// Whatever is typed here is an answer: by the person watching, or by the
	// parent through `sendToPane`, which is the same keystrokes. Recorded in
	// `answers.jsonl` because the ask tool runs in its own process and that
	// file is the only way it learns its question was answered.
	let typed = "";
	process.stdin.on("data", (chunk) => {
		typed += chunk.toString();
		const lines = typed.split("\n");
		typed = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			append(answers, { at: Date.now() });
			waiting = false;
			say(line.trim());
		}
	});

	child.on("close", () => {
		append(journal, { type: "bridge_complete" });
		// Nothing else holds this process open; without it the pane would sit
		// there on a finished run waiting for a keystroke.
		process.stdin.pause();
	});

	say(openingPrompt);
}
