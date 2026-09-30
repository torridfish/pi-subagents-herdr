import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptSurface, type AgentConfig } from "../index.ts";

const agent = (name: string, description: string, tools: string[]): AgentConfig =>
  ({ name, description, tools, model: "", thinking: "medium", systemPrompt: "", filePath: "" });

const SCOUT = agent("scout", "Fast codebase recon", ["read", "grep"]);
const WORKER = agent("worker", "General-purpose worker", ["read", "write"]);

test("the roster the model sees is the registry it can actually dispatch", () => {
  const { snippet, description } = buildPromptSurface([SCOUT, WORKER]);
  for (const a of [SCOUT, WORKER]) {
    assert.ok(snippet.includes(a.name), `snippet omits ${a.name}`);
    assert.ok(description.includes(`- ${a.name}: ${a.description} (tools: ${a.tools.join(", ")})`), `roster omits ${a.name}`);
  }
});

test("a filtered registry leaks no agent the process cannot reach", () => {
  // A child launched with PI_SUBAGENT_ALLOWED sees a filtered registry; the
  // point of that filter is that the name is not even in its prompt.
  const { snippet, description, guidelines } = buildPromptSurface([SCOUT]);
  const text = [snippet, description, ...guidelines].join("\n");
  assert.ok(text.includes("scout"));
  assert.ok(!text.includes("worker"), "a filtered-out agent appeared in the prompt");
  assert.ok(!text.includes("researcher"));
});

test("per-agent triggers are emitted only for agents that exist", () => {
  // Structural rather than string-matched, so rewording a trigger does not
  // silently turn this into a test of nothing.
  const none = buildPromptSurface([]).guidelines;
  const scoutOnly = buildPromptSurface([SCOUT]).guidelines;
  const both = buildPromptSurface([SCOUT, WORKER]).guidelines;
  assert.ok(scoutOnly.length > none.length);
  assert.ok(both.length > scoutOnly.length);
  assert.ok(scoutOnly.some((g) => g.includes("scout")));
  assert.ok(!scoutOnly.some((g) => g.includes("worker")));

  // An agent with no canned trigger still appears in the roster, just without one.
  const custom = buildPromptSurface([agent("auditor", "Third-party agent", ["read"])]);
  assert.ok(custom.description.includes("- auditor: Third-party agent"));
  assert.deepEqual(custom.guidelines, none);
});

test("guidelines lead with when to delegate, not with when not to", () => {
  const generic = buildPromptSurface([]).guidelines;
  const { guidelines } = buildPromptSurface([SCOUT, WORKER]);
  // The old surface opened on "Don't use subagents to parallelize simple I/O",
  // which was the first thing the model read about the tool. The per-agent
  // triggers must come before any of the generic hold-back bullets.
  assert.ok(guidelines[0].includes("scout") || guidelines[0].includes("worker"), `leads with: ${guidelines[0]}`);
  assert.ok(!generic.includes(guidelines[0]));
  assert.ok(guidelines.some((g) => /Do the work yourself/.test(g)), "the anti-pattern bullets should still be there");
  assert.ok(guidelines.some((g) => /run concurrently/.test(g)));
});

// Each of these was a real dispatch that went wrong, in a real session. The
// surface is the only place the parent is told any of it, so the bullets are
// pinned by what they are for rather than by their wording.
test("the surface answers the four ways a dispatch has actually gone wrong", () => {
  const { description, guidelines } = buildPromptSurface([SCOUT]);
  const text = [description, ...guidelines].join("\n");
  // The user asked for one runner by name and the retry dropped it.
  assert.ok(guidelines.some((g) => /names a runner/.test(g)), "nothing tells the parent to pass `runner`");
  assert.ok(guidelines.some((g) => /never re-send with `runner` dropped/.test(g)));
  // A Chinese request went out as an English brief and came back in English.
  assert.ok(guidelines.some((g) => /language the conversation is in/.test(g)));
  // Two children were given the same question 21 seconds apart.
  assert.ok(guidelines.some((g) => /already made is still running/.test(g)));
  assert.match(text, /does not improve the first/);
  // The parent invented a context for a term it could not place.
  assert.ok(guidelines.some((g) => /Ask the user before dispatching/.test(g)));
});

test("an empty registry degrades instead of promising agents that do not exist", () => {
  const { snippet, description, guidelines } = buildPromptSurface([]);
  assert.ok(description.includes("(none registered)"));
  assert.ok(!snippet.includes("("), `snippet should not carry an empty list: ${snippet}`);
  assert.ok(guidelines.every((g) => !/\b(scout|researcher|worker)\b/.test(g)));
});

// The model story has to match what `execute` resolves, or the model would be
// told a fallback that is not the one it actually lands on when it omits
// `model`.
test("the model note names the configured default when the config pins one", () => {
  const pinned = buildPromptSurface([SCOUT], { defaultModel: "claude-code/claude-opus-5-5" });
  assert.match(pinned.description, /configured model by default/);
  assert.match(pinned.description, /claude-code\/claude-opus-5-5/);
  const unpinned = buildPromptSurface([SCOUT]);
  assert.match(unpinned.description, /the caller's own model when nothing is configured/);
  assert.ok(!unpinned.description.includes("claude-code/"), "an invented default leaked into the unpinned surface");
});

test("the model note and its guideline survive a filtered registry", () => {
  // The wording must not name an agent that a filtered child cannot reach —
  // the "run the worker on glm" phrasing leaked `worker` into a scout-only
  // surface. The rule itself, though, is generic and must still be there.
  const { description, guidelines } = buildPromptSurface([SCOUT], { defaultModel: "opencode-go/glm-5.3-flash" });
  assert.match(description, /explicitly pairs a model with a role/);
  assert.ok(guidelines.some((g) => /Pass `model` only when the user explicitly asks/.test(g)));
});
