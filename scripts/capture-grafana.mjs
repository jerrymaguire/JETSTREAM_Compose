import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "scripts", "package.json"));
const { chromium } = require("playwright-core");
const chromePath =
  process.env.PLAYWRIGHT_CHROME ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const baseUrl = process.env.GRAFANA_URL ?? "http://127.0.0.1:8765";
const user = process.env.GRAFANA_ADMIN_USER;
const password = process.env.GRAFANA_ADMIN_PASSWORD;
const output = path.resolve(
  process.env.GRAFANA_SCREENSHOT ?? path.join(root, "check", "evidence", "grafana-dashboard.png"),
);

if (!user || !password) {
  throw new Error("GRAFANA_ADMIN_USER and GRAFANA_ADMIN_PASSWORD are required");
}

const basic = Buffer.from(`${user}:${password}`).toString("base64");
const dashboardResponse = await fetch(
  `${baseUrl}/api/dashboards/uid/agentcompose-overview`,
  { headers: { Authorization: `Basic ${basic}` } },
);
if (!dashboardResponse.ok) {
  throw new Error(`Grafana dashboard API returned ${dashboardResponse.status}`);
}
const dashboard = await dashboardResponse.json();
const panelCount = Array.isArray(dashboard.dashboard?.panels)
  ? dashboard.dashboard.panels.length
  : 0;
if (panelCount < 4) throw new Error(`Dashboard has only ${panelCount} panels`);

await mkdir(path.dirname(output), { recursive: true });
const candidates = [chromePath, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
let browser;
let lastError;
for (const executablePath of candidates) {
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    break;
  } catch (error) {
    lastError = error;
  }
}
if (!browser) throw lastError ?? new Error("No Chromium browser could be launched");
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  const inputs = page.locator("input");
  await inputs.first().waitFor({ timeout: 15_000 });
  if ((await inputs.count()) >= 2) {
    await inputs.nth(0).fill(user);
    await inputs.nth(1).fill(password);
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  }
  await page.goto(`${baseUrl}/d/agentcompose-overview/agentcompose-overview?from=now-15m&to=now`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(8_000);
  if (page.url().includes("/login")) {
    throw new Error("Grafana login did not complete");
  }
  await page.screenshot({ path: output, fullPage: true });
  console.log(JSON.stringify({ status: "captured", output, panelCount }));
} finally {
  await browser.close();
}
