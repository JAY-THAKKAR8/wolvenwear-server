-- WOLVENWEAR — initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE admin_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','staff')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drops (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,              -- e.g. DROP-04
  name        TEXT NOT NULL,
  description TEXT,
  image       TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended')),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          TEXT PRIMARY KEY DEFAULT ('p_' || substr(md5(random()::text), 1, 8)),
  slug        TEXT NOT NULL UNIQUE,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('tees','hoodies','bottoms','tactical','accessories')),
  tag         TEXT NOT NULL DEFAULT '',
  colour      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price >= 0),   -- INR, whole rupees
  mrp         INTEGER CHECK (mrp IS NULL OR mrp >= 0),
  cost        INTEGER NOT NULL DEFAULT 0,            -- for margin
  images      TEXT[] NOT NULL DEFAULT '{}',
  frames      TEXT[] NOT NULL DEFAULT '{}',          -- 360° turntable frames
  badge_label TEXT,
  badge_tone  TEXT CHECK (badge_tone IS NULL OR badge_tone IN ('danger','gold','neutral')),
  rating      NUMERIC(2,1) NOT NULL DEFAULT 4.8,
  reviews     INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','archived')),
  featured    BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  drop_id     INTEGER REFERENCES drops(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_status_idx ON products(status);
CREATE INDEX products_category_idx ON products(category);

CREATE TABLE product_variants (
  id          SERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size        TEXT NOT NULL CHECK (size IN ('S','M','L','XL','XXL')),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku         TEXT NOT NULL,
  UNIQUE (product_id, size)
);

CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT,
  city        TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id               TEXT PRIMARY KEY,                       -- WW-XXXXXX
  customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'placed'
                     CHECK (status IN ('placed','confirmed','packed','shipped','delivered','cancelled')),
  payment_method   TEXT NOT NULL CHECK (payment_method IN ('upi','card','netbanking','cod')),
  payment_status   TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','refunded')),
  speed            TEXT NOT NULL DEFAULT 'standard' CHECK (speed IN ('standard','midnight')),
  subtotal         INTEGER NOT NULL,
  discount         INTEGER NOT NULL DEFAULT 0,
  shipping         INTEGER NOT NULL DEFAULT 0,
  total            INTEGER NOT NULL,
  coupon           TEXT,
  name             TEXT NOT NULL,
  phone            TEXT NOT NULL,
  email            TEXT,
  address          TEXT NOT NULL,
  landmark         TEXT,
  city             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT '',
  pincode          TEXT NOT NULL,
  courier          TEXT,
  awb              TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX orders_created_idx ON orders(created_at DESC);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT REFERENCES products(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  image       TEXT,
  size        TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  price       INTEGER NOT NULL
);

CREATE TABLE order_events (
  id          SERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,          -- status | note
  status      TEXT,
  message     TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT 'system',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
