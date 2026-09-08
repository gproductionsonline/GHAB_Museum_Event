import { createApp } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";

async function main() {
  await prisma.$connect();
  logger.info("db_connected", { node: config.NODE_ENV }); // never log the URL (credentials)

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info("api_listening", { port: config.PORT, env: config.NODE_ENV });
    logger.info("mail_transport", { provider: config.resendEnabled ? "resend" : "outbox-fallback" });
  });

  const shutdown = async (signal: string) => {
    logger.info("shutdown", { signal });
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal_startup", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
