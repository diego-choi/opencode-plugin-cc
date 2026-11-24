#!/usr/bin/env node

// Builds the prompt for /opencode:adversarial-review (local fork addition).
//
// Upstream removed the adversarial-review subcommand (f012f68) and points
// custom reviews at `/opencode:delegate --agent plan`. That read-only task
// session denies shell, so OpenCode cannot run `git diff` itself. This helper
// collects the diff locally, fills prompts/adversarial-review.md, and writes the
// prompt to a file. The command then dispatches it with `task --agent plan`.
//
// Usage:
//   node build-adversarial-prompt.mjs --out <file> [--base <ref>]
//     [--scope auto|working-tree|branch] [focus text ...]
//
// Prints a one-line JSON summary to stdout.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");

// The prompt travels as a single argv entry (task -> task-worker) and is stored
// in job state, so keep it well below ARG_MAX (~1 MiB on macOS).
const INLINE_BYTE_LIMIT = 200 * 1024;
const SCOPES = new Set(["auto", "working-tree", "branch"]);

function parse(argv) {
  const opts = { scope: "auto" };
  const focus = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--base" || arg === "--scope") {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts[arg.slice(2)] = argv[++i];
    } else if (arg === "--model") {
      // Routing flag for the companion `task` call, not part of the prompt.
      i++;
    } else if (arg === "--wait" || arg === "--background") {
      // Execution-mode flags belong to the command, not the prompt.
    } else {
      focus.push(arg);
    }
  }
  if (!opts.out) throw new Error("--out <file> is required");
  if (!SCOPES.has(opts.scope)) {
    throw new Error(`Unsupported scope "${opts.scope}". Use auto, working-tree, or branch.`);
  }
  opts.focus = focus.join(" ").trim();
  return opts;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return "";
  }
}

function detectBase() {
  const originHead = tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", candidate])) return candidate;
  }
  throw new Error("Unable to detect the review base. Pass --base <ref> or use --scope working-tree.");
}

function resolveTarget(opts) {
  if (opts.base) return { kind: "branch", base: opts.base };
  if (opts.scope === "working-tree") return { kind: "working" };
  if (opts.scope === "auto" && tryGit(["status", "--porcelain", "--untracked-files=all"])) {
    return { kind: "working" };
  }
  return { kind: "branch", base: detectBase() };
}

// Split a unified diff into per-file chunks so the byte budget drops whole files.
function splitDiff(diff) {
  const chunks = [];
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.trim()) continue;
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    chunks.push({ file: m ? m[2] : "(unknown)", patch: part.trimEnd() });
  }
  return chunks;
}

function main() {
  const opts = parse(process.argv.slice(2));
  const target = resolveTarget(opts);

  let label;
  let diff;
  let stat;
  let untracked = [];
  if (target.kind === "working") {
    label = "working tree changes (staged + unstaged + untracked, against HEAD)";
    const hasHead = Boolean(tryGit(["rev-parse", "--verify", "--quiet", "HEAD"]));
    const range = hasHead ? ["HEAD"] : ["--cached"];
    diff = git(["diff", "--no-color", "--no-ext-diff", ...range]);
    stat = git(["diff", "--stat", ...range]).trim();
    untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  } else {
    const range = `${target.base}...HEAD`;
    label = `branch diff ${range}`;
    diff = git(["diff", "--no-color", "--no-ext-diff", range]);
    stat = git(["diff", "--stat", range]).trim();
  }

  const chunks = splitDiff(diff);
  if (chunks.length === 0 && untracked.length === 0) {
    console.log(JSON.stringify({ empty: true, target: label }));
    return;
  }

  const included = [];
  const omitted = [];
  let used = 0;
  for (const chunk of chunks) {
    const size = Buffer.byteLength(chunk.patch, "utf8");
    if (used + size <= INLINE_BYTE_LIMIT) {
      included.push(chunk);
      used += size;
    } else {
      omitted.push(chunk.file);
    }
  }

  const sections = [`## Changed files (git diff --stat)\n\n${stat || "(none)"}`];
  if (untracked.length) {
    sections.push(`## Untracked files (new, not in the diff; read them with your read tool)\n\n${untracked.join("\n")}`);
  }
  if (omitted.length) {
    sections.push(`## Diff omitted for size (read the current files; you cannot see what changed)\n\n${omitted.join("\n")}`);
  }
  sections.push(`## Diff\n\n${included.map((c) => c.patch).join("\n\n") || "(none inline)"}`);

  const guidance = [
    "You cannot run shell or git commands in this session; read, glob, and grep are available.",
    "Use the diff below as primary evidence and read surrounding code in the workspace to confirm each finding.",
    omitted.length || untracked.length
      ? "Some changes are not shown as a diff (listed below). Read those files in full before concluding, and say in the summary that those files were reviewed without a diff."
      : "",
  ].filter(Boolean).join("\n");

  const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const vars = {
    TARGET_LABEL: label,
    USER_FOCUS: opts.focus || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: guidance,
    REVIEW_INPUT: sections.join("\n\n"),
  };
  // Single pass: substituted values (diff text) are never re-scanned for placeholders.
  const prompt = template.replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : all
  ));

  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, prompt);
  console.log(JSON.stringify({
    empty: false,
    target: label,
    out: path.resolve(opts.out),
    bytes: Buffer.byteLength(prompt, "utf8"),
    inlineFiles: included.length,
    omittedFiles: omitted,
    untrackedFiles: untracked.length,
    focus: opts.focus || null,
  }));
}

try {
  main();
} catch (err) {
  console.error(`build-adversarial-prompt: ${err.message}`);
  process.exit(1);
}
