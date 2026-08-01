# EduSupply — Frontend Auth Foundations & Phase 7 Completion Notes

## What This Session Covered

Phase 7's backend was complete from a prior session, but the frontend was still the untouched Phase 0 scaffold — no login, no token storage, no authenticated API client, no route protection. This session built that foundation from scratch, then used it to finish Phase 7's originally-deferred dashboard pages and chart.

---

## 1. Token Storage — `localStorage`

**Decision: `localStorage`, key name `edusupply_token`.**

Considered three options:
- **HTTP-only cookie** — safer against XSS, but requires backend changes (setting cookies on login, `SameSite`/`Secure` config, CORS `credentials: true`) to support the cross-domain Vercel↔Railway split. Real infrastructure rework, not a frontend-only addition.
- **In-memory only (React state)** — most secure, but logs the user out on every refresh without a refresh-token system, which doesn't exist and wasn't judged worth building yet (YAGNI, same instinct as deferring `inventory` in Phase 2).
- **`localStorage`** — chosen. No backend changes needed (`/login` already returns the token in the JSON body). The 1-hour JWT expiry (set in Phase 1) does real security work here, capping the exposure window from `localStorage`'s XSS-readability.

**Key naming:** `edusupply_token` rather than a bare `token`, to avoid collisions with any other project sharing the same `localhost` origin during local dev.

---

## 2. `apiFetch` — Centralized API Wrapper

**Decision: a plain `fetch` wrapper function, not `axios`.**

Reasoning: no new dependency needed (`fetch` is native), and the actual requirement — attach an `Authorization` header, centralize 401 handling — doesn't need axios's interceptor machinery. TanStack Query doesn't care what fetcher is used underneath, so nothing is lost by skipping axios.

**Decision: `apiFetch` handles 401 redirects itself**, not the caller. Centralizing this avoids repeating the same check in every query/mutation, and nothing in EduSupply's current scope needs per-call override behavior — that's deferred until (if) a real use case appears.

`frontend/src/lib/api.ts`:
```typescript
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('edusupply_token');

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    localStorage.removeItem('edusupply_token');
    window.location.href = '/login';
    throw new ApiError(401, 'Session expired. Redirecting to login.');
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(response.status, data.error || 'Something went wrong.');
  }

  return data;
}
```

**Key design points:**
- Requires `NEXT_PUBLIC_API_URL` in `frontend/.env` (Next.js only exposes `NEXT_PUBLIC_`-prefixed vars to browser code).
- Throws after triggering the redirect on 401, since the redirect itself is non-blocking navigation — without the throw, calling code would try to read a response body that was never meaningfully fetched.
- Custom `ApiError` class (carrying `.status`) lets calling code distinguish failure types (e.g. 403 vs 500) instead of catching a generic `Error`.

---

## 3. Login Page

**Decision: plain client component with `useState`, no form library.** Same minimal-dependency instinct as the `apiFetch` decision — a two-field-plus-role-selector form doesn't need React Hook Form/Formik-level validation machinery, especially since the backend re-validates everything anyway.

**Decision: role-based redirect uses the form's own state, not the JWT payload.** The role was already known before the API call (the user selected it), so there was nothing to decode or infer from the response — `role === 'vendor' ? '/vendor/dashboard' : '/dashboard'` using the same `role` variable already in the request body.

`frontend/src/app/login/page.tsx` — client component, calls `apiFetch('/login', ...)`, stores the returned token under `edusupply_token`, redirects based on selected role. Deliberately unstyled (raw markup), since visual design decisions belong to the project owner, not to generated code.

**Bug encountered:** the file was initially never actually created on disk (`/login` 404'd) — a reminder that code shared in conversation must be explicitly saved into the project structure, not assumed to exist.

---

## 4. CORS — Missing Since Phase 0

**Bug found during first real browser test of `/login`:** the `cors` package was installed in Phase 0 (`npm install ... cors`) specifically to handle the frontend/backend port split, but was never actually required or wired into `backend/index.js`. This went undetected through Phases 1–7 because all prior testing used Postman, which isn't subject to browser CORS enforcement — this was the first time an actual browser made a request.

**Fix:**
```js
const cors = require('cors');
// ...
app.use(cors());
```

**Flagged for Phase 8:** `cors()` with no options allows any origin — fine for local dev, but should be locked to the deployed Vercel domain specifically before production.

---

## 5. Route Protection — `RequireAuth` + Layouts

**Decision: shared component enforced via Next.js layout files, not middleware.** Next.js `middleware.ts` runs server/edge-side and cannot read `localStorage` (a browser-only API) — using it would require mirroring the token into a cookie as well, maintaining two copies of the same value. Rejected as unnecessary complexity for a problem that doesn't currently exist (same YAGNI filter as the `apiFetch` override decision).

**Pattern:** one `<RequireAuth role="school">` / `<RequireAuth role="vendor">` component, reused by two route-segment layouts (`dashboard/layout.tsx`, `vendor/dashboard/layout.tsx`) — same "single source of truth, reused per scope" instinct as Phase 5's `validTransitions` and Phase 6's `createOrder()`.

**Decision: missing token, wrong-role token, and expired token all redirect to `/login`**, though for different underlying reasons:
- No token → not authenticated, straightforward.
- Wrong-role token → not authorized for this section specifically; a dedicated "unauthorized" page was considered but deferred as unnecessary scope for a case with no real-world trigger yet (nobody has reason to visit the other role's URL by anything but mistake).
- Expired token → not explicitly checked by `RequireAuth` (decoding a JWT doesn't validate `exp`); relies on the first real `apiFetch` call catching the resulting 401 instead, avoiding duplicated expiry-checking logic in two places.

`frontend/src/components/RequireAuth.tsx` uses `jwt-decode` (chosen over hand-rolled base64 decoding, since JWTs use URL-safe base64 which `atob()` doesn't handle correctly without extra fixup) to read the token's `role` claim and compare it against the expected role for that route segment.

**Tested and verified:**
- No token, direct navigation to `/dashboard` → redirected to `/login` ✅
- Vendor token, manually navigating to `/dashboard` (school route) → redirected to `/login` ✅
- Correct role, correct route → renders normally ✅

---

## 6. Phase 7 Frontend Completion — Dashboard Pages & Chart

**Prerequisite installs:** `@tanstack/react-query`, `recharts`, plus a root-level `QueryClientProvider`.

**`QueryProvider` as a dedicated client component**, rather than converting the whole root `layout.tsx` to `'use client'`:
```tsx
'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export default function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
```
`useState(() => new QueryClient())` specifically (not a bare `new QueryClient()`) — the lazy initializer ensures the client is created once on mount, not recreated (and cache wiped) on every re-render.

**Bug encountered:** `frontend/src/app/page.tsx` (the homepage) was found completely empty during this work, causing a "default export is not a React Component" runtime error on `/`. Root cause unclear (likely an earlier accidental overwrite), but decided this was a good moment to make a real choice rather than just restoring Vercel's template: **`/` now redirects to `/login`** via `next/navigation`'s `redirect()`, since EduSupply has no actual need for a marketing homepage — it's an internal tool where `/login` is the true entry point.

**Data-shape handling:** Postgres's `COUNT(*)` returns a string, not a number, and `DATE_TRUNC` returns a full ISO timestamp, not a chart-ready label. **Decision: transform this in the data-fetching hook, not the chart component** — same separation-of-concerns instinct as `createOrder()`, keeping the chart component "dumb" (renders whatever clean data it's given) and reusable.

**Decision: two separate hooks (`useSchoolMonthlyOrders`, `useVendorMonthlyOrders`) sharing a `transformRows()` helper**, rather than one parameterized hook — mirrors the backend's own Phase 7 decision (two routes + shared query helper, since it's the same shape reused across different ownership scopes, not differing permissions on one resource).

`frontend/src/hooks/useMonthlyOrders.ts` — both hooks use distinct TanStack Query cache keys (`['monthlyOrders', 'school']` / `['monthlyOrders', 'vendor']`) so their cached data never collides.

`frontend/src/components/MonthlyOrdersChart.tsx` — shared Recharts `LineChart`, used by both dashboard pages. `allowDecimals={false}` on the Y-axis (order counts are always whole numbers). Explicit empty-state handling (`"No order data yet."`) for accounts with zero orders, since Phase 7's backend query only returns months with actual data — a fresh account gets back an empty array, which Recharts doesn't render meaningfully on its own.

Dashboard pages (`frontend/src/app/dashboard/page.tsx`, `frontend/src/app/vendor/dashboard/page.tsx`) — thin client components: call their respective hook, handle loading/error states, render `<MonthlyOrdersChart>`.

---

## 7. Testing Performed (Manual, Browser + DevTools)

| # | Test | Result |
|---|---|---|
| 1 | Login, school role, correct credentials | Redirected to `/dashboard`, `edusupply_token` present in `localStorage` ✅ |
| 2 | Login, vendor role, correct credentials | Redirected to `/vendor/dashboard`, token present ✅ |
| 3 | Route guard: no token, direct nav to `/dashboard` | Redirected to `/login` ✅ |
| 4 | Route guard: vendor token, direct nav to `/dashboard` (wrong role) | Redirected to `/login` ✅ |
| 5 | Route guard: correct role, correct route | Placeholder/real page rendered normally ✅ |
| 6 | School dashboard, account with existing orders | Chart rendered with correct data point(s), tooltip functional ✅ |
| 7 | Vendor dashboard, different account with existing orders | Chart rendered with correct, distinct data — confirmed hitting `/vendor/orders/monthly`, not the school endpoint ✅ |
| 8 | School dashboard, brand-new zero-order account | `"No order data yet."` rendered cleanly, no crash ✅ |
| 9 | Vendor dashboard, brand-new zero-order account | Same clean empty-state rendering ✅ |

**Bugs found and fixed this session:**
- Missing `cors()` middleware (installed since Phase 0, never wired in) — caused all browser-based `/login` requests to fail with a CORS preflight error; invisible in prior Postman-only testing.
- Login page file never actually created on disk despite being shared in conversation — `/login` 404'd until the file was physically saved at the correct path.
- `frontend/src/app/page.tsx` found completely empty, causing a runtime crash on `/` — resolved by converting it into a redirect to `/login`.
- Root `layout.tsx` briefly missing its font-variable `className` on `<body>` after edits — restored.

---

## Key Concepts Reinforced This Session

- **Matching frontend architecture decisions to backend precedents already set** — two hooks + shared transform (mirroring Phase 7's two routes + shared query helper), `RequireAuth` reused across layouts (mirroring `validTransitions`/`createOrder()`'s single-source-of-truth pattern).
- **YAGNI applied to frontend infrastructure choices** — `localStorage` over cookie+refresh-token complexity, no `apiFetch` override option, no dedicated "unauthorized" page, layout-based guards over middleware — each deferred until a real need appears, not built speculatively.
- **Postman vs. real browser testing surface different bugs** — the CORS gap existed since Phase 0 but was invisible until an actual browser (subject to CORS enforcement) made the request.
- **Data transformation belongs at the boundary, not inside presentation components** — Postgres's raw response shape (stringified counts, ISO timestamps) gets cleaned in the data-fetching hook, keeping the chart component agnostic to where its data came from.
- **A file existing in conversation isn't the same as a file existing on disk** — a recurring source of confusion this session, resolved by explicitly confirming file paths and contents rather than assuming.

---

## Open / Deferred Items (Carried Forward)

- **`app.listen(5000, ...)` hardcoded** — must switch to `process.env.PORT` before Railway deployment (Phase 8 blocker).
- **`cors()` currently unrestricted** — should be locked to the production Vercel domain before deploy.
- **Styling** — entirely deferred to the project owner; all frontend markup currently unstyled by design.
- **`contact_number` / `address` on `school_profiles` / `vendor_profiles`** — deferred since Phase 2.
- **Malformed UUID handling on `:id` routes** — deferred since Phase 6.
- **Vendor-side individual order visibility** (as opposed to the new aggregate monthly view) — deferred since Phase 4/5.
- **`GET /orders/:id`** — single-order detail view, deferred since Phase 4.

---

## Status: ✅ Complete

- Frontend auth foundations fully built and tested: login flow, `localStorage` token storage, centralized `apiFetch` client with 401 handling, `RequireAuth` route guards via layouts.
- Phase 7 fully closed out: backend (prior session) + frontend dashboard pages and shared chart component (this session), tested against both real and empty data for both roles.
- Four bugs found and fixed live during the session (CORS, missing login file, empty homepage file, missing font className).

**Next up: Phase 8 — Polish & Deploy (Vercel + Railway, env vars in production, `PORT` fix, CORS lockdown, final smoke tests).**
