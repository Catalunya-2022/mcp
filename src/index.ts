import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { getCorpus } from "./corpus.js";

const SKIP_AUTOSTART_ENV = "MCP_SKIP_AUTOSTART";

/** How long in-flight requests get to drain on shutdown before the process force-exits. */
const SHUTDOWN_GRACE_MS = 5_000;

export function shouldAutostart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKIP_AUTOSTART_ENV] !== "1";
}

export function startServer() {
  // Load the corpus before accepting traffic so a missing or corrupt
  // corpus.json fails the process (and the deploy health check) immediately
  // instead of surfacing as 500s on the first MCP request.
  getCorpus();

  const { app, close } = createApp();
  const port = Number.parseInt(process.env.PORT || "3001", 10);
  const hostname = process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0";

  const httpServer = serve({ fetch: app.fetch, port, hostname }, () => {
    console.log(`Catalunya 2022 MCP server listening on http://${hostname}:${port}`);
  });

  httpServer.on("error", (error) => {
    console.error("Failed to start Catalunya 2022 MCP server", error);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const forceExitTimer = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();
    httpServer.close(() => {
      void Promise.resolve(close()).finally(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      });
    });
  };

  // PM2 sends SIGTERM (configured via kill_signal); `kill` and Ctrl+C too.
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return httpServer;
}

if (shouldAutostart()) {
  startServer();
}
