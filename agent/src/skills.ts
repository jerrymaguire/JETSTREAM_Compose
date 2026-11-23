import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { resolveExistingPath } from "./safe-path.js";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_FILES = 100;
const MAX_SKILL_DEPTH = 4;
const MAX_SKILL_FILE_BYTES = 256_000;

export interface SkillSummary {
  name: string;
  description: string;
}

export interface LoadedSkill extends SkillSummary {
  instructions: string;
  files: string[];
}

interface SkillRecord extends SkillSummary {
  baseDir: string;
  skillFile: string;
}

interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseSkillMarkdown(source: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match?.[1] || !match[2]) throw new Error("SKILL.md requires frontmatter and instructions");
  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (field?.[1] && field[2] !== undefined) metadata.set(field[1], unquote(field[2]));
  }
  const name = metadata.get("name")?.trim() ?? "";
  const description = metadata.get("description")?.trim() ?? "";
  if (!SKILL_NAME.test(name)) throw new Error("skill name is invalid");
  if (!description) throw new Error("skill description is required");
  return { name, description, instructions: match[2].trim() };
}

async function listFiles(root: string, current = root, depth = 0): Promise<string[]> {
  if (depth > MAX_SKILL_DEPTH) return [];
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute, depth + 1)));
    } else if (entry.isFile() && entry.name !== "SKILL.md") {
      files.push(relative(root, absolute).split(sep).join("/"));
    }
    if (files.length >= MAX_SKILL_FILES) return files.slice(0, MAX_SKILL_FILES);
  }
  return files;
}

export class SkillRegistry {
  private cache: SkillRecord[] | null = null;

  constructor(readonly root: string) {}

  async reload(): Promise<SkillSummary[]> {
    const records = new Map<string, SkillRecord>();
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_SKILL_DEPTH) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
        const file = join(directory, "SKILL.md");
        try {
          const metadata = await stat(file);
          if (metadata.size <= MAX_SKILL_FILE_BYTES) {
            const parsed = parseSkillMarkdown(await readFile(file, "utf8"));
            if (!records.has(parsed.name)) {
              records.set(parsed.name, {
                name: parsed.name,
                description: parsed.description,
                baseDir: directory,
                skillFile: file,
              });
            }
          }
        } catch {
          // Invalid skills are ignored; the capabilities endpoint only exposes valid entries.
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          await visit(join(directory, entry.name), depth + 1);
        }
      }
    };
    await visit(this.root, 0);
    this.cache = [...records.values()].sort((left, right) => left.name.localeCompare(right.name));
    return this.list();
  }

  async list(): Promise<SkillSummary[]> {
    if (!this.cache) await this.reload();
    return (this.cache ?? []).map(({ name, description }) => ({ name, description }));
  }

  async load(name: string): Promise<LoadedSkill> {
    if (!this.cache) await this.reload();
    const record = this.cache?.find((skill) => skill.name === name);
    if (!record) throw new Error(`skill not found: ${name}`);
    const parsed = parseSkillMarkdown(await readFile(record.skillFile, "utf8"));
    return {
      name: record.name,
      description: record.description,
      instructions: parsed.instructions,
      files: await listFiles(record.baseDir),
    };
  }

  async readFile(name: string, path: string, maxChars: number): Promise<string> {
    if (!this.cache) await this.reload();
    const record = this.cache?.find((skill) => skill.name === name);
    if (!record) throw new Error(`skill not found: ${name}`);
    const file = await resolveExistingPath(record.baseDir, path);
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error("skill path is not a file");
    if (metadata.size > MAX_SKILL_FILE_BYTES) throw new Error("skill file is too large");
    return (await readFile(file, "utf8")).slice(0, Math.max(1, maxChars));
  }
}
