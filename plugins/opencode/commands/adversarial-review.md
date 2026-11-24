---
description: Run an adversarial OpenCode review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <provider/model>] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash, AskUserQuestion
---

Run an adversarial OpenCode review (local fork addition; upstream removed this command in f012f68).
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

How it works:
- `scripts/build-adversarial-prompt.mjs` collects the target diff with local git and fills `prompts/adversarial-review.md`.
- The prompt is dispatched as a fresh read-only task (`task --agent plan`). That session denies edits, shell, and subagents, so OpenCode reviews from the inlined diff and its read/glob/grep tools.
- Diffs over the inline budget (~200 KiB) are dropped per file; those files and untracked files are listed for OpenCode to read without a diff.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and report OpenCode's result to the user in Korean (see "Korean report" below).
- Do not weaken the adversarial framing or rewrite the user's focus text.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run with a Claude background Bash waiter.
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
- Keep `--base <ref>` and `--scope <scope>` as separate shell words for the builder.
- Pass `--model <provider/model>` to both the builder (it ignores it) and the companion `task` call.
- Everything else is focus text. Pass it to the builder as one safely single-quoted argument, preserving the user's wording exactly.
- Staged-only or unstaged-only review is not supported; working-tree review covers staged, unstaged, and untracked changes against `HEAD`.

Dispatch (one Bash call; replace `<builder args>` and `<model flag>` per the rules above):
```bash
PROMPT_FILE="$(mktemp "${TMPDIR:-/tmp}/opencode-adversarial.XXXXXX")"
SUMMARY="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/build-adversarial-prompt.mjs" --out "$PROMPT_FILE" <builder args>)" || exit 1
printf '%s\n' "$SUMMARY"
case "$SUMMARY" in *'"empty":true'*) rm -f "$PROMPT_FILE"; exit 0;; esac
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task --background --agent plan <model flag> "$(cat "$PROMPT_FILE")"
rm -f "$PROMPT_FILE"
```
- If the summary has `"empty":true`, tell the user there is nothing to review for that target and stop.
- If the summary lists `omittedFiles`, tell the user which files were reviewed without a diff.
- Capture the `task-...` ID from the companion output. Do not add `--resume-last` or `--write`.

Foreground waiting:
- Call the following with a Bash timeout of 600000 ms, up to 20 rounds:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" wait-and-result <task-id> --max-wait 480
```
- Exit 0: the terminal `## Job:` report is ready; report it per "Korean report".
- Exit 2: still running; wait again with the same task ID.
- Exit 1 or missing report: report `ERROR: companion dispatch failed (<reason>)`.
- After 20 timeouts: report the task ID and offer `/opencode:status`, `/opencode:result`, or `/opencode:cancel`. Do not dispatch a duplicate job.

Background waiting:
- Launch this loop through `Bash` with `run_in_background: true`, replacing `<task-id>`:
```bash
for ((round = 0; round < 20; round++)); do
  node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" status <task-id> --json
  node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" wait-and-result <task-id> --max-wait 480
  code=$?
  if [ "$code" -ne 2 ]; then
    exit "$code"
  fi
done
printf '%s\n' 'OpenCode task <task-id> is still running after 20 wait rounds; check /opencode:status or /opencode:result.'
exit 2
```
- Tell the user: "OpenCode adversarial review started in the background (<task-id>). Check `/opencode:status` for progress."
- When the background notification arrives, report the result per "Korean report".

Korean report:
- Follow the "Korean report" rules in `commands/review.md`. The OpenCode output starts with `# OpenCode Adversarial Review`; include its verdict (`needs-attention` / `approve`) in the one-line overall verdict and each finding's confidence in the 심각도 column (e.g. `high (0.8)`).
- If the output does not follow that shape, still report every finding you can identify, and say the output format was off.
- Do not fix any issues mentioned in the review output.
