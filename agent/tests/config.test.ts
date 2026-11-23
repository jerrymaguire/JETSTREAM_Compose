import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayApiBaseUrl, loadConfig } from "../src/config.js";

test("loadConfig applies defaults and resolves directories", () => {
  const config = loadConfig({ GATEWAY_API_KEY: "secret" }, "C:/tmp/project");
  assert.equal(config.port, 8080);
  assert.equal(config.gatewayBaseUrl, "http://gateway:4000");
  assert.equal(config.maxConcurrency, 4);
  assert.equal(config.queueCapacity, 32);
  assert.equal(config.releaseId, "local-dev");
  assert.match(config.dataDir, /data$/);
  assert.equal(gatewayApiBaseUrl(config), "http://gateway:4000/v1");
});

test("loadConfig rejects missing key and invalid bounded integers", () => {
  assert.throws(() => loadConfig({}, "C:/tmp/project"), /GATEWAY_API_KEY is required/);
  assert.throws(
    () => loadConfig({ GATEWAY_API_KEY: "secret", AGENT_MAX_CONCURRENCY: "0" }),
    /AGENT_MAX_CONCURRENCY/,
  );
  assert.throws(
    () => loadConfig({ GATEWAY_API_KEY: "secret", GATEWAY_BASE_URL: "file:///tmp/socket" }),
    /http or https/,
  );
});

test("loadConfig strips trailing slashes from the gateway URL", () => {
  const config = loadConfig(
    {
      GATEWAY_API_KEY: "secret",
      GATEWAY_BASE_URL: "http://gateway:4000///",
      AGENT_QUEUE_CAPACITY: "0",
    },
    "C:/tmp/project",
  );
  assert.equal(config.gatewayBaseUrl, "http://gateway:4000");
  assert.equal(config.queueCapacity, 0);
});
