// Explicit opt-in: launches N real Pi children and incurs model usage. Read-only.
//
//   PI_TEST_MODEL=provider/model-id [EVAL_N=5] [EVAL_AGENT=scout] [EVAL_TASK=…] \
//     npx tsx test/eval-ping.ts
//
// Measures the one thing about `caller_ping` that argument cannot settle: how
// often a child actually reaches for it. The task below is underdetermined in a
// way the child cannot resolve by reading — and, deliberately, never tells it to
// ask. A child that pings has noticed; a child that does not has guessed.
//
// Prompt wording is the whole lever here, so treat this as an A/B harness rather
// than a pass/fail test: run it, change the surface, run it again. Small N on a
// small model is a direction, not a statistic.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildPiArgs, DEFAULT_INHERIT, type AgentConfig } from "../index.ts";

const model = process.env.PI_TEST_MODEL;
if (!model?.includes("/")) throw new Error("Set PI_TEST_MODEL=provider/model (uses real credentials)");
const N = Number(process.env.EVAL_N ?? 5);
const AGENT = process.env.EVAL_AGENT ?? "scout";
const TASK = process.env.EVAL_TASK
  ?? "Add a one-line license header to the top of index.ts, using this project's license. "
  + "Report the exact line you would add.";

// The agent definition is read from the repo's own agents/ directory, so the
// eval measures the system prompt a real dispatch would use.
const file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agents", `${AGENT}.md`);
const raw = fs.readFileSync(file, "utf-8");
const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
const tools = (/^tools:\s*(.+)$/m.exec(raw)?.[1] ?? "read, grep, find, ls").split(",").map((t) => t.trim());
const agent: AgentConfig = { name: AGENT, description: "", tools, model, thinking: "low", systemPrompt: body, filePath: file };

/** One child, run until it asks or finishes. Returns its question, or its answer. */
async function run(): Promise<{ pinged: boolean; text: string }> {
  const { args, tempDir, childEnv, rpcPrompt } = await buildPiArgs(agent, TASK, process.cwd(), DEFAULT_INHERIT);
  try {
    let question = "", text = "", buf = "";
    await new Promise<void>((resolve) => {
      const proc = spawn(args[0], args.slice(1), { cwd: process.cwd(), env: childEnv, stdio: ["pipe", "pipe", "ignore"] });
      proc.stdin?.on("error", () => {});
      const done = () => { proc.kill(); resolve(); };
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === "tool_execution_start" && evt.toolName === "caller_ping") question = String(evt.args?.question ?? "");
          if (evt.type === "message_end" && evt.message?.role === "assistant") {
            const said = (evt.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            if (said) text = said;
          }
          // A child that asked is parked and will sit there indefinitely: the
          // measurement is over the moment it does, answered or not.
          if (evt.type === "agent_settled" && question) done();
        }
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
      proc.stdin?.write(JSON.stringify({ type: "prompt", message: rpcPrompt }) + "\n");
    });
    return question ? { pinged: true, text: question } : { pinged: false, text };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

let pinged = 0;
for (let i = 1; i <= N; i++) {
  const r = await run();
  if (r.pinged) pinged++;
  console.log(`run ${i}: ${r.pinged ? "PINGED" : "guessed"} — ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
}
console.log(`\n${AGENT}: ${pinged}/${N} asked (${Math.round((pinged / N) * 100)}%) — model=${model}`);
