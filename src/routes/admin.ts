import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { query, tx } from "../db.js";
import { requireAdmin, signToken } from "../lib/auth.js";
import { publish, sseHandler } from "../lib/events.js";
import { ah, HttpError, pageParams, parse } from "../lib/http.js";

/** Tell open storefront tabs the catalogue changed (they re-fetch). */
const catalogChanged = () => publish({ type: "catalog.updated" });
import { getProductById, PRODUCT_SELECT, SIZES, totalStock, type ProductRow } from "../lib/products.js";
import { getSettings, saveSettings, SettingsSchema } from "../lib/settings.js";

export const adminRouter = Router();

/* ───────────────────────────── auth ───────────────────────────── */

adminRouter.post(
  "/auth/login",
  ah(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const { rows } = await query(`SELECT * FROM admin_users WHERE lower(email) = lower($1)`, [email]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, "Wrong email or password");
    const admin = { sub: u.id, email: u.email, name: u.name, role: u.role };
    res.json({ token: signToken(admin), admin });
  }),
);

adminRouter.use(requireAdmin);

adminRouter.get("/auth/me", (req, res) => res.json({ admin: req.admin }));
adminRouter.get("/stream", (req, res) => sseHandler(req, res));

/* ─────────────────────────── helpers ─────────────────────────── */

const TIERS = [
  { id: "alpha", label: "Alpha", min: 25000 },
  { id: "beta", label: "Beta", min: 10000 },
  { id: "pack", label: "Pack", min: 3000 },
  { id: "pup", label: "Pup", min: 0 },
] as const;
const tierOf = (ltv: number) => TIERS.find((t) => ltv >= t.min)!;

const daysParam = (v: unknown, def = 30) => Math.min(365, Math.max(1, Number(v) || def));

/** Revenue for paid / non-cancelled orders. */
const REV = `status <> 'cancelled'`;

/* ────────────────────────── dashboard ────────────────────────── */

adminRouter.get(
  "/dashboard",
  ah(async (_req, res) => {
    const settings = await getSettings();
    const [kpi, prev, series, recent, low, drops, top, statuses] = await Promise.all([
      query(`SELECT COALESCE(sum(total),0) AS revenue, count(*) AS orders, COALESCE(avg(total),0)::int AS aov,
                    count(DISTINCT customer_id) AS customers,
                    COALESCE(sum(total) FILTER (WHERE created_at >= date_trunc('day', now())),0) AS today,
                    count(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today_orders
               FROM orders WHERE ${REV} AND created_at >= now() - interval '30 days'`),
      query(`SELECT COALESCE(sum(total),0) AS revenue, count(*) AS orders, COALESCE(avg(total),0)::int AS aov, count(DISTINCT customer_id) AS customers
               FROM orders WHERE ${REV} AND created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days'`),
      query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(sum(o.total),0) AS revenue, count(o.id) AS orders
               FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
               LEFT JOIN orders o ON date_trunc('day', o.created_at) = d AND o.${REV}
              GROUP BY d ORDER BY d`),
      query(`SELECT o.id, o.name, o.city, o.total, o.status, o.payment_method, o.created_at,
                    (SELECT string_agg(i.name || ' [' || i.size || ']' || CASE WHEN i.qty > 1 THEN ' ×' || i.qty ELSE '' END, ' + ') FROM order_items i WHERE i.order_id = o.id) AS items
               FROM orders o ORDER BY o.created_at DESC LIMIT 12`),
      query(`SELECT p.id, p.name, p.sku, p.images[1] AS image, v.size, v.stock
               FROM product_variants v JOIN products p ON p.id = v.product_id
              WHERE p.status = 'active' AND v.stock <= $1 ORDER BY v.stock, p.name LIMIT 10`, [settings.lowStockThreshold]),
      query(`SELECT d.*, (SELECT count(*) FROM products p WHERE p.drop_id = d.id) AS products,
                    (SELECT COALESCE(sum(i.qty * i.price),0) FROM order_items i JOIN products p ON p.id = i.product_id JOIN orders o ON o.id = i.order_id
                      WHERE p.drop_id = d.id AND o.${REV}) AS revenue,
                    (SELECT COALESCE(sum(v.stock),0) FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.drop_id = d.id) AS stock,
                    (SELECT COALESCE(sum(i.qty),0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE p.drop_id = d.id) AS sold
               FROM drops d ORDER BY CASE d.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, d.starts_at DESC NULLS LAST LIMIT 4`),
      query(`SELECT i.product_id AS id, max(i.name) AS name, max(i.image) AS image, sum(i.qty) AS units, sum(i.qty * i.price) AS revenue
               FROM order_items i JOIN orders o ON o.id = i.order_id
              WHERE o.${REV} AND o.created_at >= now() - interval '30 days'
              GROUP BY i.product_id ORDER BY revenue DESC LIMIT 5`),
      query(`SELECT status, count(*) AS n FROM orders GROUP BY status`),
    ]);
    const delta = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
    const k = kpi.rows[0];
    const p = prev.rows[0];
    res.json({
      kpis: {
        revenue: { value: k.revenue, delta: delta(k.revenue, p.revenue) },
        orders: { value: k.orders, delta: delta(k.orders, p.orders) },
        aov: { value: k.aov, delta: delta(k.aov, p.aov) },
        customers: { value: k.customers, delta: delta(k.customers, p.customers) },
        today: { value: k.today, orders: k.today_orders },
      },
      series: series.rows,
      recent: recent.rows,
      lowStock: low.rows,
      drops: drops.rows.map((d) => ({ ...d, sellThrough: d.sold + d.stock ? Math.round((d.sold / (d.sold + d.stock)) * 100) : 0 })),
      topProducts: top.rows,
      statusCounts: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    });
  }),
);

/* ────────────────────────── analytics ────────────────────────── */

adminRouter.get(
  "/analytics",
  ah(async (req, res) => {
    const days = daysParam(req.query.days);
    const since = `now() - interval '${days} days'`;
    const [summary, series, cats, methods, cities, products, funnel, hours, repeat] = await Promise.all([
      query(`SELECT COALESCE(sum(total),0) AS revenue, count(*) AS orders, COALESCE(avg(total),0)::int AS aov,
                    COALESCE(sum(discount),0) AS discounts, count(*) FILTER (WHERE coupon IS NOT NULL) AS coupon_orders
               FROM orders WHERE ${REV} AND created_at >= ${since}`),
      query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(sum(o.total),0) AS revenue, count(o.id) AS orders
               FROM generate_series(date_trunc('day', now()) - (($1::int - 1) || ' days')::interval, date_trunc('day', now()), interval '1 day') d
               LEFT JOIN orders o ON date_trunc('day', o.created_at) = d AND o.${REV}
              GROUP BY d ORDER BY d`, [days]),
      query(`SELECT p.category, sum(i.qty) AS units, sum(i.qty * i.price) AS revenue, sum(i.qty * (i.price - p.cost)) AS profit
               FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
              WHERE o.${REV} AND o.created_at >= ${since} GROUP BY p.category ORDER BY revenue DESC`),
      query(`SELECT payment_method AS method, count(*) AS orders, sum(total) AS revenue FROM orders
              WHERE ${REV} AND created_at >= ${since} GROUP BY payment_method ORDER BY revenue DESC`),
      query(`SELECT city, count(*) AS orders, sum(total) AS revenue FROM orders
              WHERE ${REV} AND created_at >= ${since} GROUP BY city ORDER BY revenue DESC LIMIT 8`),
      query(`SELECT i.product_id AS id, max(i.name) AS name, max(i.image) AS image, sum(i.qty) AS units,
                    sum(i.qty * i.price) AS revenue, sum(i.qty * (i.price - COALESCE(p.cost,0))) AS profit
               FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN products p ON p.id = i.product_id
              WHERE o.${REV} AND o.created_at >= ${since} GROUP BY i.product_id ORDER BY revenue DESC LIMIT 10`),
      query(`SELECT status, count(*) AS n FROM orders WHERE created_at >= ${since} GROUP BY status`),
      query(`SELECT extract(hour FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*) AS orders
               FROM orders WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`),
      query(`SELECT count(*) FILTER (WHERE n > 1) AS repeat, count(*) AS total FROM
               (SELECT customer_id, count(*) AS n FROM orders WHERE ${REV} GROUP BY customer_id) t`),
    ]);
    const hourMap = new Map(hours.rows.map((h) => [h.hour, h.orders]));
    res.json({
      days,
      summary: { ...summary.rows[0], repeatRate: repeat.rows[0].total ? Math.round((repeat.rows[0].repeat / repeat.rows[0].total) * 100) : 0 },
      series: series.rows,
      categories: cats.rows,
      methods: methods.rows,
      cities: cities.rows,
      products: products.rows,
      funnel: Object.fromEntries(funnel.rows.map((r) => [r.status, r.n])),
      hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hourMap.get(h) ?? 0 })),
    });
  }),
);

/* ─────────────────────────── products ─────────────────────────── */

const adminProduct = (p: ProductRow) => ({
  ...p,
  stock: totalStock(p),
  margin: p.price ? Math.round(((p.price - p.cost) / p.price) * 100) : 0,
});

adminRouter.get(
  "/products",
  ah(async (req, res) => {
    const { page, limit, offset } = pageParams(req.query, 50);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      params.push(`%${req.query.q.trim()}%`);
      where.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.tag ILIKE $${params.length})`);
    }
    if (typeof req.query.category === "string" && req.query.category !== "all") add(`p.category = ?`, req.query.category);
    if (typeof req.query.status === "string" && req.query.status !== "all") add(`p.status = ?`, req.query.status);
    if (typeof req.query.drop === "string" && req.query.drop !== "all") add(`p.drop_id = ?`, Number(req.query.drop));
    const stockSum = `(SELECT COALESCE(sum(stock),0) FROM product_variants v WHERE v.product_id = p.id)`;
    if (req.query.stock === "low") where.push(`${stockSum} BETWEEN 1 AND 15`);
    if (req.query.stock === "out") where.push(`${stockSum} = 0`);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sorts: Record<string, string> = {
      newest: "p.created_at DESC",
      name: "p.name",
      price_desc: "p.price DESC",
      price_asc: "p.price",
      stock: `${stockSum}`,
    };
    const order = sorts[String(req.query.sort)] ?? "p.sort_order, p.created_at";
    const [rows, count] = await Promise.all([
      query<ProductRow>(`${PRODUCT_SELECT} ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
      query(`SELECT count(*) AS n FROM products p ${w}`, params),
    ]);
    const totals = await query(`SELECT status, count(*) AS n FROM products GROUP BY status`);
    res.json({ items: rows.rows.map(adminProduct), total: count.rows[0].n, page, limit, counts: Object.fromEntries(totals.rows.map((r) => [r.status, r.n])) });
  }),
);

adminRouter.get(
  "/products/:id",
  ah(async (req, res) => {
    const p = await getProductById(req.params.id);
    if (!p) throw new HttpError(404, "Product not found");
    const sales = await query(
      `SELECT COALESCE(sum(i.qty),0) AS units, COALESCE(sum(i.qty*i.price),0) AS revenue, count(DISTINCT i.order_id) AS orders
         FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = $1 AND o.${REV}`,
      [p.id],
    );
    res.json({ ...adminProduct(p), sales: sales.rows[0] });
  }),
);

const ProductInput = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and dashes").max(100).optional(),
  sku: z.string().trim().min(2).max(40),
  category: z.enum(["tees", "hoodies", "bottoms", "tactical", "accessories"]),
  tag: z.string().max(60).default(""),
  colour: z.string().max(60).default(""),
  description: z.string().max(4000).default(""),
  price: z.number().int().min(0),
  mrp: z.number().int().min(0).nullable().optional(),
  cost: z.number().int().min(0).default(0),
  images: z.array(z.string().url()).max(12).default([]),
  frames: z.array(z.string().url()).max(72).default([]),
  badge_label: z.string().max(30).nullable().optional(),
  badge_tone: z.enum(["danger", "gold", "neutral"]).nullable().optional(),
  rating: z.number().min(0).max(5).default(4.8),
  reviews: z.number().int().min(0).default(0),
  status: z.enum(["active", "draft", "archived"]).default("draft"),
  featured: z.boolean().default(false),
  sort_order: z.number().int().default(0),
  drop_id: z.number().int().nullable().optional(),
  variants: z.array(z.object({ size: z.enum(SIZES), stock: z.number().int().min(0).max(100000), sku: z.string().max(50).optional() })).max(5).default([]),
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function writeProduct(id: string | null, input: z.infer<typeof ProductInput>) {
  return tx(async (c) => {
    const slug = input.slug || slugify(input.name);
    const cols = [
      slug, input.sku.toUpperCase(), input.name, input.category, input.tag, input.colour, input.description, input.price, input.mrp ?? null,
      input.cost, input.images, input.frames, input.badge_label || null, input.badge_label ? (input.badge_tone ?? "neutral") : null,
      input.rating, input.reviews, input.status, input.featured, input.sort_order, input.drop_id ?? null,
    ];
    let pid = id;
    if (!pid) {
      const r = await c.query(
        `INSERT INTO products(slug, sku, name, category, tag, colour, description, price, mrp, cost, images, frames, badge_label, badge_tone,
                              rating, reviews, status, featured, sort_order, drop_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        cols,
      );
      pid = r.rows[0].id as string;
    } else {
      const r = await c.query(
        `UPDATE products SET slug=$1, sku=$2, name=$3, category=$4, tag=$5, colour=$6, description=$7, price=$8, mrp=$9, cost=$10, images=$11,
                frames=$12, badge_label=$13, badge_tone=$14, rating=$15, reviews=$16, status=$17, featured=$18, sort_order=$19, drop_id=$20,
                updated_at = now() WHERE id = $21`,
        [...cols, pid],
      );
      if (!r.rowCount) throw new HttpError(404, "Product not found");
    }
    const sizes = input.variants.map((v) => v.size);
    await c.query(`DELETE FROM product_variants WHERE product_id = $1 AND NOT (size = ANY($2))`, [pid, sizes]);
    for (const v of input.variants) {
      await c.query(
        `INSERT INTO product_variants(product_id, size, stock, sku) VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, size) DO UPDATE SET stock = EXCLUDED.stock, sku = EXCLUDED.sku`,
        [pid, v.size, v.stock, v.sku || `${input.sku.toUpperCase()}-${v.size}`],
      );
    }
    return pid;
  });
}

adminRouter.post(
  "/products",
  ah(async (req, res) => {
    const id = await writeProduct(null, parse(ProductInput, req.body));
    catalogChanged();
    res.status(201).json(adminProduct((await getProductById(id))!));
  }),
);

adminRouter.put(
  "/products/:id",
  ah(async (req, res) => {
    const id = await writeProduct(req.params.id, parse(ProductInput, req.body));
    catalogChanged();
    res.json(adminProduct((await getProductById(id))!));
  }),
);

/** Quick inline stock edit from the catalog table. */
adminRouter.patch(
  "/products/:id/stock",
  ah(async (req, res) => {
    const { size, stock } = parse(z.object({ size: z.enum(SIZES), stock: z.number().int().min(0) }), req.body);
    const p = await getProductById(req.params.id);
    if (!p) throw new HttpError(404, "Product not found");
    await query(
      `INSERT INTO product_variants(product_id, size, stock, sku) VALUES ($1,$2,$3,$4)
       ON CONFLICT (product_id, size) DO UPDATE SET stock = EXCLUDED.stock`,
      [p.id, size, stock, `${p.sku}-${size}`],
    );
    catalogChanged();
    res.json(adminProduct((await getProductById(p.id))!));
  }),
);

adminRouter.post(
  "/products/bulk",
  ah(async (req, res) => {
    const { ids, action } = parse(
      z.object({ ids: z.array(z.string()).min(1).max(200), action: z.enum(["active", "draft", "archived", "delete", "feature", "unfeature"]) }),
      req.body,
    );
    if (action === "delete") {
      // products with order history are archived instead of deleted to keep reports intact
      await query(`UPDATE products SET status='archived', updated_at=now() WHERE id = ANY($1) AND EXISTS (SELECT 1 FROM order_items i WHERE i.product_id = products.id)`, [ids]);
      await query(`DELETE FROM products WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.product_id = products.id)`, [ids]);
    } else if (action === "feature" || action === "unfeature") {
      await query(`UPDATE products SET featured = $2, updated_at=now() WHERE id = ANY($1)`, [ids, action === "feature"]);
    } else {
      await query(`UPDATE products SET status = $2, updated_at=now() WHERE id = ANY($1)`, [ids, action]);
    }
    catalogChanged();
    res.json({ ok: true, count: ids.length });
  }),
);

adminRouter.delete(
  "/products/:id",
  ah(async (req, res) => {
    const used = await query(`SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1`, [req.params.id]);
    if (used.rowCount) {
      await query(`UPDATE products SET status='archived', updated_at=now() WHERE id=$1`, [req.params.id]);
      catalogChanged();
      return res.json({ ok: true, archived: true });
    }
    const r = await query(`DELETE FROM products WHERE id = $1`, [req.params.id]);
    if (!r.rowCount) throw new HttpError(404, "Product not found");
    catalogChanged();
    res.json({ ok: true, deleted: true });
  }),
);

/* ──────────────────────────── orders ──────────────────────────── */

const STATUSES = ["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"] as const;

adminRouter.get(
  "/orders",
  ah(async (req, res) => {
    const { page, limit, offset } = pageParams(req.query, 25);
    const where: string[] = [];
    const params: unknown[] = [];
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      params.push(`%${req.query.q.trim()}%`);
      where.push(`(o.id ILIKE $${params.length} OR o.name ILIKE $${params.length} OR o.phone ILIKE $${params.length} OR o.city ILIKE $${params.length})`);
    }
    if (typeof req.query.status === "string" && req.query.status !== "all") {
      params.push(req.query.status);
      where.push(`o.status = $${params.length}`);
    }
    if (typeof req.query.method === "string" && req.query.method !== "all") {
      params.push(req.query.method);
      where.push(`o.payment_method = $${params.length}`);
    }
    if (typeof req.query.customer === "string") {
      params.push(req.query.customer);
      where.push(`o.customer_id = $${params.length}`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows, count, counts] = await Promise.all([
      query(
        `SELECT o.id, o.name, o.phone, o.city, o.total, o.status, o.payment_method, o.payment_status, o.speed, o.created_at,
                (SELECT sum(qty) FROM order_items i WHERE i.order_id = o.id) AS units,
                (SELECT string_agg(i.name || ' [' || i.size || ']', ', ') FROM order_items i WHERE i.order_id = o.id) AS items,
                (SELECT i.image FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS image
           FROM orders o ${w} ORDER BY o.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      query(`SELECT count(*) AS n FROM orders o ${w}`, params),
      query(`SELECT status, count(*) AS n FROM orders GROUP BY status`),
    ]);
    res.json({ items: rows.rows, total: count.rows[0].n, page, limit, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) });
  }),
);

async function loadOrder(id: string) {
  const { rows } = await query(`SELECT * FROM orders WHERE id = $1`, [id.toUpperCase()]);
  const o = rows[0];
  if (!o) throw new HttpError(404, "Order not found");
  const [items, events, cust] = await Promise.all([
    query(
      `SELECT i.*, p.sku, p.slug, (SELECT v.stock FROM product_variants v WHERE v.product_id = i.product_id AND v.size = i.size) AS stock_left
         FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY i.id`,
      [o.id],
    ),
    query(`SELECT * FROM order_events WHERE order_id = $1 ORDER BY created_at DESC, id DESC`, [o.id]),
    o.customer_id
      ? query(
          `SELECT c.*, (SELECT count(*) FROM orders x WHERE x.customer_id = c.id) AS orders,
                  (SELECT COALESCE(sum(total),0) FROM orders x WHERE x.customer_id = c.id AND x.${REV}) AS ltv
             FROM customers c WHERE c.id = $1`,
          [o.customer_id],
        )
      : Promise.resolve({ rows: [] as any[] }),
  ]);
  const c = cust.rows[0];
  return { ...o, items: items.rows, events: events.rows, customer: c ? { ...c, tier: tierOf(c.ltv) } : null };
}

adminRouter.get("/orders/:id", ah(async (req, res) => res.json(await loadOrder(req.params.id))));

adminRouter.patch(
  "/orders/:id",
  ah(async (req, res) => {
    const input = parse(
      z.object({
        status: z.enum(STATUSES).optional(),
        payment_status: z.enum(["pending", "paid", "refunded"]).optional(),
        courier: z.string().max(40).nullable().optional(),
        awb: z.string().max(40).nullable().optional(),
        note: z.string().max(500).optional(),
        restock: z.boolean().optional(),
      }),
      req.body,
    );
    const author = req.admin!.name;
    const id = req.params.id.toUpperCase();
    await tx(async (c) => {
      const cur = (await c.query(`SELECT status, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new HttpError(404, "Order not found");
      if (input.status && input.status !== cur.status) {
        if (cur.status === "cancelled") throw new HttpError(409, "Cancelled orders can't be reopened");
        await c.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [id, input.status]);
        const msg: Record<string, string> = {
          confirmed: "Order confirmed — payment verified",
          packed: "Packed and quality-checked at the den",
          shipped: `Handed to ${input.courier ?? "courier"}${input.awb ? ` • AWB ${input.awb}` : ""}`,
          delivered: "Delivered to the pack member",
          cancelled: "Order cancelled",
          placed: "Moved back to placed",
        };
        await c.query(`INSERT INTO order_events(order_id, type, status, message, author) VALUES ($1,'status',$2,$3,$4)`, [id, input.status, msg[input.status], author]);
        if (input.status === "cancelled" && input.restock !== false) {
          await c.query(
            `UPDATE product_variants v SET stock = v.stock + i.qty FROM order_items i WHERE i.order_id = $1 AND v.product_id = i.product_id AND v.size = i.size`,
            [id],
          );
          await c.query(`INSERT INTO order_events(order_id, type, message, author) VALUES ($1,'note','Items returned to inventory',$2)`, [id, author]);
        }
        if (input.status === "delivered" && cur.payment_status === "pending")
          await c.query(`UPDATE orders SET payment_status = 'paid' WHERE id = $1`, [id]);
      }
      if (input.payment_status && input.payment_status !== cur.payment_status) {
        await c.query(`UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1`, [id, input.payment_status]);
        await c.query(`INSERT INTO order_events(order_id, type, message, author) VALUES ($1,'note',$2,$3)`, [id, `Payment marked ${input.payment_status}`, author]);
      }
      if (input.courier !== undefined || input.awb !== undefined) {
        await c.query(`UPDATE orders SET courier = COALESCE($2, courier), awb = COALESCE($3, awb), updated_at = now() WHERE id = $1`, [id, input.courier ?? null, input.awb ?? null]);
      }
      if (input.note?.trim()) await c.query(`INSERT INTO order_events(order_id, type, message, author) VALUES ($1,'note',$2,$3)`, [id, input.note.trim(), author]);
    });
    const order = await loadOrder(id);
    publish({ type: "order.updated", order: { id, status: order.status } });
    if (input.status === "cancelled") catalogChanged();
    res.json(order);
  }),
);

/* ─────────────────────────── customers ─────────────────────────── */

const CUSTOMER_SELECT = `
  SELECT c.*, count(o.id) AS orders, COALESCE(sum(o.total) FILTER (WHERE o.${REV}),0) AS ltv,
         max(o.created_at) AS last_order, min(o.created_at) AS first_order
    FROM customers c LEFT JOIN orders o ON o.customer_id = c.id`;

adminRouter.get(
  "/customers",
  ah(async (req, res) => {
    const { page, limit, offset } = pageParams(req.query, 30);
    const params: unknown[] = [];
    let w = "";
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      params.push(`%${req.query.q.trim()}%`);
      w = `WHERE c.name ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1 OR c.city ILIKE $1`;
    }
    const tier = TIERS.find((t) => t.id === req.query.tier);
    const idx = tier ? TIERS.indexOf(tier) : -1;
    const having = tier ? `HAVING COALESCE(sum(o.total) FILTER (WHERE o.${REV}),0) >= ${tier.min}${idx > 0 ? ` AND COALESCE(sum(o.total) FILTER (WHERE o.${REV}),0) < ${TIERS[idx - 1].min}` : ""}` : "";
    const sort = req.query.sort === "recent" ? "last_order DESC NULLS LAST" : req.query.sort === "orders" ? "orders DESC" : "ltv DESC";
    const [rows, count, tiers] = await Promise.all([
      query(`${CUSTOMER_SELECT} ${w} GROUP BY c.id ${having} ORDER BY ${sort} LIMIT ${limit} OFFSET ${offset}`, params),
      query(`SELECT count(*) AS n FROM (SELECT c.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ${w} GROUP BY c.id ${having}) t`, params),
      query(`SELECT COALESCE(sum(o.total) FILTER (WHERE o.${REV}),0) AS ltv FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id`),
    ]);
    const tierCounts = Object.fromEntries(TIERS.map((t) => [t.id, 0]));
    tiers.rows.forEach((r) => tierCounts[tierOf(r.ltv).id]++);
    res.json({
      items: rows.rows.map((c) => ({ ...c, tier: tierOf(c.ltv) })),
      total: count.rows[0].n,
      page,
      limit,
      tiers: TIERS.map((t) => ({ ...t, count: tierCounts[t.id] })),
    });
  }),
);

adminRouter.get(
  "/customers/:id",
  ah(async (req, res) => {
    const { rows } = await query(`${CUSTOMER_SELECT} WHERE c.id = $1 GROUP BY c.id`, [req.params.id]);
    const c = rows[0];
    if (!c) throw new HttpError(404, "Customer not found");
    const [orders, fav, sizes] = await Promise.all([
      query(`SELECT o.id, o.total, o.status, o.payment_method, o.created_at, (SELECT sum(qty) FROM order_items i WHERE i.order_id = o.id) AS units
               FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 50`, [c.id]),
      query(`SELECT p.category, sum(i.qty) AS units FROM order_items i JOIN orders o ON o.id = i.order_id JOIN products p ON p.id = i.product_id
              WHERE o.customer_id = $1 GROUP BY p.category ORDER BY units DESC`, [c.id]),
      query(`SELECT i.size, sum(i.qty) AS units FROM order_items i JOIN orders o ON o.id = i.order_id
              WHERE o.customer_id = $1 GROUP BY i.size ORDER BY units DESC LIMIT 1`, [c.id]),
    ]);
    const t = tierOf(c.ltv);
    const next = TIERS[TIERS.indexOf(t) - 1];
    res.json({
      ...c,
      order_count: c.orders,
      tier: t,
      nextTier: next ? { ...next, remaining: next.min - c.ltv } : null,
      orders: orders.rows,
      categories: fav.rows,
      size: sizes.rows[0]?.size ?? null,
      aov: c.orders ? Math.round(c.ltv / c.orders) : 0,
    });
  }),
);

adminRouter.patch(
  "/customers/:id",
  ah(async (req, res) => {
    const input = parse(z.object({ notes: z.string().max(2000).nullable().optional(), name: z.string().max(80).optional(), email: z.string().max(120).nullable().optional() }), req.body);
    const r = await query(
      `UPDATE customers SET notes = COALESCE($2, notes), name = COALESCE($3, name), email = COALESCE($4, email) WHERE id = $1 RETURNING id`,
      [req.params.id, input.notes ?? null, input.name ?? null, input.email ?? null],
    );
    if (!r.rowCount) throw new HttpError(404, "Customer not found");
    res.json({ ok: true });
  }),
);

/* ───────────────────────────── drops ───────────────────────────── */

const DropInput = z.object({
  code: z.string().trim().min(2).max(20),
  name: z.string().trim().min(2).max(80),
  description: z.string().max(1000).nullable().optional(),
  image: z.string().url().nullable().optional().or(z.literal("")),
  status: z.enum(["scheduled", "live", "ended"]),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
});

adminRouter.get(
  "/drops",
  ah(async (_req, res) => {
    const { rows } = await query(
      `SELECT d.*, (SELECT count(*) FROM products p WHERE p.drop_id = d.id) AS products,
              (SELECT COALESCE(sum(v.stock),0) FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.drop_id = d.id) AS stock,
              (SELECT COALESCE(sum(i.qty),0) FROM order_items i JOIN products p ON p.id = i.product_id WHERE p.drop_id = d.id) AS sold
         FROM drops d ORDER BY d.starts_at DESC NULLS LAST, d.id DESC`,
    );
    res.json(rows.map((d) => ({ ...d, sellThrough: d.sold + d.stock ? Math.round((d.sold / (d.sold + d.stock)) * 100) : 0 })));
  }),
);

adminRouter.post(
  "/drops",
  ah(async (req, res) => {
    const d = parse(DropInput, req.body);
    const { rows } = await query(
      `INSERT INTO drops(code, name, description, image, status, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.code.toUpperCase(), d.name, d.description ?? null, d.image || null, d.status, d.starts_at || null, d.ends_at || null],
    );
    res.status(201).json(rows[0]);
  }),
);

adminRouter.put(
  "/drops/:id",
  ah(async (req, res) => {
    const d = parse(DropInput, req.body);
    const { rows } = await query(
      `UPDATE drops SET code=$2, name=$3, description=$4, image=$5, status=$6, starts_at=$7, ends_at=$8 WHERE id=$1 RETURNING *`,
      [Number(req.params.id), d.code.toUpperCase(), d.name, d.description ?? null, d.image || null, d.status, d.starts_at || null, d.ends_at || null],
    );
    if (!rows[0]) throw new HttpError(404, "Drop not found");
    res.json(rows[0]);
  }),
);

adminRouter.delete(
  "/drops/:id",
  ah(async (req, res) => {
    await query(`DELETE FROM drops WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  }),
);

/* ─────────────────────────── settings ─────────────────────────── */

adminRouter.get("/settings", ah(async (_req, res) => res.json(await getSettings())));

adminRouter.put(
  "/settings",
  ah(async (req, res) => {
    const s = parse(SettingsSchema, req.body);
    await saveSettings(s);
    publish({ type: "settings.updated" });
    res.json(s);
  }),
);

/* ─────────────────────────── team ─────────────────────────── */

adminRouter.get(
  "/team",
  ah(async (_req, res) => {
    const { rows } = await query(`SELECT id, email, name, role, created_at FROM admin_users ORDER BY created_at`);
    res.json(rows);
  }),
);

adminRouter.post(
  "/team",
  ah(async (req, res) => {
    if (req.admin!.role === "staff") throw new HttpError(403, "Only owners and admins can add team members");
    const u = parse(z.object({ email: z.string().email(), name: z.string().min(2).max(60), password: z.string().min(8).max(100), role: z.enum(["admin", "staff"]) }), req.body);
    const { rows } = await query(`INSERT INTO admin_users(email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, created_at`, [
      u.email.toLowerCase(), u.name, await bcrypt.hash(u.password, 10), u.role,
    ]);
    res.status(201).json(rows[0]);
  }),
);

adminRouter.post(
  "/auth/password",
  ah(async (req, res) => {
    const { current, next } = parse(z.object({ current: z.string(), next: z.string().min(8).max(100) }), req.body);
    const { rows } = await query(`SELECT password_hash FROM admin_users WHERE id = $1`, [req.admin!.sub]);
    if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, "Current password is wrong");
    await query(`UPDATE admin_users SET password_hash = $2 WHERE id = $1`, [req.admin!.sub, await bcrypt.hash(next, 10)]);
    res.json({ ok: true });
  }),
);
