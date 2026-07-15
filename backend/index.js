require('dotenv').config();

const express = require('express');

const app = express();

const bcrypt = require('bcrypt');

const pool = require('./db');

const jwt = require('jsonwebtoken');

app.use(express.json());

app.post('/signup', async (req, res) => {
  const { email, password, role, institution_name, business_name } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, password, and role are required.' });
  }

  if (role !== 'school' && role !== 'vendor') {
    return res.status(400).json({ error: 'Role must be either "school" or "vendor".' });
  }

  if (role === 'school' && !institution_name) {
    return res.status(400).json({ error: 'institution_name is required for schools.' });
  }

  if (role === 'vendor' && !business_name) {
    return res.status(400).json({ error: 'business_name is required for vendors.' });
  }

  const client = await pool.connect();

  try {
    // Step 6 (moved up): Start transaction
    await client.query('BEGIN');

    // Step 3: Check for existing user
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    // Step 4: Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Step 5a: Insert into users
    const newUser = await client.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, passwordHash, role]
    );
    const userId = newUser.rows[0].id;

    // Step 5b: Insert into role-specific profile table
    if (role === 'school') {
      await client.query(
        'INSERT INTO school_profiles (user_id, institution_name) VALUES ($1, $2)',
        [userId, institution_name]
      );
    } else {
      await client.query(
        'INSERT INTO vendor_profiles (user_id, business_name) VALUES ($1, $2)',
        [userId, business_name]
      );
    }

    await client.query('COMMIT');

    // Step 8: Respond to client
    res.status(201).json({ success: true, user: newUser.rows[0] });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong during signup.' });
  } finally {
    client.release();
  }

})

app.post('/login', async (req, res) => {
  const { email, password, role } = req.body || {};

  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, password and role are required.' })
  }

  try {
    const result = await pool.query(
      'SELECT id, password_hash, role FROM users WHERE email = $1 AND role = $2', [email, role]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.status(200).json({ success: true, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong during login.' });
  }
});

app.post('/products', authenticateToken, checkVendorRole, attachVendorProfileId, async (req, res) => {
  const { name, price, category, stock_quantity } = req.body || {};

  const finalStock = stock_quantity ?? 0;

  if (!name || !category) {
    return res.status(400).json({
      error: 'Name and category are required'
    })
  }

  if (typeof price !== "number" || price <= 0) {
    return res.status(400).json({
      error: 'Invalid Price'
    })
  }
  try {
    const result = await pool.query(
      'INSERT INTO products (vendor_id, name, price, category, stock_quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.vendorProfileId, name, price, category, finalStock]
    )
    return res.status(201).json({ product: result.rows[0] })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Something went wrong while creating the product.' })
  }

});

app.put('/products/:id', authenticateToken, checkVendorRole, attachVendorProfileId, async (req, res) => {
  const { name, price, category, stock_quantity } = req.body || {};

  try {
    const check = await pool.query(
      'SELECT id FROM products WHERE id = $1 AND vendor_id = $2',
      [req.params.id, req.vendorProfileId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const fields = [];
    const values = [];

    if (name) {
      fields.push(`name = $${values.length + 1}`);
      values.push(name);
    }

    if (price !== undefined) {
      if (typeof price !== "number" || price <= 0) {
        return res.status(400).json({ error: 'Invalid Price' });
      }
      fields.push(`price = $${values.length + 1}`);
      values.push(price);
    }

    if (category) {
      fields.push(`category = $${values.length + 1}`);
      values.push(category);
    }

    if (stock_quantity !== undefined) {
      if (typeof stock_quantity !== "number" || stock_quantity < 0) {
        return res.status(400).json({ error: 'Invalid stock_quantity' });
      }
      fields.push(`stock_quantity = $${values.length + 1}`);
      values.push(stock_quantity);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'At least one field (name, price, category, stock_quantity) must be provided.' });
    }

    const setClause = fields.join(', ');
    const idPlaceholder = values.length + 1;
    values.push(req.params.id);

    const updateQuery = `UPDATE products SET ${setClause} WHERE id = $${idPlaceholder} RETURNING *`;
    const result = await pool.query(updateQuery, values);

    res.status(200).json({ product: result.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while updating the product.' });
  }
});


app.delete('/products/:id', authenticateToken, checkVendorRole, attachVendorProfileId, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND vendor_id = $2',
      [req.params.id, req.vendorProfileId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    res.status(204).send();

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while deleting the product.' });
  }
});

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


function checkVendorRole(req, res, next) {
  if (req.user.role !== 'vendor') {
    return res.status(403).json({ error: 'Wrong role selected' });
  }
  next();
}


async function attachVendorProfileId(req, res, next) {

  try {
    const result = await pool.query(
      'SELECT id FROM vendor_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(500).json({ error: 'Vendor profile not found.' });
    }

    req.vendorProfileId = result.rows[0].id;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while fetching the vendor profile.' });

  }

}



app.get('/protected-test', authenticateToken, (req, res) => {
  res.json({ success: true, message: 'You accessed a protected route!', user: req.user });
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Server is running');
})

app.listen(5000, () => {
  console.log('Server is running');

})