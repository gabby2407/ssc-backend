const multer = require('multer');
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Connects to your Supabase database via the connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Supabase Client for Storage
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Multer setup for handling file uploads in memory
const upload = multer({ storage: multer.memoryStorage() });

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

// GET Route: Fetch all posts for the portal feed
app.get('/api/posts', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM posts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST Route: Create a new post (Council Officers only)
app.post('/api/posts', async (req, res) => {
  const { author_name, author_role, content, image_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO posts (author_name, author_role, content, image_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [author_name, author_role, content, image_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// DELETE Route: Remove a post by ID (Council Officers)
app.delete('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING *', [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json({ message: 'Post deleted successfully' });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: 'Server error while deleting post' });
  }
});

// POST Route: Image Upload Endpoint (Direct to Supabase Storage)
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided." });
    }

    const file = req.file;
    const fileName = `${Date.now()}-${file.originalname}`;

    // Upload file to your Supabase Storage bucket named 'post-images'
    const { data, error } = await supabase.storage
      .from('post-images')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (error) {
      console.error("Supabase storage error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Get public URL of the uploaded image
    const { data: publicURLData } = supabase.storage
      .from('post-images')
      .getPublicUrl(fileName);

    res.status(200).json({ image_url: publicURLData.publicUrl });

    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Server error during file upload." });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
