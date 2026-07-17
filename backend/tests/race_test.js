// race_test.js
// Fires two concurrent POST /orders requests for the SAME product,
// each requesting ALL remaining stock (5 units), to prove the
// atomic UPDATE...WHERE stock_quantity >= $1 pattern prevents overselling.

const SCHOOL_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjMyMWJkYWNmLWMwYTAtNGE0Zi05ZTlmLWFhYTdjYjNmZGU2MyIsInJvbGUiOiJzY2hvb2wiLCJpYXQiOjE3ODQyNjg5NzAsImV4cCI6MTc4NDI3MjU3MH0.jqJgG7ZBwjS-XU2uo3E4HNBoDFbP-XUxTJbLNHgQ1kI";
const VENDOR_ID = "4733b31b-35be-41a8-a735-66a3300e9a49";
const PRODUCT_ID = "787d5ad6-b1ea-4f45-991d-4488634112e3";

const orderBody = {
  vendor_id: VENDOR_ID,
  items: [
    { product_id: PRODUCT_ID, quantity: 5 }
  ]
};

async function placeOrder(label) {
  const res = await fetch("http://localhost:5000/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SCHOOL_TOKEN}`
    },
    body: JSON.stringify(orderBody)
  });

  const data = await res.json();
  console.log(`[${label}] status: ${res.status}`, data);
  return { label, status: res.status, data };
}

async function main() {
  console.log("Firing two concurrent order requests...\n");

  const [resultA, resultB] = await Promise.all([
    placeOrder("Request A"),
    placeOrder("Request B")
  ]);

  console.log("\n--- Summary ---");
  console.log(`Request A: ${resultA.status}`);
  console.log(`Request B: ${resultB.status}`);

  const successes = [resultA, resultB].filter(r => r.status === 201);
  const failures = [resultA, resultB].filter(r => r.status === 409);

  console.log(`\nSuccesses (201): ${successes.length}`);
  console.log(`Failures (409): ${failures.length}`);

  if (successes.length === 1 && failures.length === 1) {
    console.log("\n✅ PASS — exactly one request succeeded, stock protected.");
  } else {
    console.log("\n❌ UNEXPECTED — check results above. Possible oversell or bug.");
  }
}

main();