import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { interactiveArgs, shellQuote } from "../herdr/transport.ts";

test("interactive transport removes JSON/print mode and keeps task bytes", () => {
  const task = "Task: 'quotes' !bang $HOME\n中文";
  const args = interactiveArgs(["--mode", "json", "-p", "--session", "/tmp/run/session.jsonl", "--no-extensions", "--model", "provider/model", task]);
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("json"), false);
  assert.ok(args[1].endsWith("/herdr/child.ts"));
  assert.ok(args.includes("--no-extensions"));
  assert.equal(args.at(-1), task);
});

test("runner arguments are shell-quoted, including apostrophes and metacharacters", () => {
  const value = "a' b;$(echo injected)!\n中文";
  assert.equal(execFileSync("bash", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
});
