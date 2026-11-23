import { resolve } from "node:path";
import type { AgentConfig } from "./types.js";

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("GATEWAY_BASE_URL must use http or https");
  }
  return value.replace(/\/+$/, "");
}

export function gatewayApiBaseUrl(config: Pick<AgentConfig, "gatewayBaseUrl">): string {
  return `${config.gatewayBaseUrl}/v1`;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AgentConfig {
  return {
    port: integer(env, "AGENT_PORT", 8080, 1, 65535),
    host: env.AGENT_HOST?.trim() || "0.0.0.0",
    gatewayBaseUrl: baseUrl(env.GATEWAY_BASE_URL?.trim() || "http://gateway:4000"),
    gatewayApiKey: required(env, "GATEWAY_API_KEY"),
    model: env.AGENT_MODEL?.trim() || "deepseek-flash",
    maxConcurrency: integer(env, "AGENT_MAX_CONCURRENCY", 4, 1, 128),
    queueCapacity: integer(env, "AGENT_QUEUE_CAPACITY", 32, 0, 4096),
    queueTimeoutMs: integer(env, "AGENT_QUEUE_TIMEOUT_MS", 2_000, 1, 600_000),
    runTimeoutMs: integer(env, "AGENT_RUN_TIMEOUT_MS", 90_000, 1_000, 3_600_000),
    gatewayTimeoutMs: integer(env, "AGENT_GATEWAY_TIMEOUT_MS", 80_000, 1_000, 3_600_000),
    dataDir: resolve(cwd, env.AGENT_DATA_DIR?.trim() || "data"),
    workspaceDir: resolve(cwd, env.AGENT_WORKSPACE_DIR?.trim() || "workspace"),
    skillsDir: resolve(cwd, env.AGENT_SKILLS_DIR?.trim() || "skills"),
    maxLoopTurns: integer(env, "AGENT_MAX_LOOP_TURNS", 8, 1, 32),
    maxToolCalls: integer(env, "AGENT_MAX_TOOL_CALLS", 16, 0, 128),
    toolTimeoutMs: integer(env, "AGENT_TOOL_TIMEOUT_MS", 20_000, 1_000, 120_000),
    webFetchMaxBytes: integer(
      env,
      "AGENT_WEB_FETCH_MAX_BYTES",
      1_000_000,
      10_000,
      5_000_000,
    ),
    toolOutputMaxChars: integer(
      env,
      "AGENT_TOOL_OUTPUT_MAX_CHARS",
      20_000,
      1_000,
      100_000,
    ),
    attachmentMaxBytes: integer(
      env,
      "AGENT_ATTACHMENT_MAX_BYTES",
      8_000_000,
      1_000,
      25_000_000,
    ),
    attachmentTotalMaxBytes: integer(
      env,
      "AGENT_ATTACHMENT_TOTAL_MAX_BYTES",
      20_000_000,
      1_000,
      50_000_000,
    ),
    attachmentMaxChars: integer(
      env,
      "AGENT_ATTACHMENT_MAX_CHARS",
      50_000,
      1_000,
      200_000,
    ),
    attachmentTotalMaxChars: integer(
      env,
      "AGENT_ATTACHMENT_TOTAL_MAX_CHARS",
      120_000,
      1_000,
      500_000,
    ),
    attachmentCountLimit: integer(env, "AGENT_ATTACHMENT_COUNT_LIMIT", 8, 1, 20),
    releaseId: env.RELEASE_ID?.trim() || "local-dev",
    version: env.AGENT_VERSION?.trim() || "1.0.0",
  };
}
