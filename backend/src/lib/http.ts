import type { NextFunction, Request, RequestHandler, Response } from "express";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const badRequest = (message: string, code?: string) => new HttpError(400, message, code);
export const unauthorized = (message = "Authentication required") => new HttpError(401, message);
export const forbidden = (message = "Not permitted") => new HttpError(403, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
/** Validation failures: well-formed request, semantically invalid input. */
export const unprocessable = (message: string) => new HttpError(422, message, "VALIDATION_ERROR");

/** Safe route-parameter accessor (Express 5 widens req.params values). */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === "string" && value.length > 0) return value;
  throw badRequest(`Missing route parameter: ${name}`);
}
