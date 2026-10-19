import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../db.js";
import { publicSseHandler, publish } from "../lib/events.js";
import { ah, HttpError, parse } from "../lib/http.js";
import { computeTotals, newOrderId } from "../lib/pricing.js";
import { PRODUCT_SELECT, toStorefront, type ProductRow } from "../lib/products.js";
import { getSettings, publicSettings } from "../lib/settings.js";

export const publicRouter = Router();

/** Live storefront updates (theme/settings/catalogue changes from the admin panel). */
publicRouter.get("/stream", publicSseHandler);

/** Everything the storefront needs at boot in one request. */
publicRouter.get(
  "/bootstrap",
  ah(async (_req, res) => {
    const [settings, products] = await Promise.all([
      getSettings(),
      query<ProductRow>(`${PRODUCT_SELECT} WHERE p.status = 'active' ORDER BY p.featured DESC, p.sort_order, p.created_at`),
    ]);
    res.set("Cache-Control", "no-store");
    res.json({ settings: publicSettings(settings), products: products.rows.map(toStorefront) });
  }),
);

publicRouter.get(
  "/products",
  ah(async (req, res) => {
    const params: unknown[] = [];
    let where = "p.status = 'active'";
    if (typeof req.query.category === "string") {
      params.push(req.query.category);
      where += ` AND p.category = $${params.length}`;
    }
    const { rows } = await query<ProductRow>(`${PRODUCT_SELECT} WHERE ${where} ORDER BY p.featured DESC, p.sort_order, p.created_at`, params);
    res.json(rows.map(toStorefront));
  }),
);

publicRouter.get(
  "/products/:slug",
  ah(async (req, res) => {
    const { rows } = await query<ProductRow>(`${PRODUCT_SELECT} WHERE p.slug = $1 AND p.status = 'active'`, [req.params.slug]);
    if (!rows[0]) throw new HttpError(404, "Product not found");
    res.json(toStorefront(rows[0]));
  }),
);

publicRouter.get(
  "/settings",
  ah(async (_req, res) => {
    res.json(publicSettings(await getSettings()));
  }),
);

const OrderInput = z.object({
  items: z.array(z.object({ productId: z.string(), size: z.enum(["S", "M", "L", "XL", "XXL"]), qty: z.number().int().min(1).max(9) })).min(1).max(30),
  customer: z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().regex(/^[6-9]\d{9}$/, "10-digit Indian mobile"),
    email: z.string().email().optional().or(z.literal("")),
  }),
  address: z.object({
    address: z.string().trim().min(5).max(200),
    landmark: z.string().max(100).optional(),
    city: z.string().trim().min(2).max(80),
    state: z.string().max(60).optional(),
    pincode: z.string().regex(/^\d{6}$/),
  }),
  method: z.enum(["upi", "card", "netbanking", "cod"]),
  speed: z.enum(["standard", "midnight"]).default("standard"),
  coupon: z.string().max(20).nullable().optional(),
});

/** Place an order: validates stock, prices server-side, decrements inventory atomically. */
publicRouter.post(
  "/orders",
  ah(async (req, res) => {
    const input = parse(OrderInput, req.body);
    const settings = await getSettings();
    if (input.method === "cod" && !settings.codEnabled) throw new HttpError(400, "Cash on delivery is currently unavailable");

    const result = await tx(async (c) => {
      // lock the variants we're buying
      const lines: { productId: string; name: string; image: string | null; size: string; qty: number; price: number }[] = [];
      const lowStock: { id: string; name: string; size: string; stock: number }[] = [];
      for (const it of input.items) {
        const { rows } = await c.query(
          `SELECT p.id, p.name, p.price, p.images[1] AS image, p.status, v.stock
             FROM products p JOIN product_variants v ON v.product_id = p.id
            WHERE p.id = $1 AND v.size = $2 FOR UPDATE OF v`,
          [it.productId, it.size],
        );
        const r = rows[0];
        if (!r || r.status !== "active") throw new HttpError(409, `A product in your bag is no longer available`);
        if (r.stock < it.qty) throw new HttpError(409, `${r.name} (${it.size}) — only ${r.stock} left`);
        const left = r.stock - it.qty;
        await c.query(`UPDATE product_variants SET stock = $3 WHERE product_id = $1 AND size = $2`, [it.productId, it.size, left]);
        if (left <= settings.lowStockThreshold) lowStock.push({ id: r.id, name: r.name, size: it.size, stock: left });
        lines.push({ productId: r.id, name: r.name, image: r.image, size: it.size, qty: it.qty, price: r.price });
      }

      const totals = computeTotals(lines, settings, { coupon: input.coupon, method: input.method, speed: input.speed });

      const cust = await c.query<{ id: string }>(
        `INSERT INTO customers(phone, name, email, city) VALUES ($1,$2,$3,$4)
         ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, customers.email), city = EXCLUDED.city
         RETURNING id`,
        [input.customer.phone, input.customer.name, input.customer.email || null, input.address.city],
      );

      let id = newOrderId();
      while ((await c.query("SELECT 1 FROM orders WHERE id = $1", [id])).rowCount) id = newOrderId();

      const o = await c.query(
        `INSERT INTO orders(id, customer_id, payment_method, payment_status, speed, subtotal, discount, shipping, total, coupon,
                            name, phone, email, address, landmark, city, state, pincode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING created_at`,
        [
          id, cust.rows[0].id, input.method, input.method === "cod" ? "pending" : "paid", input.speed,
          totals.subtotal, totals.discount, totals.shipping, totals.total, totals.coupon,
          input.customer.name, input.customer.phone, input.customer.email || null,
          input.address.address, input.address.landmark || null, input.address.city, input.address.state ?? "", input.address.pincode,
        ],
      );
      for (const l of lines) {
        await c.query(`INSERT INTO order_items(order_id, product_id, name, image, size, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          id, l.productId, l.name, l.image, l.size, l.qty, l.price,
        ]);
      }
      await c.query(`INSERT INTO order_events(order_id, type, status, message) VALUES ($1,'status','placed',$2)`, [
        id,
        `Order placed via storefront • ${input.method.toUpperCase()}`,
      ]);
      return { id, totals, lines, lowStock, created_at: o.rows[0].created_at as string };
    });

    publish({
      type: "order.created",
      order: {
        id: result.id,
        name: input.customer.name,
        total: result.totals.total,
        items: result.lines.map((l) => `${l.name} [${l.size}]${l.qty > 1 ? ` ×${l.qty}` : ""}`).join(" + "),
        method: input.method,
        city: input.address.city,
        created_at: result.created_at,
      },
    });
    result.lowStock.forEach((p) => publish({ type: "stock.low", product: p }));
    publish({ type: "catalog.updated" });

    res.status(201).json({ id: result.id, total: result.totals.total, subtotal: result.totals.subtotal, discount: result.totals.discount, shipping: result.totals.shipping });
  }),
);

/** Order tracking for customers. Requires the phone number on the order as a light check. */
publicRouter.get(
  "/orders/:id",
  ah(async (req, res) => {
    const { rows } = await query(
      `SELECT id, status, payment_method, speed, total, name, phone, address, city, pincode, courier, awb, created_at, updated_at FROM orders WHERE id = $1`,
      [req.params.id.toUpperCase()],
    );
    const o = rows[0];
    if (!o) throw new HttpError(404, "Order not found");
    const phone = typeof req.query.phone === "string" ? req.query.phone.replace(/\D/g, "").slice(-10) : null;
    if (phone && phone !== o.phone) throw new HttpError(404, "Order not found");
    const [items, events] = await Promise.all([
      query(`SELECT name, image, size, qty, price, product_id FROM order_items WHERE order_id = $1 ORDER BY id`, [o.id]),
      query(`SELECT status, message, created_at FROM order_events WHERE order_id = $1 AND type = 'status' ORDER BY created_at`, [o.id]),
    ]);
    const { phone: _p, ...safe } = o;
    // without the matching phone number, don't reveal the street address / full name
    const verified = !!phone;
    res.json({
      ...safe,
      name: verified ? o.name : o.name.split(" ")[0],
      address: verified ? o.address : "",
      pincode: verified ? o.pincode : o.pincode.slice(0, 3) + "•••",
      items: items.rows,
      events: events.rows,
    });
  }),
);
