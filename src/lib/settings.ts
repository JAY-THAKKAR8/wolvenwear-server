import { z } from "zod";
import { query } from "../db.js";

/** Store-wide settings the admin controls and the storefront reads. */
export const SettingsSchema = z.object({
  storeName: z.string().min(1).max(60),
  announcement: z.array(z.string().max(80)).max(6),
  freeShippingThreshold: z.number().int().min(0).max(100000),
  shippingFee: z.number().int().min(0).max(5000),
  expressFee: z.number().int().min(0).max(5000),
  prepaidDiscountPct: z.number().min(0).max(30),
  codEnabled: z.boolean(),
  coupons: z.array(z.object({ code: z.string().min(2).max(20).toUpperCase(), amount: z.number().int().min(1), active: z.boolean() })).max(20),
  storefrontTheme: z.enum(["light", "dark", "system"]),
  dropCountdownEndsAt: z.string().nullable(),
  lowStockThreshold: z.number().int().min(0).max(100),
  instagram: z.string().max(60),
  supportEmail: z.string().max(120),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  storeName: "WOLVENWEAR",
  announcement: ["New drop live", "Free express shipping across India over ₹999", "Cash on delivery & UPI available", "Join the pack"],
  freeShippingThreshold: 999,
  shippingFee: 99,
  expressFee: 199,
  prepaidDiscountPct: 5,
  codEnabled: true,
  coupons: [
    { code: "WOLF10", amount: 500, active: true },
    { code: "PACK15", amount: 750, active: true },
  ],
  storefrontTheme: "system",
  dropCountdownEndsAt: null,
  lowStockThreshold: 5,
  instagram: "@wolvenwear.official",
  supportEmail: "support@wolvenwear.in",
};

export async function getSettings(): Promise<Settings> {
  const { rows } = await query<{ value: Settings }>("SELECT value FROM settings WHERE key = 'store'");
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

export async function saveSettings(s: Settings) {
  await query(
    `INSERT INTO settings(key, value, updated_at) VALUES ('store', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(s)],
  );
}

/** Subset safe to expose publicly to the storefront. */
export const publicSettings = (s: Settings) => ({
  storeName: s.storeName,
  announcement: s.announcement,
  freeShippingThreshold: s.freeShippingThreshold,
  shippingFee: s.shippingFee,
  expressFee: s.expressFee,
  prepaidDiscountPct: s.prepaidDiscountPct,
  codEnabled: s.codEnabled,
  coupons: s.coupons.filter((c) => c.active).map((c) => ({ code: c.code, amount: c.amount })),
  storefrontTheme: s.storefrontTheme,
  dropCountdownEndsAt: s.dropCountdownEndsAt,
  instagram: s.instagram,
});
