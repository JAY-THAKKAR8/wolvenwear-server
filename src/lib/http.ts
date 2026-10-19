import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, "Validation failed", r.error.flatten());
  return r.data;
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof ZodError) return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  const pgErr = err as { code?: string; detail?: string };
  if (pgErr?.code === "23505") return res.status(409).json({ error: "Already exists", details: pgErr.detail });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

export const pageParams = (q: Request["query"], def = 20) => {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(q.limit) || def));
  return { page, limit, offset: (page - 1) * limit };
};
