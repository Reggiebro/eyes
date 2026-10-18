import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { WIDGET_HTML, WIDGET_SCRIPT } from "./widget.ts";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };
type Result = { structuredContent?: unknown; content?: { type: string; text: string }[]; isError?: boolean };

const QUOTE = {
  workers_nearby: 2,
  est_minutes_to_answer: 8,
  suggested_bounty_usd: 3,
  allowed: true,
  reason_if_not: null,
  resolved_location: { label: "Ferry Building, San Francisco" },
};
const TASK = {
  task_id: "t1",
  status: "dispatched",
  question: "How long is the line?",
  place_label: "Ferry Building",
  answer: null,
  escrowed_usd: 3.5,
  workers_notified: 2,
};
const ANSWER = {
  answer_text: "Ten people",
  answer_bool: null,
  photo_url: null,
  verification: {},
  cost_usd: 3.5,
};

/** Boots the widget script in happy-dom. `openai` stands in for ChatGPT; without it the MCP Apps host answers. */
function boot(
  opts: { openai?: Record<string, unknown>; host?: (m: Msg) => Result | { error: { message: string } } } = {},
) {
  const happy = new Window({ url: "https://card.test/" });
  const win = happy as unknown as globalThis.Window & {
    openai?: unknown;
  };
  win.document.body.innerHTML = '<main id="root"></main>';
  const sent: Msg[] = [];
  const reply = (data: unknown) =>
    win.dispatchEvent(new happy.MessageEvent("message", { data }) as unknown as Event);
  Object.defineProperty(win, "parent", {
    value: {
      postMessage: (m: Msg) => {
        sent.push(m);
        if (m.id == null) return;
        if (m.method === "ui/initialize")
          return reply({ jsonrpc: "2.0", id: m.id, result: { hostContext: { theme: "dark" } } });
        const r = opts.host?.(m) ?? {};
        reply({ jsonrpc: "2.0", id: m.id, ...("error" in r ? r : { result: r }) });
      },
    },
  });
  if (opts.openai) win.openai = opts.openai;
  new Function("window", "document", "ResizeObserver", "crypto", WIDGET_SCRIPT)(
    win,
    win.document,
    class {
      observe() {}
    },
    { randomUUID: () => "key-1" },
  );
  const root = win.document.getElementById("root") as HTMLElement;
  const show = (structuredContent: unknown, args: Record<string, unknown> = {}) => {
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } });
  };
  const button = (act: string) => root.querySelector(`[data-act="${act}"]`) as HTMLButtonElement;
  // Hosts reply synchronously here, so a call settles within a few microtask turns: drain them, no clock.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { win, root, sent, show, button, settle };
}

describe("widget call bridge (MCP Apps host)", () => {
  it("handshakes, then Ask Eyes sends tools/call ask_eyes with the quote and renders the task", async () => {
    const host = vi.fn((_m: Msg): Result => ({ structuredContent: { ...TASK } }));
    const w = boot({ host });
    await w.settle();
    expect(w.sent[0]).toMatchObject({ method: "ui/initialize" });
    expect(w.sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
    expect(w.win.document.documentElement.dataset.theme).toBe("dark");

    w.show(QUOTE, { location: "Ferry Building, San Francisco", task_type: "line_length" });
    (w.root.querySelector('[data-field="question"]') as HTMLInputElement).value = " How long is the line? ";
    w.button("ask").click();
    expect(w.button("ask").disabled).toBe(true);
    await w.settle();
    expect(host.mock.calls[0]?.[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "ask_eyes",
        arguments: {
          question: "How long is the line?",
          location: "Ferry Building, San Francisco",
          task_type: "line_length",
          bounty_usd: 3,
          idempotency_key: "key-1",
        },
      },
    });
    expect(w.root.textContent).toContain("Finding a worker");
    expect(w.button("cancel")).not.toBeNull();
  });

  it.each([
    ["refresh", "get_task", {}],
    ["wait", "await_answer", {}],
    ["cancel", "cancel_task", {}],
  ])("task card %s calls %s with the task_id and merges the result", async (act, tool) => {
    const host = vi.fn((_m: Msg): Result => ({ structuredContent: { task_id: "t1", status: "refunded" } }));
    const w = boot({ host });
    w.show({ ...TASK });
    w.button(act).click();
    await w.settle();
    expect(host.mock.calls.at(-1)?.[0].params).toEqual({ name: tool, arguments: { task_id: "t1" } });
    expect(w.root.textContent).toContain("How long is the line?");
    expect(w.root.textContent).toContain("Refunded");
  });

  it("Dispute sends the typed reason; a tool error shows inline and re-enables the button", async () => {
    const host = vi.fn(
      (_m: Msg): Result => ({ isError: true, content: [{ type: "text", text: "reason too short" }] }),
    );
    const w = boot({ host });
    w.show({ ...TASK, status: "verified", answer: ANSWER });
    (w.root.querySelector('[data-field="reason"]') as HTMLInputElement).value = "Wrong cafe";
    w.button("dispute").click();
    await w.settle();
    expect(host.mock.calls[0]?.[0].params).toEqual({
      name: "dispute_answer",
      arguments: { task_id: "t1", reason: "Wrong cafe" },
    });
    expect(w.root.querySelector("[data-error]")?.textContent).toBe("reason too short");
    expect(w.button("dispute").disabled).toBe(false);
  });

  it("a JSON-RPC error from the host shows inline", async () => {
    const w = boot({ host: () => ({ error: { message: "tool not allowed" } }) });
    w.show({ balance_usd: 4, escrowed_usd: 0, top_up_url: "https://pay.test/top" });
    w.button("balance").click();
    await w.settle();
    expect(w.root.querySelector("[data-error]")?.textContent).toBe("tool not allowed");
  });

  it("balance Refresh calls get_balance; Top up opens the link through ui/open-link", async () => {
    const host = vi.fn(
      (m: Msg): Result =>
        m.method === "tools/call"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    balance_usd: 9,
                    escrowed_usd: 0,
                    top_up_url: "https://pay.test/top",
                  }),
                },
              ],
            }
          : {},
    );
    const w = boot({ host });
    w.show({ balance_usd: 1, escrowed_usd: 0, top_up_url: "https://pay.test/top" });
    w.button("balance").click();
    await w.settle();
    expect(host.mock.calls[0]?.[0].params).toEqual({ name: "get_balance", arguments: {} });
    expect(w.root.textContent).toContain("$9.00");
    w.button("topup").click();
    expect(w.sent.at(-1)).toMatchObject({ method: "ui/open-link", params: { url: "https://pay.test/top" } });
  });
});

describe("widget call bridge (ChatGPT)", () => {
  it("uses window.openai.callTool and openExternal instead of postMessage", async () => {
    const callTool = vi.fn(async () => ({
      structuredContent: { balance_usd: 7, escrowed_usd: 0, top_up_url: "https://pay.test/top" },
    }));
    const openExternal = vi.fn();
    const w = boot({
      openai: {
        callTool,
        openExternal,
        theme: "light",
        toolInput: {},
        toolOutput: { balance_usd: 2, escrowed_usd: 1, top_up_url: "https://pay.test/top" },
      },
    });
    expect(w.root.textContent).toContain("$2.00");
    w.button("balance").click();
    await w.settle();
    expect(callTool).toHaveBeenCalledWith("get_balance", {});
    expect(w.sent.some((m) => m.method === "tools/call")).toBe(false);
    expect(w.root.textContent).toContain("$7.00");
    w.button("topup").click();
    expect(openExternal).toHaveBeenCalledWith({ href: "https://pay.test/top" });
  });
});

describe.each(["MCP Apps", "ChatGPT"])("%s readable tool errors", (bridge) => {
  const message = "Safety review <unavailable>";
  const fix = 'Retry the same request & keep "public" places.';
  it.each(["text", "structured", "rejected"])(
    "shows message and fix from %s errors after Ask is clicked",
    async (kind) => {
      const payload = { error: "unsafe_task", message, fix, category: "other" };
      const text = JSON.stringify(payload);
      const result: Result =
        kind === "structured"
          ? { isError: true, structuredContent: payload }
          : { isError: true, content: [{ type: "text", text }] };
      const w =
        bridge === "ChatGPT"
          ? boot({
              openai: {
                callTool: async () => {
                  if (kind === "rejected") throw new Error(text);
                  return result;
                },
              },
            })
          : boot({ host: () => (kind === "rejected" ? { error: { message: text } } : result) });
      w.show(QUOTE, { location: "YC 580 20th Street", question: "Is the hackathon on going?" });
      w.button("ask").click();
      await w.settle();
      const alert = w.root.querySelector('[data-error][role="alert"]');
      expect(alert?.textContent).toBe(`${message} ${fix}`);
      expect(alert?.innerHTML).toContain("&lt;unavailable&gt;");
      expect(alert?.textContent).not.toContain("unsafe_task");
      expect(w.button("ask").disabled).toBe(false);
      w.button("ask").click();
      await w.settle();
      expect(w.root.querySelectorAll("[data-error]")).toHaveLength(1);
    },
  );
});

it.each([
  [true, "Yes", "Yes"],
  [false, " no. ", "No"],
  [true, "YES!", "Yes"],
  [true, "Yes, the side entrance is open.", "Yes Yes, the side entrance is open."],
  [false, "Opens tomorrow", "No Opens tomorrow"],
  [null, "Yes", "Yes"],
])("renders boolean %s and text %s without repeating the answer", (answer_bool, answer_text, expected) => {
  const w = boot();
  w.show({ ...TASK, status: "needs_review", answer: { ...ANSWER, answer_bool, answer_text } });
  expect(w.root.querySelector(".ui-card__answer")?.textContent?.trim()).toBe(expected);
});

it("inlines the script and the call helper in the HTML resource", () => {
  expect(WIDGET_HTML).toContain(WIDGET_SCRIPT);
  expect(WIDGET_HTML).toContain('"tools/call"');
  expect(WIDGET_HTML).toContain("window.openai.callTool");
});
