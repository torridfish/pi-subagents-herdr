// Runs in the new pane, not in the parent. No task text is interpolated into a shell.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const directory = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(directory, "launch.json"), "utf8"));
const env = { ...spec.env };
// Herdr context belongs to the actual child pane, never the parent's snapshot.
for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
for (const [key, value] of Object.entries(process.env)) if (key.startsWith("HERDR_")) env[key] = value;
env.PI_SUBAGENT_RUN_DIR = directory;
// Pane children report their events through a sidecar journal; process-backend
// children are read from stdout and must not write one.
env.PI_SUBAGENT_BRIDGE = "1";
for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
// A pi child owns the pane's terminal and writes the journal itself, through
// the extension it loads.
const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd, env,
  stdio: "inherit",
});
let finished = false, terminating = false, killer, stoppedBy;
// Why this child was put down, which the parent cannot work out for itself:
// `cancel` is the parent asking, a stale heartbeat is the parent having gone
// away without asking, and a signal is somebody at this pane or the machine
// shutting down. Only the first two are distinguishable to whoever reads the
// result, and they are different news.
function stop(reason) {
  if (finished || terminating) return;
  terminating = true;
  stoppedBy = reason;
  child.kill("SIGTERM");
  killer = setTimeout(() => { if (!finished) child.kill("SIGKILL"); }, 3000);
}
const watcher = setInterval(() => {
  try {
    if (fs.existsSync(path.join(directory, "cancel"))) return stop("cancelled");
    if (Date.now() - fs.statSync(path.join(directory, "heartbeat")).mtimeMs > 20000) return stop("parent");
  } catch { stop("parent"); }
}, 500);
function finish(code, error) {
  if (finished) return;
  finished = true;
  clearInterval(watcher); clearTimeout(killer);
  const target = path.join(directory, "exit.json");
  fs.writeFileSync(target + ".tmp", JSON.stringify({ code, error, stop: stoppedBy }), { mode: 0o600 });
  fs.renameSync(target + ".tmp", target);
  process.exitCode = code;
}
child.on("error", error => finish(1, error.message));
child.on("close", code => finish(terminating ? 130 : (code ?? 1)));
process.on("SIGTERM", () => stop("signal"));
process.on("SIGHUP", () => stop("signal"));
process.on("SIGINT", () => stop("signal"));
