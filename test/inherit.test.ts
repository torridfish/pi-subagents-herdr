import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Seeded before the extension module is imported: the discovered-tool set is
// read from the environment at module load, the way a real child process gets it.
process.env.PI_SUBAGENT_DISCOVERED_TOOLS = "subagent";

const { buildPiArgs, DEFAULT_INHERIT } = await import("../index.ts");

const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAFE_BASH = path.join(EXT_DIR, "tools", "safe-bash.ts");

async function build(tools: string[], inherit = DEFAULT_INHERIT) {
  const agent = { name: "probe", description: "", tools, model: "test/model", thinking: "medium", systemPrompt: "", filePath: "" };
  const { args, tempDir } = await buildPiArgs(agent, "task", process.cwd(), inherit);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return args;
}

test("children inherit the user's extensions by default and can be isolated on request", async () => {
  assert.ok(!(await build(["read"])).includes("--no-extensions"));
  assert.ok((await build(["read"], { ...DEFAULT_INHERIT, extensions: false })).includes("--no-extensions"));

  // Skills stay off by default: the allowlist filters any tool they register.
  assert.ok((await build(["read"])).includes("--no-skills"));
  assert.ok(!(await build(["read"], { ...DEFAULT_INHERIT, skills: true })).includes("--no-skills"));
});

test("inheriting extensions does not widen the tool allowlist", async () => {
  const args = await build(["read", "grep"]);
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep"]);
});

test("a tool the child rediscovers is not also passed with --extension", async () => {
  // Every child is handed the child extension, whatever its tools are; the
  // counts below are "one for the bridge, plus one per tool we must supply".
  const CHILD = path.join(EXT_DIR, "herdr", "child.ts");
  assert.deepEqual((await build(["read"])).filter((a) => a === "--extension").length, 1);
  assert.ok((await build(["read"])).includes(CHILD));

  // `subagent` was seeded as discovered; safe_bash ships in this repo and is not.
  const inherited = await build(["subagent", "safe_bash"]);
  assert.equal(inherited.filter((a) => a === "--extension").length, 2);
  assert.ok(inherited.includes(SAFE_BASH));
  assert.ok(!inherited.includes(path.join(EXT_DIR, "index.ts")));

  // Without discovery in the child, every declared tool must be handed over.
  const isolated = await build(["subagent", "safe_bash"], { ...DEFAULT_INHERIT, extensions: false });
  assert.equal(isolated.filter((a) => a === "--extension").length, 3);
  assert.ok(isolated.includes(path.join(EXT_DIR, "index.ts")));
});
