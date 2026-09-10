const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy so secure cookies work correctly.
app.set('trust proxy', 1);

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const SEED_PROVIDERS = [
  { name: 'James Okello', category: 'Plumbing', location: 'Kampala Central', rating: 4.8, phone: '+256701111111', bio: 'Pipe repairs, leak fixes, bathroom installs. 8 years experience.' },
  { name: 'Sarah Nambi', category: 'Electrical', location: 'Ntinda', rating: 4.9, phone: '+256702222222', bio: 'Wiring, sockets, fault diagnosis. Licensed electrician.' },
  { name: 'Moses Kato', category: 'Carpentry', location: 'Bugolobi', rating: 4.6, phone: '+256703333333', bio: 'Furniture repair, custom shelving, door fitting.' },
  { name: 'Grace Auma', category: 'Painting', location: 'Kololo', rating: 4.7, phone: '+256704444444', bio: 'Interior and exterior painting, feature walls.' },
  { name: 'Peter Ssali', category: 'Cleaning', location: 'Naalya', rating: 4.5, phone: '+256705555555', bio: 'Deep cleaning, move-in/move-out cleaning, offices.' },
  { name: 'Ruth Achieng', category: 'Gardening', location: 'Muyenga', rating: 4.8, phone: '+256706666666', bio: 'Landscaping, lawn care, hedge trimming.' },
  { name: 'David Wamala', category: 'Moving', location: 'Kansanga', rating: 4.4, phone: '+256707777777', bio: 'House and office moving, has own truck.' },
  { name: 'Betty Nakato', category: 'Plumbing', location: 'Kyanja', rating: 4.6, phone: '+256708888888', bio: 'Kitchen and bathroom plumbing specialist.' },
  { name: 'Isaac Mugisha', category: 'Electrical', location: 'Bukoto', rating: 4.7, phone: '+256709999999', bio: 'Generator installs, solar wiring, home rewiring.' },
  { name: 'Florence Atim', category: 'Carpentry', location: 'Nakawa', rating: 4.5, phone: '+256700000001', bio: 'Kitchen cabinets, wardrobes, general woodwork.' }
];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migration: the users table may already exist from before roles were
  // introduced. This adds the column if it's missing, without touching
  // existing rows (they default to 'client'). Safe to run on every boot.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS providers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      phone TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      rating NUMERIC DEFAULT 4.5,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_requests (
      id SERIAL PRIMARY KEY,
      client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'today' CHECK (urgency IN ('now', 'today', 'schedule')),
      location TEXT NOT NULL,
      location_notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'completed', 'cancelled')),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      job_id INTEGER UNIQUE NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed a few sample listings the first time, so the client search page
  // isn't empty before any real providers have signed up. These have no
  // user_id, so they're not editable through the provider dashboard.
  const { rows } = await pool.query('SELECT COUNT(*) FROM providers');
  if (parseInt(rows[0].count, 10) === 0) {
    for (const p of SEED_PROVIDERS) {
      await pool.query(
        'INSERT INTO providers (name, category, location, phone, bio, rating) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.name, p.category, p.location, p.phone, p.bio, p.rating]
      );
    }
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (req.session.role !== role) {
      return res.status(403).json({ error: 'Not authorized for this action.' });
    }
    next();
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

function isNonEmpty(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

async function getProviderIdForUser(userId) {
  const result = await pool.query('SELECT id FROM providers WHERE user_id = $1', [userId]);
  return result.rows[0]?.id || null;
}

// --- Auth routes ---

app.post('/api/signup', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;
  const role = req.body.role === 'provider' ? 'provider' : 'client';

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number.' });
  }

  let providerFields = null;
  if (role === 'provider') {
    const { name, category, location, phone, bio } = req.body;
    if (!isNonEmpty(name) || !isNonEmpty(category) || !isNonEmpty(location) || !isNonEmpty(phone)) {
      return res.status(400).json({ error: 'Please fill in your name, category, location, and phone number.' });
    }
    providerFields = {
      name: name.trim(),
      category: category.trim(),
      location: location.trim(),
      phone: phone.trim(),
      bio: isNonEmpty(bio) ? bio.trim() : ''
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An account with that email already exists. Try logging in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, role]
    );
    const userId = userResult.rows[0].id;

    if (providerFields) {
      await client.query(
        'INSERT INTO providers (user_id, name, category, location, phone, bio, rating) VALUES ($1,$2,$3,$4,$5,$6,5.0)',
        [userId, providerFields.name, providerFields.category, providerFields.location, providerFields.phone, providerFields.bio]
      );
    }

    await client.query('COMMIT');

    req.session.userId = userId;
    req.session.userEmail = email;
    req.session.role = role;
    res.json({ message: 'Account created.', email, role });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  } finally {
    client.release();
  }
});

app.post('/api/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    req.session.userId = user.id;
    req.session.userEmail = user.email;
    req.session.role = user.role;
    if (req.body.remember) {
      req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    }
    res.json({ message: 'Logged in.', email: user.email, role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging in. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out.' });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json({ email: req.session.userEmail, role: req.session.role });
});

// --- Client-facing: browse/search providers ---

app.get('/api/categories', requireLogin, async (req, res) => {
  const result = await pool.query('SELECT DISTINCT category FROM providers ORDER BY category');
  res.json({ categories: result.rows.map(r => r.category) });
});

app.get('/api/workers', requireLogin, async (req, res) => {
  const { search, category } = req.query;
  const result = await pool.query('SELECT * FROM providers ORDER BY rating DESC, name');
  let results = result.rows;

  if (category) {
    results = results.filter(w => w.category.toLowerCase() === category.toLowerCase());
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(w =>
      w.name.toLowerCase().includes(q) ||
      w.category.toLowerCase().includes(q) ||
      w.location.toLowerCase().includes(q) ||
      w.bio.toLowerCase().includes(q)
    );
  }

  res.json({ workers: results });
});

// --- Provider-facing: manage own listing ---

app.get('/api/provider/me', requireRole('provider'), async (req, res) => {
  const result = await pool.query('SELECT * FROM providers WHERE user_id = $1', [req.session.userId]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }
  res.json({ provider: result.rows[0] });
});

app.put('/api/provider/me', requireRole('provider'), async (req, res) => {
  const { name, category, location, phone, bio } = req.body;
  if (!isNonEmpty(name) || !isNonEmpty(category) || !isNonEmpty(location) || !isNonEmpty(phone)) {
    return res.status(400).json({ error: 'Please fill in your name, category, location, and phone number.' });
  }

  try {
    const result = await pool.query(
      `UPDATE providers SET name=$1, category=$2, location=$3, phone=$4, bio=$5
       WHERE user_id=$6 RETURNING *`,
      [name.trim(), category.trim(), location.trim(), phone.trim(), isNonEmpty(bio) ? bio.trim() : '', req.session.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No provider profile found.' });
    }
    res.json({ provider: result.rows[0] });
  } catch (err) {
    console.error('Provider update error:', err);
    res.status(500).json({ error: 'Something went wrong saving your profile.' });
  }
});

// --- Client-facing: create and view bookings ---

const VALID_URGENCY = ['now', 'today', 'schedule'];

app.post('/api/bookings', requireRole('client'), async (req, res) => {
  const { providerId, category, description, urgency, location, locationNotes } = req.body;

  if (!providerId || !isNonEmpty(category) || !isNonEmpty(description) || !isNonEmpty(location)) {
    return res.status(400).json({ error: 'Please fill in the job description and location.' });
  }
  if (!VALID_URGENCY.includes(urgency)) {
    return res.status(400).json({ error: 'Please choose when you need this done.' });
  }

  try {
    const providerCheck = await pool.query('SELECT id FROM providers WHERE id = $1', [providerId]);
    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'That provider no longer exists.' });
    }

    const result = await pool.query(
      `INSERT INTO job_requests (client_user_id, provider_id, category, description, urgency, location, location_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.session.userId, providerId, category.trim(), description.trim(), urgency, location.trim(), isNonEmpty(locationNotes) ? locationNotes.trim() : '']
    );
    res.json({ booking: result.rows[0] });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Something went wrong creating your booking.' });
  }
});

app.get('/api/bookings/mine', requireRole('client'), async (req, res) => {
  const result = await pool.query(
    `SELECT jr.*, p.name AS provider_name, p.phone AS provider_phone,
            (r.id IS NOT NULL) AS reviewed
     FROM job_requests jr
     JOIN providers p ON p.id = jr.provider_id
     LEFT JOIN reviews r ON r.job_id = jr.id
     WHERE jr.client_user_id = $1
     ORDER BY jr.created_at DESC`,
    [req.session.userId]
  );
  res.json({ bookings: result.rows });
});

// --- Provider-facing: manage incoming job requests ---

app.get('/api/provider/jobs', requireRole('provider'), async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }

  const result = await pool.query(
    `SELECT jr.*, u.email AS client_email
     FROM job_requests jr
     JOIN users u ON u.id = jr.client_user_id
     WHERE jr.provider_id = $1
     ORDER BY jr.created_at DESC`,
    [providerId]
  );
  res.json({ jobs: result.rows });
});

async function updateJobStatus(req, res, { from, to }) {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }

  const result = await pool.query(
    `UPDATE job_requests SET status = $1, updated_at = NOW()
     WHERE id = $2 AND provider_id = $3 AND status = $4
     RETURNING *`,
    [to, req.params.id, providerId, from]
  );

  if (result.rows.length === 0) {
    return res.status(409).json({ error: 'This job is no longer in a state that allows that action.' });
  }
  res.json({ job: result.rows[0] });
}

app.put('/api/provider/jobs/:id/accept', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: 'requested', to: 'accepted' })
);
app.put('/api/provider/jobs/:id/decline', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: 'requested', to: 'declined' })
);
app.put('/api/provider/jobs/:id/complete', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: 'accepted', to: 'completed' })
);

// --- Reviews ---

app.post('/api/reviews', requireRole('client'), async (req, res) => {
  const { jobId, rating, comment } = req.body;
  const ratingNum = parseInt(rating, 10);

  if (!jobId || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Please give a rating between 1 and 5.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jobResult = await client.query(
      `SELECT * FROM job_requests WHERE id = $1 AND client_user_id = $2 AND status = 'completed'`,
      [jobId, req.session.userId]
    );
    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This job cannot be reviewed yet.' });
    }
    const job = jobResult.rows[0];

    await client.query(
      'INSERT INTO reviews (job_id, client_user_id, provider_id, rating, comment) VALUES ($1,$2,$3,$4,$5)',
      [jobId, req.session.userId, job.provider_id, ratingNum, isNonEmpty(comment) ? comment.trim() : '']
    );

    await client.query(
      `UPDATE providers SET rating = (
         SELECT ROUND(AVG(rating)::numeric, 1) FROM reviews WHERE provider_id = $1
       ) WHERE id = $1`,
      [job.provider_id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Review submitted.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already reviewed this job.' });
    }
    console.error('Review error:', err);
    res.status(500).json({ error: 'Something went wrong submitting your review.' });
  } finally {
    client.release();
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
