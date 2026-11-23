import { randomUUID } from "node:crypto";
import { prepareAttachments } from "./documents.js";
import { AppError, asAppError } from "./errors.js";
import type { Metrics } from "./metrics.js";
import type { RunStore } from "./store.js";
import type {
  AgentCapabilities,
  AgentConfig,
  AgentRunContext,
  AgentRunner,
  AgentUsage,
  RunInputDocument,
  RunMode,
  RunResult,
  RunStreamEvent,
  SubmitRunInput,
  SubmitRunOutput,
} from "./types.js";

interface QueueItem {
  input: RunInputDocument;
  documents: NonNullable<AgentRunContext["documents"]>;
  queuedAt: number;
  deadline: number;
  completion: Promise<RunResult>;
  resolve: (result: RunResult) => void;
  controller: AbortController | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

const EMPTY_USAGE: AgentUsage = {
  available: false,
  promptTokens: null,
  completionTokens: null,
  totalTokens: null,
};

export class RunService {
  private readonly queue: QueueItem[] = [];
  private active = 0;
  private readonly activeByMode: Record<RunMode, number> = { sync: 0, async: 0 };
  private stopped = false;
  private readonly watchers = new Map<string, Set<(event: RunStreamEvent) => void>>();
  private readonly liveText = new Map<string, string>();

  constructor(
    private readonly config: AgentConfig,
    private readonly store: RunStore,
    private readonly runner: AgentRunner,
    private readonly metrics: Metrics,
  ) {}

  async init(): Promise<void> {
    await this.store.init();
    await this.store.markInterrupted();
  }

  async submit(
    request: SubmitRunInput,
    requestId: string,
    traceId: string,
  ): Promise<SubmitRunOutput> {
    if (this.stopped) {
      throw new AppError("agent_busy", "Agent service is shutting down", 503, true);
    }
    this.validate(request);
    if (
      this.active >= this.config.maxConcurrency &&
      this.queue.length >= this.config.queueCapacity
    ) {
      throw new AppError("agent_busy", "Agent queue is full", 429, true, {
        queue_depth: this.queue.length,
        queue_capacity: this.config.queueCapacity,
      });
    }

    const createdAt = nowIso();
    const runId = randomUUID();
    const mode: RunMode = request.asyncMode ? "async" : "sync";
    const sessionId = request.sessionId?.trim() || `session-${randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(sessionId)) {
      throw new AppError("invalid_request", "session_id contains invalid characters", 400);
    }
    let preparedAttachments;
    try {
      preparedAttachments = await prepareAttachments(request.attachments, this.config);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
    const attachmentMetadata = preparedAttachments.map((item) => item.metadata);
    const input: RunInputDocument = {
      schema_version: 1,
      request_id: requestId,
      trace_id: traceId,
      run_id: runId,
      session_id: sessionId,
      tenant: request.tenant,
      input: request.input,
      async_mode: request.asyncMode,
      task_mode: Boolean(request.taskMode),
      mode,
      model: this.config.model,
      release_id: this.config.releaseId,
      created_at: createdAt,
      attachments: attachmentMetadata,
    };
    const initial: RunResult = {
      schema_version: 1,
      request_id: requestId,
      trace_id: traceId,
      run_id: runId,
      session_id: sessionId,
      model_call_id: null,
      tenant: request.tenant,
      input: request.input,
      model: this.config.model,
      resolved_model: null,
      release_id: this.config.releaseId,
      status: "queued",
      task_mode: Boolean(request.taskMode),
      output: null,
      error_code: null,
      error_message: null,
      created_at: createdAt,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      gateway_request_id: null,
      usage_available: false,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      attachments: attachmentMetadata,
    };
    await this.store.create(
      input,
      {
        release_id: this.config.releaseId,
        agent_version: this.config.version,
        model_alias: this.config.model,
        gateway_base_url: this.config.gatewayBaseUrl,
        node_version: process.version,
      },
      initial,
    );
    for (const attachment of preparedAttachments) {
      if (attachment.raw && attachment.metadata.stored_as) {
        await this.store.writeRawAttachment(
          runId,
          attachment.metadata.stored_as,
          attachment.raw,
        );
      }
      await this.store.appendEvent(runId, "attachment.prepared", {
        name: attachment.metadata.name,
        kind: attachment.metadata.kind,
        chars: attachment.metadata.chars,
        truncated: attachment.metadata.truncated,
        stored_as: attachment.metadata.stored_as,
      });
    }

    let resolveCompletion: (result: RunResult) => void = () => undefined;
    const completion = new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const item: QueueItem = {
      input,
      documents: preparedAttachments.map((item) => item.document),
      queuedAt: Date.now(),
      deadline: Date.now() + this.config.runTimeoutMs,
      completion,
      resolve: resolveCompletion,
      controller: null,
    };
    this.queue.push(item);
    this.publish(runId, { type: "state", result: initial });
    this.updateGauges();
    this.pump();
    return { initial, completion };
  }

  async get(runId: string): Promise<RunResult | null> {
    return this.store.getResult(runId);
  }

  async list(limit = 50): Promise<RunResult[]> {
    return this.store.listResults(limit);
  }

  async capabilities(): Promise<AgentCapabilities> {
    return this.runner.capabilities();
  }

  watch(runId: string, listener: (event: RunStreamEvent) => void): () => void {
    const listeners = this.watchers.get(runId) ?? new Set();
    listeners.add(listener);
    this.watchers.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.watchers.delete(runId);
    };
  }

  liveTextFor(runId: string): string | undefined {
    return this.liveText.get(runId);
  }

  private publish(runId: string, event: RunStreamEvent): void {
    for (const listener of this.watchers.get(runId) ?? []) {
      try {
        listener(event);
      } catch {
        // A disconnected live viewer must not affect the Run.
      }
    }
  }

  async deleteSession(sessionId: string): Promise<number> {
    return this.store.deleteSession(sessionId);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const item of this.queue.splice(0)) {
      const result = await this.fail(
        item,
        "interrupted_by_restart",
        "Agent service stopped before the run started",
        false,
        Date.now() - item.queuedAt,
      );
      item.resolve(result);
    }
    for (const item of this.activeItems) item.controller?.abort();
    this.updateGauges();
  }

  private readonly activeItems = new Set<QueueItem>();

  private validate(request: SubmitRunInput): void {
    const hasAttachments = Boolean(request.attachments?.length);
    if (
      typeof request.input !== "string" ||
      request.input.length > 10_000 ||
      (!hasAttachments && request.input.length < 1)
    ) {
      throw new AppError("invalid_request", "input must contain 1 to 10000 characters", 400);
    }
    if (
      typeof request.tenant !== "string" ||
      request.tenant.length < 1 ||
      request.tenant.length > 64 ||
      !/^[A-Za-z0-9_-]+$/.test(request.tenant)
    ) {
      throw new AppError(
        "invalid_request",
        "tenant must contain 1 to 64 characters from [A-Za-z0-9_-]",
        400,
      );
    }
  }

  private updateGauges(): void {
    this.metrics.setQueueDepth(this.queue.length);
    this.metrics.setInFlight(this.activeByMode.sync, this.activeByMode.async);
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.active < this.config.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.active += 1;
      this.activeByMode[item.input.mode] += 1;
      this.activeItems.add(item);
      this.updateGauges();
      void this.execute(item).finally(() => {
        this.active -= 1;
        this.activeByMode[item.input.mode] -= 1;
        this.activeItems.delete(item);
        this.updateGauges();
        this.pump();
      });
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const waitMs = Date.now() - item.queuedAt;
    let final: RunResult;
    try {
      if (waitMs > this.config.queueTimeoutMs || Date.now() >= item.deadline) {
        final = await this.fail(
          item,
          "queue_timeout",
          "Run exceeded its maximum queue wait",
          true,
          waitMs,
        );
      } else {
        final = await this.run(item, waitMs);
      }
    } catch (error) {
      const appError = asAppError(error);
      final = await this.fail(
        item,
        appError.code,
        appError.message,
        appError.retryable,
        waitMs,
      );
    } finally {
      item.controller = null;
    }
    item.resolve(final);
  }

  private async run(item: QueueItem, waitMs: number): Promise<RunResult> {
    const startedAt = nowIso();
    const running: RunResult = {
      ...(await this.requireResult(item.input.run_id)),
      status: "running",
      model_call_id: `model-call-${randomUUID()}`,
      started_at: startedAt,
    };
    await this.store.writeResult(running);
    await this.store.appendEvent(item.input.run_id, "run.started", {
      status: "running",
    });
    this.publish(item.input.run_id, { type: "state", result: running });

    item.controller = new AbortController();
    const controller = item.controller;
    const remaining = Math.max(1, Math.min(item.deadline - Date.now(), this.config.gatewayTimeoutMs));
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        item.controller?.abort();
        reject(new AppError("run_timeout", "Run deadline exceeded", 504, true));
      }, remaining);
    });
    const modelStarted = Date.now();
    await this.store.appendEvent(item.input.run_id, "gateway.call.started", {
      model: this.config.model,
      model_call_id: running.model_call_id,
    });

    try {
      const output = await Promise.race([
        this.prepareHistory(item.input.session_id, item.input.run_id).then((history) =>
          this.runner.run(
            item.input.input,
            {
              requestId: item.input.request_id,
              runId: item.input.run_id,
              sessionId: item.input.session_id,
              traceId: item.input.trace_id,
              modelCallId: running.model_call_id ?? "",
              deadline: item.deadline,
          taskMode: item.input.task_mode,
              history,
              documents: item.documents,
              onEvent: async (event, details) => {
                await this.store.appendEvent(item.input.run_id, event, {
                  model_call_id: running.model_call_id,
                  ...details,
                });
                this.publish(item.input.run_id, { type: "trace", event, details });
              },
              onToolCall: (tool, outcome, durationMs) => {
                this.metrics.recordToolCall(tool, outcome, durationMs);
              },
              onTextDelta: (_delta, fullText) => {
                this.liveText.set(item.input.run_id, fullText);
                this.publish(item.input.run_id, {
                  type: "token",
                  text: fullText,
                  fullText,
                  reset: true,
                });
              },
            },
            controller.signal,
          ),
        ),
        timeoutPromise,
      ]);
      if (timeout) clearTimeout(timeout);
      const finishedAt = nowIso();
      const final: RunResult = {
        ...running,
        status: "completed",
        output: output.output,
        resolved_model: output.model,
        gateway_request_id: output.gatewayRequestId,
        finished_at: finishedAt,
        duration_ms: durationMs(running.created_at, finishedAt),
        usage_available: output.usage.available,
        prompt_tokens: output.usage.promptTokens,
        completion_tokens: output.usage.completionTokens,
        total_tokens: output.usage.totalTokens,
        tool_calls_total: output.toolCalls.length,
        tools_used: [...new Set(output.toolCalls.map((call) => call.name))],
        loop_turns: output.turns,
        skills_used: output.skillsUsed,
        plan: output.plan,
      };
      await this.store.writeResult(final);
      await this.store.appendEvent(item.input.run_id, "gateway.call.finished", {
        model_call_id: running.model_call_id,
        outcome: "success",
        duration_ms: Date.now() - modelStarted,
        usage: output.usage,
      });
      await this.store.appendEvent(item.input.run_id, "run.completed", {
        output_length: output.output.length,
      });
      this.metrics.recordQueueWait("completed", waitMs);
      this.metrics.recordRun("completed", final.tenant, item.input.mode, final.duration_ms ?? 0);
      this.metrics.recordModelCall(
        output.model ?? this.config.model,
        "success",
        200,
        (Date.now() - modelStarted) / 1_000,
        output.usage,
      );
      this.publish(item.input.run_id, { type: "state", result: final });
      this.liveText.delete(item.input.run_id);
      return final;
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      const appError = timedOut
        ? new AppError("run_timeout", "Run deadline exceeded", 504, true)
        : asAppError(
            error instanceof AppError
              ? error
              : new AppError(
                  "gateway_call_failed",
                  error instanceof Error ? error.message : String(error),
                  502,
                  true,
                ),
          );
      await this.store.appendEvent(item.input.run_id, "gateway.call.finished", {
        model_call_id: running.model_call_id,
        outcome: "error",
        error_code: appError.code,
        duration_ms: Date.now() - modelStarted,
      });
      this.metrics.recordModelCall(
        this.config.model,
        item.controller?.signal.aborted ? "cancelled" : "error",
        appError.httpStatus,
        (Date.now() - modelStarted) / 1_000,
        EMPTY_USAGE,
      );
      return await this.fail(item, appError.code, appError.message, appError.retryable, waitMs);
    }
  }

  private async fail(
    item: QueueItem,
    code: string,
    message: string,
    retryable: boolean,
    waitMs: number,
  ): Promise<RunResult> {
    const current = await this.store.getResult(item.input.run_id);
    const finishedAt = nowIso();
    const failed: RunResult = {
      ...(current ?? this.initialFallback(item)),
      status: "failed",
      output: null,
      error_code: code,
      error_message: message,
      finished_at: finishedAt,
      duration_ms: durationMs(current?.created_at ?? item.input.created_at, finishedAt),
    };
    await this.store.writeResult(failed);
    await this.store.appendEvent(item.input.run_id, "run.failed", {
      error_code: code,
      retryable,
    });
    this.metrics.recordQueueWait(code, waitMs);
    this.metrics.recordRun("failed", failed.tenant, item.input.mode, failed.duration_ms ?? 0);
    this.publish(item.input.run_id, { type: "state", result: failed });
    this.liveText.delete(item.input.run_id);
    return failed;
  }

  private initialFallback(item: QueueItem): RunResult {
    return {
      schema_version: 1,
      request_id: item.input.request_id,
      trace_id: item.input.trace_id,
      run_id: item.input.run_id,
      session_id: item.input.session_id,
      model_call_id: null,
      tenant: item.input.tenant,
      input: item.input.input,
      model: item.input.model,
      resolved_model: null,
      release_id: item.input.release_id,
      status: "queued",
      task_mode: item.input.task_mode,
      output: null,
      error_code: null,
      error_message: null,
      created_at: item.input.created_at,
      started_at: null,
      finished_at: null,
      duration_ms: null,
      gateway_request_id: null,
      usage_available: false,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      attachments: item.input.attachments ?? [],
    };
  }

  private async requireResult(runId: string): Promise<RunResult> {
    const result = await this.store.getResult(runId);
    if (!result) throw new AppError("internal_error", "Run record disappeared", 500);
    return result;
  }

  private async prepareHistory(
    sessionId: string,
    currentRunId: string,
  ): Promise<Array<{ input: string; output: string }>> {
    const previous = (await this.store.listResults(500))
      .filter(
        (run) =>
          run.session_id === sessionId &&
          run.run_id !== currentRunId &&
          run.status === "completed" &&
          Boolean(run.output),
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(-12);
    return previous.map((run) => ({
      input: run.input,
      output: run.output ?? "",
    }));
  }
}
