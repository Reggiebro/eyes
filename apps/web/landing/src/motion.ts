/** Element shapes the landing motion code uses. Real DOM elements satisfy them. */
type ClassList = {
  add(name: string): void;
  remove(name: string): void;
  toggle(name: string, force: boolean): unknown;
};

export type Clickable = {
  addEventListener: (type: "click", handler: () => Promise<void>) => void;
};

export type TextNode = { textContent: string | null };

/** Clipboard feedback for the browser-based connection flow. */
export const COPIED_HINT = "Copied. Paste this server URL into your app.";
export function wireCopy(
  button: Clickable | null,
  source: (TextNode & { value?: string; focus?: () => void; select?: () => void }) | null,
  hint: TextNode,
  write: (text: string) => Promise<void>,
): void {
  button?.addEventListener("click", async () => {
    try {
      await write(source?.value ?? source?.textContent ?? "");
      hint.textContent = COPIED_HINT;
    } catch {
      source?.focus?.();
      source?.select?.();
      hint.textContent = "Copy unavailable. Select the server URL and copy it manually.";
    }
  });
}

export type FlightPanel = { dataset: { step?: string } };
export type FlightStep = { dataset: { step?: string }; classList: ClassList };
export type FlightRow = { dataset: { hl?: string; state?: string } };
export type FlightStatus = TextNode & {
  classList: ClassList;
  getBoundingClientRect: () => unknown;
};

/** How long the badge label stays in its exit state before the new text appears. */
export const SWAP_MS = 150;

/**
 * The flight panel's discrete state. show(n) makes row n current, sets the panel's data-step, lights the step
 * that row highlights, and swaps the badge label after SWAP_MS. Showing the row already on screen does nothing.
 */
export function createFlight(parts: {
  panel: FlightPanel;
  status: FlightStatus;
  steps: FlightStep[];
  rows: FlightRow[];
}) {
  const { panel, status, steps, rows } = parts;
  let at = rows.length - 1;

  // n is always a row index: callers pass 0..rows.length-1.
  const show = (n: number) => {
    if (n === at) return;
    at = n;
    const hl = (rows[n] as FlightRow).dataset.hl;
    panel.dataset.step = String(n);
    for (const step of steps) step.classList.toggle("is-now", step.dataset.step === hl);
    status.classList.add("is-exit");
    setTimeout(() => {
      status.textContent = (rows[at] as FlightRow).dataset.state ?? "";
      status.classList.remove("is-exit");
      status.classList.add("is-enter-start");
      status.getBoundingClientRect();
      status.classList.remove("is-enter-start");
    }, SWAP_MS);
  };

  return { show };
}
