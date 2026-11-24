import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const BUILDER = path.resolve(import.meta.dirname, "../plugins/opencode/scripts/build-adversarial-prompt.mjs");

let repo;
let out;

function git(...args) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

function build(...args) {
  const stdout = execFileSync("node", [BUILDER, "--out", out, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" },
  });
  return JSON.parse(stdout);
}

beforeEach(() => {
  repo = createTmpDir("adv-prompt");
  out = path.join(repo, ".git", "prompt.md");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  cleanupTmpDir(repo);
});

describe("build-adversarial-prompt", () => {
  it("reports empty when there is nothing to review", () => {
    const summary = build("--scope", "working-tree");
    assert.equal(summary.empty, true);
  });

  it("auto prefers the branch diff over stray untracked files", () => {
    git("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    git("commit", "-q", "-am", "change");
    fs.writeFileSync(path.join(repo, "scratch.log"), "noise\n");
    const summary = build("focus", "text");
    assert.equal(summary.target, "branch diff main...HEAD");
    assert.equal(summary.focus, "focus text");
    const prompt = fs.readFileSync(out, "utf8");
    assert.match(prompt, /^\+two$/m);
    assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  });

  it("auto uses the working tree when tracked files changed", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    const summary = build("--model", "p/m");
    assert.match(summary.target, /^working tree/);
    assert.equal(summary.focus, null);
  });

  it("drops oversized diffs per file and stays under the prompt cap", () => {
    fs.writeFileSync(path.join(repo, "big.txt"), `${"x".repeat(200)}\n`.repeat(1000));
    fs.writeFileSync(path.join(repo, "a.txt"), "small change\n");
    git("add", ".");
    const summary = build("--scope", "working-tree");
    assert.deepEqual(summary.omittedFiles, ["big.txt"]);
    assert.equal(summary.inlineFiles, 1);
    assert.ok(summary.bytes <= 100 * 1024);
  });

  it("rejects unsupported scopes", () => {
    assert.throws(() => build("--scope", "staged"));
  });
});
