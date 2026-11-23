import assert from "node:assert/strict";
import { test } from "node:test";
import { Metrics } from "../src/metrics.js";

test("Metrics exports required Agent and model metrics", async () => {
  const metrics = new Metrics({
    releaseId: "release-test",
    version: "1.0.0",
    model: "deepseek-flash",
  });
  metrics.recordRun("completed", "demo", "sync", 123);
  metrics.recordHttp("GET", "/health", 200);
  metrics.recordQueueWait("completed", 12);
  metrics.setQueueDepth(1);
  metrics.setInFlight(1, 0);
  metrics.recordModelCall(
    "deepseek-flash",
    "success",
    200,
    0.5,
    {
      available: true,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
  );
  metrics.recordToolCall("web_search", "success", 120);
  const output = await metrics.render();
  assert.match(output, /agent_runs_total\{.*status="completed"/);
  assert.match(output, /agent_run_duration_ms_bucket/);
  assert.match(output, /agent_http_requests_total/);
  assert.match(output, /agent_queue_depth 1/);
  assert.match(output, /agent_runs_in_flight\{mode="sync"\} 1/);
  assert.match(output, /agent_model_calls_total/);
  assert.match(output, /agent_model_call_duration_seconds_bucket/);
  assert.match(output, /agent_model_tokens_total\{kind="total",model="deepseek-flash"\} 15/);
  assert.match(output, /agent_tool_calls_total/);
  assert.match(output, /agent_tool_call_duration_ms/);
  assert.match(output, /agent_build_info\{.*release_id="release-test"/);
  assert.match(output, /agent_up\{service="agent"\} 1/);
});
