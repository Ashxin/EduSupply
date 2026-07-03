require('dotenv').config();

const express = require('express');

const app = express();

const pool = require('./db');

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