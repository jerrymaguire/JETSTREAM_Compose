import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const SEARCH_URL = "https://lite.duckduckgo.com/lite/";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  contentType: string;
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a = -1, b = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function unsafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const family = isIP(host);
  if (family === 4) return privateIpv4(host);
  if (family === 6) return privateIpv6(host);
  return false;
}

export async function validatePublicUrl(value: string | URL): Promise<URL> {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https URLs are allowed");
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (unsafeHostname(url.hostname)) throw new Error("private or local hosts are not allowed");
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => unsafeHostname(address))) {
      throw new Error("URL resolves to a private or local address");
    }
  }
  return url;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseDuckDuckGoResults(html: string, maxResults = 5): SearchResult[] {
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];
  const results: SearchResult[] = [];
  for (let index = 0; index < links.length && results.length < maxResults; index += 1) {
    const rawHref = decodeEntities(links[index]?.[1] ?? "");
    const wrapped = new URL(rawHref, "https://duckduckgo.com");
    const target = wrapped.searchParams.get("uddg") ?? wrapped.toString();
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    results.push({
      title: htmlToText(links[index]?.[2] ?? ""),
      url: url.toString(),
      snippet: htmlToText(snippets[index]?.[1] ?? ""),
    });
  }
  return results;
}

async function fetchResponse(
  input: string,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ response: Response; url: URL }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    let current = await validatePublicUrl(input);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "AgentCompose/1.0 (+local research agent)",
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) throw new Error("too many redirects");
        current = await validatePublicUrl(new URL(location, current));
        continue;
      }
      return { response, url: current };
    }
    throw new Error("too many redirects");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function searchWeb(
  query: string,
  options: {
    maxResults?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<SearchResult[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  const { response } = await fetchResponse(url.toString(), options.signal, options.timeoutMs);
  if (!response.ok) throw new Error(`search failed with HTTP ${response.status}`);
  const html = (await readLimited(response, DEFAULT_MAX_BYTES)).toString("utf8");
  const results = parseDuckDuckGoResults(html, Math.max(1, Math.min(8, options.maxResults ?? 5)));
  if (!results.length) throw new Error("search returned no parseable results");
  return results;
}

export async function fetchWebPage(
  input: string,
  options: {
    maxBytes?: number;
    maxChars?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<FetchedPage> {
  const { response, url } = await fetchResponse(input, options.signal, options.timeoutMs);
  if (!response.ok) throw new Error(`page returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (
    !/^(text\/|application\/(json|xml|xhtml\+xml|ld\+json))/i.test(contentType)
  ) {
    throw new Error(`unsupported content type: ${contentType}`);
  }
  const raw = (await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES)).toString("utf8");
  const title = htmlToText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "");
  const text = contentType.includes("html") || contentType.includes("xml")
    ? htmlToText(raw)
    : raw.trim();
  return {
    url: url.toString(),
    title,
    text: text.slice(0, Math.max(1, options.maxChars ?? 20_000)),
    contentType,
  };
}
