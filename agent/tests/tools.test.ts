import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { SkillRegistry } from "../src/skills.js";
import { createAgentTools } from "../src/tools.js";
import type { AgentPlanItem, AgentRunContext } from "../src/types.js";
import { temporaryDirectory, testConfig } from "./test-helpers.js";

function context(): AgentRunContext {
  return {
    requestId: "req-tools",
    runId: "run-tools",
    sessionId: "session-tools",
    traceId: "a".repeat(32),
    modelCallId: "model-call-tools",
    deadline: Date.now() + 5_000,
    taskMode: true,
    history: [],
  };
}

test("workspace tools write, list and read artifacts inside the workspace", async () => {
  const temp = await temporaryDirectory("agent-tools-");
  const config = testConfig(temp.path);
  const skills = new SkillRegistry(config.skillsDir);
  const plan: AgentPlanItem[] = [];
  const skillsUsed = new Set<string>();
  const tools = createAgentTools(config, skills, context(), plan, skillsUsed);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  try {
    const write = await byName.get("workspace_write")?.execute(
      "write-1",
      { path: "reports/brief.md", content: "# Brief\n\nSaved.", mode: "overwrite" },
    );
    const writeText = write?.content[0]?.type === "text" ? write.content[0].text : "";
    assert.match(writeText, /Wrote/);

    const list = await byName.get("workspace_list")?.execute("list-1", { depth: 3 });
    const listText = list?.content[0]?.type === "text" ? list.content[0].text : "";
    assert.match(listText, /reports\/brief\.md/);

    const read = await byName.get("workspace_read")?.execute(
      "read-1",
      { path: "reports/brief.md", max_chars: 1_000 },
    );
    const readText = read?.content[0]?.type === "text" ? read.content[0].text : "";
    assert.match(readText, /Saved/);

    await assert.rejects(() =>
      byName.get("workspace_read")!.execute("read-2", { path: "../secrets.txt" }),
    );
  } finally {
    await temp.cleanup();
  }
});

test("plan and skill tools update run-visible state", async () => {
  const temp = await temporaryDirectory("agent-tools-capabilities-");
  const config = testConfig(temp.path);
  const skillDir = join(config.skillsDir, "research");
  await mkdir(join(skillDir, "references"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: research\ndescription: Research public sources.\n---\n\nRead references/checklist.md.",
  );
  await writeFile(join(skillDir, "references", "checklist.md"), "Use primary sources.");
  const skills = new SkillRegistry(config.skillsDir);
  const plan: AgentPlanItem[] = [];
  const skillsUsed = new Set<string>();
  const tools = createAgentTools(config, skills, context(), plan, skillsUsed);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  try {
    await byName.get("update_plan")?.execute("plan-1", {
      steps: [
        { step: "Collect sources", status: "in_progress" },
        { step: "Write answer", status: "pending" },
      ],
    });
    assert.deepEqual(plan[0], { step: "Collect sources", status: "in_progress" });

    const loaded = await byName.get("load_skill")?.execute("skill-1", { name: "research" });
    const loadedText = loaded?.content[0]?.type === "text" ? loaded.content[0].text : "";
    assert.match(loadedText, /references\/checklist\.md/);
    const reference = await byName.get("read_skill_file")?.execute("skill-2", {
      name: "research",
      path: "references/checklist.md",
    });
    const referenceText =
      reference?.content[0]?.type === "text" ? reference.content[0].text : "";
    assert.match(referenceText, /primary sources/);
    assert.deepEqual([...skillsUsed], ["research"]);
  } finally {
    await temp.cleanup();
  }
});
