import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseSkillMarkdown, SkillRegistry } from "../src/skills.js";
import { temporaryDirectory } from "./test-helpers.js";

test("parseSkillMarkdown reads Agent Skills frontmatter", () => {
  const parsed = parseSkillMarkdown(
    "---\nname: web-research\ndescription: Research current facts.\n---\n\n# Workflow\n\nUse sources.",
  );
  assert.equal(parsed.name, "web-research");
  assert.equal(parsed.description, "Research current facts.");
  assert.match(parsed.instructions, /Use sources/);
});

test("SkillRegistry loads instructions and scoped reference files", async () => {
  const temp = await temporaryDirectory("agent-skills-");
  const root = join(temp.path, "skills");
  const skill = join(root, "research");
  await mkdir(join(skill, "references"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: research\ndescription: Research public sources.\n---\n\nRead references/checklist.md.",
  );
  await writeFile(join(skill, "references", "checklist.md"), "Check two sources.");
  try {
    const registry = new SkillRegistry(root);
    assert.deepEqual(await registry.list(), [
      { name: "research", description: "Research public sources." },
    ]);
    const loaded = await registry.load("research");
    assert.match(loaded.instructions, /checklist/);
    assert.deepEqual(loaded.files, ["references/checklist.md"]);
    assert.equal(
      await registry.readFile("research", "references/checklist.md", 100),
      "Check two sources.",
    );
    await assert.rejects(() => registry.readFile("research", "../SKILL.md", 100));
  } finally {
    await temp.cleanup();
  }
});

test("SkillRegistry ignores malformed skills", async () => {
  const temp = await temporaryDirectory("agent-skills-invalid-");
  const root = join(temp.path, "skills");
  await mkdir(join(root, "broken"), { recursive: true });
  await writeFile(join(root, "broken", "SKILL.md"), "---\nname: BROKEN\n---\nNo description.");
  try {
    assert.deepEqual(await new SkillRegistry(root).list(), []);
  } finally {
    await temp.cleanup();
  }
});
