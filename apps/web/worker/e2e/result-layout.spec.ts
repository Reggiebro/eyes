import { expect, test } from "@playwright/test";
import { WIDGET_HTML } from "../../../mcp/src/widget.ts";

const reason = "The automatic safety check was not sure about this photo, so a person will review it.";
const task = {
  task_id: "layout-task",
  status: "needs_review",
  question: "is it still open?",
  place_label: "Union Iron Works Office, 560, 20th Street, San Francisco, California, United States",
  answer: {
    answer_bool: true,
    answer_text: "Yes",
    photo_url: null,
    worker_distance_m: 27,
    captured_at: "2026-10-18T03:51:00Z",
    cost_usd: 3.5,
    verification: { gps_ok: true, fresh_ok: true, vision_ok: false, vision_reason: reason },
  },
};

for (const width of [390, 900]) {
  test(`task result keeps labels and dispute input readable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(WIDGET_HTML);
    await page.evaluate((structuredContent) => {
      document.documentElement.dataset.theme = "dark";
      window.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: { structuredContent },
        },
        "*",
      );
    }, task);
    const answer = page.locator(".ui-card__answer");
    await expect(answer).toHaveText("Yes");
    const check = page.locator(".ui-check").nth(2);
    const label = check.locator(":scope > span").nth(1);
    const detail = check.locator(".ui-check__detail");
    await expect(label).toHaveText("Photo is safe to share");
    await expect(detail).toHaveText(reason);
    const labelBox = await label.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(labelBox?.width).toBeGreaterThan(240);
    expect(labelBox?.height).toBeLessThan(40);
    expect(detailBox?.y).toBeGreaterThanOrEqual((labelBox?.y ?? 0) + (labelBox?.height ?? 0));
    await expect(page.locator(".ui-check__detail").nth(0)).toHaveText("27 m away");
    await expect(page.locator(".ui-check__detail").nth(1)).toContainText("taken ");
    const input = page.getByRole("textbox", { name: "What is wrong" });
    expect((await input.boundingBox())?.width).toBeGreaterThan(340);
    await input.fill("The photo shows the wrong entrance.");
    await expect(input).toHaveValue("The photo shows the wrong entrance.");
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dispute", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`widget-${width}.png`), fullPage: true });

    await page.evaluate(
      (structuredContent) =>
        window.postMessage(
          {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: { structuredContent },
          },
          "*",
        ),
      {
        ...task,
        answer: {
          ...task.answer,
          verification: { ...task.answer.verification, vision_reason: "x".repeat(500) },
        },
      },
    );
    await expect(detail).toHaveText("x".repeat(500));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
