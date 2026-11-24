---
description: Show final output for a finished OpenCode job, including session ID for resuming
argument-hint: '[job-id-prefix]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the result command.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" result $ARGUMENTS
```

- If the job is a review (output contains `# OpenCode Review` or `# OpenCode Adversarial Review`, or the job kind is review), report it in Korean using the "Korean report" rules in `commands/review.md` (local customization). Keep the job id and session id lines as-is.
- For any other job, return the output verbatim.
- Do not fix any issues mentioned in the result output.
