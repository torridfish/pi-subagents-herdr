import { test } from "node:test";
import assert from "node:assert/strict";

// Pinned before the extension loads: see async-dispatch.test.ts.
process.env.PI_SUBAGENT_BACKEND = "process";
import type { AgentResult } from "../index.ts";
const { default: extension } = await import("../index.ts");

// Colour is not what can break in a renderer; width arithmetic and which
// ground a block lands on are. The stub keeps both readable: a foreground tag
// is dropped, a background tag is left in front of the line it painted.
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => `«${color}»${text}`,
  bold: (text: string) => text,
};
/** The line as the terminal would show it, with the background tag removed. */
const bare = (line: string) => line.replace(/^«\w+»/, "");
/** Which ground a line was painted on, or undefined for an unpainted one. */
const ground = (line: string) => /^«(\w+)»/.exec(line)?.[1];

const renderers = new Map<string, any>();
extension({
  registerTool() {}, registerCommand() {}, on() {}, getAllTools: () => [],
  registerMessageRenderer: (type: string, fn: any) => renderers.set(type, fn),
  sendMessage() {},
} as any);

const finished = (output: string): AgentResult => ({
  agent: "researcher", task: "find things", output, exitCode: 0,
  usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 3 },
  progress: { agent: "researcher", status: "completed", task: "find things", recentTools: [
    { tool: "web_search", args: "\"herdr panes\"", toolCallId: "a", status: "done" },
  ], toolCount: 1, tokens: 4000, durationMs: 62000, lastMessage: "Checked three sources." },
});

const paint = (message: any, expanded: boolean, width = 100): string[] =>
  renderers.get(message.customType)(message, { expanded }, theme).render(width);

test("a finished subagent's report is drawn as a tool block, named, and readable without expanding", () => {
  const report = Array.from({ length: 18 }, (_, i) => `line ${i + 1} of the report`).join("\n");
  const message = { customType: "subagent_result", details: { results: [finished(report)], handle: "researcher-2" } };
  const lines = paint(message, false);

  // The block is the seam between what a subagent said and what the main agent
  // says: without it the report reads as the parent's own prose. It is the
  // shell pi puts around a tool call — a blank line, then a padded box painted
  // edge to edge — so the reader already knows how to take it.
  assert.equal(lines[0], "", "no separating blank line before the block");
  for (const line of lines.slice(1)) {
    assert.equal(ground(line), "toolSuccessBg", `unpainted line: ${JSON.stringify(line)}`);
    assert.equal(bare(line).length, 100, `ragged line: ${JSON.stringify(line)}`);
  }
  // Titled with the handle, because that is what `subagent_message` addresses.
  assert.match(bare(lines[2]), /^ subagent researcher-2 +$/);

  // The answer is the point of the block, so it is in the collapsed view too —
  // its head, with an honest count of what was left out.
  const body = lines.join("\n");
  assert.match(body, /line 1 of the report/);
  assert.match(body, /line 8 of the report/);
  assert.equal(/line 9 of the report/.test(body), false, "the collapsed view dumped the whole report");
  assert.match(body, /… 10 more lines — ctrl\+o/);

  // Expanding gives the rest, still in the block.
  const full = paint(message, true);
  assert.match(full.join("\n"), /line 18 of the report/);
  assert.equal(ground(full.at(-1)!), "toolSuccessBg");
});

test("a short report needs no truncation hint, and a narrow terminal keeps the content", () => {
  const message = { customType: "subagent_result", details: { results: [finished("All three sources agree.")], handle: "researcher-2" } };
  assert.equal(/more lines/.test(paint(message, false).join("\n")), false);

  const narrow = paint(message, false, 20);
  assert.match(narrow.join("\n"), /researcher/);
  for (const line of narrow.slice(1)) assert.equal(bare(line).length, 20, `ragged line: ${JSON.stringify(line)}`);
});

test("prose that matters wraps rather than being cut off at the margin", () => {
  // A tool-log line reads fine truncated. Half a sentence of the report, or
  // half the question, does not — and the collapsed view is where most of them
  // are read.
  const long = "The migration has to drop the legacy column before the backfill runs, otherwise the backfill reads a column that the new writer has already stopped maintaining.";
  const message = { customType: "subagent_result", details: { results: [finished(long)], handle: "researcher-2" } };
  const body = paint(message, false, 60).join("\n");
  assert.equal(/…\s*$/m.test(body.replace(/… \d+ more.*/g, "")), false, `report was truncated:\n${body}`);
  assert.match(body, /already stopped maintaining\./);
});

test("the ground says what became of the run", () => {
  // Same three backgrounds, same meanings, as every other tool call in the
  // transcript: a child waiting on an answer has not failed, and a child that
  // failed should not look like one that succeeded.
  const waiting = finished("");
  waiting.progress.status = "waiting";
  waiting.exitCode = -1;
  waiting.question = "Postgres or SQLite?";
  const asked = paint({ customType: "subagent_question", details: { results: [waiting], handle: "scout-1" } }, false);
  assert.equal(ground(asked[1]), "toolPendingBg");
  assert.match(bare(asked[2]), /^ subagent scout-1 /);
  assert.match(asked.join("\n"), /Asks: Postgres or SQLite\?/);

  const failed = finished("");
  failed.exitCode = 1;
  failed.progress.error = "pi exited 1";
  const died = paint({ customType: "subagent_result", details: { results: [failed], handle: "scout-1" } }, false);
  assert.equal(ground(died[1]), "toolErrorBg");
});
