# EduSupply — Phase 5 Notes: Order Status Pipeline

## What Phase 5 Covered

Designing and implementing a proper state machine for `orders.status` — which had been sitting as an unconstrained `VARCHAR(255)` since Phase 2, deliberately deferred until now. This phase covered choosing the actual set of valid states, mapping legal transitions between them, enforcing that map at both the database and application layers, and building the single shared route (`PUT /orders/:id/status`) that lets both vendors and schools update status with different permission levels.

---

## 1. Narrowing Down the States

**Started with a broad, realistic-sounding list** of 9 candidate states (New/Pending, Accepted, In Progress, Shipped/Dispatched, Delivered/Completed, Canceled, On Hold, Returned/Refunded, Disputed/Problematic) — the kind of list you'd sketch out thinking about a vendor's real-world order lifecycle.

**Key filter applied to every candidate — does the app actually have any feature that could cause or represent this transition?** EduSupply currently has no shipping/logistics tracking, no payment processing, and no in-app messaging/dispute system. Walking through each state against that constraint:

- **Shipped/Dispatched** — no tracking system to back it up; indistinguishable from "In Progress" without one → cut
- **On Hold** — no "flag a problem" feature exists → cut
- **Returned/Refunded** — no payment processing exists to make a refund real → cut
- **Disputed/Problematic** — no messaging/dispute system; all communication happens outside the platform → cut

**Final 5 states, each backed by a real feature/action:**
- `pending` — order just placed (automatic, at creation)
- `accepted` — vendor reviewed and accepted
- `in_progress` — vendor actively fulfilling
- `completed` — vendor marks fulfillment done
- `canceled` — vendor or school backs out

**Principle reinforced:** a status should represent something your system can actually *know* is true, not just a real-world business concept that sounds plausible. A state with no feature behind it is just a label that will drift from reality.

---

## 2. Designing the Transition Map

Worked through legal transitions one concrete scenario at a time rather than guessing at the whole map upfront:

- Confirmed `pending` cannot jump straight to `completed` — must pass through `accepted` and `in_progress` first
- Confirmed `canceled` becomes illegal once an order reaches `completed` (that's what a future returns/refund system would handle, not this one)
- Confirmed `canceled` also becomes illegal once `in_progress` — too late to back out once the vendor is actively fulfilling

**Final map:**
```js
const validTransitions = {
  pending: ['accepted', 'canceled'],
  accepted: ['in_progress', 'canceled'],
  in_progress: ['completed'],
  completed: [],
  canceled: []
};
```
`completed` and `canceled` are terminal — empty arrays, nothing can follow them.

---

## 3. Two-Layer Enforcement — Database vs. Application

**Core question worked through:** can a `CHECK` constraint enforce *transitions* (e.g., "you can go from `accepted` to `in_progress`, but not from `completed` to `pending`")?

**Answer: no.** A `CHECK` constraint only validates a single row's value in isolation — it has no concept of "what was the value before this update." Comparing old vs. new state requires application logic.

**Resulting division of labor:**
1. **Database (`CHECK` constraint)** — guarantees `status` is always one of the 5 valid strings, catching typos or garbage values no matter what code path writes to the row.
2. **Application code (route handler)** — enforces the actual transition rules, since only application logic can compare "current status" against "requested status."

**Constraint applied via `ALTER TABLE`** (not a fresh `CREATE TABLE`, since `orders` already existed):
```sql
ALTER TABLE orders
ADD CONSTRAINT orders_status_check
CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'canceled'));
```
Verified live via `\d orders` — confirmed under "Check constraints," with Postgres internally rewriting the `IN (...)` into an `= ANY (ARRAY[...])` form (functionally identical).

**Pre-migration safety check:** ran `SELECT DISTINCT status FROM orders;` before relying on the constraint, to confirm no pre-existing row had a status value outside the 5 valid strings (all existing rows were `'pending'` — clean).

---

## 4. Route Design — Who Can Call This, and How

**Key decision — one shared route vs. two separate routes.** Reasoned through by asking: is the transition map itself different depending on who's calling, or is it the same map with different permission levels layered on top? Concluded it's **one map, with schools getting a restricted view of which edges they're allowed to trigger** — not two fundamentally different maps. That pointed to a single shared route: `PUT /orders/:id/status`.

**Permission split, worked through scenario by scenario:**
- **Vendor** can trigger: `accepted`, `in_progress`, `completed`, `canceled` — all forward progress plus cancellation, since they own fulfillment
- **School** can trigger: `canceled` only — bilateral cancellation makes sense (a school should be able to back out early), but forward progress is the vendor's call alone

**Key middleware decision — neither `checkVendorRole` nor `checkSchoolRole` belongs in this route's chain.** Both existing middleware functions reject any role that doesn't match exactly one value — but this route needs to admit *both* roles and differentiate behavior internally. Using either would lock out one legitimate caller entirely. Resolved: only `authenticateToken` sits in the middleware chain; role branching and profile-ID bridging (`vendorProfileId`/`schoolProfileId`) happen **inside the handler**, after inspecting `req.user.role` — since the bridging itself depends on which role is calling, it can't be a fixed middleware step like Phase 3/4's single-role routes.

---

## 5. Route Implementation (`PUT /orders/:id/status`)

**Request body shape:** `{ "status": "in_progress" }` — matches the column name convention used in Phase 3.

**Flow:**
1. Validate `newStatus` exists in the body → `400` if missing
2. `SELECT status, vendor_id, school_id FROM orders WHERE id = $1` — fetch the order; zero rows → `404 Order not found.`
3. Branch on `req.user.role`:
   - **`vendor`:** bridge `vendorProfileId` (same pattern as Phase 3's `attachVendorProfileId`, done inline here since it's role-conditional) → ownership check (`order.vendor_id !== req.vendorProfileId` → `404`, anti-enumeration, same reasoning as Phase 3's product ownership checks) → transition check (`!validTransitions[order.status].includes(newStatus)` → `400`)
   - **`school`:** bridge `schoolProfileId` → ownership check (`order.school_id !== req.schoolProfileId` → `404`) → restriction check (`newStatus !== 'canceled'` → `403`, chosen over `404` since the school *does* own the order and already knows it exists — no enumeration risk in confirming an action is forbidden) → transition check (same as vendor branch)
   - **`else` (unreachable given current signup validation, kept defensively):** `500 Unrecognized user role.` — chosen specifically because leaving this branch out entirely would mean a request silently never gets a response (hangs until client timeout) rather than failing loudly with a debuggable error
4. `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *` — single-table write, no transaction wrapper needed (unlike Phase 4's multi-table `POST /orders`, this route only ever writes to one table)

**Key realization during design — the school's transition check isn't redundant with its restriction check.** Even though schools can only ever *request* `'canceled'`, that alone doesn't make cancellation valid — an order sitting at `in_progress` or `completed` has `canceled` completely absent from its allowed-next list. The restriction check alone would incorrectly let a school "cancel" an order that's already too far along; the transition check catches that gap.

---

## 6. Bugs Caught & Fixed During Implementation

- **Variable name collisions** — reused `result`/`orderId` as variable names for different queries within the same `try` block scope (order lookup vs. vendor profile lookup vs. final update); each caught via `const` redeclaration errors and renamed (`vendorCheck`, `schoolCheck`, `newOrderStatus`) to avoid shadowing.
- **Dead code after early `return`** — placeholder `return` statements written before their supporting logic (e.g., a `return res.status(400)...` sitting before the `req.vendorProfileId = ...` assignment it was meant to follow) made the assignment line unreachable. Caught by tracing execution order line by line.
- **Misplaced bracket scoping** — a fallback `else { 'Invalid Credentials' }` originally nested inside the school branch's zero-row check, instead of being the outer role-branch's final `else`. Would have rejected every legitimate school request. Fixed by carefully counting braces and re-deriving intended nesting.
- **Inverted transition logic** — initially wrote `if (validTransitions[order.status].includes(newStatus))` without the negation, which would reject every *legal* transition and silently allow every illegal one. Caught by walking through what `.includes()` returning `true` actually means for the intended behavior.
- **Stray leading space in a SQL string literal** — `' canceled'` vs `'canceled'` in the first draft of the `CHECK` constraint; would have made the constraint reject the real, correctly-written value used in the application code. Caught before running by comparing characters directly.
- **`!=` vs `!==`** — briefly used loose inequality in the vendor ownership check; corrected to strict, matching the strict-equality convention used everywhere else in the project.
- **Generic/misleading error messages** — several first-draft messages named the wrong entity (`'Product not found.'` copy-pasted into an orders route, `'Invalid Vendor'` used for what was actually a transition error) or were too vague to debug (`'Request failed.'`, `'Invalid Status'`). Each corrected to name the actual failure precisely, matching the specificity convention set in Phase 1–4 (e.g. `'Incomplete fields'`, `'Invalid items'`).

---

## 7. Testing Performed (Postman + psql, manual)

Test accounts: `vendor1@test.com` (Vendor1), `vendor2@test.com` (Vendor2), `schoolA@test.com` (School A), `schoolB@test.com` (School B) — signed up, logged in, tokens captured per account.

**Auth & basic validation:**

| # | Test | Result |
|---|---|---|
| 1 | No `Authorization` header | `401 Authorization token missing.` ✅ |
| 2 | Invalid/garbage token | `401 Invalid or expired token.` ✅ |
| 3 | Missing `status` in body | `400 Status is required.` ✅ |
| 4 | Empty body / no `Content-Type` | `400 Status is required.` ✅ — confirms `req.body \|\| {}` guard |
| 5 | Nonexistent order id | `404 Order not found.` ✅ |

**Vendor — ownership & transitions:**

| # | Test | Result |
|---|---|---|
| 6 | Vendor2 updates Vendor1's order | `404 Order not Found.` ✅ — cross-ownership blocked |
| 7 | Vendor1 updates own order, `pending → accepted` | `200` ✅ |
| 8 | `pending → completed` (skip steps) | `400 Invalid status transition.` ✅ |
| 9 | `pending → in_progress` (skip `accepted`) | `400 Invalid status transition.` ✅ |
| 10 | `accepted → in_progress` | `200` ✅ |
| 11 | `in_progress → completed` | `200` ✅ |
| 12 | `completed → canceled` (terminal state) | `400 Invalid status transition.` ✅ |
| 13 | `canceled → accepted` (terminal state) | `400 Invalid status transition.` ✅ |
| 14 | Garbage status string (`"shipped"`) | `400 Invalid status transition.` ✅ |

**School — ownership, restriction, and transitions:**

| # | Test | Result |
|---|---|---|
| 15 | School B updates School A's order | `404 Order not Found.` ✅ |
| 16 | School A sends `status: "accepted"` on own `pending` order | `403 Schools can only cancel orders.` ✅ |
| 17 | School A sends `status: "in_progress"` | `403 Schools can only cancel orders.` ✅ |
| 18 | School A cancels own `pending` order | `200` ✅ |
| 19 | School A cancels own `accepted` order | `200` ✅ |

**Full vendor lifecycle proven end-to-end** on a single order: `pending → accepted → in_progress → completed`, with `completed` correctly refusing any further transition.

**Deferred (not executed this session, logic already proven via shared code path):**
- Test 20 — school attempts to cancel an `in_progress` order (passes `403` check since `canceled` was requested, should fail at transition check)
- Test 21 — school attempts to cancel a `completed` order (same expected failure path)

Both rely on the exact same `validTransitions` check already proven correct in vendor tests 12–13 and school test 16–17's sibling logic — low risk, can be verified in a future session if desired.

**Database-level safety net** — not executed this session (`UPDATE orders SET status = 'shipped' ...` direct psql bypass attempt) — worth running once as a sanity check that `orders_status_check` independently rejects invalid values even if application logic were ever bypassed.

**Session-level note:** hit two expired-JWT `401`s mid-testing (tokens issued more than `1h` earlier) — expected behavior per Phase 1's `expiresIn: '1h'` setting, resolved by re-logging in for fresh tokens, not a bug.

---

## Key Concepts Reinforced This Phase

- **A status/state should map to something the system can actually know is true** — not just a plausible real-world business concept. No backing feature means no reliable way to set or trust that state.
- **`CHECK` constraints validate values in isolation, not transitions** — enforcing "is this a legal move from the current state" requires comparing old vs. new, which only application code can do (the DB constraint has no memory of the previous value).
- **Two-layer enforcement is complementary, not redundant** — the database guarantees data integrity (always a valid string), the application guarantees process integrity (only legal transitions) — neither layer alone covers both jobs.
- **Same map, different permission levels** — rather than building two separate routes with duplicated transition logic, one shared route with a single `validTransitions` source of truth, gated by role-based permission checks, avoids drift between two copies of the same rule.
- **Anti-enumeration status codes must fit the actual scenario** — `404` when the caller has no legitimate claim to know the resource exists (cross-vendor/cross-school ownership mismatches); `403` when the caller already owns the resource and the response can't leak anything new (the school-restriction case).
- **A "redundant-looking" check can still catch real gaps** — the school's transition check looked unnecessary next to the `canceled`-only restriction, until walking through the concrete case of an `in_progress`/`completed` order proved the restriction check alone wasn't sufficient.
- **Leaving no fallback branch isn't "safe," it's a silent hang** — an unreachable `else` case still deserves a defensive response; skipping it entirely means a future edge case could leave a request hanging until client timeout instead of failing with a debuggable error.
- **Middleware must admit every legitimate caller** — reusing single-role middleware (`checkVendorRole`/`checkSchoolRole`) on a dual-role route would silently lock out half of its legitimate users; role branching belongs inside the handler when the route's very purpose is to serve multiple roles differently.

---

## Open / Deferred Items (Carried Forward)

- Tests 20–21 (school attempting to cancel an `in_progress`/`completed` order) — logic already covered by the shared `validTransitions` check, worth a quick confirmation pass in a future session.
- Direct psql bypass test of the `orders_status_check` constraint — not yet executed, low-risk confirmation that the DB-level safety net independently holds.
- **Vendor-side order visibility** — still deferred from Phase 4; vendors currently have no `GET /orders`-equivalent to see orders placed *with* them, which will matter more now that vendors are expected to actively drive status transitions.
- **`GET /orders/:id`** — single-order detail view, still deferred from Phase 4.
- `school_profiles` / `vendor_profiles` — still missing `contact_number` and `address`, deferred since Phase 2.

---

## Phase 5 Status: ✅ Complete

- 5 valid order states finalized, each backed by an actual feature (no speculative/unsupported statuses)
- `orders_status_check` `CHECK` constraint live via `ALTER TABLE`, verified in `\d orders`, pre-migration data confirmed clean
- `validTransitions` object as single source of truth for the state machine, referenced by both vendor and school logic paths
- `PUT /orders/:id/status` — single shared route, role-based permission layering, ownership checks, restriction checks, and transition checks for both vendors and schools
- 19 of 21 planned test cases executed and passing (auth, validation, ownership, terminal-state locks, garbage-input rejection, full vendor lifecycle, school restriction + cancellation); 2 remaining cases deferred with low risk given shared code path already proven
- Multiple design and implementation bugs caught and corrected collaboratively during build (variable collisions, dead code, bracket scoping, inverted logic, message accuracy)

**Next up: Phase 6 — Reorder Shortcut (clone a past order)**
