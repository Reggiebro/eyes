import type { WorkerSetup } from "@eyes/core";
import { Problem } from "./api.ts";

export type Send = (path: string, init: RequestInit) => Promise<unknown>;

export type EmailAction = "add" | "resend" | "change" | "remove";

/** The Email row on /me: the optional second channel, so it never counts toward "Finish setting up". */
export type EmailRow = {
  status: WorkerSetup["email_status"];
  title: string;
  detail: string;
  actions: EmailAction[];
};

export const validEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);

const post = (body: unknown, code?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(code && { Authorization: `Bearer ${code}` }) },
  body: JSON.stringify(body),
});

/** Every email error body carries a message and fix written for the worker; prefer them over the generic words. */
function worded(err: unknown): unknown {
  if (!(err instanceof Problem) || !err.body?.message) return err;
  return new Problem(err.body.message, err.body.fix ?? err.fix, err.status, err.body);
}

/** True when the API serves worker email: an empty sign-in request answers 400 there and 404 before. */
export async function emailOn(send: Send): Promise<boolean> {
  try {
    await send("/w/login/email", post({}));
    return true;
  } catch (err) {
    return err instanceof Problem && err.status !== 0 && err.status !== 404;
  }
}

export function emailRow(s: WorkerSetup): EmailRow | null {
  const masked = s.email_masked ?? "your email";
  // An API that predates worker email sends neither field: show no row.
  switch (s.email_status) {
    case "none":
      return s.opted_in
        ? {
            status: "none",
            title: "Get tasks by email too",
            detail: "Optional. Texts keep coming.",
            actions: ["add"],
          }
        : {
            status: "none",
            title: "Get tasks by email too",
            detail: "Text START first, then add an email.",
            actions: [],
          };
    case "pending":
      return s.opted_in
        ? {
            status: "pending",
            title: "Finish adding your email",
            detail: `Tap Send again, then send the email we open from ${masked}.`,
            actions: ["resend", "remove"],
          }
        : {
            status: "pending",
            title: "Email waiting for START",
            detail: `We'll email you a link to confirm ${s.email_masked ?? "it"} after you text START.`,
            actions: ["remove"],
          };
    case "verified":
      return {
        status: "verified",
        title: "Email on",
        detail: `Tasks also go to ${masked}.`,
        actions: ["change", "remove"],
      };
    default:
      return null;
  }
}

/** With null, removes the email (an address would mail a confirmation link; /me adds by mailto instead). */
export async function saveEmail(code: string, email: string | null, send: Send): Promise<WorkerSetup> {
  try {
    return (await send("/w/me/email", post({ email }, code))) as WorkerSetup;
  } catch (err) {
    throw worded(err);
  }
}

/** Starts adding by email: answers a mailto to Eyes; once the worker sends it, the sender's address is on, verified. */
export async function startEmail(code: string, send: Send): Promise<string> {
  try {
    const { mailto } = (await send("/w/me/email/start", {
      method: "POST",
      headers: { Authorization: `Bearer ${code}` },
    })) as { mailto: string };
    return mailto;
  } catch (err) {
    throw worded(err);
  }
}

/** Asks for a sign-in link. The API answers 200 whether or not the email is on an account. */
export async function sendLink(email: string, send: Send): Promise<void> {
  try {
    await send("/w/login/email", post({ email }));
  } catch (err) {
    throw worded(err);
  }
}

/** Trades the one-time code from an emailed link for the worker's /me code, then opens /me with it. */
export async function signIn(
  code: string,
  d: { send: Send; navigate: (url: string) => void },
): Promise<void> {
  const { token } = (await d.send("/w/login/code", post({ code }))) as { token: string };
  d.navigate(`me.html#c=${token}`);
}

/** The connect email, read out of the API's mailto so /me can show it and offer webmail. */
export type Compose = { to: string; subject: string; body: string; mailto: string };

export function parseMailto(mailto: string): Compose {
  try {
    if (typeof mailto !== "string" || /\s/.test(mailto) || mailto.includes("#")) throw new Error();
    decodeURIComponent(mailto); // Reject malformed escapes rather than silently changing the connect code.
    const url = new URL(mailto);
    const to = decodeURIComponent(url.pathname);
    if (
      url.protocol !== "mailto:" ||
      !validEmail(to) ||
      !/^[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(to)
    )
      throw new Error();
    const fields = new Map<string, string>();
    for (const [key, value] of url.searchParams) {
      const name = key.toLowerCase();
      if (!["subject", "body"].includes(name) || fields.has(name) || value.includes("\0")) throw new Error();
      fields.set(name, value);
    }
    const subject = fields.get("subject") ?? "";
    if (/[\r\n]/.test(subject)) throw new Error();
    return { to, subject, body: fields.get("body") ?? "", mailto };
  } catch {
    throw new Problem("Eyes returned an invalid connect email.", "Try Add email again.");
  }
}

export type ComposeLink = { id: "gmail" | "outlook" | "mail"; label: string; href: string; newTab: boolean };

/** True on a phone: narrow screen or iOS, where the Mail app is the likely sender. */
export const onPhone = (userAgent: string, width: number) =>
  width < 640 || /iPhone|iPad|iPod/.test(userAgent);

/** Gmail, Outlook and the Mail app, so the email can go out with no mail app set up; the likeliest one first. */
export function composeLinks(c: Compose, phone: boolean): ComposeLink[] {
  const e = encodeURIComponent;
  const gmail: ComposeLink = {
    id: "gmail",
    label: "Open Gmail",
    href: `https://mail.google.com/mail/?view=cm&fs=1&to=${e(c.to)}&su=${e(c.subject)}&body=${e(c.body)}`,
    newTab: true,
  };
  const outlook: ComposeLink = {
    id: "outlook",
    label: "Open Outlook",
    href: `https://outlook.live.com/mail/0/deeplink/compose?to=${e(c.to)}&subject=${e(c.subject)}&body=${e(c.body)}`,
    newTab: true,
  };
  const mail: ComposeLink = { id: "mail", label: "Open Mail app", href: c.mailto, newTab: false };
  return phone ? [mail, gmail, outlook] : [gmail, outlook, mail];
}
