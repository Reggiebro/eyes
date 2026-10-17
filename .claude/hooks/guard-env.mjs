import { basename } from "node:path";

const input = JSON.parse(await new Response(process.stdin).text());
const file = input?.tool_input?.file_path ?? "";
const name = basename(file);
if (/^\.env(\..+)?$/.test(name) && name !== ".env.example") {
  console.error(
    `Blocked: ${name} holds secrets and is edited by humans only. Use .env.example for variable names.`,
  );
  process.exit(2);
}
