import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { prepareAttachments } from "../src/documents.js";
import { AppError } from "../src/errors.js";
import { testConfig, temporaryDirectory } from "./test-helpers.js";

const fixtures = resolve(process.cwd(), "tests", "fixtures");

test("prepareAttachments extracts Markdown, DOCX and PDF text", async () => {
  const temp = await temporaryDirectory("agent-documents-");
  const config = testConfig(temp.path);
  const docx = await readFile(resolve(fixtures, "sample.docx"));
  const pdf = await readFile(resolve(fixtures, "sample.pdf"));
  try {
    const prepared = await prepareAttachments(
      [
        {
          name: "notes.md",
          mime_type: "text/markdown",
          data_base64: Buffer.from("# Notes\n\nMarkdown input.").toString("base64"),
        },
        {
          name: "report.docx",
          data_base64: docx.toString("base64"),
        },
        {
          name: "brief.pdf",
          data_base64: pdf.toString("base64"),
        },
      ],
      config,
    );
    assert.deepEqual(
      prepared.map((item) => item.metadata.kind),
      ["markdown", "docx", "pdf"],
    );
    assert.match(prepared[0]?.document.text ?? "", /Markdown input/);
    assert.match(prepared[1]?.document.text ?? "", /Hello from DOCX fixture/);
    assert.match(prepared[2]?.document.text ?? "", /Hello from PDF fixture/);
    assert.equal(prepared[0]?.metadata.stored_as, "01-notes.md");
    assert.equal(prepared[1]?.raw?.length, docx.length);
  } finally {
    await temp.cleanup();
  }
});

test("prepareAttachments rejects unsupported or excessive files", async () => {
  const temp = await temporaryDirectory("agent-documents-invalid-");
  const config = testConfig(temp.path, { attachmentMaxBytes: 10 });
  try {
    await assert.rejects(
      () =>
        prepareAttachments(
          [{ name: "malware.exe", data_base64: Buffer.from("data").toString("base64") }],
          testConfig(temp.path),
        ),
      (error: unknown) =>
        error instanceof AppError && /Unsupported attachment type/.test(error.message),
    );
    await assert.rejects(
      () =>
        prepareAttachments(
          [{ name: "large.txt", data_base64: Buffer.alloc(20, 65).toString("base64") }],
          config,
        ),
      (error: unknown) => error instanceof AppError && error.httpStatus === 413,
    );
  } finally {
    await temp.cleanup();
  }
});
