import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

/** In-process event bus. Storefront orders → live admin dashboard via Server-Sent Events. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export type LiveEvent =
  | { type: "order.created"; order: { id: string; name: string; total: number; items: string; method: string; city: string; created_at: string } }
  | { type: "order.updated"; order: { id: string; status: string } }
  | { type: "stock.low"; product: { id: string; name: string; size: string; stock: number } }
  | { type: "settings.updated" }
  | { type: "catalog.updated" };

export const publish = (e: LiveEvent) => bus.emit("event", e);

/** Storefront stream: only non-sensitive events (no customer data). */
export function publicSseHandler(req: Request, res: Response) {
  sseHandler(req, res, (e) => e.type === "settings.updated" || e.type === "catalog.updated");
}

export function sseHandler(req: Request, res: Response, filter: (e: LiveEvent) => boolean = () => true) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: {"ok":true}\n\n`);
  const send = (e: LiveEvent) => filter(e) && res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
  bus.on("event", send);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("event", send);
  });
}
