import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { AppError, asAppError } from "./errors.js";
import type { Metrics } from "./metrics.js";
import type { RunService } from "./run-service.js";
import type { RunStore } from "./store.js";
import type { AgentConfig, AttachmentInput, RunResult } from "./types.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY_BYTES = 33_554_432;

export interface HttpDependencies {
  config: AgentConfig;
  runService: RunService;
  store: RunStore;
  metrics: Metrics;
  publicDir: string;
}

export function normalizeRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate && REQUEST_ID_PATTERN.test(candidate)) return candidate;
  return `req-${randomUUID()}`;
}

export function traceIdFromTraceparent(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const match = candidate
    ? /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(candidate)
    : null;
  return match?.[1]?.toLowerCase() ?? randomBytes(16).toString("hex");
}

function sendJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  body: unknown,
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  requestId: string,
  error: AppError,
): void {
  sendJson(res, error.httpStatus, requestId, {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
    request_id: requestId,
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError("payload_too_large", "Request body exceeds 1 MiB", 413);
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new AppError("invalid_request", "JSON request body is required", 400);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("invalid_request", "Request body must be valid JSON", 400);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveUiAsset(
  res: ServerResponse,
  requestId: string,
  publicDir: string,
  pathname: string,
): Promise<void> {
  const root = resolve(publicDir);
  const relative = pathname === "/ui" || pathname === "/ui/"
    ? "index.html"
    : pathname.replace(/^\/ui\//, "");
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new AppError("not_found", "UI asset not found", 404);
  }
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("not_found", "UI asset not found", 404);
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  res.end(body);
}

function runHttpStatus(result: RunResult): number {
  if (result.error_code === "queue_timeout" || result.error_code === "run_timeout") return 504;
  if (result.error_code === "gateway_call_failed") return 502;
  if (result.error_code === "agent_busy") return 429;
  if (result.error_code === "invalid_request") return 400;
  return 500;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDependencies,
  requestId: string,
  routeLabel: (value: string) => void,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://agent.local");
  const path = url.pathname;

  if (method === "GET" && path === "/") {
    routeLabel("/");
    res.writeHead(302, {
      Location: "/ui/",
      "X-Request-Id": requestId,
    });
    res.end();
    return;
  }

  if (method === "GET" && (path === "/ui" || path === "/ui/" || path.startsWith("/ui/"))) {
    routeLabel("/ui/:asset");
    await serveUiAsset(res, requestId, deps.publicDir, path);
    return;
  }

  if (method === "GET" && path === "/health") {
    routeLabel("/health");
    sendJson(res, 200, requestId, {
      status: "ok",
      service: "agent",
      version: deps.config.version,
      release_id: deps.config.releaseId,
      uptime_seconds: Math.floor(process.uptime()),
    });
    return;
  }

  if (method === "GET" && path === "/v1/capabilities") {
    routeLabel("/v1/capabilities");
    sendJson(res, 200, requestId, await deps.runService.capabilities());
    return;
  }

  if (method === "GET" && path === "/metrics") {
    routeLabel("/metrics");
    const body = await deps.metrics.render();
    res.writeHead(200, {
      "Content-Type": deps.metrics.contentType,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
    });
    res.end(body);
    return;
  }

  if (method === "POST" && path === "/v1/runs") {
    routeLabel("/v1/runs");
    const body = (await readBody(req)) as Record<string, unknown>;
    const input = body.input;
    const tenant = body.tenant;
    const asyncMode = body.async === undefined ? false : body.async;
    const taskMode = body.task_mode === undefined ? false : body.task_mode;
    const sessionId = body.session_id === undefined ? undefined : body.session_id;
    const rawAttachments = body.attachments === undefined ? [] : body.attachments;
    if (
      typeof input !== "string" ||
      typeof tenant !== "string" ||
      typeof asyncMode !== "boolean" ||
      typeof taskMode !== "boolean" ||
      (sessionId !== undefined && typeof sessionId !== "string") ||
      !Array.isArray(rawAttachments)
    ) {
      throw new AppError(
        "invalid_request",
        "input, tenant and session_id must be strings; async and task_mode must be booleans when provided",
        400,
      );
    }
    const attachments: AttachmentInput[] = rawAttachments.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw new AppError("invalid_request", `Attachment ${index + 1} is invalid`, 400);
      }
      const value = item as Record<string, unknown>;
      if (typeof value.name !== "string" || !value.name.trim()) {
        throw new AppError("invalid_request", `Attachment ${index + 1} requires a name`, 400);
      }
      if (
        value.mime_type !== undefined &&
        (typeof value.mime_type !== "string" || value.mime_type.length > 200)
      ) {
        throw new AppError(
          "invalid_request",
          `Attachment ${index + 1} has an invalid mime_type`,
          400,
        );
      }
      if (
        value.url !== undefined &&
        (typeof value.url !== "string" || value.url.length > 4_000)
      ) {
        throw new AppError("invalid_request", `Attachment ${index + 1} has an invalid URL`, 400);
      }
      if (value.data_base64 !== undefined && typeof value.data_base64 !== "string") {
        throw new AppError(
          "invalid_request",
          `Attachment ${index + 1} has invalid data_base64`,
          400,
        );
      }
      if (value.url === undefined && value.data_base64 === undefined) {
        throw new AppError(
          "invalid_request",
          `Attachment ${index + 1} requires data_base64 or url`,
          400,
        );
      }
      return {
        name: value.name,
        ...(typeof value.mime_type === "string" ? { mime_type: value.mime_type } : {}),
        ...(typeof value.url === "string" ? { url: value.url } : {}),
        ...(typeof value.data_base64 === "string"
          ? { data_base64: value.data_base64 }
          : {}),
      };
    });
    const traceId = traceIdFromTraceparent(req.headers.traceparent);
    const submitted = await deps.runService.submit(
      {
        input,
        tenant,
        asyncMode,
        taskMode,
        attachments,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      requestId,
      traceId,
    );
    if (asyncMode) {
      sendJson(res, 202, requestId, submitted.initial);
      return;
    }
    const result = await submitted.completion;
    if (result.status === "completed") {
      sendJson(res, 200, requestId, result);
      return;
    }
    throw new AppError(
      (result.error_code as AppError["code"]) ?? "gateway_call_failed",
      result.error_message ?? "Agent run failed",
      runHttpStatus(result),
      result.error_code === "run_timeout" || result.error_code === "gateway_call_failed",
      { run_id: result.run_id, status: result.status },
    );
  }

  if (method === "GET" && path === "/v1/runs") {
    routeLabel("/v1/runs");
    const requested = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(100, requested)) : 50;
    const items = await deps.runService.list(limit);
    sendJson(res, 200, requestId, { items });
    return;
  }

  const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
  if (method === "DELETE" && sessionMatch?.[1] && RUN_ID_PATTERN.test(sessionMatch[1])) {
    routeLabel("/v1/sessions/:session_id");
    const sessionId = sessionMatch[1];
    const deletedRuns = await deps.runService.deleteSession(sessionId);
    sendJson(res, 200, requestId, {
      session_id: sessionId,
      deleted_runs: deletedRuns,
    });
    return;
  }

  const match = /^\/v1\/runs\/([^/]+)(\/events)?$/.exec(path);
  if (match?.[1] && RUN_ID_PATTERN.test(match[1])) {
    const runId = match[1];
    if (method === "GET" && !match[2]) {
      routeLabel("/v1/runs/:run_id");
      const result = await deps.runService.get(runId);
      if (!result) throw new AppError("not_found", "Run not found", 404);
      sendJson(res, 200, requestId, result);
      return;
    }
    if (method === "GET" && match[2] === "/events") {
      routeLabel("/v1/runs/:run_id/events");
      const current = await deps.runService.get(runId);
      if (!current) throw new AppError("not_found", "Run not found", 404);
      if (url.searchParams.get("format") === "json") {
        const events = await deps.store.readEvents(runId);
        sendJson(res, 200, requestId, { items: events });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
      });
      let closed = false;
      const writeEvent = (event: string, data: unknown): void => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!closed) res.write(": keepalive\n\n");
      }, 15_000);
      let unsubscribe = (): void => undefined;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };
      const emitState = (result: RunResult): void => {
        writeEvent("state", result);
        if (result.status === "completed" || result.status === "failed") {
          writeEvent("done", {});
          finish();
        }
      };
      unsubscribe = deps.runService.watch(runId, (event) => {
        if (event.type === "state") emitState(event.result);
        else if (event.type === "token") {
          writeEvent("token", {
            text: event.text,
            full_text: event.fullText,
            reset: event.reset,
          });
        } else {
          writeEvent("trace", { event: event.event, details: event.details });
        }
      });
      emitState(current);
      if (!closed) {
        const liveText = deps.runService.liveTextFor(runId);
        if (liveText) {
          writeEvent("token", { text: liveText, full_text: liveText, reset: true });
        }
      }
      req.on("close", () => {
        finish();
      });
      return;
    }
  }

  routeLabel("not_found");
  throw new AppError("not_found", `No route for ${method} ${path}`, 404);
}

export function createHttpServer(deps: HttpDependencies): Server {
  return createServer((req, res) => {
    const requestId = normalizeRequestId(req.headers["x-request-id"]);
    let route = "not_found";
    res.on("finish", () => {
      deps.metrics.recordHttp(req.method ?? "GET", route, res.statusCode);
    });
    void routeRequest(req, res, deps, requestId, (value) => {
      route = value;
    }).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, requestId, asAppError(error));
    });
  });
}
