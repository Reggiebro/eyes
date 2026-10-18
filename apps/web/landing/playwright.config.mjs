import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: process.env.LANDING_URL ?? "http://127.0.0.1:4327" },
  webServer: process.env.LANDING_URL
    ? undefined
    : {
        command: "pnpm build && python3 -m http.server 4327 --bind 127.0.0.1 -d dist",
        cwd: import.meta.dirname,
        port: 4327,
        reuseExistingServer: !process.env.CI,
      },
});
