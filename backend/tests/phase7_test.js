// backend/tests/phase7_test.js
require('dotenv').config();
const { Pool } = require('pg');

const BASE_URL = 'http://localhost:5000';
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.log(`❌ ${label}`);
    failed++;
  }
}

async function login(email, password, role) {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });
  const data = await res.json();
  console.log(`login(${email}, ${role}) ->`, res.status, data);
  return data.token;
}
async function run() {
  // --- Setup: reuse existing test accounts from earlier phases ---
  const schoolToken = await login('schoolA@test.com', 'Password123!', 'school');
  console.log('schoolToken:', schoolToken);
  const vendorToken = await login('vendor1@test.com', 'Password123!', 'vendor');
  console.log('vendorToken:', vendorToken);

  // 1. No token
  let res = await fetch(`${BASE_URL}/orders/monthly`);
  check('No token -> 401', res.status === 401);
  

  // 2. Garbage token
  res = await fetch(`${BASE_URL}/orders/monthly`, {
    headers: { Authorization: 'Bearer garbage.token.value' },
  });
  check('Garbage token -> 401', res.status === 401);

  // 3. Vendor token on school route
  res = await fetch(`${BASE_URL}/orders/monthly`, {
    headers: { Authorization: `Bearer ${vendorToken}` },
  });
  check('Vendor on /orders/monthly -> 403', res.status === 403);

  // 4. School token on vendor route
  res = await fetch(`${BASE_URL}/vendor/orders/monthly`, {
    headers: { Authorization: `Bearer ${schoolToken}` },
  });
  check('School on /vendor/orders/monthly -> 403', res.status === 403);

  // 5. School happy path + independent DB verification
  res = await fetch(`${BASE_URL}/orders/monthly`, {
    headers: { Authorization: `Bearer ${schoolToken}` },
  });
  const schoolBody = await res.json();
  console.log('schoolBody:', res.status, schoolBody);

  const schoolProfileResult = await pool.query(
    `SELECT sp.id FROM school_profiles sp JOIN users u ON sp.user_id = u.id WHERE u.email = $1`,
    ['schoolA@test.com']
  );
  const schoolId = schoolProfileResult.rows[0].id;

  const dbSchoolCheck = await pool.query(
    `SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS order_count
     FROM orders
     WHERE school_id = $1 AND status != 'canceled'
     GROUP BY month
     ORDER BY month ASC`,
    [schoolId]
  );

  check(
    'School happy path -> 200',
    res.status === 200 && schoolBody.success === true
  );
  check(
    'School monthly counts match independent DB query',
    JSON.stringify(schoolBody.monthly_orders.map(r => r.order_count)) ===
      JSON.stringify(dbSchoolCheck.rows.map(r => r.order_count))
  );

  // 6. Vendor happy path + independent DB verification
  
  res = await fetch(`${BASE_URL}/vendor/orders/monthly`, {
    headers: { Authorization: `Bearer ${vendorToken}` },
  });
  const vendorBody = await res.json();

  const vendorProfileResult = await pool.query(
    `SELECT vp.id FROM vendor_profiles vp JOIN users u ON vp.user_id = u.id WHERE u.email = $1`,
    ['vendor1@test.com']
  );
  const vendorId = vendorProfileResult.rows[0].id;

  const dbVendorCheck = await pool.query(
    `SELECT DATE_TRUNC('month', created_at) AS month, COUNT(*) AS order_count
     FROM orders
     WHERE vendor_id = $1 AND status != 'canceled'
     GROUP BY month
     ORDER BY month ASC`,
    [vendorId]
  );

  check('Vendor happy path -> 200', res.status === 200 && vendorBody.success === true);
  check(
    'Vendor monthly counts match independent DB query',
    JSON.stringify(vendorBody.monthly_orders.map(r => r.order_count)) ===
      JSON.stringify(dbVendorCheck.rows.map(r => r.order_count))
  );

  // 7. Canceled orders excluded — place + cancel a fresh order, confirm count doesn't move
  const productResult = await pool.query(
    `SELECT id FROM products WHERE vendor_id = $1 AND stock_quantity > 0 LIMIT 1`,
    [vendorId]
  );

  if (productResult.rows.length > 0) {
    const productId = productResult.rows[0].id;

    const beforeRes = await fetch(`${BASE_URL}/orders/monthly`, {
      headers: { Authorization: `Bearer ${schoolToken}` },
    });
    const beforeBody = await beforeRes.json();
    const beforeCount = beforeBody.monthly_orders.find(
      r => new Date(r.month).getMonth() === new Date().getMonth()
    )?.order_count ?? '0';

    const placeRes = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${schoolToken}`,
      },
      body: JSON.stringify({
        vendor_id: vendorId,
        items: [{ product_id: productId, quantity: 1 }],
      }),
    });
    const placeBody = await placeRes.json();
    const newOrderId = placeBody.order_id;

    await fetch(`${BASE_URL}/orders/${newOrderId}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${schoolToken}`,
      },
      body: JSON.stringify({ status: 'canceled' }),
    });

    const afterRes = await fetch(`${BASE_URL}/orders/monthly`, {
      headers: { Authorization: `Bearer ${schoolToken}` },
    });
    const afterBody = await afterRes.json();
    const afterCount = afterBody.monthly_orders.find(
      r => new Date(r.month).getMonth() === new Date().getMonth()
    )?.order_count ?? '0';

    check(
      'Canceled order does not increment monthly count',
      Number(beforeCount) === Number(afterCount)
    );
  } else {
    console.log('⚠️  Skipped canceled-order test — no vendor product with stock found.');
  }

  // 8. Chronological order check
  const monthsAsDates = schoolBody.monthly_orders.map(r => new Date(r.month).getTime());
  const isSorted = monthsAsDates.every((val, i, arr) => i === 0 || arr[i - 1] <= val);
  check('Monthly orders returned in ascending chronological order', isSorted);

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
}

run();