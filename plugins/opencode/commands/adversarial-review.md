---
description: Run an adversarial OpenCode review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref> | --scope auto|working-tree|branch] [--model <provider/model>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash, AskUserQuestion
---

Run an adversarial OpenCode review (local fork addition; upstream removed this command in f012f68).
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

How it works:
- `scripts/run-adversarial-review.mjs` is the single entry point. It collects the target diff with local git, fills `prompts/adversarial-review.md`, dispatches a fresh read-only task (`task --agent plan`: edits, shell, and subagents denied), waits, checks the job status, and validates the output contract.
- The whole prompt is capped at 100 KiB (Linux allows 128 KiB per argv string). Diffs that do not fit are dropped per file and listed; coverage is then `partial` and the prompt forbids an `approve` verdict.
- `--scope auto` picks: tracked changes → working tree; otherwise commits ahead of the base → branch diff; otherwise untracked files → working tree. `--base` cannot be combined with `--scope working-tree`.
- Exit codes: 0 valid review, 1 dispatch/job failure, 2 wait timed out (job may still run; resume with `--task <id>`), 3 output violates the contract (raw output still printed), 4 nothing to review. `--meta <file>` writes a JSON summary (status, taskId, verdict, coverage, parsed findings, errors).
- Other skills should call the script directly rather than this command.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and report OpenCode's result to the user in Korean (see "Korean report" below).
- Do not weaken the adversarial framing or rewrite the user's focus text.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run with `Bash` `run_in_background: true`.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Pass `--base`, `--scope`, and `--model` with their values as separate shell words. Drop `--wait` / `--background` (they only choose how you run Bash).
- Everything else is focus text: pass it after `--` as one safely single-quoted argument, preserving the user's wording exactly.

Run (replace `<args>` per the rules above):
```bash
META="$(mktemp "${TMPDIR:-/tmp}/opencode-adversarial-meta.XXXXXX")"
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-adversarial-review.mjs" --meta "$META" --timeout 3600 <args>
code=$?
echo "--- meta ($code)"; cat "$META"; rm -f "$META"
exit $code
```
- Foreground: use a Bash timeout of 600000 ms and add `--timeout 570` instead of 3600. On exit 2, rerun the same block with `--task <taskId from meta>` (no other args) up to 5 more times, then report the task ID and offer `/opencode:status`, `/opencode:result`, or `/opencode:cancel`.
- Background: launch the block with `run_in_background: true`, tell the user "OpenCode adversarial review started in the background. Results arrive when it finishes; `/opencode:status` shows progress.", and report when the notification arrives.

Reporting by exit code:
- 0 or 3: report the review per "Korean report". For 3, say first that the output did not follow the contract and list the meta `errors`.
- 1: report `ERROR: OpenCode adversarial review failed (<meta status>): <meta errors>`. Do not substitute your own review.
- 4: say there is nothing to review for the meta `target`.
- If meta `coverage` is `partial`, list `omittedFiles` as reviewed without a diff, and include any meta `warnings`.

Korean report:
- Follow the "Korean report" rules in `commands/review.md`. Include the verdict (`needs-attention` / `approve`) and coverage in the one-line overall verdict and each finding's confidence in the 심각도 column (e.g. `high (0.8)`).
- Do not fix any issues mentioned in the review output.
