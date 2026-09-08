import { Router } from "express";

import { asyncHandler } from "../../lib/http.js";
import { requireAuth } from "../../lib/auth.js";
import { rateLimit } from "../../lib/rate-limit.js";
import { login, getMe } from "./auth.controller.js";

// Brute-force protection on the login endpoint. In-memory for now; becomes
// Redis-backed when more than one API instance is deployed (see rate-limit.ts).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

export const authRouter = Router();

authRouter.post("/login", loginLimiter, asyncHandler(login));

authRouter.get("/me", requireAuth, asyncHandler(getMe));
