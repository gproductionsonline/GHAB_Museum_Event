import "dotenv/config";
import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((url) => /^postgres(ql)?:\/\//.test(url), {
      message: "DATABASE_URL must be a PostgreSQL connection string (postgresql://…). SQLite is not supported.",
    }),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  ADMIN_TOKEN_HOURS: z.coerce.number().default(12),
  SCANNER_TOKEN_DAYS: z.coerce.number().default(7),
  QR_CODE_PREFIX: z.string().default("GHAB1"),
  // Email (Resend — https://resend.com). When the API key is empty, emails
  // are written to .data/outbox instead of sent (dev fallback).
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  SNAPSHOT_SECRET: z.string().min(8),
  CREDENTIAL_SECRET: z.string().min(16),
})
// Fail fast: a configured Resend key without a verified sender address would
// have every delivery rejected at the door of the provider.
.superRefine((env, ctx) => {
  if (env.RESEND_API_KEY && !env.EMAIL_FROM) {
    ctx.addIssue({
      code: "custom",
      path: ["EMAIL_FROM"],
      message: "EMAIL_FROM is required when RESEND_API_KEY is set (e.g. \"Government House Events <no-reply@yourdomain.gov\">)",
    });
  }
});

export type EnvSchema = typeof envSchema;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        level: "error",
        event: "env_validation_failed",
        errors: parsed.error.flatten().fieldErrors,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  isTest: env.NODE_ENV === "test",
  allowedOrigins: env.FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  resendEnabled: Boolean(env.RESEND_API_KEY),
};

export type AppUser = {
  id: string;
  email: string;
  name: string;
  /** Primary role derived from the user's role set (highest rank). */
  role: "ADMIN" | "STAFF" | "CHECKIN_OPERATOR";
  /** All role codes assigned to this user. */
  roles: string[];
};
