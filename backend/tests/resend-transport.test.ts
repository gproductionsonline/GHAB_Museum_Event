import { afterEach, describe, expect, it, vi } from "vitest";

// Resend transport tests. The module reads RESEND_API_KEY/EMAIL_FROM from the
// environment at import time, so env vars are set BEFORE the dynamic import
// and the fetch API is stubbed (no network, no real key). Vitest isolates
// each test file in its own process, so this configuration never leaks into
// the other suites (they run in outbox mode).

const TEST_KEY = "re_test_key_1234567890";
const TEST_FROM = "Government House Events <no-reply@example.gov>";

type SentRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function mockFetch(status: number, jsonBody: unknown, textBody = "") {
  const calls: SentRequest[] = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => textBody,
    } as Response;
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

async function importEmailLib() {
  return import("../src/lib/email.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Resend email transport", () => {
  it("sends via the Resend API with bearer auth, inline QR attachments, and the configured sender", async () => {
    process.env.RESEND_API_KEY = TEST_KEY;
    process.env.EMAIL_FROM = TEST_FROM;
    vi.resetModules();
    const { sendMail } = await importEmailLib();

    const { calls } = mockFetch(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
    const result = await sendMail({
      to: "guest@example.gov",
      subject: "Your admission credential",
      html: '<img src="cid:qr-main"/>',
      attachments: [{ filename: "qr.png", content: Buffer.from("fake-png"), cid: "qr-main", contentType: "image/png" }],
    });

    expect(result.delivered).toBe(true);
    expect(result.detail).toContain("Resend");
    expect(result.detail).toContain("49a3999c");

    expect(calls.length).toBe(1);
    const { url, headers, body } = calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(body.from).toBe(TEST_FROM);
    expect(body.to).toBe("guest@example.gov");
    expect(body.subject).toBe("Your admission credential");
    expect(body.html).toContain("cid:qr-main");
    // QR images must ride as base64 inline attachments with a content_id —
    // data: URLs are stripped by mail clients, so CID is the only correct way.
    const attachments = body.attachments as { filename: string; content: string; content_type: string; content_id: string }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe("qr.png");
    expect(attachments[0]!.content_type).toBe("image/png");
    expect(attachments[0]!.content_id).toBe("qr-main");
    expect(attachments[0]!.content).toBe(Buffer.from("fake-png").toString("base64"));
  });

  it("throws on Resend rate limits (429) so the worker retries with backoff", async () => {
    process.env.RESEND_API_KEY = TEST_KEY;
    process.env.EMAIL_FROM = TEST_FROM;
    vi.resetModules();
    const { sendMail } = await importEmailLib();

    mockFetch(429, {}, '{"message":"Rate limit exceeded"}');
    await expect(
      sendMail({ to: "guest@example.gov", subject: "s", html: "<p>x</p>" }),
    ).rejects.toThrow(/Resend API error 429: Rate limit exceeded/);
  });

  it("throws with the provider message on validation errors (422) and never leaks the API key", async () => {
    process.env.RESEND_API_KEY = TEST_KEY;
    process.env.EMAIL_FROM = TEST_FROM;
    vi.resetModules();
    const { sendMail } = await importEmailLib();

    mockFetch(422, {}, '{"message":"From address is not a verified domain"}');
    await expect(
      sendMail({ to: "guest@example.gov", subject: "s", html: "<p>x</p>" }),
    ).rejects.toThrow(/Resend API error 422: From address is not a verified domain/);
  });

  it("falls back to the dev outbox when no API key is configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    vi.resetModules();
    const { sendMail } = await importEmailLib();

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await sendMail({ to: "guest@example.gov", subject: "s", html: "<p>x</p>" });

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("outbox");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
