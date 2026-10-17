# ADR-002: `await_answer` waits at most 55 seconds per call (doc beats prompt)

Status: accepted (G0, 2026-10-16)

## Context
The build prompt (section 6) specifies `await_answer(task_id, timeout_seconds=120)`. The mcp-use/Manufact vendor note (docs/vendor/mcp-use-manufact.md, "Long-running tool") found:
- Claude Code's per-server MCP timeout is a hard wall clock that progress notifications do not extend (https://code.claude.com/docs/en/mcp).
- The Manufact gateway request timeout is undocumented.
- mcp-use v2 is stateless; progress is only sent on the active request stream.

## Decision
`AwaitAnswerInput.timeout_seconds` defaults to 50 and is capped at 55. On timeout the tool returns `answered: false` plus a `next_step` telling the agent to call `await_answer` again. The tool description must say: call it immediately after `ask_eyes` and keep calling until `answered` is true or the status is terminal.

## Consequences
Agents loop instead of holding one long call. A 120-second wait is two or three calls. The contract test pins the cap.
