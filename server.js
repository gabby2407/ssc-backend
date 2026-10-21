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
// POST Endpoint: Register new member/officer into Supabase
app.post('/api/members', async (req, res) => {
  const { ssc_number, full_name, member_type, designation, year_section, cellphone, status } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO members (ssc_number, full_name, member_type, designation, year_section, cellphone, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [ssc_number, full_name, member_type || 'member', designation, year_section, cellphone, status || 'ACTIVE']
    );

    res.status(201).json({ message: "Registration successful!", member: result.rows[0] });
  } catch (err) {
    console.error("Insert error:", err);
    res.status(500).json({ error: "Failed to register member. SSC Number might already exist." });
  }
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
