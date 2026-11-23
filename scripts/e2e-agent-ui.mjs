import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "check", "evidence");
const require = createRequire(path.join(root, "scripts", "package.json"));
const { chromium } = require("playwright-core");
const browserCandidates = [
  process.env.PLAYWRIGHT_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
await mkdir(evidenceDir, { recursive: true });

let browser;
let lastLaunchError;
for (const executablePath of browserCandidates) {
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    break;
  } catch (error) {
    lastLaunchError = error;
  }
}
if (!browser) throw lastLaunchError ?? new Error("No supported Chromium browser found");

const errors = [];
const summary = {
  status: "failed",
  url: "http://127.0.0.1:8080/ui/",
  desktopScreenshot: path.join(evidenceDir, "agent-ui.png"),
  mobileScreenshot: path.join(evidenceDir, "agent-ui-mobile.png"),
};

try {
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await desktop.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(summary.url, { waitUntil: "domcontentloaded" });
  await page.getByText("AGENT COMPOSE").waitFor();
  await page.locator("#service-status").getByText("服务正常").waitFor({ timeout: 15_000 });
  await page.locator(".skill-chip").first().waitFor({ timeout: 15_000 });
  await page.locator("#run-list .run-item").first().waitFor();
  const previousRunId = (await page.locator("#id-list .kv-row dd").first().innerText()).trim();
  await page.locator("#new-run-button").click();
  await page.locator("#empty-state").waitFor();

  await page.locator("#tenant-input").fill("ui-demo");
  await page.locator("#file-input").setInputFiles({
    name: "e2e-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# E2E notes\n\nThis attachment should be parsed."),
  });
  await page.locator(".attachment-item").first().waitFor();
  const skillName = (await page.locator(".skill-chip").first().innerText()).trim();
  await page.locator(".skill-chip").first().click();
  if (!(await page.locator("#input-field").inputValue()).includes(`@${skillName}`)) {
    throw new Error("Skill chip did not insert an @ reference");
  }
  await page.locator("#input-field").fill(
    `@${skillName} 用一句话总结附件，并在回答中标注“UI测试完成”。`,
  );
  await page.locator('[data-mode="stream"]').click();
  await page.locator("#submit-button").click();

  await page.waitForFunction(
    () => (document.querySelector("#response-output")?.textContent || "").trim().length > 0,
    undefined,
    { timeout: 120_000 },
  );
  summary.streamingObserved =
    (await page.locator("#metric-status").innerText()).trim() !== "completed";
  await page.locator("#metric-status").getByText("completed", { exact: true }).waitFor({
    timeout: 120_000,
  });
  await page.getByText("发送消息", { exact: true }).waitFor();
  const createdRunId = (await page.locator("#id-list .kv-row dd").first().innerText()).trim();
  const sessionId = (await page.locator("#session-id").innerText()).trim();
  if (!createdRunId || createdRunId === previousRunId) {
    throw new Error("UI did not switch to the newly submitted run");
  }
  const output = (await page.locator("#response-output").innerText()).trim();
  if (!output) throw new Error("UI response output is empty");
  const runInfo = await page.locator("#run-info").innerText();
  if (!runInfo.includes("e2e-notes.md") || !runInfo.includes(skillName)) {
    throw new Error("Attachments or referenced skills were not shown in Inspector");
  }

  await page.locator('[data-intent="task"]').click();
  await page.locator("#input-field").fill("请把上面的解释整理成三个要点。");
  await page.locator("#submit-button").click();
  await page.locator(".conversation-turn").nth(1).waitFor({ timeout: 120_000 });
  await page.getByText("发送消息", { exact: true }).waitFor({ timeout: 120_000 });
  const secondRunId = (await page.locator("#id-list .kv-row").nth(1).locator("dd").innerText()).trim();
  const sessionIdAfter = (await page.locator("#session-id").innerText()).trim();
  if (secondRunId === createdRunId || sessionIdAfter !== sessionId) {
    throw new Error("Multi-turn conversation did not reuse the same session");
  }
  const conversationTurns = await page.locator(".conversation-turn").count();
  if (conversationTurns !== 2) throw new Error("Conversation does not contain two turns");

  await page.locator('[data-tab="events"]').click();
  await page.locator(".event-row").first().waitFor();
  const eventCount = await page.locator(".event-row").count();
  if (eventCount < 3) throw new Error("UI event timeline is incomplete");

  await page.locator('[data-tab="raw"]').click();
  const raw = await page.locator("#raw-output").innerText();
  if (!raw.includes("\"run_id\"")) throw new Error("UI raw run view is incomplete");
  await page.locator('[data-tab="response"]').click();

  await page.screenshot({ path: summary.desktopScreenshot, fullPage: true });
  summary.outputLength = output.length;
  summary.eventCount = eventCount;
  summary.conversationTurns = conversationTurns;
  summary.sessionId = sessionIdAfter;
  summary.attachmentUploaded = true;
  summary.skillReference = skillName;

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const mobilePage = await mobile.newPage();
  mobilePage.on("pageerror", (error) => errors.push(`mobile pageerror: ${error.message}`));
  await mobilePage.goto(summary.url, { waitUntil: "domcontentloaded" });
  await mobilePage.getByLabel("打开 Run 列表").click();
  await mobilePage.locator(".workspace-shell.sidebar-open .sidebar").waitFor();
  const overflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) throw new Error("Mobile UI has horizontal overflow");
  await mobilePage.locator("#mobile-scrim").click();
  await mobilePage.getByLabel("切换详情栏").click();
  await mobilePage.locator("#inspector").waitFor();
  await mobilePage.screenshot({ path: summary.mobileScreenshot, fullPage: true });
  await mobile.close();

  const sessionItem = page.locator(`[data-session-id="${sessionIdAfter}"]`);
  await sessionItem.waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await sessionItem.hover();
  await sessionItem.locator(".session-delete").click();
  await sessionItem.waitFor({ state: "detached", timeout: 15_000 });
  summary.sessionDeleteVerified = true;
  await desktop.close();

  if (errors.length) throw new Error(errors.join("; "));
  summary.status = "passed";
  summary.browserErrors = errors;
  await writeFile(
    path.join(evidenceDir, "agent-ui-e2e.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  summary.browserErrors = errors;
  await writeFile(
    path.join(evidenceDir, "agent-ui-e2e.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.error(JSON.stringify(summary));
  process.exitCode = 1;
} finally {
  await browser.close();
}
