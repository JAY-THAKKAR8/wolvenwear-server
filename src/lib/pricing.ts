import type { Settings } from "./settings.js";

export interface PriceLine {
  price: number;
  qty: number;
}

/** Server-side totals — never trust the client's numbers. Mirrors the storefront's useCartTotals. */
export function computeTotals(
  lines: PriceLine[],
  s: Settings,
  opts: { coupon?: string | null; method: "upi" | "card" | "netbanking" | "cod"; speed: "standard" | "midnight" },
) {
  const subtotal = lines.reduce((n, l) => n + l.price * l.qty, 0);
  const coupon = opts.coupon ? s.coupons.find((c) => c.active && c.code === opts.coupon!.toUpperCase()) : undefined;
  const couponOff = coupon && subtotal > 0 ? Math.min(coupon.amount, subtotal) : 0;
  const prepaid = opts.method !== "cod";
  const prepaidOff = prepaid ? Math.round((subtotal - couponOff) * (s.prepaidDiscountPct / 100)) : 0;
  const shipping = subtotal === 0 || subtotal >= s.freeShippingThreshold ? 0 : s.shippingFee;
  const express = opts.speed === "midnight" ? s.expressFee : 0;
  const total = Math.max(0, subtotal - couponOff - prepaidOff + shipping + express);
  return { subtotal, discount: couponOff + prepaidOff, shipping: shipping + express, total, coupon: coupon?.code ?? null };
}

export const newOrderId = () => "WW-" + Math.random().toString(36).slice(2, 8).toUpperCase();
