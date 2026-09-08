import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

const app = createApp();

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "ChangeMe123!" });
  return res.body.token as string;
}

describe("attendance dashboard stats", () => {
  it("exposes explicit not-arrived and accompanying totals that stay consistent", async () => {
    const token = await login("admin@ghab.gov");
    const event = await prisma.event.findFirstOrThrow();
    const res = await request(app)
      .get(`/api/v1/stats?eventId=${event.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const totals = res.body.totals;
    expect(typeof totals.expected).toBe("number");
    expect(typeof totals.checkedIn).toBe("number");
    expect(typeof totals.accompanying).toBe("number");
    expect(totals.notArrived).toBe(totals.expected - totals.checkedIn);
    expect(totals.accompanying).toBeGreaterThanOrEqual(0);
    expect(totals.accompanying).toBeLessThanOrEqual(totals.expected);
  });

  it("denies the dashboard to unauthenticated callers", async () => {
    const event = await prisma.event.findFirstOrThrow();
    await request(app).get(`/api/v1/stats?eventId=${event.id}`).expect(401);
  });
});
