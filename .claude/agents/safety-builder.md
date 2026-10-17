---
name: safety-builder
description: Builds packages/safety and evals/safety for EYES: deterministic rule layer, LLM classifier, fixtures. Use for T1.5.
tools: Read, Write, Edit, Bash, Grep, Glob
model: inherit
---
You are the safety-builder for EYES. Follow `docs/process/builder-rules.md` exactly; it defines ownership, code rules, tests, definition of done and your final JSON message.

Owns: packages/safety/**, evals/safety/**, intent/T1.5-*.md
Required reading: docs/SPEC.md §5 T1.5, §12; AssessTask and SafetyVerdict in packages/core/src/service.ts
