// Server errors grouped into issues for the ops Errors tab (T6.32). Every console error/warning the
// event log captures (kind "log", already redacted) gets a fingerprint: the error name, the message
// with ids, numbers, emails and URLs normalized, and the top in-app stack frame. Batches go to
// Postgres (eyes_issues_record, migration 028), so issues and their status survive restarts.
import { createHash } from "node:crypto";
import type { Rpc } from "@eyes/db";
import type { LoggedEvent } from "./ops.ts";

export type Occurrence = {
  fingerprint: string;
  level: "warn" | "error";
  title: string;
  culprit: string | null;
  message: string;
  stack: string | null;
  at: string;
  tags: Record<string, string>;
};

const FRAME = /^\s+at\s/;
// ponytail: regex normalization, not a parser; two messages that differ only in an id group together.
const NORMALIZE: [RegExp, string][] = [
  [/https?:\/\/\S+/g, "<url>"],
  [/\[email\]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<id>"],
  [/\d+(?:\.\d+)?/g, "<n>"],
];
export const normalize = (text: string) => NORMALIZE.reduce((t, [re, to]) => t.replace(re, to), text).trim();

/** The first stack frame in our code (apps/ or packages/, not node_modules), as "apps/x/y.ts:12". */
export function culpritOf(stack: string | null) {
  for (const line of stack?.split("\n") ?? []) {
    if (line.includes("node_modules")) continue;
    const m = /((?:apps|packages)\/[^\s():]+):(\d+)/.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/** Ids the event names, short, for "who was affected" and the tags. */
function tagsOf(e: LoggedEvent): Record<string, string> {
  const tags: Record<string, string> = {};
  const data = e.data as Record<string, unknown>;
  for (const key of ["route", "path", "provider", "agent_id", "worker_id"])
    if (typeof data[key] === "string") tags[key === "path" ? "route" : key] = data[key] as string;
  if (e.task_id) tags.task_id = e.task_id;
  return tags;
}

/** One occurrence for a captured console error/warning; null for anything else. */
export function occurrenceOf(e: LoggedEvent): Occurrence | null {
  if (e.kind !== "log" || (e.level !== "error" && e.level !== "warn")) return null;
  const lines = e.summary.split("\n");
  const at = lines.findIndex((l) => FRAME.test(l));
  const message = (at === -1 ? lines : lines.slice(0, at)).join("\n").trim() || "(empty)";
  const stack = at === -1 ? null : lines.slice(at).join("\n");
  const culprit = culpritOf(stack);
  // "TypeError: x is not a function" → the name; a plain line has none.
  const name = /^([A-Z]\w*(?:Error|Exception)):/.exec(message)?.[1] ?? "";
  const title = normalize(message.split("\n")[0] as string).slice(0, 200);
  const fingerprint = createHash("sha256")
    .update(`${name}\n${title}\n${culprit ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return { fingerprint, level: e.level, title, culprit, message, stack, at: e.at, tags: tagsOf(e) };
}

/** An event-log sink: groups captured errors into issues, writes them every `flushMs`. */
export function createIssueSink(rpc: Rpc, flushMs = 2000) {
  let pending: Occurrence[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // Not console.error: that would record the failure as an issue and loop.
    await rpc("eyes_issues_record", { p_events: batch }).catch((err: unknown) =>
      process.stderr.write(`issue write failed: ${String(err).slice(0, 300)}\n`),
    );
  };
  setInterval(flush, flushMs).unref();
  return {
    push(e: LoggedEvent) {
      const o = occurrenceOf(e);
      if (o && pending.length < 1000) pending.push(o);
    },
    flush,
  };
}
