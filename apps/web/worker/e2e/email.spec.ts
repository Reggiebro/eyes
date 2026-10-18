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

test("/me none: Add email opens the API's mailto, then says to send it and refresh", async ({ page }) => {
  const starts: (string | undefined)[] = [];
  const opened: string[] = [];
  page.on("request", (r) => r.url().startsWith("mailto:") && opened.push(r.url()));
  await page.route("**/api/w/me/email/start", (route) => {
    starts.push(route.request().headers().authorization);
    return route.fulfill({ json: { mailto: "mailto:work@example.test?subject=Eyes%20abc" } });
  });
  const posts = await mockMe(page, withEmail("none", null));
  const row = emailRow(page);
  await expect(row).toContainText("Get tasks by email too");
  await row.getByRole("button", { name: "Add email" }).click();
  await expect(row).toContainText("Check: send the email we opened, then refresh.");
  await expect(row.getByRole("textbox")).toBeHidden();
  await expect.poll(() => opened).toEqual(["mailto:work@example.test?subject=Eyes%20abc"]);
  expect(starts).toEqual([`Bearer ${code}`]);
  expect(posts).toEqual([]);
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

test("/me pending from an earlier visit: Resend asks for the address again", async ({ page }) => {
  const posts = await mockMe(page, withEmail("pending"), { json: withEmail("pending") });
  const row = emailRow(page);
  await row.getByRole("button", { name: "Resend link" }).click();
  await expect(row.getByText("Enter it again to resend the link.")).toBeVisible();
  await row.getByRole("textbox", { name: "Email" }).fill("ada@example.com");
  await row.getByRole("button", { name: "Send link" }).click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(emailRow(page)).toContainText("Check your inbox");
});

test("/me pending: Remove asks first; Keep it backs out, Remove email removes", async ({ page }) => {
  const posts = await mockMe(page, withEmail("pending"), { json: withEmail("none", null) });
  const row = emailRow(page);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByText("Stop sending tasks to this email? Texts keep coming.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove email" })).toBeFocused();
  await row.getByRole("button", { name: "Keep it" }).click();
  await expect(row.getByRole("button", { name: "Resend link" })).toBeVisible();
  expect(posts).toEqual([]);
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove email" }).click();
  await expect(emailRow(page)).toContainText("Get tasks by email too");
  await expect(emailRow(page).getByRole("button", { name: "Add email" })).toBeFocused();
  expect(posts[0]?.body).toEqual({ email: null });
});

test("/me verified: shows the masked address; Change shows the API's words when the email is taken", async ({
  page,
}) => {
  await mockMe(page, withEmail("verified"), {
    status: 409,
    json: {
      error: "email_taken",
      message: "Another account uses that email.",
      fix: "Use a different email.",
    },
  });
  const row = emailRow(page);
  await expect(row).toHaveClass(/ui-check--pass/);
  await expect(row).toContainText(`Tasks also go to ${MASKED}.`);
  await row.getByRole("button", { name: "Change" }).click();
  await row.getByRole("textbox", { name: "Email" }).fill("taken@example.com");
  await row.getByRole("button", { name: "Send link" }).click();
  await expect(row.getByRole("alert")).toContainText("Another account uses that email.");
  await expect(row.getByRole("alert")).toContainText("Use a different email.");
  await expect(row.getByRole("button", { name: "Send link" })).not.toHaveAttribute("aria-busy");
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
