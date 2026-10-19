import "dotenv/config";
import cors from "cors";
import express from "express";
import { pool } from "./db.js";
import { errorHandler } from "./lib/http.js";
import { adminRouter } from "./routes/admin.js";
import { publicRouter } from "./routes/public.js";

const app = express();
const origins = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || origins.includes("*") || origins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)),
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up" });
  } catch {
    res.status(503).json({ ok: false, db: "down" });
  }
});
app.use("/api/public", publicRouter);
app.use("/api/admin", adminRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`🐺 WOLVENWEAR API on http://localhost:${port}`));
