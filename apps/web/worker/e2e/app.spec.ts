import { expect, test } from "@playwright/test";

const code = "Xy3_abcDEFghiJKLmnoPQRstuVWXyz0123456789-_a";

test("/app hands the fragment code to the app and clears it from the address bar", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`/app.html#c=${code}`, { waitUntil: "commit" });
  const open = page.getByRole("link", { name: "Install / open Eyes app" });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", `eyes://connect#c=${code}`);
  expect(new URL(page.url()).hash).toBe("");
  expect(requests.filter((u) => u.includes(code) && !u.startsWith("eyes:"))).toEqual([]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("/app sends a tap with no app to TestFlight, or to the install page with the code", async ({ page }) => {
  const testflight = process.env.VITE_TESTFLIGHT_URL;
  if (testflight) await page.route(testflight, (r) => r.fulfill({ body: "TestFlight" }));
  await page.goto(`/app.html#c=${code}`);
  await page.getByRole("link", { name: "Install / open Eyes app" }).click();
  // Polls page.url(): the eyes:// attempt fails (ERR_ABORTED) in Chromium, which ends a toHaveURL wait early.
  await expect
    .poll(() => page.url(), { timeout: 8000 })
    .toBe(testflight ?? `${new URL(page.url()).origin}/install#c=${code}`);
});

test("/app without a code offers a text APP button", async ({ page }) => {
  await page.goto("/app.html");
  await expect(page.getByText("This link has no code.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text APP for a new link" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=APP",
  );
  await expect(page.getByRole("link", { name: "Install / open Eyes app" })).toBeHidden();
});

test("/app returns post-install workers to the cooldown instead of auto-opening", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-18T12:00:01Z"));
  await page.addInitScript((savedCode) => {
    if (localStorage.getItem("eyes-install")) return;
    localStorage.setItem(
      "eyes-install",
      JSON.stringify({
        code: savedCode,
        savedAt: Date.now(),
        done: 2,
        installPending: true,
        installAway: true,
        openAfter: Date.now() - 60_000,
      }),
    );
  }, code);
  await page.route("**/api/w/device", (route) =>
    route.fulfill({
      json: { registered: true, ready: true, app_connected: false },
    }),
  );
  // The install page's existing iPhone check remains in force.
  await page.route("**/install", async (route) => {
    const response = await route.fetch({
      url: route
        .request()
        .url()
        .replace(/\/install$/, "/install.html"),
    });
    await route.fulfill({ response });
  });
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" }));
  await page.goto(`/app.html#c=${code}`);
  await expect(page).toHaveURL(/\/install$/);
  await expect(page.locator("#open")).toBeDisabled();
  await expect(page.locator("#open-label")).toHaveText("Open Eyes in 3s");
  await page.clock.runFor(2_999);
  await expect(page.locator("#open")).toBeDisabled();
  await page.clock.runFor(1);
  await expect(page.locator("#open")).toBeEnabled();
  expect(new URL(page.url()).hash).toBe("");
});
