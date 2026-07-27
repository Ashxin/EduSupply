# EduSupply — Phase 4 Notes: School Side (Catalog & Ordering)

## What Phase 4 Covered

Building the school-side order placement flow on top of the `orders`/`order_items` schema from Phase 2 — including the phase's designated "hard problem": concurrency-safe stock validation, so two schools can never oversell the same limited stock. Also added a read route for schools to view their own order history.

---

## 1. Scoping Decision — Catalog Browsing

Confirmed the ordering flow is scoped **per-vendor**: a school places one order against one specific vendor at a time (`vendor_id` is required per order), rather than a single cross-vendor cart. This matches `orders.vendor_id` being a single FK, not a list — one order can't span multiple vendors by design.

---

## 2. The `id`-Bridging Problem — School Side

**Core issue, same shape as Phase 3's vendor problem:** the JWT payload only contains `{ id, role }`, where `id` is `users.id`. But `orders.school_id` references `school_profiles(id)` — a different table, different id. Naively comparing `req.user.id` to `school_id` would never match.

**Resolution — mirrored Phase 3's pattern exactly:**

```js
function checkSchoolRole(req, res, next) {
  if (req.user.role !== 'school') {
    return res.status(403).json({ error: 'Wrong role selected' });
  }
  next();
}

async function attachSchoolProfileId(req, res, next) {
  try {
    const result = await pool.query(
      'SELECT id FROM school_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(500).json({ error: 'School profile not found.' });
    }
    req.schoolProfileId = result.rows[0].id;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while fetching the school profile.' });
  }
}
```

Same reasoning as `attachVendorProfileId`: since `checkSchoolRole` already guarantees `role === 'school'`, a zero-row result here is a data-integrity red flag (500), not a normal auth failure.

---

## 3. Request Body Shape — Working It Out Column by Column

Walked through every column of `orders` and `order_items` to determine the source of each value: request body, middleware, database default, or backend-hardcoded.

**`orders` columns:**

| Column | Source |
|---|---|
| `id` | auto (`DEFAULT gen_random_uuid()`) |
| `vendor_id` | request body — school can order from multiple vendors, so this can't be inferred from the token |
| `school_id` | `req.schoolProfileId` (middleware) — never trusted from the body, same anti-spoofing reasoning as Phase 3's `vendor_id` |
| `created_at` | auto (`DEFAULT now()`) |
| `status` | hardcoded `'pending'` in the route handler — a school should never get to choose its own order's starting status |

**`order_items` columns:**

| Column | Source |
|---|---|
| `id` | auto |
| `order_id` | the `id` returned from the `orders` insert (`RETURNING id`), used inside the same transaction — can't exist before the parent row does |
| `product_id` | request body (per line item) |
| `quantity` | request body (per line item) |
| `price_at_order` | **backend looks up `products.price` at insert time** — never trusted from the client, to prevent a malicious/buggy client from sending a fake low price |

**Final request body shape:**
```json
{
  "vendor_id": "...",
  "items": [
    { "product_id": "...", "quantity": 50 },
    { "product_id": "...", "quantity": 30 }
  ]
}
```

---

## 4. Validation Layer

Validation happens entirely **before** opening any database connection or transaction — fail fast on malformed input rather than paying for a DB round-trip first.

**Top-level checks:**
```js
if (!vendor_id || !items || !Array.isArray(items) || items.length == 0) {
  return res.status(400).json({ error: 'Incomplete fields' });
}
```

**Key bug caught during development:** `!items` alone does **not** catch an empty array (`items: []`) — in JavaScript, any object (including an empty array) is truthy, so `![]` evaluates to `false`. Two additional checks were required: `Array.isArray(items)` to confirm it's actually an array, and `items.length == 0` to catch the empty-array case specifically.

**Per-item checks**, using `.every()`:
```js
const allItemsValid = items.every(item => {
  return item.product_id && typeof item.quantity === "number" && item.quantity > 0;
});

if (!allItemsValid) {
  return res.status(400).json({ error: 'Invalid items' });
}
```
`typeof item.quantity === "number"` specifically rejects a numeric-looking string like `"5"`, which would otherwise pass a looser truthy check.

---

## 5. The Hard Problem — Concurrency-Safe Stock Validation

**The race condition, in plain terms:** if stock is checked (`SELECT`) and then reduced (`UPDATE`) as two separate steps, two near-simultaneous requests can both read the same "10 in stock" before either writes — both then proceed to order 10, taking stock to -10. Classic time-of-check-to-time-of-use (TOCTOU) bug / lost update problem.

**Resolution — collapse check-and-write into one atomic statement:**
```sql
UPDATE products
SET stock_quantity = stock_quantity - $1
WHERE id = $2 AND stock_quantity >= $1
RETURNING price
```

This works because the `WHERE` clause condition and the write happen as a single atomic operation at the database level — Postgres won't let two concurrent transactions both pass this `WHERE` clause against the same shrinking value. One succeeds; by the time the second one's `WHERE` clause is evaluated, the first has already reduced `stock_quantity`, so the second's `>= $1` check now fails.

**Detecting failure:** `result.rowCount === 0` means either not enough stock, or (as a side effect) a nonexistent `product_id` — both correctly produce the same `409` response, since neither case matched the `WHERE` clause. Same pattern as `DELETE /products/:id`'s ownership check in Phase 3.

**Efficiency detail:** `RETURNING price` on this same `UPDATE` avoids a separate `SELECT` for `price_at_order` — the current price is fetched in the exact same round-trip that reserved the stock, at the exact moment of the transaction.

---

## 6. Transaction Design

Since order placement involves multiple writes (`orders` insert + N `order_items` inserts + N stock `UPDATE`s), the entire operation is wrapped in one transaction — not just the two-insert case from Phase 1's signup, but an arbitrary number of related writes that must all succeed or all roll back together.

**Full flow:**
```js
app.post('/orders', authenticateToken, checkSchoolRole, attachSchoolProfileId, async (req, res) => {
  const { vendor_id, items } = req.body || {};

  if (!vendor_id || !items || !Array.isArray(items) || items.length == 0) {
    return res.status(400).json({ error: 'Incomplete fields' });
  }

  const allItemsValid = items.every(item => {
    return item.product_id && typeof item.quantity === "number" && item.quantity > 0;
  });

  if (!allItemsValid) {
    return res.status(400).json({ error: 'Invalid items' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'INSERT INTO orders (vendor_id, school_id, status) VALUES ($1, $2, $3) RETURNING *',
      [vendor_id, req.schoolProfileId, 'pending']
    );

    const orderId = result.rows[0].id;

    for (const item of items) {
      const result = await client.query(
        `UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2 AND stock_quantity >= $1 RETURNING price`,
        [item.quantity, item.product_id]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Insufficient stock for product ${item.product_id}.` });
      }

      const priceAtOrder = result.rows[0].price;

      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, price_at_order) VALUES ($1, $2, $3, $4) RETURNING *',
        [orderId, item.product_id, item.quantity, priceAtOrder]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ success: true, order_id: orderId });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong during ordering' });
  } finally {
    client.release();
  }
});
```

**Key design point:** the stock `UPDATE` + `order_items` insert live *inside* the same transaction as the `orders` insert, not before or after it. This guarantees that if any item in a multi-item order fails (e.g. item 2 of 3 has insufficient stock), the stock already decremented for item 1 is rolled back too — proven directly in testing (see below), not just assumed.

**Loop construct:** used `for...of` rather than `.forEach()` or `.every()`, since those don't correctly `await` async operations inside their callbacks — a plain `for` loop properly pauses on each `await`.

---

## 7. `GET /orders` — School Order History

Simple, read-only, no transaction needed:

```js
app.get('/orders', authenticateToken, checkSchoolRole, attachSchoolProfileId, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE school_id = $1',
      [req.schoolProfileId]
    );
    res.status(200).json({ success: true, orders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to view the order' });
  }
});
```

**Key decisions:**
- `200`, not `201` — this route retrieves existing data, it doesn't create anything.
- `result.rows` (full array), not `result.rows[0]` — a school can have many orders.
- Same middleware chain as `POST /orders`, reused directly.
- Ownership scoping via `WHERE school_id = $1` follows the exact same pattern proven safe in Phase 3 (`WHERE vendor_id = $2`) — `req.schoolProfileId` is always server-derived from the JWT, never client-supplied, so cross-school data leakage isn't structurally possible.

**Scope note:** deliberately kept to schools viewing their own orders only. Vendor-side order visibility (vendors seeing orders placed with them) was consciously deferred as a separate, later addition rather than folded into this route.

---

## 8. Testing Performed (Postman + psql, manual)

Two accounts used: one vendor (`vendor_race@test.com`) with multiple products at known stock levels, one school (`school_race@test.com`).

**Validation & auth (`POST /orders`):**

| # | Test | Result |
|---|---|---|
| 1 | No token | `401 Authorization token missing.` ✅ |
| 2 | Invalid/garbage token | `401 Invalid or expired token.` ✅ |
| 3 | Wrong role (vendor token) | `403 Wrong role selected` ✅ |
| 4 | Missing `vendor_id` | `400 Incomplete fields` ✅ |
| 5 | Missing `items` | `400 Incomplete fields` ✅ |
| 6 | `items` is empty array `[]` | `400 Incomplete fields` ✅ — confirms the truthy-empty-array trap was actually fixed |
| 7 | `items` is not an array | `400 Incomplete fields` ✅ |
| 8 | Item missing `product_id` | `400 Invalid items` ✅ |
| 9 | `quantity` = 0 | `400 Invalid items` ✅ |
| 10 | `quantity` negative | `400 Invalid items` ✅ |
| 11 | `quantity` as string (`"5"`) | `400 Invalid items` ✅ — confirms `typeof` check, not just truthy check |
| 17 | Empty body / no `Content-Type` | `400 Incomplete fields` ✅ — `req.body \|\| {}` guard working |

**Happy paths & business logic:**

| # | Test | Result |
|---|---|---|
| 12 | Single item, sufficient stock | `201`, `order_id` returned; verified in psql: `orders` row `status='pending'`, correct `order_items` row, stock correctly reduced ✅ |
| 13 | Multi-item order (2 products, 1 order) | `201`; verified 2 `order_items` rows under the same `order_id`, both products' stock correctly reduced independently ✅ |
| 14 | Insufficient stock, single item | `409 Insufficient stock for product <id>.`; verified in psql: no `orders` row created, stock untouched (full rollback) ✅ |
| 15 | **Multi-item, second item fails after first succeeds** | `409` on the failing item; **critically verified in psql that the first item's stock reduction was also rolled back** — proves the transaction undoes all writes since `BEGIN`, not just the failing one ✅ |
| 16 | Nonexistent `product_id` (valid UUID, no match) | `409 Insufficient stock...` — same code path as low stock, since the `UPDATE`'s `WHERE` clause simply matches zero rows either way ✅ |

**Concurrency — the actual hard problem, proven under real load:**

| # | Test | Method | Result |
|---|---|---|---|
| 18 | Two concurrent requests for the same product, both requesting all remaining stock (5 units) | Node script (`race_test.js`) using `Promise.all()` to fire both `fetch()` calls with no `await` in between, guaranteeing genuine overlap | Exactly **one** request succeeded (`201`), the other correctly failed (`409`); verified in psql: `stock_quantity` landed at exactly `0`, never negative; only 1 `orders` row persisted (the failed request's initial `orders` insert was fully rolled back, leaving zero trace) ✅ |

**`GET /orders`:**

| # | Test | Result |
|---|---|---|
| — | Happy path | `200`, returned exactly the orders belonging to the logged-in school (verified count and IDs matched what was actually created across the session) ✅ |
| — | Wrong role (vendor token) | `403 Wrong role selected` ✅ |

---

## Key Concepts Reinforced This Phase

- **TOCTOU (time-of-check-to-time-of-use) race conditions** — the core danger of separating a stock check from a stock write, and why combining them into one atomic `UPDATE ... WHERE` statement closes the gap entirely.
- **`RETURNING` for efficiency** — using `RETURNING price` on the same `UPDATE` that reserves stock avoids a redundant `SELECT`, and captures the price at the exact moment of reservation.
- **Transaction scope covering N dynamic writes**, not just a fixed two-insert case — a `for...of` loop of stock updates + line-item inserts, all still living inside one `BEGIN...COMMIT` boundary.
- **JS truthiness gotcha** — empty arrays and objects are truthy in JavaScript; `!items` alone is not sufficient to validate "did the client send a non-empty array," requiring `Array.isArray()` + `.length` checks.
- **`.every()` vs `for...of`** — `.every()` suits synchronous all-true validation; `for...of` is required when the loop body needs `await` for sequential async database operations.
- **Fail-fast validation** — all input validation happens before any database connection is opened, avoiding wasted round-trips on malformed requests.
- **Never trust client-supplied prices** — `price_at_order` is always derived server-side from the current `products.price`, same principle as never trusting a client-supplied `vendor_id`/`school_id` for identity.
- **Proving concurrency safety empirically** — reasoning about a race condition fix is necessary but not sufficient; firing genuinely concurrent requests via `Promise.all()` and inspecting real post-test database state is what actually confirms the fix works.

---

## Open / Deferred Items (Carried Forward)

- **Vendor-side order visibility** — `GET /orders` currently only supports schools viewing their own orders. A vendor-side equivalent (orders placed *with* them) was deliberately deferred as a separate addition.
- **`GET /orders/:id`** — single-order detail view (including its line items) was considered but deferred; `GET /orders` alone was judged sufficient to close out Phase 4's stated scope.
- **`orders.status` validation** — still unconstrained `VARCHAR(255)`, as intentionally deferred since Phase 2, to be properly designed in **Phase 5 (Order Status Pipeline)**.

---

## Phase 4 Status: ✅ Complete

- `POST /orders` — full request validation, id-bridging middleware (`checkSchoolRole`, `attachSchoolProfileId`), transaction-safe multi-item order placement, atomic concurrency-safe stock validation
- `GET /orders` — school order history, correctly scoped and role-protected
- Race condition fix proven via a dedicated concurrent test script (`backend/tests/race_test.js`), not just reasoned about
- 18+ test cases covering validation, happy paths, rollback correctness, and true concurrency — all verified against actual database state
- Committed and pushed to `main` on GitHub (commit `10dc0db`)

**Next up: Phase 5 — Order Status Pipeline (state machine for order status, vendor updates it, school views it in real time)**
