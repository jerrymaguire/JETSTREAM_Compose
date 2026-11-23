import { loadConfig } from "./config.js";
import { createHttpServer, normalizeRequestId } from "./http.js";
import { log } from "./logger.js";
import { Metrics } from "./metrics.js";
import { PiAgentRunner } from "./pi-runner.js";
import { RunService } from "./run-service.js";
import { RunStore } from "./store.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new RunStore(`${config.dataDir}/runs`);
  const metrics = new Metrics(config);
  const runner = new PiAgentRunner(config);
  const runService = new RunService(config, store, runner, metrics);
  await runService.init();

  const server = createHttpServer({
    config,
    runService,
    store,
    metrics,
    publicDir: resolve(process.cwd(), "public"),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log("info", "agent.started", {
    port: config.port,
    host: config.host,
    release_id: config.releaseId,
    model: config.model,
    request_id_example: normalizeRequestId(undefined),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "agent.stopping", { signal });
    server.close();
    await runService.shutdown();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  log("error", "agent.start_failed", {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
