import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { AppError } from "./errors.js";
import type {
  AgentConfig,
  AgentDocument,
  AttachmentInput,
  AttachmentKind,
  RunAttachment,
} from "./types.js";
import { fetchWebPage, htmlToText } from "./web.js";

export interface PreparedAttachment {
  metadata: RunAttachment;
  document: AgentDocument;
  raw: Buffer | null;
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".sql",
  ".sh",
]);

function safeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || "attachment";
}

function detectedKind(name: string, mimeType = ""): AttachmentKind | null {
  const extension = extname(name).toLowerCase();
  const mime = mimeType.toLowerCase();
  if (extension === ".md" || extension === ".markdown" || mime === "text/markdown") {
    return "markdown";
  }
  if (extension === ".html" || extension === ".htm" || mime === "text/html") return "html";
  if (extension === ".docx") {
    return "docx";
  }
  if (extension === ".pdf" || mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return "text";
  }
  return null;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMMatrix ??= class DOMMatrix {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
  };
  globals.ImageData ??= class ImageData {};
  globals.Path2D ??= class Path2D {};
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      pages.push(text);
    }
    return pages.join("\n\n");
  } finally {
    await document.destroy();
  }
}

async function extractText(
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ kind: AttachmentKind; text: string }> {
  const kind = detectedKind(name, mimeType);
  if (!kind) {
    throw new AppError(
      "invalid_request",
      `Unsupported attachment type: ${name}`,
      400,
    );
  }
  if (kind === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return { kind, text: result.value };
  }
  if (kind === "pdf") {
    return { kind, text: await extractPdf(buffer) };
  }
  const decoded = buffer.toString("utf8");
  return { kind, text: kind === "html" ? htmlToText(decoded) : decoded };
}

export async function prepareAttachments(
  inputs: AttachmentInput[] | undefined,
  config: Pick<
    AgentConfig,
    | "attachmentMaxBytes"
    | "attachmentTotalMaxBytes"
    | "attachmentMaxChars"
    | "attachmentTotalMaxChars"
    | "attachmentCountLimit"
    | "webFetchMaxBytes"
    | "toolTimeoutMs"
  >,
  signal?: AbortSignal,
): Promise<PreparedAttachment[]> {
  const list = inputs ?? [];
  if (list.length === 0) return [];
  if (list.length > config.attachmentCountLimit) {
    throw new AppError(
      "invalid_request",
      `At most ${config.attachmentCountLimit} attachments are allowed`,
      400,
    );
  }

  const prepared: PreparedAttachment[] = [];
  let totalBytes = 0;
  let totalChars = 0;
  for (let index = 0; index < list.length; index += 1) {
    const input = list[index];
    if (!input || typeof input.name !== "string" || !input.name.trim()) {
      throw new AppError("invalid_request", "Each attachment requires a name", 400);
    }
    const originalName = basename(input.name).slice(0, 160);
    const storedAs = `${String(index + 1).padStart(2, "0")}-${safeName(originalName)}`;

    let raw: Buffer | null = null;
    let kind: AttachmentKind;
    let source: string;
    let text: string;
    if (input.url !== undefined) {
      if (input.data_base64 !== undefined) {
        throw new AppError(
          "invalid_request",
          `Attachment ${originalName} cannot contain both url and data_base64`,
          400,
        );
      }
      const page = await fetchWebPage(input.url, {
        maxBytes: Math.min(config.webFetchMaxBytes, config.attachmentMaxBytes),
        maxChars: config.attachmentMaxChars,
        ...(signal ? { signal } : {}),
        timeoutMs: config.toolTimeoutMs,
      });
      kind = "web";
      source = page.url;
      text = page.text;
    } else {
      if (typeof input.data_base64 !== "string" || !input.data_base64.trim()) {
        throw new AppError(
          "invalid_request",
          `Attachment ${originalName} requires data_base64 or url`,
          400,
        );
      }
      const estimatedBytes = Math.floor((input.data_base64.length * 3) / 4);
      if (estimatedBytes > config.attachmentMaxBytes) {
        throw new AppError(
          "invalid_request",
          `Attachment ${originalName} exceeds ${config.attachmentMaxBytes} bytes`,
          413,
        );
      }
      raw = Buffer.from(input.data_base64, "base64");
      if (!raw.length) {
        throw new AppError("invalid_request", `Attachment ${originalName} is empty`, 400);
      }
      totalBytes += raw.length;
      if (totalBytes > config.attachmentTotalMaxBytes) {
        throw new AppError(
          "invalid_request",
          `Attachments exceed ${config.attachmentTotalMaxBytes} total bytes`,
          413,
        );
      }
      const extracted = await extractText(originalName, input.mime_type ?? "", raw);
      kind = extracted.kind;
      source = originalName;
      text = extracted.text;
    }

    const remaining = config.attachmentTotalMaxChars - totalChars;
    if (remaining <= 0) {
      throw new AppError(
        "invalid_request",
        `Attachment text exceeds ${config.attachmentTotalMaxChars} characters`,
        413,
      );
    }
    const normalized = text.replace(/\u0000/g, "").trim();
    if (!normalized) {
      throw new AppError(
        "invalid_request",
        `Attachment ${originalName} contains no extractable text`,
        400,
      );
    }
    const allowed = Math.min(config.attachmentMaxChars, remaining);
    const clipped = normalized.slice(0, allowed);
    totalChars += clipped.length;
    const metadata: RunAttachment = {
      name: originalName,
      kind,
      source,
      chars: clipped.length,
      original_bytes: raw?.length ?? Buffer.byteLength(normalized),
      truncated: clipped.length < normalized.length,
      stored_as: raw ? storedAs : null,
    };
    prepared.push({
      metadata,
      document: {
        name: originalName,
        kind,
        source,
        text: clipped,
        truncated: metadata.truncated,
      },
      raw,
    });
  }
  return prepared;
}
