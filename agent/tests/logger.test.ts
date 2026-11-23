import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../src/logger.js";

test("structured logger writes valid JSON to stdout and stderr", () => {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    log("info", "test.info", { value: 1 });
    log("error", "test.error", { value: 2 });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal((JSON.parse(out[0] ?? "{}") as { event: string }).event, "test.info");
  assert.equal((JSON.parse(err[0] ?? "{}") as { event: string }).event, "test.error");
});
