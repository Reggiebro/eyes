import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function qualityPasses(output: string, status: number | null): boolean {
  const quality = output.match(/^Quality:\s+(\d+)\s*->\s*(\d+)\s*$/m);
  return (
    status === 0 &&
    !/\bDEGRADED\b/.test(output) &&
    quality !== null &&
    Number(quality[1]) - Number(quality[2]) <= 250
  );
}

if (import.meta.main) {
  if (!existsSync(".sentrux/baseline.json")) {
    console.error("Missing required .sentrux/baseline.json");
    process.exit(1);
  }
  const result = spawnSync("sentrux", ["gate", "."], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(output);
  if (result.error) console.error(result.error.message);
  if (!qualityPasses(output, result.status)) {
    console.error("Sentrux failed: DEGRADED, quality drop over 250, or no valid comparison.");
    process.exit(1);
  }
}
