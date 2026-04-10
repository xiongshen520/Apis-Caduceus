import { createServer } from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"] ?? "8082";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

const server = createServer(app);

server.listen(port, () => {
  logger.info({ port }, "🪷 Apis Caduceus listening");
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
