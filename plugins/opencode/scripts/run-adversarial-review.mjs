#!/usr/bin/env node

// Non-interactive entry point for an OpenCode adversarial review (local fork
// addition). Builds the prompt, dispatches a read-only `task --agent plan`,
// waits, and validates the output contract. Meant for scripts and other
// skills (e.g. a multi-model review) as well as /opencode:adversarial-review.
//
// Usage:
//   node run-adversarial-review.mjs [--base <ref> | --scope auto|working-tree|branch]
//     [--model <provider/model>] [--timeout <seconds>] [--meta <file>]
//     [--task <task-id>] [--] [focus text ...]
//
//   --task resumes waiting on an already dispatched job (e.g. after exit 2).
//
// stdout: the review Markdown (starting at "# OpenCode Adversarial Review") on
//         exit 0 and 3; nothing otherwise.
// stderr: progress and errors.
// --meta: JSON written on every exit: { exitCode, status, taskId, target,
//         coverage, verdict, findings[], errors[], warnings[], ... }.
//
// Exit codes:
//   0  review completed and the output matches the contract
//   1  dispatch or job failure (failed/cancelled job, worker died, bad args)
//   2  timed out waiting; the job may still be running (resume with --task)
//   3  job completed but the output violates the contract (raw output on stdout)
//   4  nothing to review for the selected target

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPrompt, parseReviewArgs } from "./build-adversarial-prompt.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "opencode-companion.mjs");
export const MARKER = "# OpenCode Adversarial Review";
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const DEFAULT_TIMEOUT_S = 1800;
const WAIT_ROUND_S = 30;
// A worker that has not recorded an OpenCode session after this long and whose
// process is gone will never finish.
const WORKER_GRACE_MS = 20_000;

/**
 * Validate and parse the review Markdown against the prompt's output contract.
 * @param {string} text raw assistant output
 * @returns {{ ok: boolean, errors: string[], markdown: string, verdict?: string,
 *   coverage?: string, findings: Array<{ title: string, severity?: string,
 *   location?: string, file?: string, line?: number, lineEnd?: number, confidence?: number }> }}
 */
export function parseReviewOutput(text) {
  const errors = [];
  const raw = (text ?? "").replace(/\r\n/g, "\n");
  const start = raw.search(/^# OpenCode Adversarial Review[ \t]*$/m);
  if (start < 0) {
    return { ok: false, errors: [`missing "${MARKER}" heading`], markdown: raw.trim(), findings: [] };
  }
  // Drop any preamble and a trailing code fence the model may have added.
  const markdown = raw.slice(start).replace(/\n```\s*$/, "").trim();

  const field = (name) => markdown.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, "m"))?.[1].trim();
  const verdictRaw = field("Verdict");
  const coverageRaw = field("Coverage");
  const verdict = verdictRaw?.match(/^`?(needs-attention|approve)`?\.?$/)?.[1];
  const coverage = coverageRaw?.match(/^`?(full|partial)`?\.?$/)?.[1];
  if (!verdict) errors.push(`invalid Verdict: ${verdictRaw ?? "(missing)"}`);
  if (!coverage) errors.push(`invalid Coverage: ${coverageRaw ?? "(missing)"}`);

  const findingsStart = markdown.search(/^## Findings[ \t]*$/m);
  const findings = [];
  if (findingsStart < 0) {
    errors.push("missing \"## Findings\" section");
  } else {
    const body = markdown.slice(findingsStart);
    const blocks = body.split(/^### /m).slice(1);
    for (const block of blocks) {
      const title = block.split("\n", 1)[0].replace(/^\d+\.\s*/, "").trim();
      const get = (name) => block.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, "m"))?.[1].trim();
      const severity = get("Severity")?.replace(/`/g, "").toLowerCase();
      const location = get("Location")?.replace(/`/g, "");
      const confidence = Number.parseFloat(get("Confidence") ?? "");
      const finding = { title };
      if (SEVERITIES.has(severity)) finding.severity = severity;
      else errors.push(`finding "${title}": invalid Severity ${severity ?? "(missing)"}`);
      // First path:line in the field; extra locations after a comma are kept in `location`.
      const loc = location?.match(/([^\s,`]+?):(\d+)(?:-(\d+))?/);
      if (loc) {
        Object.assign(finding, { location, file: loc[1], line: Number(loc[2]) });
        if (loc[3]) finding.lineEnd = Number(loc[3]);
      } else {
        errors.push(`finding "${title}": invalid Location ${location ?? "(missing)"}`);
      }
      if (Number.isFinite(confidence)) finding.confidence = confidence;
      findings.push(finding);
    }
    if (blocks.length === 0 && !/No material findings\./.test(body)) {
      errors.push("Findings section has neither findings nor \"No material findings.\"");
    }
  }
  if (verdict === "needs-attention" && findings.length === 0 && coverage !== "partial") {
    errors.push("needs-attention verdict without any finding");
  }
  return { ok: errors.length === 0, errors, markdown, verdict, coverage, findings };
}

/**
 * Cross-field rules the model must follow. The builder knows the real
 * coverage; the model's claim cannot widen it.
 * @param {ReturnType<typeof parseReviewOutput>} parsed mutated: errors/ok
 * @param {string|null} builderCoverage
 */
export function enforceConsistency(parsed, builderCoverage) {
  if (builderCoverage === "partial" && parsed.coverage === "full") {
    parsed.errors.push("model reported full coverage but the builder omitted part of the change");
  }
  if ((builderCoverage ?? parsed.coverage) === "partial" && parsed.verdict === "approve") {
    parsed.errors.push("approve verdict on partial coverage is not allowed");
  }
  if (parsed.verdict === "approve" && parsed.findings.some((f) => f.severity === "critical" || f.severity === "high")) {
    parsed.errors.push("approve verdict with critical/high findings");
  }
  parsed.ok = parsed.errors.length === 0;
  return parsed;
}

/**
 * Split the companion's rendered `## Job:` report into status and body.
 * @param {string} rendered
 */
export function parseJobReport(rendered) {
  const status = rendered.match(/^- \*\*Status\*\*: (\S+)/m)?.[1];
  const session = rendered.match(/^- \*\*OpenCode Session\*\*: (\S+)/m)?.[1];
  const output = rendered.match(/^### Output\n\n([\s\S]*)$/m)?.[1];
  const error = rendered.match(/^### Error\n\n([\s\S]*)$/m)?.[1];
  return { status, session, output, error };
}

function companion(args, cwd) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Pin the companion to this plugin even if another plugin's root leaked in.
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function log(msg) {
  process.stderr.write(`[opencode-adversarial] ${msg}\n`);
}

async function run(argv, meta) {
  const opts = parseReviewArgs(argv, { valueFlags: ["timeout", "meta", "task"] });
  const timeoutS = opts.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(opts.timeout);
  if (!Number.isFinite(timeoutS) || timeoutS < 1) throw Object.assign(new Error("--timeout must be a positive number of seconds"), { exitCode: 1 });
  const deadline = Date.now() + timeoutS * 1000;

  let cwd = process.cwd();
  let taskId = opts.task;
  if (!taskId) {
    const built = buildPrompt(opts);
    cwd = built.root;
    Object.assign(meta, {
      target: built.target,
      coverage: built.coverage ?? null,
      omittedFiles: built.omittedFiles ?? [],
      untrackedFiles: built.untrackedFiles ?? 0,
      promptBytes: built.bytes ?? 0,
      focus: built.focus ?? null,
    });
    if (built.empty) {
      meta.status = "skipped";
      log(`nothing to review for ${built.target}`);
      return 4;
    }
    log(`target: ${built.target}; ${built.inlineFiles} file(s) inline, ${built.omittedFiles.length} omitted, coverage ${built.coverage}`);

    const args = ["task", "--background", "--agent", "plan"];
    if (opts.model) args.push("--model", opts.model);
    args.push(built.prompt);
    const res = companion(args, cwd);
    taskId = res.stdout?.match(/\b(task-[a-z0-9]+-[a-z0-9]+)\b/)?.[1];
    if (res.status !== 0 || !taskId) {
      meta.status = "dispatch-failed";
      meta.errors.push((res.stderr || res.stdout || res.error?.message || "unknown dispatch error").trim());
      log(`dispatch failed (exit ${res.status})`);
      return 1;
    }
    log(`dispatched ${taskId}`);
  }
  meta.taskId = taskId;

  while (Date.now() < deadline) {
    const round = Math.max(1, Math.min(WAIT_ROUND_S, Math.ceil((deadline - Date.now()) / 1000)));
    const res = companion(["wait-and-result", taskId, "--max-wait", String(round)], cwd);
    if (res.status === 0) {
      const report = parseJobReport(res.stdout);
      meta.status = report.status ?? "unknown";
      meta.opencodeSession = report.session ?? null;
      if (report.status !== "completed") {
        meta.errors.push((report.error ?? `job ended with status ${report.status}`).trim());
        log(`job ${report.status}: ${meta.errors.at(-1)}`);
        return 1;
      }
      const parsed = parseReviewOutput(report.output ?? "");
      Object.assign(meta, { verdict: parsed.verdict ?? null, findings: parsed.findings });
      meta.coverage ??= parsed.coverage ?? null;
      enforceConsistency(parsed, meta.coverage);
      process.stdout.write(`${parsed.markdown}\n`);
      if (!parsed.ok) {
        meta.status = "format-error";
        meta.errors.push(...parsed.errors);
        log(`output violates the contract: ${parsed.errors.join("; ")}`);
        return 3;
      }
      return 0;
    }
    if (res.status !== 2) {
      meta.status = "wait-failed";
      meta.errors.push((res.stderr || res.stdout || `wait-and-result exit ${res.status}`).trim());
      return 1;
    }

    // Still running: make sure the worker is still alive before waiting again.
    const st = companion(["status", taskId, "--json"], cwd);
    let job;
    try {
      job = JSON.parse(st.stdout).job;
    } catch {
      job = null;
    }
    if (job && !job.opencodeSessionId && job.pid && !isAlive(job.pid)
      && Date.now() - Date.parse(job.createdAt) > WORKER_GRACE_MS) {
      meta.status = "worker-died";
      meta.errors.push(`worker pid ${job.pid} exited before creating an OpenCode session (status ${job.status}); see ${job.logFile ?? "job log"}`);
      log(meta.errors.at(-1));
      return 1;
    }
    log(`waiting on ${taskId} (${job?.status ?? "unknown"}, ${job?.phase ?? "-"})`);
  }
  meta.status = "timeout";
  log(`timed out after ${timeoutS}s; resume with --task ${taskId}`);
  return 2;
}

async function main() {
  const meta = { exitCode: 1, status: "error", taskId: null, verdict: null, findings: [], errors: [], warnings: [] };
  // Resolve --meta before parsing so even an argument error leaves a meta file.
  const metaIdx = process.argv.indexOf("--meta");
  if (metaIdx > 1 && process.argv[metaIdx + 1]) meta.metaFile = path.resolve(process.argv[metaIdx + 1]);
  let code;
  try {
    code = await run(process.argv.slice(2), meta);
  } catch (err) {
    meta.errors.push(err.message);
    log(err.message);
    code = err.exitCode ?? 1;
  }
  meta.exitCode = code;
  if (meta.metaFile) {
    const file = meta.metaFile;
    delete meta.metaFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
  }
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
