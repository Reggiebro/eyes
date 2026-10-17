import { execSync } from "node:child_process";

const input = JSON.parse(await new Response(process.stdin).text());
if (input?.stop_hook_active) process.exit(0);
const cwd = input?.cwd ?? process.cwd();
let branch = "";
try {
  branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
} catch {
  process.exit(0);
}
if (!branch.startsWith("feat/")) process.exit(0);
try {
  execSync("pnpm verify:fast", { cwd, stdio: "pipe", encoding: "utf8" });
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.split("\n").slice(-40).join("\n");
  console.error(`pnpm verify:fast failed on ${branch}. Fix it before finishing:\n${out}`);
  process.exit(2);
}
