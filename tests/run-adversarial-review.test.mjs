import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewOutput, parseJobReport } from "../plugins/opencode/scripts/run-adversarial-review.mjs";

const GOOD = `Some preamble the model added.

# OpenCode Adversarial Review

**Verdict:** \`needs-attention\`
**Coverage:** \`full\`
**Target:** branch diff main...HEAD
**Summary:** Do not ship.

## Findings

### 1. Lock is never released
- **Severity:** high
- **Location:** \`src/a.js:10-12\`, \`src/b.js:3\`
- **Confidence:** 0.8
- **What can go wrong:** ...
- **Recommendation:** ...

### 2. Minor leak
- **Severity:** low
- **Location:** \`src/c.js:7\`
- **Confidence:** 0.4
- **What can go wrong:** ...
- **Recommendation:** ...
`;

describe("parseReviewOutput", () => {
  it("parses a contract-conforming review and strips the preamble", () => {
    const r = parseReviewOutput(GOOD);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.verdict, "needs-attention");
    assert.equal(r.coverage, "full");
    assert.ok(r.markdown.startsWith("# OpenCode Adversarial Review"));
    assert.equal(r.findings.length, 2);
    assert.deepEqual(
      { severity: r.findings[0].severity, file: r.findings[0].file, line: r.findings[0].line, lineEnd: r.findings[0].lineEnd },
      { severity: "high", file: "src/a.js", line: 10, lineEnd: 12 },
    );
    assert.equal(r.findings[1].confidence, 0.4);
  });

  it("accepts an approve with no findings", () => {
    const r = parseReviewOutput("# OpenCode Adversarial Review\n\n**Verdict:** approve\n**Coverage:** full\n\n## Findings\n\nNo material findings.\n");
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.findings.length, 0);
  });

  it("rejects missing marker, echoed verdict template, and bad finding fields", () => {
    assert.equal(parseReviewOutput("Looks fine to me.").ok, false);
    const echoed = parseReviewOutput("# OpenCode Adversarial Review\n\n**Verdict:** `needs-attention` or `approve`\n**Coverage:** full\n\n## Findings\n\nNo material findings.\n");
    assert.equal(echoed.ok, false);
    const bad = parseReviewOutput("# OpenCode Adversarial Review\n\n**Verdict:** needs-attention\n**Coverage:** full\n\n## Findings\n\n### 1. X\n- **Severity:** severe\n- **Location:** somewhere\n");
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 2);
  });
});

describe("parseJobReport", () => {
  it("reads status, output, and error from a rendered job report", () => {
    const ok = parseJobReport("## Job: task-1\n\n- **Type**: task\n- **Status**: completed\n- **OpenCode Session**: ses_1\n\n### Output\n\n# OpenCode Adversarial Review\nbody\n");
    assert.equal(ok.status, "completed");
    assert.equal(ok.session, "ses_1");
    assert.match(ok.output, /^# OpenCode Adversarial Review\nbody/);
    const failed = parseJobReport("## Job: task-2\n\n- **Type**: task\n- **Status**: failed\n\n### Error\n\nprovider auth expired\n");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.trim(), "provider auth expired");
  });
});
