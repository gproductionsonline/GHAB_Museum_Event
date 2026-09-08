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

async function registerDevice(token: string, eventId: string) {
  const name = `test-device-${crypto.randomUUID().slice(0, 8)}`;
  const res = await request(app)
    .post("/api/v1/devices")
    .set("Authorization", `Bearer ${token}`)
    .send({ eventId, name });
  return { name, res };
}

/** A fresh guest + credential + applied check-in, unique per invocation —
 *  never borrows rows another test may have claimed (OfflineCheckIn.checkInId
 *  is unique, so sharing a CheckIn across tests is a constraint race). */
async function createUniqueCheckIn(eventId: string): Promise<string> {
  const lastName = `Syncworth-${crypto.randomUUID().slice(0, 8)}`;
  const [category, rsvp] = await Promise.all([
    prisma.guestCategory.findFirstOrThrow({ where: { eventId } }),
    prisma.rsvpStatus.findUniqueOrThrow({ where: { code: "CONFIRMED" } }),
  ]);
  const guest = await prisma.guest.create({
    data: {
      eventId,
      categoryId: category.id,
      rsvpStatusId: rsvp.id,
      firstName: "Device",
      lastName,
      normalizedName: `device ${lastName.toLowerCase()}`,
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
  const checkIn = await prisma.checkIn.create({
    data: {
      eventId,
      guestId: guest.id,
      credentialVersionId: cred.id,
      operationId: `op-${crypto.randomUUID()}`,
      method: "QR",
    },
  });
  return checkIn.id;
}

describe("device management", () => {
  it("registers a device (admin) and returns the token exactly once", async () => {
    const token = await login("admin@ghab.gov");
    const eventId = await getEventId();
    const { res } = await registerDevice(token, eventId);
    expect(res.status).toBe(201);
    expect(res.body.device.status).toBe("ACTIVE");
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(20);
  });

  it("denies device management to staff (403)", async () => {
    const token = await login("staff@ghab.gov");
    const eventId = await getEventId();
    await request(app)
      .post("/api/v1/devices")
      .set("Authorization", `Bearer ${token}`)
      .send({ eventId, name: "should-not-exist" })
      .expect(403);
  });

  it("lists devices for the event", async () => {
    const token = await login("admin@ghab.gov");
    const eventId = await getEventId();
    const { res } = await registerDevice(token, eventId);
    expect(res.status).toBe(201);
    const list = await request(app)
      .get(`/api/v1/devices?eventId=${eventId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.devices.some((d: { name: string }) => d.name === res.body.device.name)).toBe(true);
  });

  it("returns per-device sync history, including rejected evidence, without code hashes", async () => {
    const token = await login("admin@ghab.gov");
    const eventId = await getEventId();
    const { res } = await registerDevice(token, eventId);
    const deviceId = res.body.device.id as string;

    // One applied and one rejected offline operation (server is the source of
    // truth; both rows must be retained as evidence per OFFLINE_MODE.md).
    const checkInId = await createUniqueCheckIn(eventId);
    await prisma.offlineCheckIn.create({
      data: {
        deviceId,
        eventId,
        operationId: `op-${crypto.randomUUID()}`,
        codeHash: "0".repeat(64),
        clientTimestamp: new Date(),
        status: "APPLIED",
        checkInId,
      },
    });
    await prisma.offlineCheckIn.create({
      data: {
        deviceId,
        eventId,
        operationId: `op-${crypto.randomUUID()}`,
        codeHash: "1".repeat(64),
        clientTimestamp: new Date(),
        status: "INVALID",
        resultDetail: "INVALID",
      },
    });

    const history = await request(app)
      .get(`/api/v1/devices/${deviceId}/sync-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(history.body.device.id).toBe(deviceId);
    const ops: { status: string; codeHash?: string }[] = history.body.operations;
    expect(ops.length).toBe(2);
    expect(ops.some((o) => o.status === "APPLIED")).toBe(true);
    expect(ops.some((o) => o.status === "INVALID")).toBe(true);
    // No hash material in the DTO.
    for (const o of ops) expect(o.codeHash).toBeUndefined();
  });

  it("revokes and re-activates a device", async () => {
    const token = await login("admin@ghab.gov");
    const eventId = await getEventId();
    const { res } = await registerDevice(token, eventId);
    const deviceId = res.body.device.id as string;

    await request(app)
      .post(`/api/v1/devices/${deviceId}/revoke`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
      .then((r) => expect(r.body.device.status).toBe("REVOKED"));

    await request(app)
      .post(`/api/v1/devices/${deviceId}/activate`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
      .then((r) => expect(r.body.device.status).toBe("ACTIVE"));
  });
});
