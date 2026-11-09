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

async function requireAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Sign in is required.' });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session is invalid or expired.' });
    const result = await pool.query('SELECT role, display_name FROM profiles WHERE id = $1', [data.user.id]);
    if (result.rowCount === 0) return res.status(403).json({ error: 'Account profile is not configured.' });
    req.authUser = data.user;
    req.authProfile = result.rows[0];
    next();
  } catch (err) {
    console.error('Authentication check error:', err);
    res.status(500).json({ error: 'Could not verify your account.' });
  }
}

function requireOfficer(req, res, next) {
  if (req.authProfile?.role !== 'officer') {
    return res.status(403).json({ error: 'Only council officers can publish or remove announcements.' });
  }
  next();
}

// Route to fetch members from Supabase
app.get('/api/members', async (req, res) => {
  try {
    const { search, type } = req.query;
    let query = "SELECT * FROM members WHERE UPPER(status) = 'ACTIVE'";
    let params = [];

    if (type && type.toUpperCase() !== 'ALL') {
      const normalizedType = type.toUpperCase();
      if (normalizedType === 'OFFICER' || normalizedType === 'OFFICERS') {
        params.push('officer');
      } else if (normalizedType === 'MEMBER' || normalizedType === 'MEMBERS') {
        params.push('member');
      } else {
        return res.status(400).json({ error: 'Invalid member type filter.' });
      }
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
  const { ssc_number, full_name, designation, year_section, cellphone } = req.body;

  if (!ssc_number || !String(ssc_number).trim()) {
    return res.status(400).json({ error: 'SSC ID is required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO members (ssc_number, full_name, member_type, designation, year_section, cellphone, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [ssc_number, full_name, 'member', designation, year_section, cellphone, 'PENDING']
    );

    res.status(201).json({ message: "Registration successful!", member: result.rows[0] });
  } catch (err) {
    console.error("Insert error:", err);

    // PostgreSQL uses 23505 for duplicate-key/unique-constraint violations.
    // Check the constraint/message as well so this remains clear if the
    // database driver does not expose the error code consistently.
    const isDuplicateSscId = err?.code === '23505'
      || /duplicate key|unique constraint/i.test(err?.message || '')
      || /ssc[_-]?number/i.test(err?.constraint || '');

    if (isDuplicateSscId) {
      return res.status(400).json({
        error: 'This SSC ID is already registered. Please log in or use a different ID.'
      });
    }

    res.status(500).json({ error: "Failed to register member. SSC Number might already exist." });
  }
});

// Council review routes use a shared secret kept on the server, never in the page source.
function requireCouncilKey(req, res, next) {
  const expected = process.env.SSC_COUNCIL_APPROVAL_KEY;
  const provided = req.get('x-council-approval-key');
  if (!expected) {
    return res.status(503).json({ error: 'Council approval is not configured on the server.' });
  }
  if (!provided || provided !== expected) {
    return res.status(403).json({ error: 'Council approval key is invalid.' });
  }
  next();
}

app.get('/api/members/pending', requireCouncilKey, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT ssc_number, full_name, member_type, designation, year_section, cellphone, status FROM members WHERE UPPER(status) = 'PENDING' ORDER BY ssc_number ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Pending members query error:', err);
    res.status(500).json({ error: 'Failed to load pending registrations.' });
  }
});

app.post('/api/members/:ssc_number/approve', requireCouncilKey, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE members SET status = 'ACTIVE' WHERE LOWER(ssc_number) = LOWER($1) AND UPPER(status) = 'PENDING' RETURNING *",
      [req.params.ssc_number]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pending registration not found.' });
    }
    res.json({ message: 'Registration approved.', member: result.rows[0] });
  } catch (err) {
    console.error('Member approval error:', err);
    res.status(500).json({ error: 'Failed to approve registration.' });
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
app.post('/api/posts', requireAuth, requireOfficer, async (req, res) => {
  const { content, image_url } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO posts (author_name, author_role, content, image_url)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.authProfile.display_name, 'Council Officer', content, image_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// DELETE Route: Remove a post by ID (Council Officers)
app.delete('/api/posts/:id', requireAuth, requireOfficer, async (req, res) => {
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
app.post('/api/upload', requireAuth, requireOfficer, upload.single('image'), async (req, res) => {
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
