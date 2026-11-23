import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createHttpServer } from "../src/http.js";
import { Metrics } from "../src/metrics.js";
import { RunService } from "../src/run-service.js";
import { RunStore } from "../src/store.js";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import {
  ImmediateRunner,
  temporaryDirectory,
  testConfig,
} from "./test-helpers.js";

let server: Server;
let service: RunService;
let store: RunStore;
let temp: Awaited<ReturnType<typeof temporaryDirectory>>;
let baseUrl = "";

before(async () => {
  temp = await temporaryDirectory("agent-http-");
  const config = testConfig(temp.path);
  store = new RunStore(`${config.dataDir}/runs`);
  const metrics = new Metrics(config);
  service = new RunService(config, store, new ImmediateRunner(), metrics);
  await service.init();
  server = createHttpServer({
    config,
    runService: service,
    store,
    metrics,
    publicDir: resolve(process.cwd(), "public"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await temp.cleanup();
});

test("health returns release metadata", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id") ?? "", /^req-/);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.release_id, "test-release");
});

test("capabilities returns tools, skills and execution limits", async () => {
  const response = await fetch(`${baseUrl}/v1/capabilities`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    tools: unknown[];
    skills: unknown[];
    limits: { maxLoopTurns: number; maxToolCalls: number; maxAttachments: number };
  };
  assert.ok(Array.isArray(body.tools));
  assert.ok(Array.isArray(body.skills));
  assert.equal(body.limits.maxLoopTurns, 6);
  assert.equal(body.limits.maxToolCalls, 12);
  assert.equal(body.limits.maxAttachments, 8);
});

test("invalid input returns a structured 400", async () => {
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "", tenant: "bad tenant" }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as {
    error: { code: string; retryable: boolean };
    request_id: string;
  };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.retryable, false);
  assert.ok(body.request_id);
});

test("sync run returns completed output and can be queried", async () => {
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": "req-client-fixed",
      traceparent: `00-${"d".repeat(32)}-${"e".repeat(16)}-01`,
    },
    body: JSON.stringify({ input: "hello", tenant: "demo" }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(result.status, "completed");
  assert.equal(result.output, "answer:hello");
  assert.equal(result.request_id, "req-client-fixed");
  assert.equal(result.trace_id, "d".repeat(32));
  const queried = await fetch(`${baseUrl}/v1/runs/${String(result.run_id)}`);
  assert.equal(queried.status, 200);
  const queryBody = (await queried.json()) as Record<string, unknown>;
  assert.equal(queryBody.status, "completed");
});

test("run accepts Markdown attachments and persists the raw file", async () => {
  const content = "# Attached notes\n\nUse these notes.";
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: "Summarize the attachment",
      tenant: "demo",
      attachments: [
        {
          name: "notes.md",
          mime_type: "text/markdown",
          data_base64: Buffer.from(content).toString("base64"),
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    run_id: string;
    attachments: Array<{
      name: string;
      kind: string;
      chars: number;
      stored_as: string;
    }>;
  };
  assert.equal(result.attachments[0]?.name, "notes.md");
  assert.equal(result.attachments[0]?.kind, "markdown");
  assert.equal(result.attachments[0]?.chars, content.length);
  const raw = await readFile(
    join(store.root, result.run_id, "raw", result.attachments[0]!.stored_as),
    "utf8",
  );
  assert.equal(raw, content);
});

test("run list and event history support the workbench", async () => {
  const response = await fetch(`${baseUrl}/v1/runs?limit=10`);
  assert.equal(response.status, 200);
  const list = (await response.json()) as { items: Array<{ run_id: string }> };
  assert.ok(list.items.length >= 1);
  const runId = list.items[0]?.run_id;
  assert.ok(runId);
  const eventResponse = await fetch(`${baseUrl}/v1/runs/${runId}/events?format=json`);
  assert.equal(eventResponse.status, 200);
  const events = (await eventResponse.json()) as { items: Array<{ event: string }> };
  assert.ok(events.items.some((event) => event.event === "run.completed"));
});

test("UI assets are served from the Agent container", async () => {
  const page = await fetch(`${baseUrl}/ui/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AgentCompose Workbench/);
  const script = await fetch(`${baseUrl}/ui/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /submitRun/);
});

test("session delete removes the conversation from history", async () => {
  const created = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: "delete me",
      tenant: "demo",
      session_id: "session-delete-ui",
    }),
  });
  assert.equal(created.status, 200);
  const deleted = await fetch(`${baseUrl}/v1/sessions/session-delete-ui`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  const body = (await deleted.json()) as { deleted_runs: number };
  assert.equal(body.deleted_runs, 1);
  const list = (await (await fetch(`${baseUrl}/v1/runs?limit=100`)).json()) as {
    items: Array<{ session_id: string }>;
  };
  assert.ok(!list.items.some((run) => run.session_id === "session-delete-ui"));
});

test("async run returns 202 and reaches completed", async () => {
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "async", tenant: "demo", async: true }),
  });
  assert.equal(response.status, 202);
  const accepted = (await response.json()) as { run_id: string; status: string };
  assert.equal(accepted.status, "queued");
  let final: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const queried = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}`);
    final = (await queried.json()) as Record<string, unknown>;
    if (final.status === "completed" || final.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(final?.status, "completed", JSON.stringify(final));
  assert.equal(final?.output, "answer:async");
});

test("events endpoint returns SSE terminal state", async () => {
  const submit = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "events", tenant: "demo", async: true }),
  });
  const accepted = (await submit.json()) as { run_id: string };
  await new Promise((resolve) => setTimeout(resolve, 40));
  const response = await fetch(`${baseUrl}/v1/runs/${accepted.run_id}/events`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: state/);
  assert.match(text, /event: done/);
});

test("metrics endpoint exposes required metric names", async () => {
  await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "metric", tenant: "demo" }),
  });
  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /agent_runs_total/);
  assert.match(body, /agent_run_duration_ms_bucket/);
  assert.match(body, /agent_model_calls_total/);
});

test("unknown and invalid routes return structured errors", async () => {
  const missing = await fetch(`${baseUrl}/v1/runs/not-a-real-run`);
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${baseUrl}/v1/runs/..%2Fescape`);
  assert.equal(invalid.status, 404);
});
