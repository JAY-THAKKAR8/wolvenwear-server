import { query } from "../db.js";

export const SIZES = ["S", "M", "L", "XL", "XXL"] as const;

export interface ProductRow {
  id: string;
  slug: string;
  sku: string;
  name: string;
  category: string;
  tag: string;
  colour: string;
  description: string;
  price: number;
  mrp: number | null;
  cost: number;
  images: string[];
  frames: string[];
  badge_label: string | null;
  badge_tone: string | null;
  rating: number;
  reviews: number;
  status: string;
  featured: boolean;
  sort_order: number;
  drop_id: number | null;
  created_at: string;
  updated_at: string;
  variants: { size: string; stock: number; sku: string }[];
  drop_code?: string | null;
  drop_name?: string | null;
}

/** SELECT products with their variants aggregated as JSON. */
export const PRODUCT_SELECT = `
  SELECT p.*, d.code AS drop_code, d.name AS drop_name,
    COALESCE((
      SELECT json_agg(json_build_object('size', v.size, 'stock', v.stock, 'sku', v.sku)
        ORDER BY array_position(ARRAY['S','M','L','XL','XXL'], v.size))
      FROM product_variants v WHERE v.product_id = p.id
    ), '[]') AS variants
  FROM products p
  LEFT JOIN drops d ON d.id = p.drop_id`;

export const totalStock = (p: ProductRow) => p.variants.reduce((n, v) => n + v.stock, 0);

/** Shape the storefront (React app) already understands — see website src/data/products.ts */
export function toStorefront(p: ProductRow) {
  const stock = totalStock(p);
  const badge = p.badge_label
    ? { label: p.badge_label, tone: (p.badge_tone ?? "neutral") as "danger" | "gold" | "neutral" }
    : stock > 0 && stock <= 12
      ? { label: `Only ${stock} left`, tone: "danger" as const }
      : undefined;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    tag: p.tag,
    price: p.price,
    mrp: p.mrp ?? undefined,
    colour: p.colour,
    description: p.description,
    images: p.images,
    frames: p.frames.length ? p.frames : undefined,
    sizes: p.variants.map((v) => v.size),
    soldOut: p.variants.filter((v) => v.stock <= 0).map((v) => v.size),
    rating: p.rating,
    reviews: p.reviews,
    badge,
    stock,
  };
}

export async function getProductById(id: string) {
  const { rows } = await query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}
