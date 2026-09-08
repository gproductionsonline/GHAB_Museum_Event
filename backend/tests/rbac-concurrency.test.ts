import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { generateCredentialCode, sha256 } from "../src/lib/codes.js";
import { encryptSecret } from "../src/lib/crypto.js";

const app = createApp();

async function login(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "ChangeMe123!" });
  return res.body.token as string;
}

async function getEventId(): Promise<string> {
  const events = await prisma.event.findMany({ take: 1 });
  return events[0]!.id;
}

async function createConfirmedGuestWithCredential(): Promise<{ code: string; guestId: string; lastName: string }> {
  const eventId = await getEventId();
  // Unique per invocation: the shared test database persists between runs.
  const lastName = `Testington-${crypto.randomUUID().slice(0, 8)}`;
  const [category, rsvp] = await Promise.all([
    prisma.guestCategory.findFirstOrThrow({ where: { eventId } }),
    prisma.rsvpStatus.findUniqueOrThrow({ where: { code: "CONFIRMED" } }),
  ]);
  const guest = await prisma.guest.create({
    data: {
      eventId,
      categoryId: category.id,
      rsvpStatusId: rsvp.id,
      firstName: "Concurren",
      lastName,
      normalizedName: `concurren ${lastName.toLowerCase()}`,
      source: "MANUAL",
    },
  });
  const code = generateCredentialCode();
  const cred = await prisma.credentialVersion.create({
    data: {
      guestId: guest.id,
      eventId,
      versionNumber: 1,
      codeHash: sha256(code),
      codeEnc: encryptSecret(code),
      codeLast4: code.slice(-4),
      status: "ACTIVE",
    },
  });
  await prisma.guest.update({ where: { id: guest.id }, data: { activeCredentialId: cred.id } });
  return { code, guestId: guest.id, lastName };
}

describe("RBAC authorization", () => {
  it("rejects unauthenticated requests to protected endpoints", async () => {
    await request(app).get("/api/v1/events").expect(401);
  });

  it("rejects invalid tokens", async () => {
    await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer not-a-real-token")
      .expect(401);
  });

  it("allows ADMIN to list events", async () => {
    const token = await login("admin@ghab.gov");
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("denies CHECKIN_OPERATOR an admin-only operation (403)", async () => {
    const token = await login("scanner@ghab.gov");
    const eventId = await getEventId();
    const res = await request(app)
      .get(`/api/v1/import/batches?eventId=${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.message).toContain("Missing permission");
  });

  it("permits CHECKIN_OPERATOR to list events but not export reports", async () => {
    const token = await login("scanner@ghab.gov");
    await request(app)
      .get("/api/v1/events")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const eventId = await getEventId();
    await request(app)
      .get(`/api/v1/reports/guests.csv?eventId=${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("auth/me returns role and permission set", async () => {
    const token = await login("staff@ghab.gov");
    const res = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.user.role).toBe("STAFF");
    expect(res.body.permissions).toContain("guest:read");
    expect(res.body.permissions).not.toContain("user:manage");
  });
});

describe("check-in concurrency guarantee", () => {
  it("exactly one of 12 simultaneous scans succeeds; the rest report ALREADY_USED", async () => {
    const token = await login("scanner@ghab.gov");
    const eventId = await getEventId();
    const { code, lastName } = await createConfirmedGuestWithCredential();

    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app)
          .post("/api/v1/checkin/scan")
          .set("Authorization", `Bearer ${token}`)
          .send({ eventId, code, gate: "Main Entrance", deviceName: "conc-test" }),
      ),
    );

    const results = attempts.map((r) => r.body.result as string);
    const checkedIn = results.filter((r) => r === "CHECKED_IN").length;
    const alreadyUsed = results.filter((r) => r === "ALREADY_USED").length;

    expect(checkedIn).toBe(1);
    expect(alreadyUsed).toBe(11);

    // Database is the final authority: exactly one admission row exists.
    const rows = await prisma.checkIn.findMany({
      where: { guest: { lastName } },
    });
    expect(rows.length).toBe(1);
  });

  it("replaying the same operationId is idempotent (no second admission)", async () => {
    const token = await login("scanner@ghab.gov");
    const eventId = await getEventId();
    const { guestId } = await createConfirmedGuestWithCredential();
    const operationId = `op-idempotent-${crypto.randomUUID().slice(0, 12)}`;

    const first = await request(app)
      .post("/api/v1/checkin/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ eventId, guestId, operationId });
    expect(first.body.result).toBe("CHECKED_IN");

    const retry = await request(app)
      .post("/api/v1/checkin/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ eventId, guestId, operationId });
    expect(retry.body.result).toBe("CHECKED_IN");

    const count = await prisma.checkIn.count({ where: { operationId } });
    expect(count).toBe(1);
  });
});
