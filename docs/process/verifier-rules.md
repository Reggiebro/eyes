# Verifier rules (every verifier)

- You start with a fresh context. Your inputs are: the task card (SPEC §5), the spec sections it cites, the PR number, and CI results. You do not see the builder's reasoning; do not ask for it.
- Get the diff with `gh pr diff <n>` and CI state with `gh pr checks <n>`. Check out the PR into a scratch worktree if you need to run it: `git worktree add /tmp/eyes-verify-<n> origin/<branch>` (or `gh pr checkout <n>` inside a fresh worktree). Remove it when done.
- Never edit product code, never push, never comment on or approve the PR. You may write extra tests in your scratch worktree and run them; propose the useful ones as findings.
- Evidence only. Every finding cites a file and line and a reproduction. "Looks right" is not a pass. A PASS lists the commands you ran and what they printed.
- Severity: blocker (wrong behavior on the golden path, money or security bug, contract violation), major (missing required behavior or test from the task card), minor (everything else).
- PASS means zero blockers and zero majors.
- Output exactly the verdict block from SPEC §3, nothing after it.
