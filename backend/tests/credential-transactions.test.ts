// Audit M-1 / M-2 / M-3 / L-1 regressions: credential state-transition
// serialization, atomic void+audit evidence, and operationId replay semantics.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { AppUser } from "../src/config.js";
import { decryptSecret } from "../src/lib/crypto.js";
import {
  issueCredential,
  revokeCredential,
  reissueCredential,
} from "../src/modules/credentials/credentials.service.js";
import { attemptCheckIn, undoCheckIn } from "../src/modules/checkin/checkin.service.js";

const app = createApp();

async function actorFor(email: string): Promise<AppUser> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: email === "scanner@ghab.gov" ? "CHECKIN_OPERATOR" : "ADMIN",
    roles: [email === "scanner@ghab.gov" ? "CHECKIN_OPERATOR" : "ADMIN"],
  };
}

async function getEventId(): Promise<string> {
  const events = await prisma.event.findMany({ take: 1 });
  return events[0]!.id;
}

type Fixture = {
  guestId: string;
  code: string;
  codeHash: string;
  eventId: string;
};

async function createGuestWithCredential(): Promise<Fixture> {
  const eventId = await getEventId();
  const [category, rsvp] = await Promise.all([
    prisma.guestCategory.findFirstOrThrow({ where: { eventId } }),
    prisma.rsvpStatus.findUniqueOrThrow({ where: { code: "CONFIRMED" } }),
  ]);
  const suffix = crypto.randomUUID().slice(0, 8);
  const guest = await prisma.guest.create({
    data: {
      eventId,
      categoryId: category.id,
      rsvpStatusId: rsvp.id,
      firstName: "Race",
      lastName: `Guest-${suffix}`,
      normalizedName: `race guest-${suffix}`,
      source: "MANUAL",
    },
  });
  await issueCredential(guest.id, null);
  const cred = await prisma.credentialVersion.findFirstOrThrow({
    where: { guestId: guest.id, status: "ACTIVE" },
  });
  // Recover the raw code through the service's encrypted storage.
  const code = decryptSecret(cred.codeEnc!);
  return { guestId: guest.id, code, codeHash: cred.codeHash, eventId };
}

/** Invariant: no orphaned ACTIVE credential behind a null pointer, and at
 *  most one ACTIVE credential per guest. */
async function assertCredentialStateConsistent(guestId: string): Promise<void> {
  const guest = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } });
  const active = await prisma.credentialVersion.findMany({
    where: { guestId, status: "ACTIVE" },
  });
  expect(active.length).toBeLessThanOrEqual(1);
  if (guest.activeCredentialId === null) {
    expect(active.length).toBe(0);
  } else {
    expect(active.length).toBe(1);
    expect(active[0]!.id).toBe(guest.activeCredentialId);
  }
}

describe("M-1: credential state transition serialization", () => {
  it("concurrent revoke vs reissue leaves consistent state (no orphaned ACTIVE credential)", async () => {
    const admin = await actorFor("admin@ghab.gov");
    const { guestId } = await createGuestWithCredential();

    const [revokeResult, reissueResult] = await Promise.allSettled([
      revokeCredential(guestId, "race-revoke", admin),
      reissueCredential(guestId, "race-reissue", admin),
    ]);

    // Both operations must complete without unexpected failure shapes.
    for (const r of [revokeResult, reissueResult]) {
      expect(r.status).toBe("fulfilled");
    }

    await assertCredentialStateConsistent(guestId);
    // Final state is one of the two legal outcomes, never an orphan.
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } });
    const active = await prisma.credentialVersion.count({
      where: { guestId, status: "ACTIVE" },
    });
    expect(active).toBe(guest.activeCredentialId ? 1 : 0);
  });

  it("concurrent double reissue leaves exactly one ACTIVE credential and a consistent pointer", async () => {
    const admin = await actorFor("admin@ghab.gov");
    const { guestId } = await createGuestWithCredential();

    const results = await Promise.allSettled([
      reissueCredential(guestId, "reissue-a", admin),
      reissueCredential(guestId, "reissue-b", admin),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
    }

    await assertCredentialStateConsistent(guestId);
    const activeCount = await prisma.credentialVersion.count({
      where: { guestId, status: "ACTIVE" },
    });
    expect(activeCount).toBe(1);
  });

  it("check-in racing a revocation admits at most once and never leaves a live credential behind", async () => {
    const admin = await actorFor("admin@ghab.gov");
    const operator = await actorFor("scanner@ghab.gov");
    const { guestId, codeHash, eventId } = await createGuestWithCredential();

    const [attemptResult, revokeResult] = await Promise.allSettled([
      attemptCheckIn({ eventId, method: "QR", codeHash, gate: "Main Entrance", actor: operator }),
      revokeCredential(guestId, "post-admission-revoke", admin),
    ]);

    expect(revokeResult.status).toBe("fulfilled");
    if (attemptResult.status !== "fulfilled") throw attemptResult.reason;
    expect(["CHECKED_IN", "CANCELLED"]).toContain(attemptResult.value.result);

    const admissions = await prisma.checkIn.count({ where: { guestId } });
    if (attemptResult.value.result === "CHECKED_IN") {
      expect(admissions).toBe(1);
    } else {
      expect(admissions).toBe(0);
    }

    // Whichever order executed, the credential ends revoked.
    const active = await prisma.credentialVersion.count({
      where: { guestId, status: "ACTIVE" },
    });
    expect(active).toBe(0);
  });

  it("check-in racing a reissue never admits twice and never admits a REPLACED version", async () => {
    const admin = await actorFor("admin@ghab.gov");
    const operator = await actorFor("scanner@ghab.gov");
    const { guestId, codeHash, eventId } = await createGuestWithCredential();

    const [attemptResult, reissueResult] = await Promise.allSettled([
      attemptCheckIn({ eventId, method: "QR", codeHash, gate: "Main Entrance", actor: operator }),
      reissueCredential(guestId, "concurrent-reissue", admin),
    ]);

    expect(reissueResult.status).toBe("fulfilled");
    if (attemptResult.status !== "fulfilled") throw attemptResult.reason;
    expect(["CHECKED_IN", "REPLACED"]).toContain(attemptResult.value.result);

    const admissions = await prisma.checkIn.count({ where: { guestId } });
    expect(admissions).toBeLessThanOrEqual(1);
    await assertCredentialStateConsistent(guestId);
  });
});

describe("M-2: void + audit atomicity and completeness", () => {
  it("a successful void deletes the admission AND leaves a complete audit record", async () => {
    const admin = await actorFor("admin@ghab.gov");
    const operator = await actorFor("scanner@ghab.gov");
    const { guestId, codeHash, eventId } = await createGuestWithCredential();

    const admitted = await attemptCheckIn({
      eventId,
      method: "QR",
      codeHash,
      gate: "VIP Gate",
      actor: operator,
    });
    expect(admitted.result).toBe("CHECKED_IN");
    const checkInId = admitted.checkIn!.id;
    const original = await prisma.checkIn.findUniqueOrThrow({ where: { id: checkInId } });

    await undoCheckIn(checkInId, admin);

    // Row is gone (guest can be re-admitted)…
    await expect(
      prisma.checkIn.findUnique({ where: { id: checkInId } }),
    ).resolves.toBeNull();

    // …and the forensic evidence is complete.
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "CHECKIN_UNDONE", entityId: checkInId },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow.actorUserId).toBe(admin.id);
    expect(auditRow.eventId).toBe(eventId);
    const before = JSON.parse(auditRow.beforeJson!) as Record<string, unknown>;
    expect(before).toMatchObject({
      checkInId,
      eventId,
      guestId,
      credentialVersionId: original.credentialVersionId,
      operationId: original.operationId,
      operatorUserId: original.operatorUserId,
      deviceId: original.deviceId,
      method: "QR",
      gate: "VIP Gate",
      scannedAt: original.scannedAt.toISOString(),
      clientTimestamp: null,
    });
  });
});

describe("M-3 + L-1: operationId replay semantics", () => {
  async function login(email: string): Promise<string> {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: "ChangeMe123!" });
    return res.body.token as string;
  }

  it("an operationId reused with a DIFFERENT guest returns INVALID, never a false CHECKED_IN", async () => {
    const token = await login("scanner@ghab.gov");
    const eventId = await getEventId();
    const a = await createGuestWithCredential();
    const b = await createGuestWithCredential();
    const operationId = `op-mismatch-${crypto.randomUUID().slice(0, 10)}`;

    const first = await request(app)
      .post("/api/v1/checkin/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ eventId, guestId: a.guestId, operationId });
    expect(first.body.result).toBe("CHECKED_IN");

    // Same operationId, different guest: must not be treated as a replay.
    const second = await request(app)
      .post("/api/v1/checkin/manual")
      .set("Authorization", `Bearer ${token}`)
      .send({ eventId, guestId: b.guestId, operationId });
    expect(second.body.result).toBe("INVALID");

    // Guest B was never admitted.
    const bAdmissions = await prisma.checkIn.count({ where: { guestId: b.guestId } });
    expect(bAdmissions).toBe(0);
    // The stored operation belongs to exactly one admission.
    const opRows = await prisma.checkIn.count({ where: { operationId } });
    expect(opRows).toBe(1);
  });

  it("concurrent scans sharing one operationId admit exactly one; the loser is INVALID (not ALREADY_USED)", async () => {
    const token = await login("scanner@ghab.gov");
    const eventId = await getEventId();
    const a = await createGuestWithCredential();
    const b = await createGuestWithCredential();
    const operationId = `op-race-${crypto.randomUUID().slice(0, 10)}`;

    const responses = await Promise.all([
      request(app)
        .post("/api/v1/checkin/scan")
        .set("Authorization", `Bearer ${token}`)
        .send({ eventId, code: a.code, gate: "Main Entrance", operationId }),
      request(app)
        .post("/api/v1/checkin/scan")
        .set("Authorization", `Bearer ${token}`)
        .send({ eventId, code: b.code, gate: "Main Entrance", operationId }),
    ]);

    const results = responses.map((r) => r.body.result as string).sort();
    expect(results).toEqual(["CHECKED_IN", "INVALID"]);

    const opRows = await prisma.checkIn.count({ where: { operationId } });
    expect(opRows).toBe(1);
  });
});
