// Audit M-5 regression: SSE stream authorization must be FRESH from the
// database — a deactivated user, or a user without guest:read, loses stream
// access even with an unexpired JWT.
import { describe, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/auth.js";

const app = createApp();

async function getEventId(): Promise<string> {
  const events = await prisma.event.findMany({ take: 1 });
  return events[0]!.id;
}

async function createStaffUser(email: string): Promise<string> {
  const user = await prisma.user.upsert({
    where: { email },
    update: { active: true },
    create: {
      email,
      name: `SSE Test ${email}`,
      passwordHash: await hashPassword("ChangeMe123!"),
    },
  });
  const staffRole = await prisma.role.findUniqueOrThrow({ where: { code: "STAFF" } });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: staffRole.id } },
    update: {},
    create: { userId: user.id, roleId: staffRole.id },
  });
  return user.id;
}

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "ChangeMe123!" });
  return res.body.token as string;
}

describe("M-5: SSE authorization freshness", () => {
  it("rejects an invalid token outright", async () => {
    const eventId = await getEventId();
    await request(app)
      .get(`/api/v1/stats/stream?eventId=${eventId}&token=not-a-token`)
      .expect(401);
  });

  it("rejects a DEACTIVATED user despite an unexpired JWT", async () => {
    const email = `sse-deactivated-${crypto.randomUUID().slice(0, 8)}@test.local`;
    await createStaffUser(email);
    const token = await login(email);
    const eventId = await getEventId();

    // Stream works before deactivation (headers arrive; we abort immediately
    // by closing — supertest resolves on end, so we only assert rejection
    // paths here to avoid holding the stream open).
    await prisma.user.update({ where: { email }, data: { active: false } });

    await request(app)
      .get(`/api/v1/stats/stream?eventId=${eventId}&token=${token}`)
      .expect(401);

    // The JSON stats endpoint (same permission model) also rejects.
    await request(app)
      .get(`/api/v1/stats?eventId=${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("rejects a user whose roles/permissions were removed (no guest:read)", async () => {
    const email = `sse-noperm-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const userId = await createStaffUser(email);
    const token = await login(email);
    const eventId = await getEventId();

    // Strip all roles: user remains active but holds no permissions.
    await prisma.userRole.deleteMany({ where: { userId } });

    await request(app)
      .get(`/api/v1/stats/stream?eventId=${eventId}&token=${token}`)
      .expect(401);
  });
});
