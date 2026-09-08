import crypto from "node:crypto";

// Crockford-ish alphabet: visually unambiguous characters only.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256(input: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/** Cryptographically secure bearer token with ~100 bits of entropy. */
export function generateCredentialCode(length = 20): string {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return code;
}

/** Detects a PostgreSQL unique-constraint violation from a rejected mutation. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("duplicate key value violates unique constraint") ||
      err.message.includes("UNIQUE constraint failed") ||
      (err as { code?: string }).code === "P2002")
  );
}

/**
 * Identifies a violation of CheckIn.operationId specifically (audit L-1):
 * the client reused an idempotency key across different operations. This is
 * a client error, never a duplicate admission, and must not be reported as
 * ALREADY_USED.
 */
export function isOperationIdViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes("CheckIn_operationId_key")) return true;
  const meta = (err as { meta?: { target?: string[] | string } }).meta;
  if (Array.isArray(meta?.target) && meta.target.includes("operationId")) return true;
  if (typeof meta?.target === "string" && meta.target.toLowerCase().includes("operationid")) {
    return true;
  }
  return false;
}
