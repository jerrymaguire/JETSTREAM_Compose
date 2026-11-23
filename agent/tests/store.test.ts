import assert from "node:assert/strict";
import { test } from "node:test";
import { RunStore } from "../src/store.js";
import type { RunInputDocument, RunVersionsDocument } from "../src/types.js";
import { sampleResult, temporaryDirectory } from "./test-helpers.js";

function input(runId: string): RunInputDocument {
  return {
    schema_version: 1,
    request_id: "req-1",
    trace_id: "b".repeat(32),
    run_id: runId,
    session_id: `session-${runId}`,
    tenant: "demo",
    input: "hello",
    async_mode: false,
    task_mode: false,
    mode: "sync",
    model: "deepseek-flash",
    release_id: "test-release",
    created_at: "2026-11-22T00:00:00.000Z",
  };
}

const versions: RunVersionsDocument = {
  release_id: "test-release",
  agent_version: "1.0.0-test",
  model_alias: "deepseek-flash",
  gateway_base_url: "http://gateway:4000",
  node_version: "v24.0.0",
};

test("RunStore persists results and append-only events", async () => {
  const temp = await temporaryDirectory("agent-store-");
  try {
    const store = new RunStore(temp.path);
    const runId = "run-1";
    await store.create(input(runId), versions, sampleResult(runId));
    await store.appendEvent(runId, "run.started", { stage: "execute" });
    const result = await store.getResult(runId);
    const events = await store.readEvents(runId);
    assert.equal(result?.status, "queued");
    assert.deepEqual(events.map((event) => event.event), ["run.created", "run.started"]);
    assert.equal(events[1]?.seq, 2);
    assert.equal(events[1]?.request_id, "req-1");
  } finally {
    await temp.cleanup();
  }
});

test("RunStore marks unfinished runs interrupted after restart", async () => {
  const temp = await temporaryDirectory("agent-store-");
  try {
    const store = new RunStore(temp.path);
    const runId = "run-interrupted";
    await store.create(input(runId), versions, sampleResult(runId, "running"));
    const interrupted = await store.markInterrupted();
    const result = await store.getResult(runId);
    assert.deepEqual(interrupted, [runId]);
    assert.equal(result?.status, "failed");
    assert.equal(result?.error_code, "interrupted_by_restart");
  } finally {
    await temp.cleanup();
  }
});

test("RunStore lists newest run results first", async () => {
  const temp = await temporaryDirectory("agent-store-");
  try {
    const store = new RunStore(temp.path);
    const older = sampleResult("run-old", "completed");
    older.created_at = "2026-11-22T00:00:00.000Z";
    const newer = sampleResult("run-new", "failed");
    newer.created_at = "2026-11-22T00:01:00.000Z";
    await store.create(input("run-old"), versions, older);
    await store.create({ ...input("run-new"), created_at: newer.created_at }, versions, newer);
    const results = await store.listResults(10);
    assert.deepEqual(results.map((result) => result.run_id), ["run-new", "run-old"]);
  } finally {
    await temp.cleanup();
  }
});

test("RunStore rejects unsafe run identifiers", async () => {
  const temp = await temporaryDirectory("agent-store-");
  try {
    const store = new RunStore(temp.path);
    await assert.rejects(() => store.getResult("../escape"), /invalid run id/);
  } finally {
    await temp.cleanup();
  }
});

test("RunStore deletes every run in a session", async () => {
  const temp = await temporaryDirectory("agent-store-");
  try {
    const store = new RunStore(temp.path);
    const first = input("run-delete-1");
    first.session_id = "session-delete";
    const second = input("run-delete-2");
    second.session_id = "session-delete";
    await store.create(first, versions, { ...sampleResult("run-delete-1"), session_id: "session-delete" });
    await store.create(second, versions, { ...sampleResult("run-delete-2"), session_id: "session-delete" });
    assert.equal(await store.deleteSession("session-delete"), 2);
    assert.equal((await store.listResults(10)).length, 0);
  } finally {
    await temp.cleanup();
  }
});
