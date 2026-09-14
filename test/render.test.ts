import { test } from "node:test";
import assert from "node:assert/strict";

// Pinned before the extension loads: see async-dispatch.test.ts.
process.env.PI_SUBAGENT_BACKEND = "process";
import type { AgentResult } from "../index.ts";
const { default: extension } = await import("../index.ts");

// Colour is not what can break in a renderer; width arithmetic is. The stub
// keeps the tag so a test can still assert *which* colour a line was given.
const theme = {
  fg: (color: string, text: string) => (color === "borderMuted" ? text : text),
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
};

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

test("a finished subagent's report is framed, named, and readable without expanding", () => {
  const report = Array.from({ length: 18 }, (_, i) => `line ${i + 1} of the report`).join("\n");
  const message = { customType: "subagent_result", details: { results: [finished(report)], handle: "researcher-2" } };
  const lines = paint(message, false);

  // The frame is the seam between what a subagent said and what the main agent
  // says: without it the report reads as the parent's own prose.
  assert.match(lines[0], /^╭─ researcher-2 · researcher ─+$/);
  assert.match(lines.at(-1)!, /^╰─+$/);
  for (const line of lines.slice(1, -1)) assert.match(line, /^│ /, `unframed line: ${JSON.stringify(line)}`);
  assert.equal(lines[0].length, 100);

  // The answer is the point of the block, so it is in the collapsed view too —
  // its head, with an honest count of what was left out.
  const body = lines.join("\n");
  assert.match(body, /line 1 of the report/);
  assert.match(body, /line 8 of the report/);
  assert.equal(/line 9 of the report/.test(body), false, "the collapsed view dumped the whole report");
  assert.match(body, /… 10 more lines — ctrl\+o/);

  // Expanding gives the rest, still framed.
  const full = paint(message, true).join("\n");
  assert.match(full, /line 18 of the report/);
  assert.match(full, /^╭─ researcher-2/);
});

test("a short report needs no truncation hint, and a narrow terminal keeps the content", () => {
  const message = { customType: "subagent_result", details: { results: [finished("All three sources agree.")], handle: "researcher-2" } };
  assert.equal(/more lines/.test(paint(message, false).join("\n")), false);

  // Below the frame's own width the content wins: a border that wraps is worse
  // than no border at all.
  const narrow = paint(message, false, 20);
  assert.equal(narrow.some((l) => l.startsWith("╭")), false);
  assert.match(narrow.join("\n"), /researcher/);
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

test("a waiting subagent's question is framed the same way", () => {
  const waiting = finished("");
  waiting.progress.status = "waiting";
  waiting.exitCode = -1;
  waiting.question = "Postgres or SQLite?";
  const lines = paint({ customType: "subagent_question", details: { results: [waiting], handle: "scout-1" } }, false);
  assert.match(lines[0], /^╭─ scout-1 · researcher ─+$/);
  assert.match(lines.join("\n"), /Asks: Postgres or SQLite\?/);
});
