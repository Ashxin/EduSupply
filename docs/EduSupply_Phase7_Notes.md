# EduSupply — Phase 7 Notes: Dashboard & Analytics (Backend)

## What Phase 7 Covered (This Session)

Building the data layer for the "one solid chart" deliverable — orders-per-month, reusable for both vendors and schools. This session covered scoping the chart concept, designing and implementing the query/route layer, testing it with an automated script, and a real debugging session that surfaced several process lessons. Frontend chart work was deliberately deferred (see below) after a bigger gap was discovered.

---

## 1. Scoping — Who Is This For, and Which Chart?

**Key decision — build one chart concept, reused by both roles**, rather than two unrelated dashboards. Orders-per-month works identically for both sides of the platform: a vendor sees "orders received per month," a school sees "orders placed per month" — same visual, same story, just whose orders.

**Chart type chosen: orders/month (time trend), over top products.** Reasoning:
- **Same query shape for both roles** — `COUNT(orders) GROUP BY month`, filtered by `WHERE vendor_id = $1` or `WHERE school_id = $1`. This mirrors the exact "same logic, different ownership column" pattern already proven in `GET /orders` (Phase 4).
- **Uses data already fully in place** — `orders.created_at` and `orders.status` require no new columns or tables. Top products (by revenue) would need a join through `order_items` → `products` and a `SUM(price_at_order * quantity)` — more moving parts for a first chart.
- **Reads naturally for both sides** without needing different framing per role.

---

## 2. Business Rule — Excluding Canceled Orders

**Decision: canceled orders do not count toward monthly totals.** Reasoning: this chart is meant to represent actual business activity — a canceled order is functionally a non-event, the same way Phase 5 treated `canceled` as a terminal state where nothing further happens. Counting it would inflate the trend with orders that never went anywhere. Cost of excluding it is trivial (`AND status != 'canceled'` in the `WHERE` clause), so there was no complexity tradeoff pushing toward inclusion.

**Time range: all-time**, every month with data — no fixed 6/12-month window. Since this is "every month that actually has data," there was no need to generate a zero-filled month series for gaps; the query only returns months with real activity.

---

## 3. Query Design

```sql
SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS order_count
FROM orders
WHERE <owner_column> = $1 AND status != 'canceled'
GROUP BY month
ORDER BY month ASC
```

**Key concepts worked through:**
- **`DATE_TRUNC('month', created_at)` vs. grouping by raw `created_at`** — grouping by the raw timestamp column would create a near-unique group per row (down to the millisecond), defeating the purpose of a monthly rollup. `DATE_TRUNC` collapses all timestamps within the same month to one representative value, so rows genuinely share a group.
- **`GROUP BY month` (the alias) is valid in Postgres** — Postgres resolves aliases used in `GROUP BY` against the `SELECT` list, so there's no need to repeat the full `DATE_TRUNC(...)` expression a second time. (Not all databases support this, but Postgres does.)
- **`ORDER BY month ASC` is required, not optional** — without an explicit `ORDER BY`, Postgres makes no guarantee about row order at all. For a trend chart meant to plot left-to-right, oldest to newest, ascending chronological order is essential, not a nicety.

---

## 4. Route Shape — Two Routes + Shared Helper

**Key decision, made by explicitly comparing it to two existing precedents:**
- **Option A:** one shared dual-role route with branching inside the handler (Phase 5's `PUT /orders/:id/status` pattern) — used when permissions differ on the *same* action against the *same* resource.
- **Option B:** two separate routes, each gated by existing single-role middleware, sharing a query helper underneath (Phase 6's `createOrder()` extraction pattern) — used when it's fundamentally the same query, just filtered by a different ownership column.

**Chose Option B.** This isn't a case of differing permissions on one resource — it's the same query shape reused per role, which is exactly what Phase 6's extraction pattern was built for.

**Route naming:** `GET /orders/monthly` (school) and `GET /vendor/orders/monthly` (vendor). `/orders/monthly` sits naturally next to the existing `/orders` namespace from Phase 4. Vendors don't have an existing `/orders`-rooted namespace, so `/vendor/orders/monthly` keeps ownership explicit and avoids any naming collision.

**Shared helper — `getMonthlyOrderCounts(ownerColumn, ownerId)`:**
```js
async function getMonthlyOrderCounts(ownerColumn, ownerId) {
  const result = await pool.query(
    `SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS order_count
     FROM orders
     WHERE ${ownerColumn} = $1 AND status != 'canceled'
     GROUP BY month
     ORDER BY month ASC`,
    [ownerId]
  );
  return result.rows;
}
```

**Important safety note on `${ownerColumn}` string interpolation:** column/table names can't be parameterized with `$1`-style placeholders in `pg` — only values can. Interpolating a string directly into SQL is normally a SQL-injection red flag, but it's safe here **only because** `ownerColumn` is always a hardcoded literal (`'vendor_id'` or `'school_id'`) written directly in route files — never derived from `req.body`, `req.params`, or any client input. Rule of thumb going forward: string-interpolated SQL is fine when the string is a constant your own code wrote, dangerous the moment it can trace back to a request.

**Both routes** reuse existing middleware chains directly — no new bridging logic needed, since this phase is purely a new *read* on top of infrastructure already built in Phases 3–4:
```js
app.get('/orders/monthly', authenticateToken, checkSchoolRole, attachSchoolProfileId, async (req, res) => {
  const monthlyCounts = await getMonthlyOrderCounts('school_id', req.schoolProfileId);
  res.status(200).json({ success: true, monthly_orders: monthlyCounts });
});

app.get('/vendor/orders/monthly', authenticateToken, checkVendorRole, attachVendorProfileId, async (req, res) => {
  const monthlyCounts = await getMonthlyOrderCounts('vendor_id', req.vendorProfileId);
  res.status(200).json({ success: true, monthly_orders: monthlyCounts });
});
```

`200`, not `201` — same reasoning as `GET /orders` in Phase 4: this retrieves existing data, creates nothing.

---

## 5. Testing — Automated Script (`backend/tests/phase7_test.js`)

Followed Phase 6's departure from Postman-only testing: `fetch()` for HTTP behavior, direct `pg.Pool` queries for independent DB-level verification (not just trusting status codes).

| # | Test | Result |
|---|---|---|
| 1 | No token | `401` ✅ |
| 2 | Garbage token | `401` ✅ |
| 3 | Vendor token on `/orders/monthly` | `403` ✅ |
| 4 | School token on `/vendor/orders/monthly` | `403` ✅ |
| 5 | School happy path | `200`; counts matched an independent DB query byte-for-byte ✅ |
| 6 | Vendor happy path | `200`; counts matched an independent DB query ✅ |
| 7 | Canceled order excluded | placed + canceled a fresh order; confirmed the month's count did **not** move ✅ |
| 8 | Chronological order | confirmed `ORDER BY month ASC` held across returned rows ✅ |

**Result: 10/10 checks passed.**

---

## 6. Debugging Session — What Actually Went Wrong (and the Process Lesson)

Every failure encountered this session traced back to **test-script mistakes or half-applied edits — not the design itself.** Worth documenting precisely, since the pattern is a lesson in its own right:

1. **Missing `role` field in the test's `login()` helper.** `/login` (Phase 1) requires `email`, `password`, *and* `role` — the test script's `login()` only sent two of the three, so every login attempt hit `400`, leaving `schoolToken`/`vendorToken` as `undefined`. This silently produced misleading downstream results (e.g. `401`s that looked like correct role-guard behavior for the wrong reason).
2. **Duplicate `const` declarations.** While adding debug logging, new `const schoolToken`/`const vendorToken`/`const schoolBody` lines were pasted in *alongside* the originals in the same scope — a `SyntaxError` in JS, since `const` can't be redeclared in the same scope. Caught by carefully re-reading the full file rather than guessing at another fix.
3. **Wrong password assumed.** `password123` (assumed from habit) wasn't correct for the existing test accounts — `Password123!` was. Since passwords are hashed and unrecoverable, this had to be discovered empirically (checking the DB confirmed the accounts and roles were correct, which narrowed the problem down to the one remaining unverifiable variable).
4. **`getMonthlyOrderCounts()` never actually added to `index.js`.** The two routes were pasted in, but the helper function itself was missed — confirmed via `ReferenceError: getMonthlyOrderCounts is not defined` in the server's own terminal output, not the test script's.

**Process lesson reinforced:** the *design* (shared helper, two thin routes, `DATE_TRUNC` + aliased `GROUP BY` + `ORDER BY`) worked correctly on the first real attempt once the code actually matched the plan. Every bug was either a test-harness issue or a partially-applied edit. Debugging strategy that worked: **check the server's own terminal for stack traces**, not just the test script's output — the `ReferenceError` that finally pinpointed the missing helper only appeared there, never in the test script's `console.log`s.

---

## 7. Frontend — Designed, Not Built

Design decisions made and worth carrying into the next session:
- **Charting library: Recharts.** Declarative, React-native API (JSX components, not imperative canvas config) fits the existing React/Next.js/TypeScript stack; right-sized for one chart versus D3's much lower-level power; more idiomatic for React than Chart.js's canvas-based imperative API.
- **Chart type: line chart** — better communicates trend/direction over time than a bar chart's discrete-category framing.
- **Route structure: two dedicated pages** — `/dashboard` (school) and `/vendor/dashboard` (vendor) — mirroring the backend's two-endpoint split, for the same reasoning as the backend decision (same concept, different ownership scope, not different permission logic on one resource).
- **Shared chart component** — a single `<MonthlyOrdersChart data={monthlyOrders} />` component used by both pages, following the same "extract shared logic, avoid drift" instinct as Phase 6's `createOrder()`.

**Blocking discovery:** inspecting the actual repository confirmed the frontend is still the **untouched Phase 0 scaffold** — `package.json` has only `next`, `react`, `react-dom`; no TanStack Query, no auth libraries; `src/app/` contains only the default `layout.tsx`/`page.tsx`. No login flow, no token storage, no authenticated API client exists yet, despite six backend phases having been built on top of the assumption that auth exists.

**Decision: stop here for this session.** Building a dashboard page requires frontend auth foundations first (login page, JWT storage, an authenticated fetch pattern) — this is realistically a frontend equivalent of Phase 1's scope, not a tail-end addition to Phase 7. It deserves the same deliberate, one-decision-at-a-time treatment Phase 1 got, in a fresh session.

---

## Key Concepts Reinforced This Phase

- **Reusing a proven filtering pattern** (`WHERE owner_column = $1`) across a new use case (analytics) rather than inventing a new access pattern — same instinct as Phase 4/6.
- **`DATE_TRUNC` for time-bucketed aggregation** — collapsing full-precision timestamps into a coarser grouping key is what makes `GROUP BY` meaningful for monthly rollups.
- **Postgres allows aliasing in `GROUP BY`/`ORDER BY`** — a Postgres-specific convenience worth knowing, though not universal across all SQL dialects.
- **String-interpolated SQL is only safe when the string is a hardcoded server-side constant** — never when it can trace back, directly or indirectly, to client input.
- **Two routes + shared helper vs. one dual-role route** — the deciding question is whether permissions differ on the *same* resource/action (→ one route, Phase 5-style) or whether it's the *same* logic reused across different ownership scopes (→ two routes + shared helper, Phase 6-style).
- **Check the server's own terminal, not just the test script's output, when debugging a `500`** — the actual stack trace (and the real root cause) often only surfaces there.
- **A string of failures is often one root cause wearing different masks** — nearly every symptom this session (misleading `401`s, a crash on `.map()`, a `500`) traced back to just a few underlying mistakes, found by working backward methodically rather than patching each symptom individually.
- **Discovering scope gaps mid-phase is normal and worth surfacing immediately** — better to pause and re-scope (frontend auth needed first) than to force a chart onto infrastructure that doesn't exist yet.

---

## Open / Deferred Items (Carried Forward)

- **Frontend auth foundations** — login page, JWT storage strategy, authenticated API client/fetch pattern. Blocks all frontend work, including this phase's chart. Next session's actual starting point.
- **Frontend dashboard pages** (`/dashboard`, `/vendor/dashboard`) and `<MonthlyOrdersChart>` component — designed (Recharts, line chart, shared component), not yet built.
- **Vendor-side order visibility** — still deferred from Phase 4/5; vendors still have no way to see individual orders placed *with* them (separate from the new monthly aggregate view).
- **`GET /orders/:id`** — single-order detail view, still deferred since Phase 4.
- **Malformed UUID handling on `:id` routes** — still an open, project-wide gap flagged in Phase 6.
- **`school_profiles` / `vendor_profiles`** — still missing `contact_number` and `address`, deferred since Phase 2.

---

## Phase 7 Status: 🟡 Backend Complete, Frontend Pending

- `GET /orders/monthly` (school) and `GET /vendor/orders/monthly` (vendor) — implemented, role-guarded, ownership-scoped via existing middleware
- `getMonthlyOrderCounts(ownerColumn, ownerId)` — shared query helper, single source of truth for both routes
- Canceled orders correctly excluded from totals; all-time range with no gap-filling needed
- `backend/tests/phase7_test.js` — 10/10 automated checks passing, including DB-independent verification
- Committed and pushed to `main` in two focused commits: missed Phase 6 docs, then Phase 7 backend feature + tests
- Frontend chart work fully designed (library, chart type, route structure, shared component) but blocked on frontend auth foundations, which don't yet exist anywhere in the codebase

**Next up: Frontend Auth Foundations (login flow, token storage, authenticated API client) — prerequisite for finishing Phase 7's dashboard pages, and for Phase 8 (Polish & Deploy) to make sense at all.**
