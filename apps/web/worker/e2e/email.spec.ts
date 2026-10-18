import { expect, type Page, test } from "@playwright/test";

// Worker email on /me and /login, against a mocked API.
const code = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const loginCode = `${"A1_-".repeat(10)}abc`; // 43 base64url characters, like the API's
const MASKED = "a…@example.com";

const base = {
  opted_in: true,
  spot: { at: new Date().toISOString(), fresh: true, max_age_h: 24 },
  app: { last_at: new Date().toISOString(), sending: true },
  payouts: { set_up: true, live: true, setup_url: null },
  here_url: "https://app.eyes.test/here.html?t=h.t",
};
const withEmail = (email_status: string, email_masked: string | null = MASKED, over: object = {}) => ({
  ...base,
  email_status,
  email_masked,
  ...over,
});

type Reply = { status?: number; json: object };

/** Mocks GET /w/me, its tasks, and POST /w/me/email (answers in order); records the email posts. */
async function mockMe(page: Page, setup: object, ...saves: Reply[]) {
  const posts: { body: { email: string | null }; auth?: string }[] = [];
  await page.route("**/api/w/me", (route) => route.fulfill({ json: setup }));
  await page.route("**/api/w/me/tasks?*", (route) =>
    route.fulfill({ json: { paid_usd: 0, pending_usd: 0, tasks: [], next_cursor: null } }),
  );
  await page.route("**/api/w/me/email", (route) => {
    posts.push({ body: route.request().postDataJSON(), auth: route.request().headers().authorization });
    return route.fulfill(saves.shift() ?? { status: 500, json: {} });
  });
  await page.goto(`/me.html#c=${code}`);
  return posts;
}

const emailRow = (page: Page) => page.locator("#checks > li.me-email");

test("/me shows no email row while the API does not send the email fields", async ({ page }) => {
  await mockMe(page, base);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  await expect(emailRow(page)).toHaveCount(0);
});

const MAILTO = "mailto:work@example.test?subject=Eyes%20abc&body=Send%20this";

/** Mocks POST /w/me/email/start; records its auth headers and every mailto the page opens. */
async function mockStart(page: Page) {
  const starts: (string | undefined)[] = [];
  const opened: string[] = [];
  page.on("request", (r) => r.url().startsWith("mailto:") && opened.push(r.url()));
  await page.route("**/api/w/me/email/start", (route) => {
    starts.push(route.request().headers().authorization);
    return route.fulfill({ json: { mailto: MAILTO } });
  });
  return { starts, opened };
}

const GMAIL =
  "https://mail.google.com/mail/?view=cm&fs=1&to=work%40example.test&su=Eyes%20abc&body=Send%20this";
const OUTLOOK =
  "https://outlook.live.com/mail/0/deeplink/compose?to=work%40example.test&subject=Eyes%20abc&body=Send%20this";

for (const [state, button] of [
  ["none", "Add email"],
  ["pending", "Send again"],
  ["verified", "Change"],
] as const) {
  test(`/me ${state}: ${button} shows the email to send with Gmail, Outlook and the Mail app, and asks for no link`, async ({
    page,
  }) => {
    const { starts, opened } = await mockStart(page);
    const posts = await mockMe(page, withEmail(state, state === "none" ? null : MASKED));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const before = page.url();
    const row = emailRow(page);
    await row.getByRole("button", { name: button }).click();
    const panel = row.getByRole("group", { name: "Send one email to connect" });
    await expect(panel).toContainText("To:work@example.test");
    await expect(panel).toContainText("Subject:Eyes abc");
    await expect(panel).toContainText("Send it from the address you want to add. Then refresh this page.");
    // Desktop: Gmail first, then Outlook, then the Mail app; webmail in a new tab.
    const links = panel.getByRole("link");
    await expect(links).toHaveText(["Open Gmail", "Open Outlook", "Open Mail app"]);
    await expect(links.nth(0)).toHaveAttribute("href", GMAIL);
    await expect(links.nth(0)).toHaveAttribute("target", "_blank");
    await expect(links.nth(1)).toHaveAttribute("href", OUTLOOK);
    await expect(links.nth(2)).toHaveAttribute("href", MAILTO);
    await expect(row.getByRole("textbox")).toHaveCount(0);
    expect(opened).toEqual([]);
    expect(page.url()).toBe(before);
    expect(new URL(page.url()).hash).toBe("");
    expect(page.context().pages()).toHaveLength(1);
    expect(requests.every((url) => new URL(url).origin === new URL(before).origin)).toBe(true);
    expect(requests.some((url) => url.includes(code) || url.includes("Eyes%20abc"))).toBe(false);
    expect(starts).toEqual([`Bearer ${code}`]);
    expect(posts).toEqual([]);
  });
}

test("/me: Copy puts the address and subject on the clipboard and says Copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockStart(page);
  await mockMe(page, withEmail("none", null));
  const row = emailRow(page);
  await row.getByRole("button", { name: "Add email" }).click();
  const copies = row.getByRole("button", { name: /^Cop/ });
  await copies.nth(0).click();
  await expect(copies.nth(0)).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("work@example.test");
  await copies.nth(1).click();
  await expect(copies.nth(1)).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Eyes abc");
});

for (const unavailable of [false, true]) {
  test(`/me: clipboard ${unavailable ? "unavailable" : "denied"} gives a manual-copy instruction`, async ({
    page,
  }) => {
    await page.addInitScript((missing) => {
      Object.defineProperty(navigator, "clipboard", {
        value: missing ? undefined : { writeText: () => Promise.reject(new Error("denied")) },
      });
    }, unavailable);
    await mockStart(page);
    await mockMe(page, withEmail("none", null));
    const row = emailRow(page);
    await row.getByRole("button", { name: "Add email" }).click();
    await row.getByRole("button", { name: "Copy", exact: true }).first().click();
    await expect(row.getByRole("alert")).toContainText("Could not copy.");
    await expect(row.getByRole("alert")).toContainText("Select the To or Subject text and copy it manually.");
    await expect(row.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
  });
}

for (const [label, href] of [
  ["Open Gmail", GMAIL],
  ["Open Outlook", OUTLOOK],
] as const) {
  test(`/me: ${label} opens its compose URL only after an explicit click`, async ({ page, context }) => {
    const outgoing: { url: string; headers: Record<string, string> }[] = [];
    await context.route("https://mail.google.com/**", (route) => {
      outgoing.push({ url: route.request().url(), headers: route.request().headers() });
      return route.fulfill({ body: "Mock compose" });
    });
    await context.route("https://outlook.live.com/**", (route) => {
      outgoing.push({ url: route.request().url(), headers: route.request().headers() });
      return route.fulfill({ body: "Mock compose" });
    });
    await mockStart(page);
    await mockMe(page, withEmail("none", null));
    const before = page.url();
    await emailRow(page).getByRole("button", { name: "Add email" }).click();
    await expect(emailRow(page).getByRole("link", { name: label })).toBeVisible();
    expect(outgoing).toEqual([]);
    const opened = context.waitForEvent("page");
    await emailRow(page).getByRole("link", { name: label }).click();
    const popup = await opened;
    await expect(popup).toHaveURL(href);
    expect(page.url()).toBe(before);
    expect(outgoing).toEqual([{ url: href, headers: expect.any(Object) }]);
    expect(outgoing[0]?.headers.authorization).toBeUndefined();
    expect(outgoing[0]?.headers.referer).toBeUndefined();
    expect(href).not.toContain(code);
    await popup.close();
  });
}

test("/me: a malicious start response never becomes a provider link", async ({ page }) => {
  await page.route("**/api/w/me/email/start", (route) =>
    route.fulfill({ json: { mailto: "javascript:alert('secret')" } }),
  );
  await mockMe(page, withEmail("none", null));
  await emailRow(page).getByRole("button", { name: "Add email" }).click();
  await expect(emailRow(page).getByRole("alert")).toContainText("Eyes returned an invalid connect email.");
  await expect(emailRow(page).getByRole("group", { name: "Send one email to connect" })).toBeHidden();
  await expect(emailRow(page).getByRole("link")).toHaveCount(0);
  await expect(emailRow(page).getByRole("alert")).not.toContainText("secret");
});

test("/me on a phone: Open Mail app comes first and opens the mailto", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { opened } = await mockStart(page);
  await mockMe(page, withEmail("none", null));
  const row = emailRow(page);
  await row.getByRole("button", { name: "Add email" }).click();
  const links = row.getByRole("link");
  await expect(links).toHaveText(["Open Mail app", "Open Gmail", "Open Outlook"]);
  await links.nth(0).click();
  await expect.poll(() => opened).toEqual([MAILTO]);
});

test("/me on a phone: the full connect code wraps without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const subject = `Eyes ${"a".repeat(43)}`;
  await page.route("**/api/w/me/email/start", (route) =>
    route.fulfill({ json: { mailto: `mailto:work@example.test?subject=${encodeURIComponent(subject)}` } }),
  );
  await mockMe(page, withEmail("none", null));
  await emailRow(page).getByRole("button", { name: "Add email" }).click();
  await expect(emailRow(page).locator("span[data-field=subject]")).toHaveText(subject);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

/** SHOTS=<dir> saves the send panel at 390 and 1440 px, light and dark. */
test("/me send panel screenshots", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS not set");
  await mockStart(page);
  for (const width of [390, 1440])
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: scheme });
      await mockMe(page, withEmail("none", null));
      await emailRow(page).getByRole("button", { name: "Add email" }).click();
      await emailRow(page).screenshot({ path: `${process.env.SHOTS}/me-email-${width}-${scheme}.png` });
    }
});

test("/me none: Add email shows the API's words when it refuses", async ({ page }) => {
  await page.route("**/api/w/me/email/start", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "invalid_input", message: "Text START to the Eyes number first.", fix: "" },
    }),
  );
  await mockMe(page, withEmail("none", null));
  await emailRow(page).getByRole("button", { name: "Add email" }).click();
  await expect(emailRow(page).getByRole("alert")).toContainText("Text START to the Eyes number first.");
  await expect(emailRow(page).getByRole("button", { name: "Add email" })).not.toHaveAttribute("aria-busy");
});

test("/me none before START: says to text START first, offers nothing", async ({ page }) => {
  await mockMe(page, withEmail("none", null, { opted_in: false }));
  await expect(emailRow(page)).toContainText("Text START first, then add an email.");
  await expect(emailRow(page).getByRole("button")).toHaveCount(0);
});

test("/me pending: says to tap Send again and send the email", async ({ page }) => {
  await mockMe(page, withEmail("pending"));
  await expect(emailRow(page)).toContainText("Finish adding your email");
  await expect(emailRow(page)).toContainText(`Tap Send again, then send the email we open from ${MASKED}.`);
});

test("/me pending: Remove asks first; Keep it backs out, Remove email removes", async ({ page }) => {
  const posts = await mockMe(page, withEmail("pending"), { json: withEmail("none", null) });
  const row = emailRow(page);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByText("Stop sending tasks to this email? Texts keep coming.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove email" })).toBeFocused();
  await row.getByRole("button", { name: "Keep it" }).click();
  await expect(row.getByRole("button", { name: "Send again" })).toBeVisible();
  expect(posts).toEqual([]);
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove email" }).click();
  await expect(emailRow(page)).toContainText("Get tasks by email too");
  await expect(emailRow(page).getByRole("button", { name: "Add email" })).toBeFocused();
  expect(posts[0]?.body).toEqual({ email: null });
});

test("/me verified: shows the masked address with Change and Remove", async ({ page }) => {
  await mockMe(page, withEmail("verified"));
  const row = emailRow(page);
  await expect(row).toHaveClass(/ui-check--pass/);
  await expect(row).toContainText(`Tasks also go to ${MASKED}.`);
  await expect(row.getByRole("button", { name: "Change" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("/me: an expired code on save shows the expired page", async ({ page }) => {
  await mockMe(page, withEmail("verified"), { status: 401, json: { error: "unauthorized" } });
  await emailRow(page).getByRole("button", { name: "Remove" }).click();
  await emailRow(page).getByRole("button", { name: "Remove email" }).click();
  await expect(page.getByText("This link has expired.")).toBeVisible();
});

test("/login sends a link for any email and says to check the inbox", async ({ page }) => {
  const asks: object[] = [];
  await page.route("**/api/w/login/email", (route) => {
    const body = route.request().postDataJSON();
    if (!body.email) return route.fulfill({ status: 400, json: { error: "invalid_input" } });
    asks.push(body);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/login.html");
  const email = page.getByRole("textbox", { name: "Email" });
  await email.fill("ada@");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("That email does not look right.")).toBeVisible();
  await email.fill("ada@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your inbox.")).toBeVisible();
  await expect(page.getByText("If that email is on an Eyes account, we sent a sign-in link.")).toBeVisible();
  expect(asks).toEqual([{ email: "ada@example.com" }]);
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(email).toBeFocused();
  await expect(email).toHaveValue("");
});

test("/login shows the texted-link path while the API has no email sign-in", async ({ page }) => {
  await page.route("**/api/w/login/email", (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto("/login.html");
  await expect(page.getByText("Open your Eyes page with the link Eyes texts you.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text HELP for a new link" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=HELP",
  );
  await expect(page.getByRole("textbox", { name: "Email" })).toBeHidden();
});

test("/login#c= trades the code for the /me code and opens /me with it, never in a URL sent to a server", async ({
  page,
}) => {
  const trades: object[] = [];
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.route("**/api/w/login/code", (route) => {
    trades.push(route.request().postDataJSON());
    return route.fulfill({ json: { token: code } });
  });
  await page.route("**/api/w/me", (route) => route.fulfill({ json: withEmail("verified") }));
  await page.route("**/api/w/me/tasks?*", (route) =>
    route.fulfill({ json: { paid_usd: 0, pending_usd: 0, tasks: [], next_cursor: null } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  expect(trades).toEqual([{ code: loginCode }]);
  expect(new URL(page.url()).pathname).toBe("/me.html");
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((u) => u.includes(loginCode) || u.includes(code))).toEqual([]);
  await expect(emailRow(page)).toContainText(`Tasks also go to ${MASKED}.`);
});

test("/login#c= with a used or expired code says so and offers a new link", async ({ page }) => {
  await page.route("**/api/w/login/code", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByText("This link expired or was used. Request a new one.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("/login#c= on a rate limit shows the API's words, not the expired notice", async ({ page }) => {
  await page.route("**/api/w/login/code", (route) =>
    route.fulfill({ status: 429, json: { error: "rate_limited" } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByRole("alert")).toContainText("Too many");
  await expect(page.getByText("This link expired or was used.")).toBeHidden();
});
