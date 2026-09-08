import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp();

describe("health and readiness", () => {
  it("GET /health reports liveness without diagnostics", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toEqual({
      status: "ok",
      service: "ghab-events-backend",
      time: expect.any(String) as string,
    });
  });

  it("GET /ready verifies the PostgreSQL dependency", async () => {
    const res = await request(app).get("/ready").expect(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.dependencies.database).toBe("up");
  });

  it("returns 404 with the error envelope for unknown API paths", async () => {
    const res = await request(app).get("/api/v1/nope").expect(404);
    expect(res.body.error).toMatchObject({
      code: "NOT_FOUND",
      requestId: expect.any(String) as string,
      details: [],
    });
  });
});
