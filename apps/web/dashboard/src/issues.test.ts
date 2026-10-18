import { afterEach, describe, expect, it, vi } from "vitest";
import { createIssueSink, culpritOf, normalize, occurrenceOf } from "./issues.ts";
import type { LoggedEvent } from "./ops.ts";

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'lat')",
  "    at nearest (node:internal/x:1:1)",
  "    at dispatch (/app/node_modules/hono/dist/index.js:12:3)",
  "    at offer (/app/packages/engine/src/dispatch.ts:88:14)",
  "    at main (/app/apps/mcp/src/server.ts:431:7)",
].join("\n");
const ev = (over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  at: "2026-10-17T12:00:00.000Z",
  kind: "log",
  level: "error",
  task_id: null,
  summary: STACK,
  data: {},
  ...over,
});

describe("issue fingerprints", () => {
  it("normalizes ids, numbers, emails and URLs so occurrences group", () => {
    expect(
      normalize(
        "task 3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b failed after 1200 ms for [email] at https://api.x/y?z=1, ref deadbeef12",
      ),
    ).toBe("task <id> failed after <n> ms for <email> at <url> ref <id>");
    expect(normalize("  sent to bob@example.com 3.5 times ")).toBe("sent to <email> <n> times");
  });

  it("finds the first frame in our code, skipping node internals and node_modules", () => {
    expect(culpritOf(STACK)).toBe("packages/engine/src/dispatch.ts:88");
    expect(culpritOf("    at x (node:internal/y:1:1)")).toBeNull();
    expect(culpritOf(null)).toBeNull();
  });

  it("makes one occurrence per captured error or warning with name, message, stack, culprit and tags", () => {
    const o = occurrenceOf(
      ev({ task_id: "t-1", data: { path: "/v1/tasks", provider: "stripe", agent_id: "a-1", worker_id: 7 } }),
    );
    expect(o).toMatchObject({
      level: "error",
      title: "TypeError: Cannot read properties of undefined (reading 'lat')",
      culprit: "packages/engine/src/dispatch.ts:88",
      message: "TypeError: Cannot read properties of undefined (reading 'lat')",
      at: "2026-10-17T12:00:00.000Z",
      tags: { route: "/v1/tasks", provider: "stripe", agent_id: "a-1", task_id: "t-1" },
    });
    expect(o?.stack?.split("\n")).toHaveLength(4);
    expect(o?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Same error, other ids: same issue. Other culprit: another issue.
    const again = occurrenceOf(ev({ summary: STACK.replace("'lat'", "'lat'") }));
    expect(again?.fingerprint).toBe(o?.fingerprint);
    const elsewhere = occurrenceOf(ev({ summary: STACK.replace("dispatch.ts:88", "offers.ts:9") }));
    expect(elsewhere?.fingerprint).not.toBe(o?.fingerprint);
  });

  it("groups plain lines by their normalized text, and skips everything that is not a console error or warning", () => {
    const a = occurrenceOf(ev({ level: "warn", summary: "clef classifier slow: 4120 ms" }));
    const b = occurrenceOf(ev({ level: "warn", summary: "clef classifier slow: 980 ms" }));
    expect(a).toMatchObject({
      level: "warn",
      title: "clef classifier slow: <n> ms",
      culprit: null,
      stack: null,
    });
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(occurrenceOf(ev({ summary: "" }))?.message).toBe("(empty)");
    expect(occurrenceOf(ev({ kind: "http" }))).toBeNull();
    expect(occurrenceOf(ev({ level: "info" }))).toBeNull();
  });
});

describe("issue sink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("batches occurrences to eyes_issues_record, and only writes a failure to stderr", async () => {
    const calls: { fn: string; events: unknown[] }[] = [];
    let fail = false;
    const sink = createIssueSink(async (fn, args) => {
      if (fail) throw new Error("db down");
      calls.push({ fn, events: Array.isArray(args.p_events) ? args.p_events : [] });
      return [];
    }, 60_000);
    await sink.flush();
    expect(calls).toEqual([]);
    sink.push(ev());
    sink.push(ev({ kind: "http" }));
    await sink.flush();
    expect(calls.map((c) => [c.fn, c.events.length])).toEqual([["eyes_issues_record", 1]]);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    fail = true;
    sink.push(ev());
    await sink.flush();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("issue write failed: Error: db down");
    // Past 1000 waiting occurrences, new ones are dropped rather than growing memory.
    for (let i = 0; i < 1005; i++) sink.push(ev());
    fail = false;
    await sink.flush();
    expect(calls.at(-1)?.events).toHaveLength(1000);
  });
});
