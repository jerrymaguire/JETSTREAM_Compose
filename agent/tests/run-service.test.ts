import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { Metrics } from "../src/metrics.js";
import { RunService } from "../src/run-service.js";
import { RunStore } from "../src/store.js";
import type {
  AgentCapabilities,
  AgentRunResult,
  AgentRunner,
} from "../src/types.js";
import {
  ImmediateRunner,
  temporaryDirectory,
  testConfig,
} from "./test-helpers.js";

async function testCapabilities(): Promise<AgentCapabilities> {
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

function agentResult(output: string, model: string | null): AgentRunResult {
  return {
    output,
    model,
    gatewayRequestId: null,
    usage: {
      available: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    },
    toolCalls: [],
    turns: 1,
    skillsUsed: [],
    plan: [],
  };
}

async function makeService(
  root: string,
  runner: AgentRunner,
  overrides: Parameters<typeof testConfig>[1] = {},
): Promise<{ service: RunService; store: RunStore }> {
  const config = testConfig(root, overrides);
  const store = new RunStore(`${config.dataDir}/runs`);
  const metrics = new Metrics(config);
  const service = new RunService(config, store, runner, metrics);
  await service.init();
  return { service, store };
}

test("RunService completes a synchronous run and persists events", async () => {
  const temp = await temporaryDirectory("agent-run-");
  const { service, store } = await makeService(temp.path, new ImmediateRunner());
  try {
    const submitted = await service.submit(
      { input: "hello", tenant: "demo", asyncMode: false },
      "req-sync",
      "c".repeat(32),
    );
    assert.equal(submitted.initial.status, "queued");
    const final = await submitted.completion;
    assert.equal(final.status, "completed");
    assert.equal(final.output, "answer:hello");
    assert.equal(final.total_tokens, 15);
    const events = await store.readEvents(final.run_id);
    assert.ok(events.some((event) => event.event === "gateway.call.finished"));
    assert.ok(events.some((event) => event.event === "run.completed"));
  } finally {
    await service.shutdown();
    await temp.cleanup();
  }
});

test("RunService bounds concurrency and rejects when the queue is full", async () => {
  const temp = await temporaryDirectory("agent-run-");
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started = 0;
  let releaseStarted: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  let active = 0;
  let maxActive = 0;
  const runner: AgentRunner = {
    async run(): Promise<AgentRunResult> {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      releaseStarted?.();
      await firstGate;
      active -= 1;
      return agentResult(`run-${started}`, "deepseek-flash");
    },
    capabilities: testCapabilities,
  };
  const { service } = await makeService(temp.path, runner, {
    maxConcurrency: 1,
    queueCapacity: 1,
  });
  try {
    const first = await service.submit(
      { input: "one", tenant: "demo", asyncMode: true },
      "req-1",
      "1".repeat(32),
    );
    await startedPromise;
    const second = await service.submit(
      { input: "two", tenant: "demo", asyncMode: true },
      "req-2",
      "2".repeat(32),
    );
    await assert.rejects(
      () =>
        service.submit(
          { input: "three", tenant: "demo", asyncMode: true },
          "req-3",
          "3".repeat(32),
        ),
      (error: unknown) => error instanceof AppError && error.code === "agent_busy",
    );
    releaseFirst?.();
    const firstFinal = await first.completion;
    const secondFinal = await second.completion;
    assert.equal(firstFinal.status, "completed");
    assert.equal(secondFinal.status, "completed");
    assert.equal(maxActive, 1);
  } finally {
    await service.shutdown();
    await temp.cleanup();
  }
});

test("RunService fails queued work after queue timeout", async () => {
  const temp = await temporaryDirectory("agent-run-");
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const runner: AgentRunner = {
    async run(): Promise<AgentRunResult> {
      releaseStarted?.();
      await gate;
      return agentResult("first", null);
    },
    capabilities: testCapabilities,
  };
  const { service } = await makeService(temp.path, runner, {
    maxConcurrency: 1,
    queueCapacity: 2,
    queueTimeoutMs: 20,
  });
  try {
    const first = await service.submit(
      { input: "first", tenant: "demo", asyncMode: true },
      "req-first",
      "4".repeat(32),
    );
    await started;
    const second = await service.submit(
      { input: "second", tenant: "demo", asyncMode: true },
      "req-second",
      "5".repeat(32),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseFirst?.();
    await first.completion;
    const failed = await second.completion;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "queue_timeout");
  } finally {
    await service.shutdown();
    await temp.cleanup();
  }
});

test("RunService maps runner failures to a failed Run", async () => {
  const temp = await temporaryDirectory("agent-run-");
  const runner: AgentRunner = {
    async run(): Promise<AgentRunResult> {
      throw new AppError("gateway_call_failed", "upstream failed", 502, true);
    },
    capabilities: testCapabilities,
  };
  const { service } = await makeService(temp.path, runner);
  try {
    const submitted = await service.submit(
      { input: "fail", tenant: "demo", asyncMode: false },
      "req-fail",
      "6".repeat(32),
    );
    const failed = await submitted.completion;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error_code, "gateway_call_failed");
  } finally {
    await service.shutdown();
    await temp.cleanup();
  }
});

test("RunService reuses a session and supplies previous turns as history", async () => {
  const temp = await temporaryDirectory("agent-run-");
  const seenHistory: number[] = [];
  const runner: AgentRunner = {
    async run(input, context): Promise<AgentRunResult> {
      seenHistory.push(context.history.length);
      return agentResult(`reply:${input}`, "deepseek-v4-flash");
    },
    capabilities: testCapabilities,
  };
  const { service } = await makeService(temp.path, runner);
  try {
    const first = await service.submit(
      { input: "first", tenant: "demo", asyncMode: false, sessionId: "session-fixed" },
      "req-first",
      "7".repeat(32),
    );
    await first.completion;
    const second = await service.submit(
      { input: "second", tenant: "demo", asyncMode: false, sessionId: "session-fixed" },
      "req-second",
      "8".repeat(32),
    );
    const final = await second.completion;
    assert.equal(final.session_id, "session-fixed");
    assert.deepEqual(seenHistory, [0, 1]);
  } finally {
    await service.shutdown();
    await temp.cleanup();
  }
});
