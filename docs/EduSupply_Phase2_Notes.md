# EduSupply — Phase 2 Notes: Database Schema & Models

## What Phase 2 Covered
Designing and building out the core business-domain tables — `products`, `orders`, `order_items` — on top of the auth/role foundation from Phase 1, plus deliberately deciding what *not* to build yet (`inventory` as a separate table, extra profile fields).

---

## 1. The Restaurant Receipt Model — `orders` vs `order_items`

**Core question:** why can't `orders` just have `product_id` and `quantity` columns directly on it?

**Answer, via analogy:** a restaurant receipt has two kinds of information —
- **Header info** (once per visit): table number, date/time, total — maps to `orders`
- **Line items** (repeats, one row per item): burger x2, fries x1 — maps to `order_items`

A single order can contain multiple different products (e.g. 50 belts + 30 ties + 100 badges in one order). Cramming `product_id`/`quantity` directly onto `orders` would force splitting one real-world order into multiple `orders` rows — breaking "show me all orders for school X" (one order would appear as N rows) and order-level status tracking (rows could drift out of sync).

**Resolution:** `orders` = one row per order (who placed it, who it's going to, when, overall status). `order_items` = one row per distinct product within that order, FK'd back to its parent order.

---

## 2. `products` Table

**Key decision — `vendor_id` references `vendor_profiles`, not `users`.** Reasoning carried over directly from the Phase 1 split: `users` holds auth credentials (generic to any account), `vendor_profiles` holds business identity. A product is a business asset — it belongs to the company (e.g. "Acme Uniform Co."), not to a set of login credentials. Same logic will apply to `orders.school_id` referencing `school_profiles`.

**Key decision — no `UNIQUE` on `vendor_id`.** Unlike `user_id` in `school_profiles`/`vendor_profiles` (strictly one-to-one), `vendor_id` on `products` needs to allow **many** products per vendor — a `UNIQUE` constraint here would wrongly restrict a vendor to a single product.

**Key decision — `price` uses `NUMERIC(9,2)`, not `FLOAT`.** Floating-point types introduce rounding/precision errors and are inappropriate for money. `NUMERIC(precision, scale)` stores exact decimal values — `scale = 2` for paise/cents, `precision = 9` gives headroom up to 9,999,999.99, comfortably above a realistic ₹50,000 bulk-order ceiling without being wasteful.

**Key decision — stock lives directly on `products.stock_quantity`, not a separate `inventory` table.** Explicitly reasoned through via YAGNI ("you aren't gonna need it"): a separate `inventory` table would be justified by multi-warehouse tracking, stock history/auditing, or per-location fulfillment — none of which EduSupply currently needs. Adding that complexity now would mean extra joins and code for a problem that doesn't exist yet. `stock_quantity INT NOT NULL DEFAULT 0` — defaults to 0 since a newly created product legitimately starts with no stock.

**Final schema:**
```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendor_profiles(id),
  name VARCHAR(255) NOT NULL,
  price NUMERIC(9,2) NOT NULL,
  category VARCHAR(255) NOT NULL,
  stock_quantity INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);
```

---

## 3. `orders` Table

**Columns:** `id` (UUID PK), `vendor_id` (FK → `vendor_profiles`), `school_id` (FK → `school_profiles`), `created_at`, `status`.

**Key decision — `status` is unconstrained for now (`VARCHAR(255) NOT NULL`), deliberately.** Adding a `CHECK` constraint or converting to a Postgres `ENUM` was consciously deferred to Phase 5 ("Order Status Pipeline"), where the actual state machine (valid states + valid transitions) will be designed properly rather than half-built now. Noted as a known, intentional gap — not an oversight.

**Final schema:**
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES vendor_profiles(id),
  school_id UUID NOT NULL REFERENCES school_profiles(id),
  created_at TIMESTAMP DEFAULT now(),
  status VARCHAR(255) NOT NULL
);
```

---

## 4. `order_items` Table

**Key decision — reference `product_id` (FK), never store the product name directly.** If `order_items` stored a product's name as text, a vendor renaming a product later would create inconsistency between historical orders and the live catalog. Referencing by ID follows the same pattern as `vendor_id`/`school_id` elsewhere.

**Key decision — snapshot the price at time of purchase (`price_at_order`), independent of `products.price`.** Worked through via a concrete scenario: school orders 50 belts at ₹200 each; three months later the vendor raises the price to ₹250. If `order_items` only stored `product_id` and calculated totals via a live join to `products.price`, every historical order's total would silently drift whenever the vendor changed prices — corrupting past financial records. Identified as a bug, not acceptable behavior.

**General principle reinforced:** whenever a value changes over time (price, exchange rate, tax rate, etc.) but a specific past record needs to reflect what the value *was* at that moment, snapshot it into the transaction row rather than relying on a live join to the current value.

**Key decision — `CHECK (quantity > 0)` constraint.** Prevents zero or negative quantities from ever being inserted at the database level, not just relying on application-level validation.

**Final schema:**
```sql
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID NOT NULL REFERENCES products(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  price_at_order NUMERIC(9,2) NOT NULL
);
```

---

## 5. `schools` / `vendors` — Confirmed Already Covered

No new tables needed — `school_profiles` and `vendor_profiles` from Phase 1 already serve this role. Revisited deliberately now that `products` and `orders` actively reference them, to check whether the Phase 1 shape (just `institution_name` / `business_name`) is still sufficient now that real order fulfillment is in play.

**Gap identified:** neither profile table currently has a `contact_number` or `address` — both of which a vendor would realistically need to actually ship an order to a school.

**Key decision — deliberately deferred, not built now.** Distinguished explicitly from the `inventory` decision: this isn't "we don't need this" (like `inventory`), it's "we'll need this eventually, just not yet." Doesn't block Phase 3/4 (product management, catalog browsing/ordering), so adding it now isn't required. Can be added later via a simple `ALTER TABLE school_profiles ADD COLUMN ...` once shipping/fulfillment becomes the active concern. **Flagged here explicitly so it isn't forgotten.**

---

## 6. `inventory` — Deliberately Skipped

Confirmed final: stock is tracked via `products.stock_quantity` rather than a separate `inventory` table. A dedicated `inventory` table would only be justified by multi-warehouse tracking, stock history/auditing, or per-location fulfillment — none of which apply to EduSupply's current scope. Revisit only if that scope changes.

---

## Key Concepts Reinforced This Phase

- **Header/line-item table split** (`orders` / `order_items`) for one-to-many relationships within a single logical transaction — same pattern as an invoice or receipt.
- **Referencing business-identity tables, not auth tables**, for domain data (`vendor_profiles`/`school_profiles`, not `users`) — consistent with the Phase 1 class-table-inheritance split.
- **`NUMERIC(precision, scale)` over `FLOAT`** for any monetary value, to avoid floating-point rounding errors.
- **Snapshotting time-sensitive values** (`price_at_order`) into transactional records rather than relying on a live join to a value that can change later — prevents historical data from silently drifting.
- **YAGNI** — consciously deferring `inventory` as a separate table and profile fields (`contact_number`, `address`) until the project actually needs them, rather than building for hypothetical future complexity.
- **`CHECK` constraints** for enforcing basic data integrity rules (`quantity > 0`) directly at the database level.

---

## Open / Deferred Items (Carried Forward)

- `orders.status` — currently unconstrained `VARCHAR(255)`; valid states + transitions to be designed properly in **Phase 5 (Order Status Pipeline)**.
- `school_profiles` / `vendor_profiles` — missing `contact_number` and `address` (or structured address fields); to be added via `ALTER TABLE` once shipping/fulfillment is actively being built (likely around Phase 4/5).

---

## Phase 2 Status: ✅ Complete

- `products`, `orders`, `order_items` — designed, tested live in psql (`\d` verified), version-controlled in `backend/db/schema.sql`
- `schools`/`vendors` — confirmed covered by existing Phase 1 profile tables, with a noted future addition
- `inventory` — deliberately excluded, reasoning documented
- Commit discipline maintained: each table's schema addition to `schema.sql` committed and pushed separately, verified via `git status` / `git diff` / `git show HEAD` before pushing

**Next up: Phase 3 — Vendor Side: Product Management (CRUD for products, stock quantity, category)**
