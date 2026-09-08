import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

// Rate-limit enforcement (SECURITY.md DoS controls). Each flood targets one
// bucket key; limiters run BEFORE authentication so unauthenticated floods
// are capped without ever reaching bcrypt or the database. Vitest isolates
// test files in separate processes, so exhausted buckets never leak into
// other test files.
const app = createApp();

/** Fire `count` unauthenticated requests at one endpoint; return all statuses. */
async function flood(
  method: "get" | "post",
  path: string,
  count: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const res =
      method === "post"
        ? await request(app).post(path).send({})
        : await request(app).get(path);
    statuses.push(res.status);
  }
  return statuses;
}

/** Assert the first `allowed` requests pass the limiter (401 here) and the
 *  next one is rejected with 429 RATE_LIMITED. */
function expectThrottle(statuses: number[], allowed: number, last: request.Response) {
  expect(statuses.slice(0, allowed)).toEqual(Array<number>(allowed).fill(401));
  expect(last.status).toBe(429);
  expect(last.body.error.code).toBe("RATE_LIMITED");
}

describe("rate limiting", () => {
  it("login brute-force limit: 10 attempts per 15 min, then 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post("/api/v1/auth/login")
        .send({ email: "bruteforce@test.local", password: "WrongPassword1!" });
      statuses.push(res.status);
    }
    expect(statuses).toEqual(Array<number>(10).fill(401));
    const blocked = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "bruteforce@test.local", password: "WrongPassword1!" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("guest mutation flood: 120/min shared budget, then 429", async () => {
    const statuses = await flood("post", "/api/v1/guests", 120);
    const blocked = await request(app).post("/api/v1/guests").send({});
    expectThrottle(statuses, 120, blocked);
  });

  it("import preview upload: 10/min, then 429", async () => {
    const statuses = await flood("post", "/api/v1/import/preview", 10);
    const blocked = await request(app).post("/api/v1/import/preview");
    expectThrottle(statuses, 10, blocked);
  });

  it("bulk credential email: 10/min, then 429", async () => {
    const statuses = await flood("post", "/api/v1/credentials/bulk-email", 10);
    const blocked = await request(app).post("/api/v1/credentials/bulk-email").send({});
    expectThrottle(statuses, 10, blocked);
  });

  it("sync snapshot download: 30/min, then 429", async () => {
    const statuses = await flood("get", "/api/v1/sync/snapshot", 30);
    const blocked = await request(app).get("/api/v1/sync/snapshot");
    expectThrottle(statuses, 30, blocked);
  });

  it("SSE stream connections: 10/min, then 429", async () => {
    const statuses = await flood("get", "/api/v1/stats/stream", 10);
    const blocked = await request(app).get("/api/v1/stats/stream");
    expectThrottle(statuses, 10, blocked);
  });

  it("CSV report exports: 30/min shared budget, then 429", async () => {
    const statuses = await flood("get", "/api/v1/reports/guests.csv", 30);
    const blocked = await request(app).get("/api/v1/reports/guests.csv");
    expectThrottle(statuses, 30, blocked);
  });

  it("device registration: 30/min, then 429", async () => {
    const statuses = await flood("post", "/api/v1/devices", 30);
    const blocked = await request(app).post("/api/v1/devices").send({});
    expectThrottle(statuses, 30, blocked);
  });
});
