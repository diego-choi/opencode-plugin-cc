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

describe("build-adversarial-prompt edge cases", () => {
  it("rejects --base combined with --scope working-tree and unknown flags", () => {
    assert.throws(() => build("--base", "main", "--scope", "working-tree"));
    assert.throws(() => build("--bsae", "main"));
  });

  it("lists untracked files from the repo root even when run in a subdirectory", () => {
    fs.mkdirSync(path.join(repo, "sub"));
    fs.writeFileSync(path.join(repo, "top.txt"), "new\n");
    fs.writeFileSync(path.join(repo, "sub", "inner.txt"), "new\n");
    const stdout = execFileSync("node", [BUILDER, "--out", out, "--scope", "working-tree"], {
      cwd: path.join(repo, "sub"),
      encoding: "utf8",
    });
    assert.equal(JSON.parse(stdout).untrackedFiles, 2);
    const prompt = fs.readFileSync(out, "utf8");
    assert.match(prompt, /^top\.txt$/m);
    assert.match(prompt, /^sub\/inner\.txt$/m);
  });

  it("keeps non-ASCII paths readable and marks omitted deleted files", () => {
    fs.writeFileSync(path.join(repo, "한글.txt"), `${"y".repeat(200)}\n`.repeat(1000));
    git("add", ".");
    git("commit", "-q", "-m", "add big");
    git("rm", "-q", "한글.txt");
    const summary = build("--scope", "working-tree");
    assert.deepEqual(summary.omittedFiles, ["한글.txt"]);
    assert.deepEqual(summary.deletedOmitted, ["한글.txt"]);
    assert.equal(summary.coverage, "partial");
    const prompt = fs.readFileSync(out, "utf8");
    assert.match(prompt, /한글\.txt \(deleted; its old content is not available to you\)/);
    assert.match(prompt, /Coverage is PARTIAL/);
  });

  it("treats an untracked list over the cap as partial coverage", () => {
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(repo, `n${i}.txt`), "x\n");
    const summary = build("--scope", "working-tree");
    assert.equal(summary.untrackedDropped, 5);
    assert.equal(summary.coverage, "partial");
  });
});
