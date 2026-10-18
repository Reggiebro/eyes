# ADR-025: The photo check is moderation only

Status: accepted (2026-10-17, operator); photo policy narrowed on 2026-10-18. `VisionJudgeInput` is `{ photo_url }`; `VisionVerdict` is now `{ allowed, reason, confidence }`. The obsolete `prominent_faces` flag is removed. API fields `verification.vision_ok` / `vision_reason` are unchanged.

## Context
`verifySubmission` asked clef-omni (then Claude) whether the photo answers the question, and a "no" held the payout in `needs_review`. A model guessing whether "about 4 people in line" is right blocked honest workers on judgment calls, and the agent, who asked the question, is better placed to judge the answer from the photo. Wrong answers already have a path: `dispute_answer`.

## Decision
- Reject photo content only for confirmed graphic gore or explicit sexual/adult content. Do not infer adultery, relationships or moral traits. Ordinary scenes, faces, private spaces, personal details, screenshots and blank images are not rejection categories. Task-request privacy restrictions in `packages/safety` are unchanged.
- The judge sees only the photo. The question, place and worker answer are no longer sent, so the verdict cannot be about correctness (and there is no task data to inject through).
- clef-omni asks `gore` and `explicit_sexual` as `noul` questions. A category probability >= 0.8 rejects; otherwise content passes, including uncertainty. Actual provider failures use Claude when configured. Claude returns structured content flags and rejects only when a blocked flag is true with confidence >= 0.8. Missing, malformed or out-of-range provider responses throw; if fallback fails or is unavailable, verification remains unavailable and the task needs review.
- Payout: `gps_ok && fresh_ok && vision_ok` auto-approves, as before; `vision_ok` now means "safe to share". Answer correctness never blocks payout.
- A blocked or unavailable photo is not delivered (`photo_url: null` in agent answers); stored photos remain available to reviewers. Face-only deletion is removed, superseding ADR-014 for moderation. Lost-claim upload cleanup remains. No existing photos or held tasks are reprocessed, deleted, released or refunded by this change.
- User-facing label: "Photo is safe to share" (capture page, ChatGPT widget card, dashboard, ops review, docs).

## Alternatives rejected
- New field names (`moderation_ok`): breaks agents already reading `vision_ok`. Redefining the meaning in descriptions is enough because both fields only ever gated the same payout.
- Keep a correctness score as advice only: the agent would still read it as a verdict, and it costs a model call per photo.
- A generic "safe to share" question and face threshold: they conflated task-request privacy restrictions with photo moderation and held ordinary photos. Two explicit content categories keep the policy bounded.

## Consequences
The agent still evaluates correctness. An ops-approved blocked photo stays undelivered (ops cannot "unblock" a photo for the agent). The 0.8 clef threshold is a policy cutoff, not a measured accuracy guarantee. Image-ground-truth evaluation is separate from mocked category tests and safe-image runtime smoke.
