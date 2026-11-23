import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolveWritablePath } from "./safe-path.js";
import type {
  RunEvent,
  RunInputDocument,
  RunResult,
  RunVersionsDocument,
} from "./types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;

function nowIso(): string {
  return new Date().toISOString();
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EPERM", "EBUSY", "EACCES"].includes(code) || attempt === 4) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await delay(20 * 2 ** attempt);
    }
  }
}

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  runDir(runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
    return join(this.root, runId);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async create(
    input: RunInputDocument,
    versions: RunVersionsDocument,
    result: RunResult,
  ): Promise<RunResult> {
    const dir = this.runDir(input.run_id);
    await mkdir(join(dir, "raw"), { recursive: true });
    await atomicJson(join(dir, "input.json"), input);
    await atomicJson(join(dir, "versions.json"), versions);
    await atomicJson(join(dir, "result.json"), result);
    await writeFile(join(dir, "events.jsonl"), "", "utf8");
    await this.appendEvent(input.run_id, "run.created", {
      tenant: input.tenant,
      mode: input.mode,
      model: input.model,
    });
    return result;
  }

  async getResult(runId: string): Promise<RunResult | null> {
    try {
      const raw = await readFile(join(this.runDir(runId), "result.json"), "utf8");
      const result = JSON.parse(raw) as RunResult;
      if (!result.session_id) result.session_id = result.run_id;
      if (typeof result.task_mode !== "boolean") result.task_mode = false;
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listResults(limit = 50): Promise<RunResult[]> {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => this.getResult(entry.name)),
    );
    return results
      .filter((result): result is RunResult => result !== null)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, Math.max(0, limit));
  }

  async deleteSession(sessionId: string): Promise<number> {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("invalid session id");
    const runs = (await this.listResults(1_000)).filter(
      (run) => run.session_id === sessionId,
    );
    await Promise.all(runs.map((run) => rm(this.runDir(run.run_id), { recursive: true, force: true })));
    return runs.length;
  }

  async writeResult(result: RunResult): Promise<void> {
    await atomicJson(join(this.runDir(result.run_id), "result.json"), result);
  }

  async writeRawAttachment(runId: string, name: string, data: Buffer): Promise<string> {
    const rawRoot = join(this.runDir(runId), "raw");
    const file = await resolveWritablePath(rawRoot, name);
    await writeFile(file, data);
    return name;
  }

  async appendEvent(
    runId: string,
    event: string,
    details: Record<string, unknown> = {},
  ): Promise<RunEvent> {
    const dir = this.runDir(runId);
    const [inputRaw, eventsRaw] = await Promise.all([
      readFile(join(dir, "input.json"), "utf8"),
      readFile(join(dir, "events.jsonl"), "utf8").catch(() => ""),
    ]);
    const input = JSON.parse(inputRaw) as RunInputDocument;
    const seq = eventsRaw.split("\n").filter(Boolean).length + 1;
    const record: RunEvent = {
      seq,
      event,
      timestamp: nowIso(),
      request_id: input.request_id,
      run_id: input.run_id,
      trace_id: input.trace_id,
      release_id: input.release_id,
      details,
    };
    await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readFile(join(this.runDir(runId), "events.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async markInterrupted(): Promise<string[]> {
    await this.init();
    const entries = await readdir(this.root, { withFileTypes: true });
    const interrupted: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
      const result = await this.getResult(entry.name);
      if (!result || (result.status !== "queued" && result.status !== "running")) continue;
      const finishedAt = nowIso();
      const updated: RunResult = {
        ...result,
        status: "failed",
        error_code: "interrupted_by_restart",
        error_message: "Agent process restarted before the run reached a terminal state",
        finished_at: finishedAt,
        duration_ms:
          result.started_at === null
            ? null
            : Math.max(0, Date.parse(finishedAt) - Date.parse(result.started_at)),
      };
      await this.writeResult(updated);
      await this.appendEvent(entry.name, "run.failed", {
        error_code: updated.error_code,
        reason: "interrupted_by_restart",
      });
      interrupted.push(entry.name);
    }
    return interrupted;
  }
}
