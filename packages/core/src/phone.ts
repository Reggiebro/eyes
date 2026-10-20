export function toE164(input: string): string | null {
  const digits = input.replace(/^(\s*\+[1-9]\d{0,2})\s*\(0\)/, "$1").replace(/\D/g, "");
  const e164 = input.trim().startsWith("+") ? `+${digits}` : `+1${digits.replace(/^1(?=\d{10}$)/, "")}`;
  return /^\+(1[2-9]\d\d[2-9]\d{6}|[2-9]\d{6,14})$/.test(e164) ? e164 : null;
}
