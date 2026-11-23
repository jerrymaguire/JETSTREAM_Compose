import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentPlanItem, AgentRunContext } from "./types.js";
import { resolveExistingPath, resolveWritablePath } from "./safe-path.js";
import type { SkillRegistry } from "./skills.js";
import { fetchWebPage, searchWeb } from "./web.js";

export interface ToolCatalogEntry {
  name: string;
  label: string;
  description: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: "web_search",
    label: "Web Search",
    description: "Search the public web for current information and source URLs.",
  },
  {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a public web page and return readable text with a size limit.",
  },
  {
    name: "workspace_list",
    label: "List Workspace",
    description: "List files in the Agent's isolated workspace.",
  },
  {
    name: "workspace_read",
    label: "Read Workspace File",
    description: "Read a UTF-8 text file from the Agent workspace.",
  },
  {
    name: "workspace_write",
    label: "Write Workspace File",
    description: "Create or append a UTF-8 text artifact inside the Agent workspace.",
  },
  {
    name: "update_plan",
    label: "Update Plan",
    description: "Create or update a concise multi-step execution plan.",
  },
  {
    name: "load_skill",
    label: "Load Skill",
    description: "Load the full instructions for an available Agent Skill.",
  },
  {
    name: "read_skill_file",
    label: "Read Skill File",
    description: "Read a reference, script, or asset bundled with a loaded skill.",
  },
];

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

async function workspaceFiles(root: string, maxDepth: number): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || output.length >= 200) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, depth + 1);
      else if (entry.isFile()) output.push(relative(root, file).split(sep).join("/"));
      if (output.length >= 200) break;
    }
  };
  await mkdir(root, { recursive: true });
  await visit(root, 0);
  return output;
}

export function createAgentTools(
  config: AgentConfig,
  skills: SkillRegistry,
  context: AgentRunContext,
  plan: AgentPlanItem[],
  skillsUsed: Set<string>,
): AgentTool<any>[] {
  const webSearch: AgentTool<any> = {
    name: "web_search",
    label: "Web Search",
    description: TOOL_CATALOG.find((tool) => tool.name === "web_search")!.description,
    parameters: objectSchema(
      {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", minimum: 1, maximum: 8, default: 5 },
      },
      ["query"],
    ),
    executionMode: "parallel",
    execute: async (_id, params, signal) => {
      const query = String(params.query ?? "").trim();
      if (!query || query.length > 500) throw new Error("query must contain 1 to 500 characters");
      const results = await searchWeb(query, {
        maxResults: Number(params.max_results ?? 5),
        ...(signal ? { signal } : {}),
        timeoutMs: config.toolTimeoutMs,
      });
      return textResult(
        "UNTRUSTED SEARCH RESULTS\n\n" + results.map((result, index) =>
          `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`,
        ).join("\n\n"),
        { query, results },
      );
    },
  };

  const webFetch: AgentTool<any> = {
    name: "web_fetch",
    label: "Web Fetch",
    description: TOOL_CATALOG.find((tool) => tool.name === "web_fetch")!.description,
    parameters: objectSchema(
      {
        url: { type: "string", description: "Public HTTP or HTTPS URL" },
        max_chars: { type: "integer", minimum: 500, maximum: 50_000, default: 15_000 },
      },
      ["url"],
    ),
    executionMode: "parallel",
    execute: async (_id, params, signal) => {
      const page = await fetchWebPage(String(params.url ?? ""), {
        maxBytes: config.webFetchMaxBytes,
        maxChars: Number(params.max_chars ?? 15_000),
        ...(signal ? { signal } : {}),
        timeoutMs: config.toolTimeoutMs,
      });
      return textResult(
        `UNTRUSTED WEB PAGE\nURL: ${page.url}\nTitle: ${page.title || "(untitled)"}\n\n${page.text}`,
        { title: page.title, url: page.url, contentType: page.contentType, chars: page.text.length },
      );
    },
  };

  const workspaceList: AgentTool<any> = {
    name: "workspace_list",
    label: "List Workspace",
    description: TOOL_CATALOG.find((tool) => tool.name === "workspace_list")!.description,
    parameters: objectSchema(
      { depth: { type: "integer", minimum: 0, maximum: 4, default: 2 } },
      [],
    ),
    execute: async (_id, params) => {
      const files = await workspaceFiles(config.workspaceDir, Number(params.depth ?? 2));
      return textResult(files.length ? files.join("\n") : "(workspace is empty)", {
        count: files.length,
        files,
      });
    },
  };

  const workspaceRead: AgentTool<any> = {
    name: "workspace_read",
    label: "Read Workspace File",
    description: TOOL_CATALOG.find((tool) => tool.name === "workspace_read")!.description,
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        max_chars: { type: "integer", minimum: 1, maximum: 50_000, default: 20_000 },
      },
      ["path"],
    ),
    execute: async (_id, params) => {
      const file = await resolveExistingPath(config.workspaceDir, String(params.path ?? ""));
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new Error("workspace path is not a file");
      if (metadata.size > config.toolOutputMaxChars * 4) throw new Error("workspace file is too large");
      const text = (await readFile(file, "utf8")).slice(
        0,
        Number(params.max_chars ?? config.toolOutputMaxChars),
      );
      return textResult(text, { path: String(params.path), chars: text.length });
    },
  };

  const workspaceWrite: AgentTool<any> = {
    name: "workspace_write",
    label: "Write Workspace File",
    description: TOOL_CATALOG.find((tool) => tool.name === "workspace_write")!.description,
    parameters: objectSchema(
      {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "UTF-8 text to write" },
        mode: { type: "string", enum: ["overwrite", "append"], default: "overwrite" },
      },
      ["path", "content"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const path = String(params.path ?? "");
      const content = String(params.content ?? "");
      if (content.length > config.toolOutputMaxChars) {
        throw new Error(`content exceeds ${config.toolOutputMaxChars} characters`);
      }
      const file = await resolveWritablePath(config.workspaceDir, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, {
        encoding: "utf8",
        flag: params.mode === "append" ? "a" : "w",
      });
      const size = (await stat(file)).size;
      return textResult(`Wrote ${content.length} characters to ${path}`, { path, size });
    },
  };

  const updatePlan: AgentTool<any> = {
    name: "update_plan",
    label: "Update Plan",
    description: TOOL_CATALOG.find((tool) => tool.name === "update_plan")!.description,
    parameters: objectSchema(
      {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      ["steps"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const steps = Array.isArray(params.steps) ? params.steps : [];
      plan.splice(
        0,
        plan.length,
        ...steps.slice(0, 12).map((item: unknown) => {
          const value = item as { step?: unknown; status?: unknown };
          const status = value.status === "completed" || value.status === "in_progress"
            ? value.status
            : "pending";
          return { step: String(value.step ?? "").slice(0, 500), status };
        }).filter((item: AgentPlanItem) => item.step),
      );
      return textResult(
        plan.map((item) => `[${item.status}] ${item.step}`).join("\n"),
        { plan },
      );
    },
  };

  const loadSkill: AgentTool<any> = {
    name: "load_skill",
    label: "Load Skill",
    description: TOOL_CATALOG.find((tool) => tool.name === "load_skill")!.description,
    parameters: objectSchema(
      { name: { type: "string", description: "Exact skill name" } },
      ["name"],
    ),
    executionMode: "sequential",
    execute: async (_id, params) => {
      const name = String(params.name ?? "");
      const skill = await skills.load(name);
      skillsUsed.add(skill.name);
      const files = skill.files.length
        ? skill.files.map((file) => `- ${file}`).join("\n")
        : "(no bundled files)";
      return textResult(
        `# ${skill.name}\n${skill.description}\n\n${skill.instructions}\n\nBundled files:\n${files}`,
        { name: skill.name, files: skill.files },
      );
    },
  };

  const readSkillFile: AgentTool<any> = {
    name: "read_skill_file",
    label: "Read Skill File",
    description: TOOL_CATALOG.find((tool) => tool.name === "read_skill_file")!.description,
    parameters: objectSchema(
      {
        name: { type: "string", description: "Exact skill name" },
        path: { type: "string", description: "Skill-relative file path" },
        max_chars: { type: "integer", minimum: 1, maximum: 50_000, default: 15_000 },
      },
      ["name", "path"],
    ),
    execute: async (_id, params) => {
      const name = String(params.name ?? "");
      const path = String(params.path ?? "");
      const content = await skills.readFile(
        name,
        path,
        Number(params.max_chars ?? config.toolOutputMaxChars),
      );
      skillsUsed.add(name);
      return textResult(content, { name, path, chars: content.length });
    },
  };

  return [
    webSearch,
    webFetch,
    workspaceList,
    workspaceRead,
    workspaceWrite,
    updatePlan,
    loadSkill,
    readSkillFile,
  ];
}
