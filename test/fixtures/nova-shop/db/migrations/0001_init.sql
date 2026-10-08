CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer text NOT NULL,
  total numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
