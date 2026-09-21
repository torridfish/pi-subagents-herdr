/**
 * `caller_ping` for a Claude Code child, as a stdio MCP server.
 *
 * The pi runner registers this tool from inside the child (`herdr/child.ts`),
 * which a Pi extension can do and Claude Code has no equivalent of. An MCP
 * server is the one surface a headless `claude` child will load a tool from, so
 * the tool lives out here in its own process, spawned by the child.
 *
 * It carries no channel to the parent, and needs none. The question IS the tool
 * call, and the parent is already reading every tool call off the child's
 * stream-json stdout — the same trick the pi side uses. All this process does
 * is describe the tool well enough that a child reaches for it, and refuse a
 * second question while one is still outstanding.
 *
 * Spawned by `claude`, so: plain Node, no build step, no dependencies.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

/** Where the parent records what it has delivered. Absent when the run
 *  directory was not passed, in which case the outstanding-question check
 *  degrades to allowing every ask rather than to refusing every second one. */
const runDir = process.env.PI_SUBAGENT_RUN_DIR;
const answersPath = runDir ? path.join(runDir, "answers.jsonl") : undefined;

/** How many messages the caller has sent this child so far. The parent appends
 *  one line per delivery; a child that asked at count N is still waiting for as
 *  long as the count is N. */
function answerCount() {
	if (!answersPath) return 0;
	try {
		return fs.readFileSync(answersPath, "utf-8").split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

/** The count at the moment of the last unanswered question, or undefined when
 *  nothing is outstanding. */
let askedAt;

// Ordered deliberately: what to use it FOR comes first, what not to use it for
// comes last. A tool introduced by its restrictions is a tool a smaller model
// never reaches for — the lesson `test/eval-ping.ts` measured on the pi side
// (1/6 → 5/6), and the whole of this tool's prompt surface is this string:
// MCP has no equivalent of pi's `promptGuidelines`, so everything the child is
// told about asking is here and in the delegation note appended to its system
// prompt.
const TOOL = {
	name: "caller_ping",
	description: [
		"Ask the agent that dispatched you a question, and pause until it answers.",
		"Use it when the brief is ambiguous, when a choice would materially change what you produce, or when you need something only your caller has — prefer asking over guessing.",
		"Prefer it over guessing whenever the brief leaves open something that changes what you produce: which of several valid approaches to take, a value or path you were not given, or whether to take a step that cannot be undone.",
		"Use it when more than one answer is defensible and the right one depends on what your caller intended — that is a decision to hand back, not one to make on their behalf.",
		"Your session pauses rather than ends: everything you have done is kept, the answer arrives as your next message, and you carry on from there.",
		"Give the question enough context to be answered on its own — your caller sees the question, not your conversation — and name the options you are choosing between.",
		"One question per call, and after calling it stop: end your turn without another tool call and without assuming an answer.",
		"Do not use it for progress reports, to confirm something you could establish by reading, or to ask what the brief already answers.",
	].join(" "),
	inputSchema: {
		type: "object",
		properties: {
			question: {
				type: "string",
				description: "What you need to know, self-contained. Include the options you are weighing and what you will do with the answer.",
			},
		},
		required: ["question"],
		additionalProperties: false,
	},
};

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });

function callTool(id, params) {
	const question = typeof params?.arguments?.question === "string" ? params.arguments.question.trim() : "";
	if (!question) {
		return ok(id, { isError: true, content: [{ type: "text", text: "caller_ping requires a question." }] });
	}
	if (askedAt !== undefined && askedAt === answerCount()) {
		return ok(id, {
			isError: true,
			content: [{ type: "text", text: "You have already asked your caller a question and are still waiting on it; it answers one at a time. Stop here." }],
		});
	}
	askedAt = answerCount();
	ok(id, {
		content: [{
			type: "text",
			text: "Question sent to your caller. Stop now: end your turn without calling another tool and without guessing an answer. Your session stays open and the answer arrives as your next message.",
		}],
	});
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return; // not ours to complain about
	}
	// Notifications carry no id and want no reply.
	if (request.id === undefined) return;

	switch (request.method) {
		case "initialize":
			return ok(request.id, {
				// Echo the host's protocol version: this server uses nothing
				// version-specific, so whatever the host speaks is what it gets.
				protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "pi-subagents-caller", version: "1" },
			});
		case "tools/list":
			return ok(request.id, { tools: [TOOL] });
		case "tools/call":
			if (request.params?.name !== TOOL.name) {
				return send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: `unknown tool ${request.params?.name}` } });
			}
			return callTool(request.id, request.params);
		default:
			return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
	}
});
