import type { WorkerSetup } from "@eyes/core";
import { describe, expect, it, vi } from "vitest";
import { Problem } from "./api.ts";
import { emailOn, emailRow, removeEmail, sendLink, signIn, validEmail } from "./email.ts";

// No email fields by default: what an API that predates worker email sends.
const setup = (over: Partial<WorkerSetup> = {}) =>
  ({
    opted_in: true,
    spot: { at: null, fresh: false, max_age_h: 24 },
    app: { last_at: null, sending: false },
    payouts: { set_up: false, live: false, setup_url: null },
    here_url: "https://app.eyes.test/here.html?t=h.t",
    ...over,
  }) as WorkerSetup;

const refuse = (status: number, body: object | null = null) =>
  vi.fn().mockRejectedValue(new Problem("x", "y", status, body));

describe("validEmail", () => {
  it.each([
    ["ada@example.com", true],
    ["a.b+tag@mail.example.co.uk", true],
    ["ada@example", false],
    ["ada@", false],
    ["@example.com", false],
    ["ada @example.com", false],
    ["ada@example..com", false],
    [`${"a".repeat(250)}@b.co`, false],
  ])("validEmail(%j) is %j", (s, ok) => expect(validEmail(s)).toBe(ok));
});

describe("emailOn", () => {
  it("is on when the empty probe is refused as invalid, or accepted", async () => {
    const send = refuse(400);
    expect(await emailOn(send)).toBe(true);
    expect(send).toHaveBeenCalledWith(
      "/w/login/email",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(await emailOn(vi.fn().mockResolvedValue({ ok: true }))).toBe(true);
  });

  it("is off when the route is missing or Eyes is unreachable", async () => {
    expect(await emailOn(refuse(404))).toBe(false);
    expect(await emailOn(refuse(0))).toBe(false);
    expect(await emailOn(vi.fn().mockRejectedValue(new TypeError("boom")))).toBe(false);
  });
});

describe("emailRow", () => {
  it("is null while the API does not send the email fields", () => {
    expect(emailRow(setup())).toBeNull();
  });

  it.each([true, false])("gives text-first onboarding with opted_in=%j", (opted_in) => {
    const instruction = "Text EMAIL to Eyes in iMessage. We’ll reply with a link to send your first email.";
    expect(emailRow(setup({ opted_in, email_status: "none", email_masked: null }))).toEqual({
      status: "none",
      title: "Get tasks by email too",
      detail: instruction,
      removable: false,
    });
    expect(emailRow(setup({ opted_in, email_status: "pending", email_masked: "a…@example.com" }))).toEqual({
      status: "pending",
      title: "Finish adding your email",
      detail: instruction,
      removable: true,
    });
    expect(emailRow(setup({ opted_in, email_status: "verified", email_masked: "a…@example.com" }))).toEqual({
      status: "verified",
      title: "Email on",
      detail: `Tasks also go to a…@example.com. ${instruction}`,
      removable: true,
    });
  });
});

describe("removeEmail", () => {
  it("posts null with the code in the header and answers the updated setup", async () => {
    const next = setup({ email_status: "none", email_masked: null });
    const send = vi.fn().mockResolvedValue(next);
    expect(await removeEmail("c.d", send)).toBe(next);
    expect(send).toHaveBeenCalledWith("/w/me/email", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer c.d" },
      body: '{"email":null}',
    });
  });

  it("shows the API's own message and fix, keeping the status", async () => {
    const err = await removeEmail(
      "c.d",
      refuse(400, { error: "invalid_input", message: "Email removal failed.", fix: "Try again." }),
    ).catch((e) => e);
    expect(err).toMatchObject({
      message: "Email removal failed.",
      fix: "Try again.",
      status: 400,
    });
    const noFix = await removeEmail("c.d", refuse(400, { message: "Email removal failed." })).catch((e) => e);
    expect(noFix).toMatchObject({ message: "Email removal failed.", fix: "y" });
  });

  it("passes other failures through unchanged", async () => {
    const plain = new Problem("Could not reach Eyes.", "Check your signal.");
    await expect(removeEmail("c.d", vi.fn().mockRejectedValue(plain))).rejects.toBe(plain);
    const boom = new TypeError("boom");
    await expect(removeEmail("c.d", vi.fn().mockRejectedValue(boom))).rejects.toBe(boom);
  });
});

describe("sendLink", () => {
  it("posts the email without a code", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await sendLink("ada@example.com", send);
    expect(send).toHaveBeenCalledWith("/w/login/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"email":"ada@example.com"}',
    });
  });

  it("words a refusal with the API's message", async () => {
    await expect(sendLink("x", refuse(400, { message: "Enter a valid email." }))).rejects.toMatchObject({
      message: "Enter a valid email.",
    });
  });
});

describe("signIn", () => {
  it("trades the code for the /me code and opens /me with it in the fragment", async () => {
    const send = vi.fn().mockResolvedValue({ token: "e.t" });
    const navigate = vi.fn();
    await signIn("c".repeat(43), { send, navigate });
    expect(send).toHaveBeenCalledWith(
      "/w/login/code",
      expect.objectContaining({ body: `{"code":"${"c".repeat(43)}"}` }),
    );
    expect(navigate).toHaveBeenCalledWith("me.html#c=e.t");
  });

  it("does not navigate when the code is refused", async () => {
    const navigate = vi.fn();
    await expect(signIn("x", { send: refuse(401), navigate })).rejects.toMatchObject({ status: 401 });
    expect(navigate).not.toHaveBeenCalled();
  });
});
