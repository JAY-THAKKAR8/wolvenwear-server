import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { HttpError } from "./http.js";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
if (!process.env.JWT_SECRET) console.warn("⚠  JWT_SECRET not set — using an insecure development secret");

export interface AdminClaims {
  sub: string;
  email: string;
  name: string;
  role: string;
}

declare module "express-serve-static-core" {
  interface Request {
    admin?: AdminClaims;
  }
}

export const signToken = (c: AdminClaims) => jwt.sign(c, SECRET, { expiresIn: "7d" });

export const verifyToken = (token: string) => jwt.verify(token, SECRET) as AdminClaims;

/** Requires `Authorization: Bearer <token>` (or `?token=` for EventSource, which can't set headers). */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : typeof req.query.token === "string" ? req.query.token : null;
  if (!token) return next(new HttpError(401, "Not signed in"));
  try {
    req.admin = verifyToken(token);
    next();
  } catch {
    next(new HttpError(401, "Session expired — sign in again"));
  }
}
