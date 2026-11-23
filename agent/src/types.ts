export type RunStatus = "queued" | "running" | "completed" | "failed";
export type RunMode = "sync" | "async";
export type AttachmentKind =
  | "markdown"
  | "text"
  | "html"
  | "docx"
  | "pdf"
  | "web";

export interface AgentConfig {
  port: number;
  host: string;
  gatewayBaseUrl: string;
  gatewayApiKey: string;
  model: string;
  maxConcurrency: number;
  queueCapacity: number;
  queueTimeoutMs: number;
  runTimeoutMs: number;
  gatewayTimeoutMs: number;
  dataDir: string;
  workspaceDir: string;
  skillsDir: string;
  maxLoopTurns: number;
  maxToolCalls: number;
  toolTimeoutMs: number;
  webFetchMaxBytes: number;
  toolOutputMaxChars: number;
  attachmentMaxBytes: number;
  attachmentTotalMaxBytes: number;
  attachmentMaxChars: number;
  attachmentTotalMaxChars: number;
  attachmentCountLimit: number;
  releaseId: string;
  version: string;
}

export interface RunInputDocument {
  schema_version: 1;
  request_id: string;
  trace_id: string;
  run_id: string;
  session_id: string;
  tenant: string;
  input: string;
  async_mode: boolean;
  task_mode: boolean;
  mode: RunMode;
  model: string;
  release_id: string;
  created_at: string;
  attachments?: RunAttachment[];
}

export interface RunVersionsDocument {
  release_id: string;
  agent_version: string;
  model_alias: string;
  gateway_base_url: string;
  node_version: string;
}

export interface RunUsage {
  available: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

export interface RunResult {
  schema_version: 1;
  request_id: string;
  trace_id: string;
  run_id: string;
  session_id: string;
  model_call_id: string | null;
  tenant: string;
  input: string;
  model: string;
  resolved_model: string | null;
  release_id: string;
  status: RunStatus;
  task_mode: boolean;
  output: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  gateway_request_id: string | null;
  usage_available: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  tool_calls_total?: number;
  tools_used?: string[];
  loop_turns?: number;
  skills_used?: string[];
  plan?: AgentPlanItem[];
  attachments?: RunAttachment[];
}

export interface AttachmentInput {
  name: string;
  mime_type?: string;
  data_base64?: string;
  url?: string;
}

export interface RunAttachment {
  name: string;
  kind: AttachmentKind;
  source: string;
  chars: number;
  original_bytes: number;
  truncated: boolean;
  stored_as: string | null;
}

export interface AgentDocument {
  name: string;
  kind: AttachmentKind;
  source: string;
  text: string;
  truncated: boolean;
}

export interface RunEvent {
  seq: number;
  event: string;
  timestamp: string;
  request_id: string;
  run_id: string;
  trace_id: string;
  release_id: string;
  details: Record<string, unknown>;
}

export interface AgentUsage {
  available: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface AgentPlanItem {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentToolCallRecord {
  name: string;
  outcome: "success" | "error";
  durationMs: number;
}

export interface AgentRunResult {
  output: string;
  model: string | null;
  gatewayRequestId: string | null;
  usage: AgentUsage;
  toolCalls: AgentToolCallRecord[];
  turns: number;
  skillsUsed: string[];
  plan: AgentPlanItem[];
}

export interface AgentRunContext {
  requestId: string;
  runId: string;
  sessionId: string;
  traceId: string;
  modelCallId: string;
  deadline: number;
  taskMode: boolean;
  history: Array<{
    input: string;
    output: string;
  }>;
  onEvent?: (event: string, details: Record<string, unknown>) => Promise<void>;
  onToolCall?: (
    name: string,
    outcome: "success" | "error",
    durationMs: number,
  ) => void;
  documents?: AgentDocument[];
  onTextDelta?: (delta: string, fullText: string) => void;
}

export type RunStreamEvent =
  | {
      type: "state";
      result: RunResult;
    }
  | {
      type: "token";
      text: string;
      fullText: string;
      reset: boolean;
    }
  | {
      type: "trace";
      event: string;
      details: Record<string, unknown>;
    };

export interface AgentCapabilities {
  tools: Array<{
    name: string;
    label: string;
    description: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
  }>;
  limits: {
    maxLoopTurns: number;
    maxToolCalls: number;
    toolTimeoutMs: number;
    maxAttachments: number;
    maxAttachmentBytes: number;
  };
  features: {
    streaming: boolean;
    attachmentKinds: AttachmentKind[];
  };
}

export interface AgentRunner {
  run(input: string, context: AgentRunContext, signal: AbortSignal): Promise<AgentRunResult>;
  capabilities(): Promise<AgentCapabilities>;
}

export interface SubmitRunInput {
  input: string;
  tenant: string;
  asyncMode: boolean;
  sessionId?: string;
  taskMode?: boolean;
  attachments?: AttachmentInput[];
}

export interface SubmitRunOutput {
  initial: RunResult;
  completion: Promise<RunResult>;
}
