import { expect, type Page, test } from "@playwright/test";

const CODE = "a".repeat(43);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const base = { profile_url: "https://api.eyes.test/w/device/profile/t", registered: false, ready: false };

test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });

/** Answers POST /w/device; reply gets the call number. */
async function mockDevice(page: Page, reply: (n: number) => object) {
  let n = 0;
  await page.route("**/api/w/device", (route) => route.fulfill({ json: { ...base, ...reply(++n) } }));
  return () => n;
}

const current = (page: Page) => page.locator('#steps > li[aria-current="step"] h2');

/** SHOTS=<dir> saves light and dark 390 px screenshots of each state. */
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(() => window.scrollTo(0, 0)); // the sticky header otherwise lands mid-page
    await page.screenshot({
      path: `${process.env.SHOTS}/install-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
}

test("register, then waiting, install and open: Developer Mode is help, not a step", async ({ page }) => {
  await mockDevice(page, () => ({}));
  await page.goto(`/install.html#c=${CODE}`);
  await expect(current(page)).toHaveText("Register this iPhone");
  expect(page.url()).not.toContain(CODE);
  await expect(page.locator("#steps > li")).toHaveCount(3);
  await shot(page, "register");
  await page.getByRole("button", { name: "I already did this" }).first().click();
  await expect(current(page)).toHaveText("Install Eyes");
  await expect(page.locator("#waiting")).toBeVisible();
  await shot(page, "waiting");
});

test("Install tap moves to Open Eyes; the app connecting finishes the page", async ({ page }) => {
  await mockDevice(page, (n) => ({ registered: true, ready: true, app_connected: n >= 3 }));
  await page.goto(`/install.html#c=${CODE}`);
  await expect(current(page)).toHaveText("Install Eyes");
  await shot(page, "install");
  await page.locator("#itms").evaluate((a) => a.removeAttribute("href")); // no itms-services navigation here
  await page.locator("#itms").click();
  await expect(current(page)).toHaveText("Open Eyes");
  await expect(page.getByText("If Eyes won't open")).toBeVisible();
  await expect(page.getByText("Turn on Developer Mode")).toHaveCount(0);
  await shot(page, "open");
  // The page asks every 5 s; the third answer says the app sent a fix.
  await expect(page.getByText("Eyes is connected. You can close this page.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("#steps > li[data-done]")).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem("eyes-install"))).toBeNull();
  await shot(page, "connected");
});

test("I already did this on Open Eyes ends the steps, keeping the code", async ({ page }) => {
  await mockDevice(page, () => ({ registered: true, ready: true }));
  await page.goto(`/install.html#c=${CODE}`);
  await page.locator("#itms").evaluate((a) => a.removeAttribute("href"));
  await page.locator("#itms").click();
  await page.locator('li[data-key="open"]').getByRole("button", { name: "I already did this" }).click();
  await expect(page.getByText("All steps done. You can close this page.")).toBeVisible();
  await expect(page.locator("#steps > li[data-done]")).toHaveCount(3);
  await page.reload();
  await expect(page.getByText("All steps done. You can close this page.")).toBeVisible();
  await shot(page, "done");
});

for (const width of [390, 1280]) {
  test(`post-install return waits three seconds with a filling native button at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-18T12:00:01Z"));
    await mockDevice(page, () => ({ registered: true, ready: true }));
    await page.goto(`/install.html#c=${CODE}`);
    await page.locator("#itms").evaluate((a) => a.removeAttribute("href"));
    await page.locator("#itms").click();
    const open = page.locator("#open");
    await expect(open).toBeDisabled();
    await expect(open).toHaveAttribute("aria-busy", "true");
    // Simulate time in iOS, not an actual installation or a device write.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.clock.runFor(60_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(open).toHaveText("Open Eyes in 3s");
    await open.dispatchEvent("click"); // programmatic events cannot bypass the native disabled state
    await open.press("Enter");
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("eyes-install") ?? "null")?.installPending),
    ).toBe(true);
    await page.clock.runFor(1_500);
    await expect(open).toBeDisabled();
    await expect(page.locator("#open-fill")).toHaveAttribute("style", "transform: scaleX(0.5);");
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/cooldown-${width}-progress.png`, fullPage: true });
    await page.clock.runFor(1_499);
    await expect(open).toBeDisabled();
    await page.clock.runFor(1);
    await expect(open).toBeEnabled();
    await expect(open).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#open-status")).toHaveText("Ready to open Eyes.");
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/cooldown-${width}-ready.png`, fullPage: true });
    await open.click();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("eyes-install") ?? "null")?.installPending),
    ).toBe(false);
  });
}

test("reduced motion preserves the full delay and server readiness gate after reload", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-18T12:00:01Z"));
  let ready = true;
  await mockDevice(page, () => ({ registered: true, ready }));
  await page.goto(`/install.html#c=${CODE}`);
  await page.locator("#itms").evaluate((a) => a.removeAttribute("href"));
  await page.locator("#itms").click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  ready = false;
  await page.reload();
  const open = page.locator("#open");
  await expect(open).toBeDisabled();
  await page.clock.runFor(3_000);
  await expect(open).toBeDisabled();
  await expect(page.locator("#open-status")).toHaveText("Waiting for this iPhone to be ready.");
  ready = true;
  await page.clock.runFor(2_000);
  await expect(open).toBeEnabled();
});
