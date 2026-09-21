import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { herdrBin, interactiveArgs, shellQuote } from "../herdr/transport.ts";

test("interactive transport removes JSON/print mode and keeps task bytes", () => {
  const task = "Task: 'quotes' !bang $HOME\n中文";
  const args = interactiveArgs(["--mode", "json", "-p", "--session", "/tmp/run/session.jsonl",
    "--no-extensions", "--extension", "/pkg/herdr/child.ts", "--model", "provider/model", task]);
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("json"), false);
  assert.ok(args.includes("--no-extensions"));
  // The child extension comes from `buildPiArgs` now; the pane rewrite only
  // strips print mode, and must pass every other option through untouched.
  assert.equal(args.filter((a) => a === "/pkg/herdr/child.ts").length, 1);
  assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), ["--session", "/tmp/run/session.jsonl"]);
  assert.equal(args.at(-1), task);
});

test("runner arguments are shell-quoted, including apostrophes and metacharacters", () => {
  const value = "a' b;$(echo injected)!\n中文";
  assert.equal(execFileSync("bash", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
});

test("a herdr upgraded out from under its server is still reachable", () => {
  const saved = process.env.HERDR_BIN_PATH;
  // A real executable to point at, so the "it is actually there" branch is
  // exercised against the filesystem rather than against a stub.
  const real = process.execPath;
  assert.ok(existsSync(real));
  try {
    // Linux appends this to /proc/self/exe once the running binary has been
    // replaced; herdr reads its own exe to fill HERDR_BIN_PATH, so a server
    // that lived across an upgrade hands the suffixed string to every pane.
    process.env.HERDR_BIN_PATH = `${real} (deleted)`;
    assert.equal(herdrBin(), real, "the deleted-marker path was not recovered");

    // Suffix stripped but the path is genuinely gone: PATH still resolves to
    // the new build, because an upgrade replaces the same path.
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr (deleted)";
    assert.equal(herdrBin(), "herdr");
    process.env.HERDR_BIN_PATH = "/nonexistent/herdr";
    assert.equal(herdrBin(), "herdr");

    // An ordinary, intact override is still honoured — the point is to survive
    // an upgrade, not to stop believing the environment.
    process.env.HERDR_BIN_PATH = real;
    assert.equal(herdrBin(), real);

    for (const empty of ["", "   "]) {
      process.env.HERDR_BIN_PATH = empty;
      assert.equal(herdrBin(), "herdr");
    }
    delete process.env.HERDR_BIN_PATH;
    assert.equal(herdrBin(), "herdr");
  } finally {
    if (saved === undefined) delete process.env.HERDR_BIN_PATH;
    else process.env.HERDR_BIN_PATH = saved;
  }
});
