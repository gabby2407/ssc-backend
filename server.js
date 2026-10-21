const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Connects to your Supabase database via the connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Route to fetch members from Supabase
app.get('/api/members', async (req, res) => {
  try {
    const { search, type } = req.query;
    let query = 'SELECT * FROM members WHERE 1=1';
    let params = [];

    if (type && type !== 'ALL') {
      params.push(type === 'OFFICERS' ? 'officer' : 'member');
      query += ` AND member_type = $${params.length}`;
    }

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (LOWER(full_name) LIKE LOWER($${params.length}) OR LOWER(ssc_number) LIKE LOWER($${params.length}))`;
    }

    query += ' ORDER BY ssc_number ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));