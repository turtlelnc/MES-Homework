import http from "node:http";
import { runtimeProfile } from "./runtime-profile.mjs";

export function createHttpServer(app) {
  const server = http.createServer(
    {
      headersTimeout: 15000,
      requestTimeout: 70000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
      highWaterMark: 64 * 1024,
      maxHeaderSize: 16384,
    },
    app,
  );
  server.maxConnections = runtimeProfile().httpConnections;
  server.maxRequestsPerSocket = 100;
  return server;
}

export function installLifecycle(server, stop) {
  // The parent watchdog runs outside the API event loop. A blocked loop cannot
  // falsely report health; no network connection is needed for this heartbeat.
  const heartbeat = () => {
    if (process.connected) process.send({ type: "heartbeat" }, () => {});
  };
  const timer = setInterval(heartbeat, 5000);
  timer.unref();
  heartbeat();
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    stop();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 10000);
    deadline.unref();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  // If its supervisor dies, the API must not remain as an unmonitored orphan.
  if (process.send) {
    process.once("disconnect", shutdown);
    process.on("message", (message) => {
      if (message?.type === "shutdown") shutdown();
    });
  }
}
