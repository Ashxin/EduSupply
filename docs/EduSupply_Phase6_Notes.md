# EduSupply — Phase 6 Notes: Reorder Shortcut

## What Phase 6 Covered

Building a "clone a past order" shortcut for schools — letting School A recreate an old order without re-entering every product and quantity by hand. The core design challenge wasn't the reorder route itself, but figuring out which parts of Phase 4's order-creation logic could be reused as-is, and refactoring that logic into a shared function so both routes stay in sync going forward.

---

## 1. The Core Design Question — What Does "Reorder" Actually Mean?

**Worked through via a concrete scenario:** School A ordered 50 belts @ ₹200 three months ago. Today, the vendor has raised the belt price to ₹250. When School A clicks "reorder," should the new order use ₹200 (the old snapshotted price) or ₹250 (today's live price)?

**Resolution:** `price_at_order` (Phase 2) exists to freeze a value *within* one transaction's lifetime — it protects against the vendor changing prices *while an order is being processed*. It has nothing to say about a brand-new transaction that happens to reuse an old order as a template. A reorder isn't resurrecting the old order; it's placing a **new** order that should behave exactly like any other new order — live price, live stock, from scratch.

**Same reasoning applied to stock:** if an item from the old order is now out of stock, the reorder should fail on that item exactly the way a fresh `POST /orders` would — not silently succeed with a different price, and not silently drop the unavailable item either (see Section 2).

---

## 2. All-or-Nothing vs. Partial Reorder

**Considered two options** for handling an old order where one item is now out of stock:
- **Option A (all-or-nothing):** the whole reorder fails, nothing gets created.
- **Option B (partial):** the order is created anyway, silently dropping unavailable items.

**Chose Option A**, deliberately, for two reasons:
1. It's what Phase 4's existing transaction logic already does *for free* — no new stock-handling code required, since every item's stock check already lives inside one `BEGIN`/`COMMIT`/`ROLLBACK` boundary.
2. Option B would mean giving a school *less* than they asked for without them realizing it up front, and would require new UX/response shape (a "here's what we couldn't include" summary) — real added complexity for a feature meant to be a shortcut. Consistent with the project's YAGNI discipline (same reasoning as deferring `inventory` in Phase 2): can be revisited as a deliberate future upgrade if it turns out to matter.

---

## 3. Route Shape — Dedicated Backend Route vs. Frontend Orchestration

**Considered two options** for how reorder would actually be triggered:
- **Option 1:** `POST /orders/:id/reorder` — a dedicated route, entirely backend-driven.
- **Option 2:** Frontend fetches the old order's items (via some `GET` route), reshapes them, then calls the existing `POST /orders` directly.

**Key finding that settled it:** Option 2 would require a `GET /orders/:id` endpoint that returns line items — but that route doesn't exist. `GET /orders` (Phase 4) only does `SELECT * FROM orders`, which never touches `order_items` — no `product_id`s, no `quantity`s. `GET /orders/:id` was explicitly flagged as deferred in both Phase 4 and Phase 5's notes.

Since *some* new backend capability was needed either way, building it as **internal-only logic inside a dedicated route** (Option 1) was preferred over building a general-purpose `GET /orders/:id` and having the frontend stitch things together:
- One request instead of two (fetch old order, then place new one) — fewer failure points, better UX.
- No risk of the frontend mis-assembling the request body.
- `GET /orders/:id` as a standalone public feature stays deferred, exactly as before — Phase 6 doesn't force it into existence.

---

## 4. Ownership Check — Reused Pattern, Single Query

**Followed the same anti-enumeration pattern established in Phase 3 and Phase 5:** ownership is verified in the `WHERE` clause of a single query, not as a separate fetch-then-compare step:

```sql
SELECT id, school_id, vendor_id FROM orders WHERE id = $1 AND school_id = $2
```

Zero rows back means either the order doesn't exist, or it belongs to a different school — both return the same generic `404 Order not found.`, deliberately not distinguishing the two cases (same anti-enumeration reasoning as every ownership check since Phase 3).

**Scope decision:** reorder is **school-only** — a vendor reordering doesn't make conceptual sense. The route uses the same middleware chain as `POST /orders` (`authenticateToken, checkSchoolRole, attachSchoolProfileId`), with no need for Phase 5's dual-role branching.

---

## 5. Extracting Shared Logic — `createOrder()`

**Key decision, reasoned through explicitly:** rather than copy-pasting Phase 4's transaction block into the new reorder route, that logic was extracted into a standalone function, `createOrder(schoolId, vendorId, items)`, called by *both* `POST /orders` and `POST /orders/:id/reorder`.

**Why extraction over duplication:** if the stock-check or transaction logic ever needs a fix or a change, two copies means two places to remember to update — a silent behavioral mismatch between fresh orders and reorders is exactly the kind of bug that's hard to catch, since both routes would still individually "look like they work."

**Key design point — response handling stays outside the function.** `createOrder()` never calls `res.status(...)` directly; it returns a plain result object instead:
```js
{ success: true, status: 201, order_id: orderId }
// or
{ success: false, status: 409, error: '...' }
// or
{ success: false, status: 500, error: '...' }
```
Each calling route decides what to do with that result (`return res.status(result.status).json(result)`), keeping `createOrder()` decoupled from any one route's specific response conventions — the same instinct behind separating `checkVendorRole` from `attachVendorProfileId` in Phase 3.

**Validation stays outside `createOrder()` too.** Phase 4's input validation (`!vendor_id || !items...`, per-item `typeof` checks) exists specifically to guard against **untrusted client input**. Reorder's `items` array never comes from a client body — it's reconstructed server-side from `order_items` rows that already passed a `CHECK (quantity > 0)` constraint and a valid foreign key when the original order was placed. Duplicating that validation inside `createOrder()` would be redundant for reorder and would blur the function's one job (running the transaction) — so it stays in `POST /orders`'s handler only.

**Refactored `POST /orders`** to call the shared function once its own validation passes:
```js
const orderResult = await createOrder(req.schoolProfileId, vendor_id, items);
return res.status(orderResult.status).json(orderResult);
```

---

## 6. Reorder Route Implementation

```js
app.post('/orders/:id/reorder', authenticateToken, checkSchoolRole, attachSchoolProfileId, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, school_id, vendor_id FROM orders WHERE id = $1 AND school_id = $2',
      [req.params.id, req.schoolProfileId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const oldOrder = result.rows[0];

    const itemsResult = await pool.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [oldOrder.id]
    );

    const orderResult = await createOrder(req.schoolProfileId, oldOrder.vendor_id, itemsResult.rows);
    return res.status(orderResult.status).json(orderResult);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while reordering.' });
  }
});
```

**Key realization confirmed during design:** `pg`'s query results are already keyed by column name — `SELECT product_id, quantity FROM order_items` returns rows shaped exactly as `{ product_id, quantity }`, which is precisely what `createOrder()`'s items loop expects. No reshaping/transformation step was needed between the DB query and the shared function.

**Structural invariant confirmed:** `createOrder()` is the *only* place in the app that inserts into `orders`, and both callers guarantee non-empty `items` before reaching it (`POST /orders` via its own length check; reorder because it pulls from an *existing* order, which by the same guarantee could never have been created with zero items). This makes "an order with zero line items" structurally impossible, not just assumed — the same kind of invariant-by-construction reasoning behind `price_at_order` and the atomic stock check in Phase 4.

---

## 7. Testing Performed (Automated Script — `backend/tests/phase6_test.js`)

Departed from Phase 3–5's Postman-only approach and built a dedicated Node test script, mirroring Phase 4's `race_test.js` pattern — plain `fetch()` calls against the locally running server, plus direct `pg.Pool` queries for DB-level verification (not just status codes).

**Setup:** logs in existing test accounts (`schoolA`, `schoolB`, `vendor1`), creates fresh test products, places one original order to use as the reorder template.

| # | Test | Result |
|---|---|---|
| 1 | No `Authorization` header | `401 Authorization token missing.` ✅ |
| 2 | Garbage token | `401 Invalid or expired token.` ✅ |
| 3 | Vendor token (wrong role) | `403 Wrong role selected` ✅ |
| 4 | Nonexistent order id | `404 Order not found.` ✅ |
| 6 | **Cross-school ownership** — School B reorders School A's order | `404 Order not found.` ✅ |
| 7/8 | **Happy path** — reorder own order, all items in stock | `201`; verified 2 correct line items, quantities matched original, `price_at_order` reflected **current** price ✅ |
| 9 | **Out-of-stock item on reorder** | `409 Insufficient stock for product <id>.` ✅ |
| 10 | **Partial-failure rollback** (item 1 in stock, item 2 not) | `409` on failing item; verified in DB that item 1's stock was **not** decremented — full rollback confirmed ✅ |
| 11 | **Price drift** — price raised after original order, then reordered | `201`; verified `price_at_order` on the new order reflected the **new**, raised price, not the original ✅ |
| 12 | Reordering a `canceled` order | `201` — confirms reorder doesn't care about the old order's status ✅ |
| 13 | Regression — fresh `POST /orders` still works post-refactor | `201` ✅ |
| 14 | Regression — insufficient stock on fresh `POST /orders` | `409` ✅ |

**Result: 18/18 checks passed**, including DB-level assertions (not just HTTP status codes) — confirming both the reorder logic and the `POST /orders` refactor behave correctly.

**One issue caught and fixed during setup:** the test script initially crashed with a `pg` SASL auth error (`client password must be a string`) because `dotenv` was loading zero environment variables — traced to running the script from `backend/tests/` while `.env` lives in `backend/`, so `dotenv.config()`'s default relative lookup missed it. Resolved by running from the `backend/` directory (matching how `race_test.js` is presumably run).

**Deliberately not tested this session:** malformed (non-UUID) order ids passed to `:id` routes — currently falls through to a generic `500`, since Postgres throws on invalid UUID syntax before any application-level check runs. Flagged as a pre-existing, project-wide gap (likely present in every `:id` route since Phase 3), not something Phase 6 introduced — worth a deliberate decision in a future session on whether to add UUID-format validation across all `:id` routes uniformly.

---

## Key Concepts Reinforced This Phase

- **Snapshot values apply to the transaction they were created in, not to templates derived from it** — `price_at_order`'s protection is scoped to one order's lifetime; a reorder is a new transaction and correctly gets fresh values.
- **Reusing existing validated logic beats rebuilding it** — the "hard problem" (atomic stock check, transaction safety) was already solved in Phase 4; Phase 6's job was routing new inputs into that same proven path, not reinventing it.
- **Shared logic extraction avoids silent drift** — pulling `createOrder()` out into one function used by two routes means a future bug fix only has to happen once, and both callers of a feature always stay in sync by construction, not by remembering to update both places.
- **Decoupling logic from HTTP response concerns** — a shared function should return data, not send responses; letting each caller decide the status code/message keeps the function reusable across different contexts.
- **Validation belongs at the trust boundary, not inside shared logic** — client-supplied data needs guarding against; server-reconstructed data (already validated once, at creation time) doesn't need the same checks repeated.
- **Invariants can be structural, not just assumed** — confirming that `createOrder()` is the sole insertion point for `orders` turns "no order should ever have zero items" from a hopeful assumption into a guaranteed property of the codebase.
- **Automated DB-level test verification catches more than status codes alone** — confirming `stock_quantity` truly stayed untouched after a rollback, or that `price_at_order` truly reflects the new price, requires querying the database directly, not just trusting an HTTP response.

---

## Open / Deferred Items (Carried Forward)

- **Malformed UUID handling on `:id` routes** — currently produces a generic `500` via an uncaught Postgres syntax error, across all routes taking a UUID `:id` param, not just reorder. Deliberate decision on whether/how to validate UUID format uniformly deferred to a future session.
- **Vendor-side order visibility** — still deferred from Phase 4/5; vendors still have no way to see orders placed *with* them.
- **`GET /orders/:id`** — single-order detail view, still deferred; Phase 6 deliberately avoided building it by keeping the old-order lookup internal to the reorder route.
- **`school_profiles` / `vendor_profiles`** — still missing `contact_number` and `address`, deferred since Phase 2.

---

## Phase 6 Status: ✅ Complete

- `POST /orders/:id/reorder` — ownership-checked (anti-enumeration `404`), reconstructs `items` from `order_items`, delegates to shared order-creation logic
- `createOrder(schoolId, vendorId, items)` extracted as single source of truth for order creation, used by both `POST /orders` and the new reorder route
- `POST /orders` refactored to use the shared function with zero behavioral change (confirmed via regression tests)
- All-or-nothing failure behavior on reorder confirmed to fall out naturally from the existing transaction design — no new stock-handling logic required
- Automated test script (`backend/tests/phase6_test.js`) covering auth, ownership, happy path, both rollback scenarios, price drift, terminal-state reordering, and `POST /orders` regressions — 18/18 passing, verified against real DB state
- Committed and pushed to `main` in two focused commits: feature (route + `createOrder()` extraction) and test script

**Next up: Phase 7 — Dashboard & Analytics (one solid chart: orders/month or top products)**
