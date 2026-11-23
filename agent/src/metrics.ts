import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { AgentConfig, AgentUsage, RunMode, RunStatus } from "./types.js";

const RUN_BUCKETS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 90_000, 120_000];
const MODEL_BUCKETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10, 30, 60];

export class Metrics {
  readonly registry = new Registry();

  private readonly runs: Counter;
  private readonly runDuration: Histogram;
  private readonly httpRequests: Counter;
  private readonly inFlight: Gauge;
  private readonly queueDepth: Gauge;
  private readonly queueWait: Histogram;
  private readonly modelCalls: Counter;
  private readonly modelDuration: Histogram;
  private readonly modelTokens: Counter;
  private readonly toolCalls: Counter;
  private readonly toolDuration: Histogram;

  constructor(config: Pick<AgentConfig, "releaseId" | "version" | "model">) {
    collectDefaultMetrics({ register: this.registry, prefix: "agent_node_" });

    this.runs = new Counter({
      name: "agent_runs_total",
      help: "Agent runs by final status, tenant and mode",
      labelNames: ["status", "tenant", "mode"],
      registers: [this.registry],
    });
    this.runDuration = new Histogram({
      name: "agent_run_duration_ms",
      help: "Agent run duration in milliseconds",
      labelNames: ["status", "tenant", "mode"],
      buckets: RUN_BUCKETS,
      registers: [this.registry],
    });
    this.httpRequests = new Counter({
      name: "agent_http_requests_total",
      help: "Agent HTTP requests by route template and status",
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry],
    });
    this.inFlight = new Gauge({
      name: "agent_runs_in_flight",
      help: "Agent runs currently executing",
      labelNames: ["mode"],
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: "agent_queue_depth",
      help: "Agent runs currently waiting in the queue",
      registers: [this.registry],
    });
    this.queueWait = new Histogram({
      name: "agent_run_queue_wait_ms",
      help: "Agent queue wait duration in milliseconds",
      labelNames: ["outcome"],
      buckets: RUN_BUCKETS,
      registers: [this.registry],
    });
    this.modelCalls = new Counter({
      name: "agent_model_calls_total",
      help: "Model calls made through the gateway",
      labelNames: ["workflow", "model", "outcome", "status_code"],
      registers: [this.registry],
    });
    this.modelDuration = new Histogram({
      name: "agent_model_call_duration_seconds",
      help: "Model call duration in seconds",
      labelNames: ["workflow", "model", "outcome"],
      buckets: MODEL_BUCKETS,
      registers: [this.registry],
    });
    this.modelTokens = new Counter({
      name: "agent_model_tokens_total",
      help: "Model tokens observed by the Agent",
      labelNames: ["kind", "model"],
      registers: [this.registry],
    });
    this.toolCalls = new Counter({
      name: "agent_tool_calls_total",
      help: "Agent tool calls by tool name and outcome",
      labelNames: ["tool", "outcome"],
      registers: [this.registry],
    });
    this.toolDuration = new Histogram({
      name: "agent_tool_call_duration_ms",
      help: "Agent tool call duration in milliseconds",
      labelNames: ["tool", "outcome"],
      buckets: [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
      registers: [this.registry],
    });

    new Gauge({
      name: "agent_build_info",
      help: "Agent build and release information",
      labelNames: ["release_id", "version", "model"],
      registers: [this.registry],
    }).labels(config.releaseId, config.version, config.model).set(1);

    new Gauge({
      name: "agent_up",
      help: "Whether the Agent process is up",
      labelNames: ["service"],
      registers: [this.registry],
    }).labels("agent").set(1);
  }

  recordRun(status: RunStatus, tenant: string, mode: RunMode, durationMs: number): void {
    this.runs.inc({ status, tenant, mode });
    this.runDuration.observe({ status, tenant, mode }, durationMs);
  }

  recordHttp(method: string, route: string, statusCode: number): void {
    this.httpRequests.inc({ method, route, status_code: String(statusCode) });
  }

  setQueueDepth(depth: number): void {
    this.queueDepth.set(depth);
  }

  setInFlight(sync: number, asyncMode: number): void {
    this.inFlight.labels("sync").set(sync);
    this.inFlight.labels("async").set(asyncMode);
  }

  recordQueueWait(outcome: string, durationMs: number): void {
    this.queueWait.observe({ outcome }, durationMs);
  }

  recordModelCall(
    model: string,
    outcome: "success" | "error" | "cancelled",
    statusCode: number,
    durationSeconds: number,
    usage: AgentUsage,
  ): void {
    this.modelCalls.inc({
      workflow: "agent.run",
      model,
      outcome,
      status_code: String(statusCode),
    });
    if (outcome !== "cancelled") {
      this.modelDuration.observe({ workflow: "agent.run", model, outcome }, durationSeconds);
    }
    if (usage.promptTokens !== null) {
      this.modelTokens.inc({ kind: "prompt", model }, usage.promptTokens);
    }
    if (usage.completionTokens !== null) {
      this.modelTokens.inc({ kind: "completion", model }, usage.completionTokens);
    }
    if (usage.totalTokens !== null) {
      this.modelTokens.inc({ kind: "total", model }, usage.totalTokens);
    }
  }

  recordToolCall(
    tool: string,
    outcome: "success" | "error",
    durationMs: number,
  ): void {
    this.toolCalls.inc({ tool, outcome });
    this.toolDuration.observe({ tool, outcome }, durationMs);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
