import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCapabilities,
  AgentConfig,
  AgentRunContext,
  AgentRunResult,
  AgentRunner,
  RunResult,
} from "../src/types.js";

export async function temporaryDirectory(prefix: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

export function testConfig(root: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    gatewayBaseUrl: "http://gateway:4000",
    gatewayApiKey: "test-gateway-key",
    model: "deepseek-flash",
    maxConcurrency: 2,
    queueCapacity: 4,
    queueTimeoutMs: 1_000,
    runTimeoutMs: 5_000,
    gatewayTimeoutMs: 4_000,
    dataDir: join(root, "data"),
    workspaceDir: join(root, "workspace"),
    skillsDir: join(root, "skills"),
    maxLoopTurns: 6,
    maxToolCalls: 12,
    toolTimeoutMs: 2_000,
    webFetchMaxBytes: 500_000,
    toolOutputMaxChars: 20_000,
    attachmentMaxBytes: 2_000_000,
    attachmentTotalMaxBytes: 5_000_000,
    attachmentMaxChars: 20_000,
    attachmentTotalMaxChars: 50_000,
    attachmentCountLimit: 8,
    releaseId: "test-release",
    version: "1.0.0-test",
    ...overrides,
  };
}

export function sampleResult(runId: string, status: RunResult["status"] = "queued"): RunResult {
  return {
    schema_version: 1,
    request_id: "req-test",
    trace_id: "a".repeat(32),
    run_id: runId,
    session_id: `session-${runId}`,
    model_call_id: null,
    tenant: "demo",
    input: "hello",
    model: "deepseek-flash",
    resolved_model: null,
    release_id: "test-release",
    status,
    task_mode: false,
    output: null,
    error_code: null,
    error_message: null,
    created_at: "2026-11-22T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    duration_ms: null,
    gateway_request_id: null,
    usage_available: false,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
  };
}

export class ImmediateRunner implements AgentRunner {
  async run(
    input: string,
    context: AgentRunContext,
    _signal: AbortSignal,
  ): Promise<AgentRunResult> {
    return {
      output: context.history.length
        ? `answer:${context.history.at(-1)?.input ?? ""}|${input}`
        : `answer:${input}`,
      model: "deepseek-v4-flash",
      gatewayRequestId: "gateway-request-1",
      usage: {
        available: true,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      toolCalls: [],
      turns: 1,
      skillsUsed: [],
      plan: [],
    };
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      tools: [],
      skills: [],
      limits: {
        maxLoopTurns: 6,
        maxToolCalls: 12,
        toolTimeoutMs: 2_000,
        maxAttachments: 8,
        maxAttachmentBytes: 2_000_000,
      },
      features: {
        streaming: true,
        attachmentKinds: ["markdown", "text", "html", "docx", "pdf", "web"],
      },
    };
  }
}
