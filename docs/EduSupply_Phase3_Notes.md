# EduSupply — Phase 3 Notes: Vendor Side (Product Management)

## Goal

Give vendors full CRUD control over their own products, while making sure:
1. Only authenticated vendors can create/edit/delete products.
2. A vendor can never touch another vendor's products, even if they know or guess the product's ID.

## Schema recap

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

## The core problem this phase solved: id mismatch

- The JWT payload (`req.user`, set by `authenticateToken`) carries `users.id`.
- `products.vendor_id` is a foreign key into `vendor_profiles(id)` — a **different** table, different id.
- `vendor_profiles.user_id` is the bridge between the two.

Naively comparing `product.vendor_id === req.user.id` would never match, even for the legitimate owner. This had to be resolved with a dedicated middleware.

## Middleware chain (used on all three product routes)

```
authenticateToken → checkVendorRole → attachVendorProfileId → route handler
```

**`authenticateToken`** (from Phase 1) — verifies the JWT, sets `req.user = { id, role }`.

**`checkVendorRole`** — rejects non-vendors:
```js
function checkVendorRole(req, res, next) {
  if (req.user.role !== 'vendor') {
    return res.status(403).json({ error: 'Wrong role selected' });
  }
  next();
}
```

**`attachVendorProfileId`** — bridges `users.id` → `vendor_profiles.id` and attaches it to `req.vendorProfileId`:
```js
async function attachVendorProfileId(req, res, next) {
  try {
    const result = await pool.query(
      'SELECT id FROM vendor_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      // Should be impossible — users + vendor_profiles are created
      // together in one transaction at signup. Zero rows here means
      // the data itself is in a broken state, not a client error.
      return res.status(500).json({ error: 'Vendor profile not found.' });
    }
    req.vendorProfileId = result.rows[0].id;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while fetching the vendor profile.' });
  }
}
```

Key design point: since `checkVendorRole` already guarantees `req.user.role === 'vendor'` by the time this runs, a zero-row result here is a data-integrity red flag (500), not a normal auth failure — it should never actually happen given how signup works.

## POST /products — create

- Required from client: `name`, `category`, `price` (must be `typeof "number"` and `> 0`).
- Optional: `stock_quantity` — defaults to `0` via `stock_quantity ?? 0` (not `||`, to correctly preserve an explicit `0`).
- `vendor_id` is **never** trusted from the request body — always taken from `req.vendorProfileId`, set server-side by the middleware. (Otherwise a vendor could spoof another vendor's id and create products under their name.)
- `INSERT ... RETURNING *`, response `201`.

## PUT /products/:id — partial update

- Supports **partial updates** — a vendor can send just one field (e.g. `{ "stock_quantity": 0 }`) without resending everything.
- Ownership check first, single query:
  ```sql
  SELECT id FROM products WHERE id = $1 AND vendor_id = $2
  ```
  Zero rows → generic `404 Product not found.` This deliberately does **not** distinguish "doesn't exist" from "exists but isn't yours" — returning different codes for those two cases would let a vendor probe IDs and learn which products exist system-wide, even ones they don't own.
- SQL `SET` clause built dynamically:
  ```js
  const fields = [];
  const values = [];
  if (name) { fields.push(`name = $${values.length + 1}`); values.push(name); }
  // ...same pattern for price, category, stock_quantity
  ```
  - `price`: three-way branch — not sent (skip), sent but invalid (`400`), sent and valid (include).
  - `stock_quantity`: same three-way branch, but uses `!== undefined` (not truthy check) and `< 0` (not `<= 0`), since `0` is a legitimate, intentional stock level.
  - `category`/`name`: simple truthy check is sufficient — no invalid-but-truthy trap like numeric fields have.
  - If nothing was provided at all: `400 At least one field (name, price, category, stock_quantity) must be provided.`
- Placeholder numbers computed dynamically via `values.length + 1`, since the number of fields varies per request.
- Response: `200` with the full updated row via `RETURNING *`.

## DELETE /products/:id — delete

- No separate ownership `SELECT` needed — the `DELETE`'s own `WHERE` clause does double duty:
  ```sql
  DELETE FROM products WHERE id = $1 AND vendor_id = $2
  ```
- `result.rowCount === 0` → `404` (same generic reasoning as `PUT`).
- Success → `204 No Content`, sent with `res.status(204).send()` — no JSON body, per HTTP convention for a successful delete with nothing to return.

## Bug found during testing (and fixed)

All three routes destructure `req.body` on their first line. If a client sends a request with **no body / no `Content-Type: application/json` header**, `req.body` is `undefined`, and destructuring it directly throws — *before* the route's own `try/catch` or validation ever runs. This produced an unhandled Express HTML stack-trace page instead of a clean `400`, and leaked internal error details.

Fix — guard with a fallback on every route that destructures the body:
```js
const { name, price, category, stock_quantity } = req.body || {};
```
This lets `req.body` safely fall back to `{}`, so all destructured fields become `undefined` and flow into the existing validation checks (which already handle `undefined` correctly) instead of crashing. Applied to `/signup`, `/login`, `POST /products`, and `PUT /products/:id`.

## Testing performed (Postman, manual)

Two vendor accounts (A and B) created and logged in; one product created per vendor.

| Category | Result |
|---|---|
| No token / invalid token on `POST /products` | `401` ✅ |
| Non-vendor role on `POST /products` | `403` (not explicitly retested this phase, verified in Phase 1 pattern) |
| Missing `name`/`category` | `400` ✅ |
| Negative / non-numeric `price` | `400` ✅ |
| `stock_quantity` omitted on create | defaults to `0`, `201` ✅ |
| **Vendor B `PUT`s Vendor A's product** | `404` ✅ — core ownership test |
| **Vendor A `DELETE`s Vendor B's product** | `404` ✅ — core ownership test |
| `PUT` with `{ "stock_quantity": 0 }` | `200`, correctly set to `0` (not skipped) ✅ |
| `PUT` with empty body, before fix | unhandled `500` HTML crash ❌ → fixed |
| `PUT` with empty body, after fix (owner token) | `400`, clean JSON error ✅ |
| `DELETE` happy path | `204 No Content` ✅ |
| `DELETE` same product again | `404` ✅ |

## Committed & pushed

`backend/index.js` updated with all three routes and middleware; pushed to `main` on GitHub (commit `d01cf41`).

## Open items / next phase candidates

- School-side order placement, using the `orders` / `order_items` tables from Phase 2.
- Not yet tested: non-vendor (school) role explicitly hitting `POST /products` in this session (was verified in earlier phase's pattern, but worth a fresh regression check given `checkVendorRole` now has its own dedicated middleware file).
