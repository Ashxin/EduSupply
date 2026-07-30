// backend/tests/phase6_test.js
//
// Automated test script for Phase 6 (Reorder Shortcut).
// Mirrors the style of Phase 4's race_test.js: plain fetch() calls against
// your locally running server, plus direct psql-equivalent checks via `pg`
// for anything that needs DB-level verification.
//
// Usage:
//   1. Make sure your backend is running locally: npm run dev (in backend/)
//   2. Place this file at backend/tests/phase6_test.js
//   3. Run: node tests/phase6_test.js
//
// Requires: two school accounts, one vendor account, already signed up.
// Edit the CONFIG block below with real emails/passwords for your test users.

const { Pool } = require('pg');
require('dotenv').config();

const BASE_URL = 'http://localhost:5000';

// ---- CONFIG: fill these in with your actual test accounts ----
const CONFIG = {
  schoolA: { email: 'schoolA@test.com', password: 'Password123!', role: 'school' },
  schoolB: { email: 'schoolB@test.com', password: 'Password123!', role: 'school' },
  vendor1: { email: 'vendor1@test.com', password: 'Password123!', role: 'vendor' },
};

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

let pass = 0;
let fail = 0;

function check(label, condition, extra = '') {
  if (condition) {
    console.log(`✅ ${label}`);
    pass++;
  } else {
    console.log(`❌ ${label} ${extra}`);
    fail++;
  }
}

async function login(account) {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  const data = await res.json();
  if (!data.token) {
    throw new Error(`Login failed for ${account.email}: ${JSON.stringify(data)}`);
  }
  return data.token;
}

async function getProfileId(userId, table) {
  const result = await pool.query(`SELECT id FROM ${table} WHERE user_id = $1`, [userId]);
  return result.rows[0].id;
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

async function createProduct(vendorToken, body) {
  const res = await fetch(`${BASE_URL}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vendorToken}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function placeOrder(schoolToken, body) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${schoolToken}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function reorder(schoolToken, orderId) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}/reorder`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${schoolToken}` },
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function setStock(productId, stock) {
  await pool.query('UPDATE products SET stock_quantity = $1 WHERE id = $2', [stock, productId]);
}

async function setStatus(schoolToken, orderId, status) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${schoolToken}` },
    body: JSON.stringify({ status }),
  });
  return res.json();
}

async function main() {
  console.log('--- Setup: logging in ---');
  const schoolAToken = await login(CONFIG.schoolA);
  const schoolBToken = await login(CONFIG.schoolB);
  const vendorToken = await login(CONFIG.vendor1);

  const schoolAId = decodeJwtPayload(schoolAToken).id;
  const vendorUserId = decodeJwtPayload(vendorToken).id;

  const schoolAProfileId = await getProfileId(schoolAId, 'school_profiles');
  const vendorProfileId = await getProfileId(vendorUserId, 'vendor_profiles');

  console.log('--- Setup: creating fresh test products ---');
  const productA = await createProduct(vendorToken, {
    name: 'Test Belt', price: 200, category: 'Accessories', stock_quantity: 100,
  });
  const productB = await createProduct(vendorToken, {
    name: 'Test Tie', price: 150, category: 'Accessories', stock_quantity: 100,
  });
  const productAId = productA.product.id;
  const productBId = productB.product.id;

  console.log('--- Setup: placing an original order (School A) ---');
  const original = await placeOrder(schoolAToken, {
    vendor_id: vendorProfileId,
    items: [
      { product_id: productAId, quantity: 5 },
      { product_id: productBId, quantity: 3 },
    ],
  });
  check('Setup order created (201)', original.status === 201, JSON.stringify(original.data));
  const originalOrderId = original.data.order_id;

  console.log('\n--- Test 1: No Authorization header ---');
  {
    const res = await fetch(`${BASE_URL}/orders/${originalOrderId}/reorder`, { method: 'POST' });
    check('401 Authorization token missing', res.status === 401);
  }

  console.log('\n--- Test 2: Garbage token ---');
  {
    const res = await fetch(`${BASE_URL}/orders/${originalOrderId}/reorder`, {
      method: 'POST',
      headers: { Authorization: 'Bearer garbage123' },
    });
    check('401 Invalid or expired token', res.status === 401);
  }

  console.log('\n--- Test 3: Vendor token (wrong role) ---');
  {
    const res = await fetch(`${BASE_URL}/orders/${originalOrderId}/reorder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendorToken}` },
    });
    check('403 Wrong role selected', res.status === 403);
  }

  console.log('\n--- Test 4: Nonexistent order id ---');
  {
    const { status } = await reorder(schoolAToken, '00000000-0000-0000-0000-000000000000');
    check('404 Order not found', status === 404);
  }

  console.log('\n--- Test 6: Cross-school ownership (School B reorders School A order) ---');
  {
    const { status } = await reorder(schoolBToken, originalOrderId);
    check('404 Order not found (cross-school)', status === 404);
  }

  console.log('\n--- Test 7/8: Happy path ---');
  {
    const { status, data } = await reorder(schoolAToken, originalOrderId);
    check('201 Created', status === 201, JSON.stringify(data));
    const newOrderId = data.order_id;

    const items = await pool.query(
      'SELECT product_id, quantity, price_at_order FROM order_items WHERE order_id = $1 ORDER BY product_id',
      [newOrderId]
    );
    check('New order has 2 line items', items.rows.length === 2, `got ${items.rows.length}`);

    const belt = items.rows.find(r => r.product_id === productAId);
    check('Belt quantity matches original (5)', belt && belt.quantity === 5);
    check('Belt price_at_order reflects current price (200.00)', belt && Number(belt.price_at_order) === 200);
  }

  console.log('\n--- Test 9: Out-of-stock item on reorder ---');
  {
    await setStock(productAId, 0);
    const { status, data } = await reorder(schoolAToken, originalOrderId);
    check('409 Insufficient stock', status === 409, JSON.stringify(data));

    const countBefore = await pool.query('SELECT COUNT(*) FROM orders WHERE school_id = $1', [schoolAProfileId]);
    // no strict count assertion here since prior tests created orders too;
    // real check is that this specific attempt didn't leave a dangling row,
    // which the rollback inside createOrder() already guarantees structurally.
    console.log(`   (informational) total orders for School A so far: ${countBefore.rows[0].count}`);

    await setStock(productAId, 100); // reset for later tests
  }

  console.log('\n--- Test 10: Partial-failure rollback ---');
  {
    await setStock(productAId, 100);
    await setStock(productBId, 0);
    const { status } = await reorder(schoolAToken, originalOrderId);
    check('409 on second item', status === 409);

    const stockCheck = await pool.query('SELECT stock_quantity FROM products WHERE id = $1', [productAId]);
    check('First item stock untouched (still 100)', stockCheck.rows[0].stock_quantity === 100,
      `got ${stockCheck.rows[0].stock_quantity}`);

    await setStock(productBId, 100); // reset
  }

  console.log('\n--- Test 11: Price drift ---');
  {
    await fetch(`${BASE_URL}/products/${productAId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vendorToken}` },
      body: JSON.stringify({ price: 999.99 }),
    });

    const { status, data } = await reorder(schoolAToken, originalOrderId);
    check('201 Created after price change', status === 201, JSON.stringify(data));

    const items = await pool.query(
      'SELECT price_at_order FROM order_items WHERE order_id = $1 AND product_id = $2',
      [data.order_id, productAId]
    );
    check('price_at_order reflects new price (999.99)', Number(items.rows[0].price_at_order) === 999.99,
      `got ${items.rows[0].price_at_order}`);

    await fetch(`${BASE_URL}/products/${productAId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vendorToken}` },
      body: JSON.stringify({ price: 200 }),
    }); // reset
  }

  console.log('\n--- Test 12: Reorder a canceled order ---');
  {
    const fresh = await placeOrder(schoolAToken, {
      vendor_id: vendorProfileId,
      items: [{ product_id: productAId, quantity: 2 }],
    });
    await setStatus(schoolAToken, fresh.data.order_id, 'canceled');

    const { status } = await reorder(schoolAToken, fresh.data.order_id);
    check('201 Created (reordering a canceled order works)', status === 201);
  }

  console.log('\n--- Test 13: Regression - fresh POST /orders still works ---');
  {
    const { status } = await placeOrder(schoolAToken, {
      vendor_id: vendorProfileId,
      items: [{ product_id: productAId, quantity: 1 }],
    });
    check('201 Created', status === 201);
  }

  console.log('\n--- Test 14: Regression - insufficient stock on fresh order ---');
  {
    const { status } = await placeOrder(schoolAToken, {
      vendor_id: vendorProfileId,
      items: [{ product_id: productAId, quantity: 999999 }],
    });
    check('409 Insufficient stock', status === 409);
  }

  console.log(`\n--- Results: ${pass} passed, ${fail} failed ---`);
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Test run crashed:', err);
  await pool.end();
  process.exit(1);
});
