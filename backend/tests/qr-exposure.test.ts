// Audit H-1 regression: a check-in operator (guest:read) must never be able
// to retrieve a guest's raw QR bearer credential. Raw codes are exposed only
// through credential:read-gated surfaces.
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { issueCredential, rawCode } from "../src/modules/credentials/credentials.service.js";

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

/** Creates a guest with an ACTIVE credential; returns guestId + raw code. */
async function createGuestWithCredential(): Promise<{ guestId: string; rawCode: string }> {
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
      firstName: "QrExposure",
      lastName: suffix,
      normalizedName: `qrexposure ${suffix}`,
      source: "MANUAL",
    },
  });
  const credential = await issueCredential(guest.id, null);
  const row = await prisma.credentialVersion.findUniqueOrThrow({ where: { id: credential.id } });
  return { guestId: guest.id, rawCode: rawCode(row) };
}

describe("H-1: raw QR credential exposure boundary", () => {
  it("CHECKIN_OPERATOR receives guest detail WITHOUT the raw QR credential", async () => {
    const { guestId, rawCode } = await createGuestWithCredential();
    const token = await login("scanner@ghab.gov");

    const res = await request(app)
      .get(`/api/v1/guests/${guestId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.guest.qr).toBeNull();
    expect(res.body.guest.credential.status).toBe("ACTIVE");
    // The raw bearer secret must not appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(rawCode);
  });

  it("a caller with credential:read still receives the QR (admin workflows keep working)", async () => {
    const { guestId, rawCode } = await createGuestWithCredential();
    const token = await login("staff@ghab.gov"); // STAFF holds credential:read

    const res = await request(app)
      .get(`/api/v1/guests/${guestId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.guest.qr).not.toBeNull();
    expect(res.body.guest.qr.code).toBe(rawCode);
  });

  it("CHECKIN_OPERATOR is denied the QR PNG render route", async () => {
    const { guestId } = await createGuestWithCredential();
    const token = await login("scanner@ghab.gov");

    await request(app)
      .get(`/api/v1/credentials/${guestId}/qr.png`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });
});
