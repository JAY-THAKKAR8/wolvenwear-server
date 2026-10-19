import "dotenv/config";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { pool, tx } from "./db.js";
import { DEFAULT_SETTINGS } from "./lib/settings.js";

/**
 * Seeds the database with the storefront catalogue (ids p1..p8 so existing carts keep working),
 * three drops, an admin user and ~60 days of realistic order history for the dashboard.
 * Safe to re-run: wipes business tables first (not the migrations table).
 */
interface SeedProduct {
  id: string; slug: string; name: string; category: string; tag: string; price: number; mrp?: number; colour: string;
  images: string[]; sizes: string[]; soldOut?: string[]; rating: number; reviews: number;
  badge?: { label: string; tone: string }; stock?: number; frames?: string[];
}
const catalogue: SeedProduct[] = JSON.parse(readFileSync(new URL("./seed-data.json", import.meta.url), "utf8"));

const DESCRIPTIONS: Record<string, string> = {
  tees: "Cut from 300 GSM combed French terry with a drop-shoulder, boxy block. Garment-dyed, acid washed by hand.",
  hoodies: "450 GSM double-layer fleece with a brushed interior, structured three-panel hood and gunmetal wolf-claw hardware.",
  bottoms: "Relaxed tapered silhouette in heavyweight terry or water-repellent ripstop with matte gold toggles.",
  tactical: "Modular utility layer in 500D Cordura with quick-release buckles, MOLLE webbing and a removable chest pouch.",
  accessories: "Solid brass hardware cast in small runs and finished by hand with an aged patina.",
};
const COST_RATIO: Record<string, number> = { tees: 0.32, hoodies: 0.36, bottoms: 0.38, tactical: 0.42, accessories: 0.28 };
const DROP_FOR: Record<string, string> = { p1: "DROP-04", p2: "DROP-04", p5: "DROP-04", p4: "DROP-03", p7: "DROP-03", p3: "DROP-04" };

const FIRST = ["Arjun", "Riya", "Kabir", "Aanya", "Vihaan", "Ishaan", "Meera", "Rohan", "Zara", "Aditya", "Sana", "Dev", "Tara", "Kunal", "Nisha", "Yash", "Diya", "Reyansh", "Kiara", "Aarav", "Myra", "Siddharth", "Anika", "Harsh", "Pooja", "Neil", "Ira", "Karan"];
const LAST = ["Mehta", "Sharma", "Kapoor", "Iyer", "Reddy", "Singh", "Nair", "Patel", "Khan", "Verma", "Bose", "Gill", "Joshi", "Rao", "Malhotra", "Das"];
const CITIES: [string, string, string][] = [
  ["Mumbai", "Maharashtra", "400050"], ["Bengaluru", "Karnataka", "560038"], ["New Delhi", "Delhi", "110017"], ["Pune", "Maharashtra", "411001"],
  ["Hyderabad", "Telangana", "500034"], ["Ahmedabad", "Gujarat", "380015"], ["Chennai", "Tamil Nadu", "600040"], ["Kolkata", "West Bengal", "700019"],
  ["Jaipur", "Rajasthan", "302001"], ["Chandigarh", "Chandigarh", "160017"], ["Goa", "Goa", "403001"], ["Surat", "Gujarat", "395007"],
];
const STREETS = ["14, Linking Road, Bandra West", "221 Indiranagar 100ft Rd", "B-42 Hauz Khas", "7 Koregaon Park Lane 5", "Plot 9, Jubilee Hills", "C-301 Satellite Rd", "12 Anna Nagar 2nd Ave", "56 Park Street"];
const COURIERS = ["Delhivery", "Blue Dart", "Shiprocket", "Xpressbees"];

// deterministic PRNG so every reseed gives the same dashboard
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
const id6 = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(rnd() * 32)]).join("");

async function run() {
  await tx(async (c) => {
    await c.query(`TRUNCATE order_events, order_items, orders, customers, product_variants, products, drops, admin_users, settings RESTART IDENTITY CASCADE`);

    // admin
    const email = (process.env.ADMIN_EMAIL ?? "admin@wolvenwear.in").toLowerCase();
    const password = process.env.ADMIN_PASSWORD ?? "Wolven@123";
    await c.query(`INSERT INTO admin_users(email, name, password_hash, role) VALUES ($1,$2,$3,'owner')`, [
      email, process.env.ADMIN_NAME ?? "Alpha Admin", await bcrypt.hash(password, 10),
    ]);

    // settings — live drop countdown 3 days out
    const countdown = new Date(Date.now() + 3 * 864e5 + 7 * 36e5).toISOString();
    await c.query(`INSERT INTO settings(key, value) VALUES ('store', $1)`, [JSON.stringify({ ...DEFAULT_SETTINGS, dropCountdownEndsAt: countdown })]);

    // drops
    const day = 864e5;
    const drops = [
      ["DROP-03", "Lunar Eclipse", "Midnight-dyed terry and ripstop. The night shift capsule.", catalogue[3].images[0], "ended", -48, -20],
      ["DROP-04", "Apex Predator", "Flagship heavy fleece, acid-washed tees and the Cordura vest.", catalogue[0].images[0], "live", -19, 3],
      ["DROP-05", "Cerberus Protocol", "Three-headed graphics, 500 GSM fleece and brass hardware.", catalogue[1].images[0], "scheduled", 3, 24],
    ] as const;
    const dropIds: Record<string, number> = {};
    for (const [code, name, desc, image, status, s, e] of drops) {
      const r = await c.query(`INSERT INTO drops(code, name, description, image, status, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
        code, name, desc, image, status, new Date(Date.now() + s * day), new Date(Date.now() + e * day),
      ]);
      dropIds[code] = r.rows[0].id;
    }

    // products + variants
    for (const [i, p] of catalogue.entries()) {
      const sku = `WW-${p.category.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, "0")}`;
      const explicitLowStock = p.badge?.label.startsWith("Only");
      await c.query(
        `INSERT INTO products(id, slug, sku, name, category, tag, colour, description, price, mrp, cost, images, frames, badge_label, badge_tone,
                              rating, reviews, status, featured, sort_order, drop_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18,$19,$20, now() - ($21 || ' days')::interval)`,
        [
          p.id, p.slug, sku, p.name, p.category, p.tag, p.colour, DESCRIPTIONS[p.category], p.price, p.mrp ?? null,
          Math.round(p.price * COST_RATIO[p.category]), p.images, p.frames ?? [],
          explicitLowStock ? null : p.badge?.label ?? null, explicitLowStock ? null : p.badge?.tone ?? null,
          p.rating, p.reviews, i < 4, i, DROP_FOR[p.id] ? dropIds[DROP_FOR[p.id]] : null, 60 - i * 3,
        ],
      );
      // spread the storefront's "stock" figure across sizes, or a healthy default
      const sizes = p.sizes;
      const total = p.stock ?? 40 + Math.floor(rnd() * 80);
      let left = total;
      const avail = sizes.filter((s) => !p.soldOut?.includes(s));
      for (const size of sizes) {
        const j = avail.indexOf(size);
        const stock = j < 0 ? 0 : j === avail.length - 1 ? Math.max(0, left) : Math.min(left, Math.max(1, Math.round(total / avail.length + (rnd() - 0.5) * 4)));
        left -= stock;
        await c.query(`INSERT INTO product_variants(product_id, size, stock, sku) VALUES ($1,$2,$3,$4)`, [p.id, size, Math.max(0, stock), `${sku}-${size}`]);
      }
    }

    // customers
    const customers: { id: string; name: string; phone: string; email: string; city: [string, string, string]; weight: number }[] = [];
    for (let i = 0; i < 34; i++) {
      const name = `${FIRST[i % FIRST.length]} ${pick(LAST)}`;
      const phone = `9${String(800000000 + Math.floor(rnd() * 199999999)).slice(0, 9)}`;
      const city = pick(CITIES);
      const r = await c.query(
        `INSERT INTO customers(phone, name, email, city, notes, created_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval) RETURNING id`,
        [phone, name, `${name.split(" ")[0].toLowerCase()}.${i}@mail.in`, city[0], i === 0 ? "Founding pack member. Always ships midnight express." : null, 90 - i],
      );
      // a few heavy buyers make the VIP tiers interesting
      customers.push({ id: r.rows[0].id, name, phone, email: `${name.split(" ")[0].toLowerCase()}.${i}@mail.in`, city, weight: i < 4 ? 6 : i < 10 ? 3 : 1 });
    }
    const weighted = customers.flatMap((cu) => Array(cu.weight).fill(cu));

    // orders across the last 60 days, trending up
    const variantStock = new Map<string, number>();
    const methods = ["upi", "upi", "upi", "card", "card", "netbanking", "cod", "cod"] as const;
    for (let n = 0; n < 190; n++) {
      const ageDays = Math.pow(rnd(), 1.4) * 60; // more recent orders than older ones
      const at = new Date(Date.now() - ageDays * day - rnd() * 36e5);
      const cu = pick(weighted);
      const lines: { p: SeedProduct; size: string; qty: number }[] = [];
      const count = rnd() < 0.62 ? 1 : rnd() < 0.8 ? 2 : 3;
      for (let k = 0; k < count; k++) {
        const p = pick(catalogue);
        const sizes = p.sizes.filter((s) => !p.soldOut?.includes(s));
        if (!sizes.length || lines.some((l) => l.p.id === p.id)) continue;
        lines.push({ p, size: pick(sizes), qty: rnd() < 0.88 ? 1 : 2 });
      }
      if (!lines.length) continue;
      const method = pick(methods);
      const speed = rnd() < 0.18 ? "midnight" : "standard";
      const subtotal = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
      const coupon = rnd() < 0.15 ? pick(["WOLF10", "PACK15"]) : null;
      const couponOff = coupon === "WOLF10" ? 500 : coupon === "PACK15" ? 750 : 0;
      const prepaidOff = method !== "cod" ? Math.round((subtotal - couponOff) * 0.05) : 0;
      const shipping = (subtotal >= 999 ? 0 : 99) + (speed === "midnight" ? 199 : 0);
      const total = subtotal - couponOff - prepaidOff + shipping;

      const status =
        ageDays < 0.5 ? pick(["placed", "placed", "confirmed"]) :
        ageDays < 1.5 ? pick(["confirmed", "packed"]) :
        ageDays < 4 ? pick(["packed", "shipped", "shipped"]) :
        rnd() < 0.05 ? "cancelled" : ageDays < 7 ? pick(["shipped", "delivered"]) : "delivered";
      const paid = method !== "cod" || status === "delivered";
      const shipped = ["shipped", "delivered"].includes(status);
      const id = `WW-${id6()}`;
      const [city, state, pin] = cu.city;
      await c.query(
        `INSERT INTO orders(id, customer_id, status, payment_method, payment_status, speed, subtotal, discount, shipping, total, coupon,
                            name, phone, email, address, city, state, pincode, courier, awb, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
        [
          id, cu.id, status, method, status === "cancelled" ? (method === "cod" ? "pending" : "refunded") : paid ? "paid" : "pending", speed,
          subtotal, couponOff + prepaidOff, shipping, total, coupon, cu.name, cu.phone, cu.email, pick(STREETS), city, state, pin,
          shipped ? pick(COURIERS) : null, shipped ? `${Math.floor(1e11 + rnd() * 9e11)}` : null, at,
        ],
      );
      for (const l of lines) {
        await c.query(`INSERT INTO order_items(order_id, product_id, name, image, size, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          id, l.p.id, l.p.name, l.p.images[0], l.size, l.qty, l.p.price,
        ]);
        variantStock.set(`${l.p.id}:${l.size}`, (variantStock.get(`${l.p.id}:${l.size}`) ?? 0) + l.qty);
      }
      // timeline
      const flow = ["placed", "confirmed", "packed", "shipped", "delivered"];
      const upto = status === "cancelled" ? 1 : flow.indexOf(status);
      const msgs: Record<string, string> = {
        placed: `Order placed via storefront • ${method.toUpperCase()}`,
        confirmed: "Order confirmed — payment verified",
        packed: "Packed and quality-checked at the den",
        shipped: "Handed to courier",
        delivered: "Delivered to the pack member",
      };
      for (let s = 0; s <= upto; s++) {
        const t = new Date(at.getTime() + s * (s < 3 ? 5 : 30) * 36e5);
        await c.query(`INSERT INTO order_events(order_id, type, status, message, author, created_at) VALUES ($1,'status',$2,$3,$4,$5)`, [
          id, flow[s], msgs[flow[s]], s === 0 ? "system" : "Alpha Admin", t > new Date() ? new Date() : t,
        ]);
      }
      if (status === "cancelled")
        await c.query(`INSERT INTO order_events(order_id, type, status, message, author, created_at) VALUES ($1,'status','cancelled','Cancelled at customer request','Alpha Admin',$2)`, [id, new Date(at.getTime() + 6 * 36e5)]);
    }
  });

  const counts = await pool.query(`SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM orders) o, (SELECT count(*) FROM customers) c`);
  console.log(`✓ Seeded ${counts.rows[0].p} products, ${counts.rows[0].o} orders, ${counts.rows[0].c} customers`);
  console.log(`  Admin login → ${process.env.ADMIN_EMAIL ?? "admin@wolvenwear.in"} / ${process.env.ADMIN_PASSWORD ?? "Wolven@123"}`);
  await pool.end();
}

run().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
