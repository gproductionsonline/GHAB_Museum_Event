import express from "express";
import helmet from "helmet";
import cors from "cors";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestContext } from "./middleware/request-context.js";
import { pingDatabase } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { eventsRouter } from "./modules/events/events.routes.js";
import { guestsRouter } from "./modules/guests/guests.routes.js";
import { credentialsRouter } from "./modules/credentials/credentials.routes.js";
import { importRouter } from "./modules/import/import.routes.js";
import { checkinRouter } from "./modules/checkin/checkin.routes.js";
import { syncRouter } from "./modules/sync/sync.routes.js";
import { statsRouter } from "./modules/stats/stats.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { devicesRouter } from "./modules/devices/devices.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { emailRouter } from "./modules/email/email.routes.js";

export function createApp() {
  const app = express();

  // Trust exactly the configured proxy hop(s) so req.ip is real behind the
  // load balancer but cannot be spoofed by direct clients (audit M-10).
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
  app.disable("x-powered-by");

  // Security headers (CSP is owned by the Next.js frontend, not this API).
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // CORS: explicit allowlist of browser origins only.
  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      maxAge: 86400,
    }),
  );

  // Correlation ID + structured request logging.
  app.use(requestContext());

  // Bounded request bodies (defense against oversized payloads).
  app.use(express.json({ limit: "2mb" }));

  // --- Liveness: process is up. No diagnostics are exposed. ---
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ghab-events-backend", time: new Date().toISOString() });
  });

  // --- Readiness: required dependencies are usable. ---
  app.get("/ready", async (_req, res) => {
    const dbUp = await pingDatabase();
    if (dbUp) {
      res.json({ status: "ready", dependencies: { database: "up" } });
    } else {
      logger.error("readiness_failed", { dependency: "database" });
      res.status(503).json({ status: "unavailable", dependencies: { database: "down" } });
    }
  });

  // API surface. Versioned per API_DESIGN.md.
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/events", eventsRouter);
  app.use("/api/v1/guests", guestsRouter);
  app.use("/api/v1/credentials", credentialsRouter);
  app.use("/api/v1/import", importRouter);
  app.use("/api/v1/checkin", checkinRouter);
  app.use("/api/v1/sync", syncRouter);
  app.use("/api/v1/stats", statsRouter);
  app.use("/api/v1/reports", reportsRouter);
  app.use("/api/v1/devices", devicesRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/audit", auditRouter);
  app.use("/api/v1/email", emailRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
