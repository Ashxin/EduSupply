# EduSupply — Phase 1 Notes: Auth & Roles

## What Phase 1 Covered
Designing the database schema for users and role-specific profiles, then building signup, login, and JWT-based route protection — each reasoned through deliberately and verified working before moving forward.

---

## 1. Database Setup

**Confirmed local Postgres install working**, then created a dedicated project database:
```sql
CREATE DATABASE edusupply;
```

**Note on case sensitivity:** Postgres automatically lowercases unquoted identifiers. `CREATE DATABASE eduSupply;` (no quotes) silently becomes `edusupply`. To preserve exact casing you'd need `CREATE DATABASE "eduSupply";` — but then every future reference needs quotes too. Decided lowercase (`edusupply`) was simpler and consistent enough.

**Key psql habit:** Every SQL statement needs a trailing `;` — psql buffers input and won't execute until it sees one. Forgetting it and retyping the command causes the buffered fragments to concatenate into a broken statement (seen firsthand: `CREATE DATABASE edusupply CREATE DATABASE edusupply;` → syntax error). Typing `;` alone flushes a stuck buffer.

---

## 2. Schema Design Decisions

**Core question: one shared `users` table, or separate `schools`/`vendors` tables?**

Started leaning toward separate tables, but working through the **login flow** exposed the problem: at login time (just email + password), the backend doesn't yet know which table to query. Considered options — searching both tables, or having the user select their role upfront on the login form. Chose **role selection on the login form**.

That raised a follow-up: should `email` be unique only *within* each table, or globally unique across both? Realized Postgres can't enforce a `UNIQUE` constraint *across* two separate tables natively — doing so with two tables would require extra machinery (a shared lookup table, or app-level checks). This tradeoff was the deciding factor to pivot to a **single shared `users` table** for auth fields, with **separate profile tables** for role-specific data — sometimes called the "class table inheritance" pattern.

**Final schema:**

**`users`** — shared, lean, one row per account:
- `id` — UUID, primary key, `DEFAULT gen_random_uuid()`
- `email` — `UNIQUE`, `NOT NULL`
- `password_hash` — `NOT NULL`
- `role` — `NOT NULL` (`'school'` or `'vendor'`)
- `created_at` — `DEFAULT now()`

**`school_profiles`** — role-specific data for schools:
- `id` — UUID, primary key
- `user_id` — UUID, `UNIQUE`, `NOT NULL`, `REFERENCES users(id)`
- `institution_name` — `NOT NULL`
- `created_at`

**`vendor_profiles`** — role-specific data for vendors:
- `id` — UUID, primary key
- `user_id` — UUID, `UNIQUE`, `NOT NULL`, `REFERENCES users(id)`
- `business_name` — `NOT NULL`
- `created_at`

**Why `UNIQUE` on `user_id`:** without it, nothing would stop two profile rows from accidentally pointing at the same user — breaking the intended one-to-one relationship.

**Why UUID over `SERIAL`:** sequential integer IDs leak information (competitor could guess `/orders/42` exists by counting up) and are less safe to expose in URLs. UUIDs avoid that, at the cost of being bulkier/less human-readable — an acceptable tradeoff for a platform where user/order IDs may appear in shared URLs.

**UUID generation — database vs. backend:** chose to let **Postgres auto-generate UUIDs** via the `pgcrypto` extension (`gen_random_uuid()`) rather than generating them in Express. Reasoning: keeps ID generation consistent regardless of which code path inserts a row (API, direct psql, future services), rather than relying on every insert path in application code to remember to generate one.

**Schema saved and version-controlled** at `backend/db/schema.sql`, containing the `CREATE EXTENSION IF NOT EXISTS pgcrypto;` line plus all three `CREATE TABLE` statements — so the database can be rebuilt from scratch on any machine (including eventually Railway) without retyping commands in psql.

---

## 3. Environment & Connection Setup

**`.env` placement:** initially had an empty `.env` at the project root. Corrected to **per-folder `.env` files** (`frontend/.env`, `backend/.env`) — matching the independent Vercel/Railway deployment split established in Phase 0. A root-level `.env` wouldn't be visible to a backend deployed from just the `backend/` subfolder.

**`backend/.env` contents:** `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME`, and later `JWT_SECRET` (a long random string generated via `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`, never a guessable string).

**Verified gitignore coverage:** confirmed via `git status` that `backend/.env` never appears as trackable — the root `.gitignore`'s `.env` rule (no leading slash) correctly matches `.env` in any subfolder, not just at root.

**Connection pool (`backend/db/index.js`):** built using `pg.Pool` rather than a single `Client`. Reasoning: a single client holds one connection open the whole time and doesn't scale — concurrent requests would contend for it. A pool manages multiple reusable connections, handing one out per request automatically.

```js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

module.exports = pool;
```

**`dotenv.config()` placement:** moved to the very top of `backend/index.js` (the main entry file) as the single source of truth for loading environment variables, rather than relying on it being called only inside `db/index.js`. Calling it in both places is harmless (idempotent) but redundant.

**Verified live** via a temporary `GET /test-db` route running `SELECT NOW()` through the pool — confirmed a real timestamp came back, then removed the route once verified (same "verify before building on top of it" discipline as Phase 0's scaffold checks).

---

## 4. Signup Route (`POST /signup`)

**Planned flow (in order):** parse body → validate required fields/role/role-specific field → check for existing user → hash password → insert into `users` + insert into profile table → respond.

**Key decision — transactions:** Since signup requires **two separate inserts** (`users`, then `school_profiles`/`vendor_profiles`), a failure between the two would leave an orphaned `users` row with no profile. Solved with a **database transaction**: `BEGIN` → both inserts → `COMMIT` if both succeed, or `ROLLBACK` if anything fails — ensuring both writes succeed together or neither happens at all (same principle as an atomic bank transfer).

**Practical requirement:** all statements in a transaction must run on the *same* connection — so signup uses `pool.connect()` to reserve one specific client for the whole request, rather than `pool.query()` (which grabs any available connection per call). The reserved client is released back to the pool in a `finally` block regardless of success or failure.

**Key decision — duplicate email check: query-first vs. rely on the DB constraint.** Two options considered:
- **Option A:** explicitly `SELECT` for an existing email before inserting, return a clean `409` if found.
- **Option B:** skip the check, attempt the insert directly, and catch Postgres's unique-constraint violation (error code `23505`) in the `catch` block.

Option B is technically fewer database round-trips, but requires the error handler to specifically detect and interpret a Postgres-specific error code — judged to add back the complexity it was trying to save. **Chose Option A** — explicit check first, clearer and more maintainable, worth the extra query.

**Password hashing:** `bcrypt.hash(password, 10)` — salt rounds of `10` is the standard default balancing security and performance. `bcrypt` operations are asynchronous (return Promises), handled with `async/await` since every step in signup depends sequentially on the previous one's actual result (can't insert a hash that isn't computed yet).

**Parameterized queries:** all queries use `$1, $2, $3` placeholders rather than string-concatenating user input — a critical defense against SQL injection, not just a style choice.

**Response shape:** `201 Created` with `{ success: true, user: { id, email, role } }` — deliberately excludes `password_hash` from the response.

**Tested and verified (via Postman + direct psql inspection):**
- Valid school signup → `201`, row confirmed in both `users` and `school_profiles`, matching `created_at` timestamps confirming atomic transaction behavior
- `password_hash` confirmed in psql as a genuine bcrypt hash (`$2b$10$...`), never plaintext
- Duplicate email → `409 "A user with this email already exists."`
- Vendor missing `business_name` → `400` validation error
- Invalid role (e.g. `"admin"`) → `400` validation error

---

## 5. Login Route (`POST /login`)

**Key correction during design:** initially considered querying `schools`/`vendors` tables directly — caught and corrected back to the actual schema: login queries the single `users` table (which holds `email`, `password_hash`, `role`), not separate role tables.

**Key decision — filter by `email` alone, or `email` AND `role` together?** Chose to filter by both. Important nuance worked through: this is **not** primarily a security measure (the password is what actually proves identity, regardless of which role field matches) — it's about **error message clarity**, letting the login flow confirm "no account with this role/email combination" rather than a vague mismatch.

**Key decision — how specific should the error message be?** Considered returning a specific reason (wrong email vs. wrong role vs. wrong password) for a clearer user experience, but recognized this creates an **account enumeration risk** — a specific "no school account with this email" message would confirm to an attacker that the email exists under a different role, without ever needing the password. **Chose a single generic `401 "Invalid credentials."` message** for every failure case (missing user, wrong role, wrong password) — standard practice for production auth systems, prioritizing security over friendliness.

**Password verification:** `bcrypt.compare(password, user.password_hash)` — bcrypt hashes are one-way; you can't "un-hash" a stored password. Instead, `compare()` re-hashes the submitted plaintext password and checks if the result matches the stored hash.

**JWT issuance on success:**
```js
const token = jwt.sign(
  { id: user.id, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);
```

**Key decision — what goes in the JWT payload?** Worked through the core JWT property first: a JWT is *signed* (tamper-proof) but **not encrypted** — anyone holding the token can decode and read its payload in plain text. This ruled out including the password (even hashed) in the payload, since that would expose the hash to anyone who intercepts the token. Landed on the minimum necessary: **`id` and `role` only** — enough for future requests to identify the user and check permissions, without exposing anything sensitive. `id` being a UUID (not sequential) makes it safe to expose this way.

**`expiresIn: '1h'`:** tokens automatically become invalid after 1 hour, limiting the damage window if a token is ever stolen.

**Tested and verified:**
- Valid login → `200`, real JWT returned
- Wrong password → `401 "Invalid credentials."`
- Correct email/password but wrong role selected → `401 "Invalid credentials."` (same message, no leak)
- Nonexistent email → `401 "Invalid credentials."` (same message, no leak)
- Confirmed via jwt.io that the payload is human-readable (contains `id`, `role`, `iat`, `exp`) despite being cryptographically signed — demonstrating "readable but tamper-proof" concretely

---

## 6. JWT Authentication Middleware

**Purpose:** protect future routes by requiring a valid JWT, extracted from the `Authorization` header in `Bearer <token>` format — the standard convention for sending bearer tokens.

```js
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authorization token missing.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    req.user = decoded;
    next();
  });
}
```

**Key mechanics:**
- `authHeader && authHeader.split(' ')[1]` — short-circuit guard; if the header is missing entirely (`undefined`), avoids crashing on `.split()` of `undefined`.
- `jwt.verify()` checks both the token's signature (proving it was issued by this server, unmodified) and its expiry in one call.
- `next()` is called **only** on success — this is what actually allows the request to proceed to the real route handler. Skipping `next()` in the error branches is what blocks unauthorized requests from ever reaching protected logic.
- On success, decoded payload (`{ id, role }`) is attached to `req.user` — a conventional (not built-in) property name — so downstream route handlers can access the authenticated user's identity without re-verifying anything themselves.

**Usage pattern:** `app.get(path, authenticateToken, routeHandler)` — Express chains middleware and handler; the handler only runs if the middleware calls `next()`.

**Tested and verified** via a temporary `/protected-test` route (removed after verification, same pattern as `/test-db`):
- No `Authorization` header → `401 "Authorization token missing."`
- Fake/garbage token → `401 "Invalid or expired token."`
- Valid real token (from actual login) → `200`, with `req.user` correctly showing `id`, `role`, `iat`, `exp` exactly as encoded at login

---

## Key Concepts Reinforced This Phase

- **Database transactions** (`BEGIN`/`COMMIT`/`ROLLBACK`) for atomic multi-table writes — same principle as an all-or-nothing bank transfer
- **`async/await`** for sequential operations that each depend on the previous step's actual result (password hash → insert → token)
- **Parameterized SQL queries** (`$1, $2...`) as a security requirement, not a style choice
- **JWTs are signed, not encrypted** — readable by anyone holding them, but tamper-proof; payload should never contain sensitive data
- **Account enumeration risk** — specific error messages can inadvertently leak which accounts exist; generic messages are safer for public-facing auth endpoints
- **Express middleware pattern** — `(req, res, next)`, where skipping `next()` is what enforces a blocked request

---

## Phase 1 Status: ✅ Complete

- Schema designed (shared `users` + `school_profiles`/`vendor_profiles`), created, and version-controlled at `backend/db/schema.sql`
- Per-folder `.env` setup confirmed gitignored, `JWT_SECRET` generated and stored
- Postgres connection pool (`pg.Pool`) built and verified live
- `/signup` — validated, transaction-safe, tested against all success/failure paths
- `/login` — role-verified, enumeration-safe, JWT issuance, tested against all success/failure paths
- JWT authentication middleware — protects routes, tested against missing/invalid/valid tokens
- Commit discipline maintained throughout: schema, connection setup, signup, login, and middleware each committed separately with descriptive messages

**Next up: Phase 2**
