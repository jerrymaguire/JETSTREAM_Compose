import assert from "node:assert/strict";
import { test } from "node:test";
import {
  htmlToText,
  parseDuckDuckGoResults,
  validatePublicUrl,
} from "../src/web.js";

test("parseDuckDuckGoResults extracts titles, URLs and snippets", () => {
  const html = `
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x"
       class='result-link'>Example <b>Docs</b></a>
    <td class='result-snippet'>A useful <b>reference</b>.</td>
  `;
  assert.deepEqual(parseDuckDuckGoResults(html), [
    {
      title: "Example Docs",
      url: "https://example.com/docs",
      snippet: "A useful reference.",
    },
  ]);
});

test("htmlToText removes executable markup and normalizes whitespace", () => {
  assert.equal(
    htmlToText("<h1>Hello</h1><script>alert(1)</script><p>A &amp; B</p>"),
    "Hello\n\nA & B",
  );
});

test("validatePublicUrl blocks local, private and credential URLs", async () => {
  await assert.rejects(() => validatePublicUrl("http://127.0.0.1/"));
  await assert.rejects(() => validatePublicUrl("http://localhost/"));
  await assert.rejects(() => validatePublicUrl("http://169.254.169.254/latest/meta-data"));
  await assert.rejects(() => validatePublicUrl("file:///etc/passwd"));
  await assert.rejects(() => validatePublicUrl("https://user:pass@example.com/"));
});
