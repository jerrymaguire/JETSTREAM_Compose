import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PiAgentRunner, referencedSkillNames } from "../src/pi-runner.js";
import { testConfig, temporaryDirectory } from "./test-helpers.js";

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(
  res: ServerResponse,
  chunks: unknown[],
  finishReason: string,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created,
    model: "deepseek-v4-flash",
    system_fingerprint: "fp_mock",
  };
  for (const chunk of chunks) {
    res.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: chunk, finish_reason: null }],
      })}\n\n`,
    );
  }
  res.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

test("PiAgentRunner streams through an OpenAI-compatible mock gateway", async () => {
  const mock = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      writeSse(res, [{ role: "assistant", content: "Hello" }, { content: " from PI" }], "stop");
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address() as AddressInfo;
  const temp = await temporaryDirectory("agent-pi-runner-");
  const previousKey = process.env.GATEWAY_API_KEY;
  process.env.GATEWAY_API_KEY = "test-key";
  const deltas: string[] = [];
  try {
    const runner = new PiAgentRunner(
      testConfig(temp.path, {
        gatewayBaseUrl: `http://127.0.0.1:${address.port}`,
      }),
    );
    const result = await runner.run(
      "Say hello",
      {
        requestId: "req-pi",
        runId: "run-pi",
        sessionId: "session-pi",
        traceId: "f".repeat(32),
        modelCallId: "model-call-pi",
        deadline: Date.now() + 5_000,
        taskMode: false,
        history: [],
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.output, "Hello from PI");
    assert.equal(result.model, "deepseek-v4-flash");
    assert.equal(result.gatewayRequestId, "chatcmpl-mock");
    assert.deepEqual(result.usage, {
      available: true,
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
    });
    assert.equal(result.turns, 1);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(deltas.join(""), "Hello from PI");
  } finally {
    if (previousKey === undefined) delete process.env.GATEWAY_API_KEY;
    else process.env.GATEWAY_API_KEY = previousKey;
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await temp.cleanup();
  }
});

test("referencedSkillNames resolves known @skill references", () => {
  assert.deepEqual(
    referencedSkillNames(
      "@web-research and @missing, then @task-planning",
      ["web-research", "task-planning"],
    ),
    ["web-research", "task-planning"],
  );
});

test("PiAgentRunner executes a PI tool loop and exposes the plan", async () => {
  let requests = 0;
  const mock = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    await readRequestBody(req);
    requests += 1;
    if (requests === 1) {
      writeSse(
        res,
        [
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-plan",
                type: "function",
                function: {
                  name: "update_plan",
                  arguments:
                    '{"steps":[{"step":"Inspect request","status":"completed"},{"step":"Deliver answer","status":"in_progress"}]}',
                },
              },
            ],
          },
        ],
        "tool_calls",
      );
    } else {
      writeSse(res, [{ role: "assistant", content: "Tool loop complete." }], "stop");
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address() as AddressInfo;
  const temp = await temporaryDirectory("agent-pi-loop-");
  const previousKey = process.env.GATEWAY_API_KEY;
  process.env.GATEWAY_API_KEY = "test-key";
  const events: string[] = [];
  try {
    const config = testConfig(temp.path, {
      gatewayBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const skillDir = join(config.skillsDir, "role-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: role-skill\ndescription: Role workflow.\n---\n\nFollow the explicit role workflow.",
    );
    const runner = new PiAgentRunner(
      config,
    );
    const result = await runner.run(
      "@role-skill Make a short plan and answer",
      {
        requestId: "req-loop",
        runId: "run-loop",
        sessionId: "session-loop",
        traceId: "e".repeat(32),
        modelCallId: "model-call-loop",
        deadline: Date.now() + 10_000,
        taskMode: true,
        history: [],
        onEvent: async (event) => {
          events.push(event);
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.output, "Tool loop complete.");
    assert.equal(result.turns, 2);
    assert.equal(result.toolCalls[0]?.name, "update_plan");
    assert.equal(result.plan.length, 2);
    assert.deepEqual(result.skillsUsed, ["role-skill"]);
    assert.equal(requests, 2);
    assert.ok(events.includes("tool.call.started"));
    assert.ok(events.includes("skill.referenced"));
    assert.ok(events.includes("agent.loop.finished"));
  } finally {
    if (previousKey === undefined) delete process.env.GATEWAY_API_KEY;
    else process.env.GATEWAY_API_KEY = previousKey;
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await temp.cleanup();
  }
});
