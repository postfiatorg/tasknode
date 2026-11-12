#!/usr/bin/env node
// Restore the synthetic local acceptance session without printing credentials.
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
process.env.TMPDIR = path.join(root, ".tmp");
mkdirSync(process.env.TMPDIR, { recursive: true });
const fixture = JSON.parse(readFileSync(path.join(root, "artifacts/prompts/review-session.json"), "utf8"));
if (fixture.origin !== "http://localhost:3195") throw new Error("Only the local synthetic stack is allowed");
const require = createRequire(path.join(process.env.PFDOCS_ROOT || "/home/postfiat/repos/pftdocs", "package.json"));
const { chromium } = require("./artifacts/spike-browser/node_modules/playwright");
const browser = await chromium.launch({
  headless: !process.argv.includes("--headed"),
  executablePath:
    process.env.CHROMIUM_PATH || "/home/postfiat/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  args: ["--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=3197"],
});
const context = await browser.newContext({
  storageState: fixture.storageState,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
await page.goto(fixture.origin + "/#docs");
await page.getByRole("button", { name: "Unlock", exact: true }).click();
await page.getByLabel("Wallet unlock password").fill(fixture.password);
await page
  .getByRole("dialog", { name: "Unlock seed wallet" })
  .getByRole("button", { name: "Unlock", exact: true })
  .click();
await page.getByRole("button", { name: "Prompts", exact: true }).click();
await page.getByRole("region", { name: "Prompt statistics" }).waitFor();
console.log(
  "Synthetic review browser ready at http://localhost:3195/#docs; connect browser automation over http://127.0.0.1:3197",
);
await new Promise((resolve) => browser.on("disconnected", resolve));
