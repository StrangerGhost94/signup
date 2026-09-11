const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Email is configured via generic SMTP env vars, so it works with a Gmail
// app password, or any SMTP-speaking provider (Resend, SendGrid, etc.).
const SMTP_HOST = process.env.SMTP_HOST || null;
const mailTransport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@handylink.app';
const APP_URL = process.env.APP_URL || null; // e.g. https://your-app.up.railway.app

const app = express();
const PORT = process.env.PORT || 3000;

// Wraps an async route handler so a thrown/rejected error is passed to
// Express's error handler instead of hanging the request or crashing the process.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Trust Railway's reverse proxy so secure cookies work correctly.
app.set('trust proxy', 1);

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Rough estimate midpoints in UGX, mirroring the ranges shown to clients.
// Used only to give providers a sense of estimated (not real transacted) earnings.
const ESTIMATE_MIDPOINTS = {
  'Plumbing': 45000,
  'Electrical': 60000,
  'Carpentry': 62500,
  'Painting': 325000,
  'Cleaning': 47500,
  'Gardening': 40000,
  'Moving': 165000,
  'Mechanical': 125000
};

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

  // Migration: collect phone numbers and names going forward (nullable for old rows).
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT
  `);
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT
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

  // Migration: profile photo, stored as a data URL (small, compressed client-side).
  await pool.query(`
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS photo TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migration: presence tracking for online/offline status in chat.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migration: provider coordinates for proximity-based search.
  await pool.query(`
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS latitude NUMERIC
  `);
  await pool.query(`
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS longitude NUMERIC
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

  // Migration: estimated job value, for the provider earnings view.
  await pool.query(`
    ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS estimate_amount INTEGER DEFAULT 0
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
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

app.use(express.json({ limit: '1mb' }));
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

// Basic brute-force protection on auth endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  // Fire-and-forget presence update — don't block the request on it.
  pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [req.session.userId]).catch(() => {});
  next();
}

async function createNotification(userId, type, body, link) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, body, link) VALUES ($1, $2, $3, $4)',
      [userId, type, body, link || null]
    );
  } catch (err) {
    console.error('Notification creation failed:', err);
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (req.session.role !== role) {
      return res.status(403).json({ error: 'Not authorized for this action.' });
    }
    pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [req.session.userId]).catch(() => {});
    next();
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const dns = require('dns').promises;
const domainCheckCache = new Map(); // avoid repeat DNS lookups for common domains

async function domainCanReceiveMail(email) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  if (domainCheckCache.has(domain)) return domainCheckCache.get(domain);

  let ok = false;
  try {
    const mxRecords = await dns.resolveMx(domain);
    ok = mxRecords && mxRecords.length > 0;
  } catch (err) {
    // No MX records — fall back to checking the domain resolves at all
    // (some small domains route mail through their A record).
    try {
      await dns.resolve4(domain);
      ok = true;
    } catch (err2) {
      ok = false;
    }
  }
  domainCheckCache.set(domain, ok);
  return ok;
}

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

function isValidPhoto(photo) {
  if (!isNonEmpty(photo)) return true; // optional field
  if (!photo.startsWith('data:image/')) return false;
  if (photo.length > 600000) return false; // ~440KB, plenty for a compressed avatar
  return true;
}

// --- Auth routes ---

app.post('/api/signup', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;
  const role = req.body.role === 'provider' ? 'provider' : 'client';
  const name = req.body.name;
  const phone = req.body.phone;

  if (!isNonEmpty(name)) {
    return res.status(400).json({ error: 'Please enter your full name.' });
  }
  if (!isNonEmpty(phone)) {
    return res.status(400).json({ error: 'Please enter your phone number.' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const domainOk = await domainCanReceiveMail(email);
  if (!domainOk) {
    return res.status(400).json({ error: 'That email domain doesn\u2019t appear to accept mail. Please double-check it.' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number.' });
  }

  let providerFields = null;
  if (role === 'provider') {
    const { category, location, bio, photo } = req.body;
    if (!isNonEmpty(category) || !isNonEmpty(location)) {
      return res.status(400).json({ error: 'Please fill in the trade you offer and the area you serve.' });
    }
    if (!isValidPhoto(photo)) {
      return res.status(400).json({ error: 'That photo is too large or in an unsupported format.' });
    }
    providerFields = {
      name: name.trim(),
      category: category.trim(),
      location: location.trim(),
      phone: phone.trim(),
      bio: isNonEmpty(bio) ? bio.trim() : '',
      photo: isNonEmpty(photo) ? photo : null
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
      'INSERT INTO users (email, password_hash, role, phone, name) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [email, passwordHash, role, phone.trim(), name.trim()]
    );
    const userId = userResult.rows[0].id;

    if (providerFields) {
      await client.query(
        'INSERT INTO providers (user_id, name, category, location, phone, bio, rating, photo) VALUES ($1,$2,$3,$4,$5,$6,5.0,$7)',
        [userId, providerFields.name, providerFields.category, providerFields.location, providerFields.phone, providerFields.bio, providerFields.photo]
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

app.post('/api/login', authLimiter, async (req, res) => {
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

    const expectedRole = req.body.expectedRole;
    if (expectedRole && expectedRole !== user.role) {
      const correctTab = user.role === 'provider' ? 'Worker' : 'Customer';
      return res.status(409).json({ error: `This account is registered as a ${correctTab}. Switch tabs above and sign in again.` });
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

// Tells the frontend whether Google sign-in is actually wired up, so it can
// hide the button (falling back to the honest placeholder) when it's not.
app.get('/api/config', (req, res) => {
  res.json({ googleEnabled: !!googleClient, googleClientId: GOOGLE_CLIENT_ID, emailEnabled: !!mailTransport });
});

app.post('/api/auth/google', authLimiter, asyncHandler(async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ error: 'Google sign-in isn\u2019t set up yet.' });
  }
  const { credential, expectedRole } = req.body;
  if (!isNonEmpty(credential)) {
    return res.status(400).json({ error: 'Missing Google credential.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google sign-in. Please try again.' });
  }

  const email = normalizeEmail(payload.email);
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  if (!user) {
    // No account yet — let the frontend send them to sign up with these prefilled.
    return res.json({ accountFound: false, email, name: payload.name || '' });
  }

  if (expectedRole && expectedRole !== user.role) {
    const correctTab = user.role === 'provider' ? 'Worker' : 'Customer';
    return res.status(409).json({ error: `This account is registered as a ${correctTab}. Switch tabs above and try again.` });
  }

  req.session.userId = user.id;
  req.session.userEmail = user.email;
  req.session.role = user.role;
  res.json({ message: 'Logged in.', email: user.email, role: user.role, accountFound: true });
}));

app.post('/api/forgot-password', authLimiter, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);

  // Always return the same generic response, whether or not the email
  // exists — otherwise this endpoint could be used to check which emails
  // have accounts.
  const genericResponse = { message: 'If an account exists for that email, a reset link has been sent.' };

  if (!mailTransport) {
    return res.status(503).json({ error: 'Password reset by email isn\u2019t set up yet.' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.json(genericResponse);
  }

  const result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (result.rows.length === 0) {
    return res.json(genericResponse);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [result.rows[0].id, token, expiresAt]
  );

  const baseUrl = APP_URL || `${req.protocol}://${req.get('host')}`;
  const resetLink = `${baseUrl}/reset-password.html?token=${token}`;

  try {
    await mailTransport.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: 'Reset your HandyLink password',
      text: `Reset your password: ${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
      html: `<p>Someone requested a password reset for this HandyLink account.</p>
             <p><a href="${resetLink}">Click here to reset your password</a> (expires in 1 hour).</p>
             <p>If you didn't request this, you can safely ignore this email.</p>`
    });
  } catch (err) {
    console.error('Password reset email failed:', err);
    return res.status(500).json({ error: 'Could not send the reset email. Please try again shortly.' });
  }

  res.json(genericResponse);
}));

app.post('/api/reset-password', authLimiter, asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!isNonEmpty(token)) {
    return res.status(400).json({ error: 'Missing reset token.' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number.' });
  }

  const result = await pool.query(
    `SELECT * FROM password_resets WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
    [token]
  );
  if (result.rows.length === 0) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  const reset = result.rows[0];
  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, reset.user_id]);
  await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [reset.id]);

  res.json({ message: 'Password updated. You can now log in.' });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out.' });
  });
});

app.get('/api/me', asyncHandler(async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  const result = await pool.query('SELECT id, email, role, name, phone, created_at FROM users WHERE id = $1', [req.session.userId]);
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json(result.rows[0]);
}));

app.put('/api/me', requireLogin, asyncHandler(async (req, res) => {
  const { name, phone } = req.body;
  if (!isNonEmpty(name)) {
    return res.status(400).json({ error: 'Please enter your full name.' });
  }
  if (!isNonEmpty(phone)) {
    return res.status(400).json({ error: 'Please enter your phone number.' });
  }
  const result = await pool.query(
    'UPDATE users SET name = $1, phone = $2 WHERE id = $3 RETURNING email, role, name, phone, created_at',
    [name.trim(), phone.trim(), req.session.userId]
  );
  res.json(result.rows[0]);
}));

// --- Client-facing: browse/search providers ---

app.get('/api/categories', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT DISTINCT category FROM providers ORDER BY category');
  res.json({ categories: result.rows.map(r => r.category) });
}));

app.get('/api/workers', requireLogin, asyncHandler(async (req, res) => {
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
}));

// --- Provider-facing: manage own listing ---

app.get('/api/provider/me', requireRole('provider'), asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM providers WHERE user_id = $1', [req.session.userId]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }
  res.json({ provider: result.rows[0] });
}));

app.put('/api/provider/me', requireRole('provider'), async (req, res) => {
  const { name, category, location, phone, bio, photo, latitude, longitude } = req.body;
  if (!isNonEmpty(name) || !isNonEmpty(category) || !isNonEmpty(location) || !isNonEmpty(phone)) {
    return res.status(400).json({ error: 'Please fill in your name, category, location, and phone number.' });
  }
  if (!isValidPhoto(photo)) {
    return res.status(400).json({ error: 'That photo is too large or in an unsupported format.' });
  }
  const lat = (typeof latitude === 'number' && !isNaN(latitude)) ? latitude : null;
  const lng = (typeof longitude === 'number' && !isNaN(longitude)) ? longitude : null;

  try {
    // COALESCE keeps the existing photo when none is sent with this update.
    const result = await pool.query(
      `UPDATE providers SET name=$1, category=$2, location=$3, phone=$4, bio=$5, photo=COALESCE($6, photo),
              latitude=COALESCE($8, latitude), longitude=COALESCE($9, longitude)
       WHERE user_id=$7 RETURNING *`,
      [name.trim(), category.trim(), location.trim(), phone.trim(), isNonEmpty(bio) ? bio.trim() : '', isNonEmpty(photo) ? photo : null, req.session.userId, lat, lng]
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
    const providerCheck = await pool.query('SELECT id, user_id, name FROM providers WHERE id = $1', [providerId]);
    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'That provider no longer exists.' });
    }

    const result = await pool.query(
      `INSERT INTO job_requests (client_user_id, provider_id, category, description, urgency, location, location_notes, estimate_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.session.userId, providerId, category.trim(), description.trim(), urgency, location.trim(), isNonEmpty(locationNotes) ? locationNotes.trim() : '', ESTIMATE_MIDPOINTS[category.trim()] || 40000]
    );

    if (providerCheck.rows[0].user_id) {
      createNotification(
        providerCheck.rows[0].user_id,
        'new_job',
        `New ${category.trim()} job request`,
        '/provider-dashboard.html'
      );
    }

    res.json({ booking: result.rows[0] });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Something went wrong creating your booking.' });
  }
});

app.get('/api/bookings/mine', requireRole('client'), asyncHandler(async (req, res) => {
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
}));

// --- Provider-facing: manage incoming job requests ---

app.get('/api/provider/jobs', requireRole('provider'), asyncHandler(async (req, res) => {
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
}));

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

  const job = result.rows[0];
  const messages = {
    accepted: 'Your job request was accepted',
    declined: 'Your job request was declined',
    completed: 'Your job was marked completed'
  };
  if (messages[to]) {
    createNotification(job.client_user_id, `job_${to}`, `${messages[to]} — ${job.category}`, '/dashboard.html#recentJobs');
  }

  res.json({ job });
}

app.get('/api/provider/earnings', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }

  const completedResult = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(estimate_amount), 0)::int AS total
     FROM job_requests WHERE provider_id = $1 AND status = 'completed'`,
    [providerId]
  );
  const providerResult = await pool.query('SELECT rating FROM providers WHERE id = $1', [providerId]);
  const recentResult = await pool.query(
    `SELECT jr.id, jr.category, jr.description, jr.estimate_amount, jr.updated_at, u.email AS client_email,
            r.rating AS review_rating, r.comment AS review_comment
     FROM job_requests jr
     JOIN users u ON u.id = jr.client_user_id
     LEFT JOIN reviews r ON r.job_id = jr.id
     WHERE jr.provider_id = $1 AND jr.status = 'completed'
     ORDER BY jr.updated_at DESC LIMIT 10`,
    [providerId]
  );

  res.json({
    completedCount: completedResult.rows[0].count,
    totalEstimated: completedResult.rows[0].total,
    rating: providerResult.rows[0]?.rating || null,
    recent: recentResult.rows
  });
}));

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

// --- Messaging (job-scoped conversations between client and provider) ---

async function getJobForParticipant(jobId, userId) {
  const result = await pool.query(
    `SELECT jr.id, jr.category, jr.client_user_id, p.user_id AS provider_user_id,
            p.name AS provider_name, uc.email AS client_email, uc.name AS client_name,
            CASE WHEN jr.client_user_id = $2 THEN up.last_active_at ELSE uc.last_active_at END AS other_last_active
     FROM job_requests jr
     JOIN providers p ON p.id = jr.provider_id
     JOIN users uc ON uc.id = jr.client_user_id
     LEFT JOIN users up ON up.id = p.user_id
     WHERE jr.id = $1 AND (jr.client_user_id = $2 OR p.user_id = $2)`,
    [jobId, userId]
  );
  return result.rows[0] || null;
}

app.get('/api/conversations', requireLogin, asyncHandler(async (req, res) => {
  const userId = req.session.userId;
  const result = await pool.query(
    `SELECT jr.id AS job_id, jr.category, jr.status, jr.created_at,
            CASE WHEN jr.client_user_id = $1 THEN p.name ELSE uc.name END AS other_party_name,
            (SELECT body FROM messages m WHERE m.job_id = jr.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages m WHERE m.job_id = jr.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.job_id = jr.id AND m.sender_user_id != $1 AND m.read_at IS NULL) AS unread_count
     FROM job_requests jr
     JOIN providers p ON p.id = jr.provider_id
     JOIN users uc ON uc.id = jr.client_user_id
     WHERE jr.client_user_id = $1 OR p.user_id = $1
     ORDER BY COALESCE(
       (SELECT created_at FROM messages m WHERE m.job_id = jr.id ORDER BY m.created_at DESC LIMIT 1),
       jr.created_at
     ) DESC`,
    [userId]
  );
  res.json({ conversations: result.rows });
}));

app.get('/api/messages/:jobId', requireLogin, asyncHandler(async (req, res) => {
  const job = await getJobForParticipant(req.params.jobId, req.session.userId);
  if (!job) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }

  const result = await pool.query(
    'SELECT * FROM messages WHERE job_id = $1 ORDER BY created_at ASC',
    [job.id]
  );

  // Mark the other person's messages as read now that we've fetched them.
  await pool.query(
    'UPDATE messages SET read_at = NOW() WHERE job_id = $1 AND sender_user_id != $2 AND read_at IS NULL',
    [job.id, req.session.userId]
  );

  const otherPartyName = job.client_user_id === req.session.userId ? job.provider_name : (job.client_name || job.client_email);
  res.json({
    messages: result.rows,
    job: { id: job.id, category: job.category, otherPartyName, otherPartyLastActive: job.other_last_active }
  });
}));

app.post('/api/messages/:jobId', requireLogin, asyncHandler(async (req, res) => {
  const job = await getJobForParticipant(req.params.jobId, req.session.userId);
  if (!job) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  if (!isNonEmpty(req.body.body)) {
    return res.status(400).json({ error: 'Message can\u2019t be empty.' });
  }
  if (req.body.body.length > 2000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }

  const result = await pool.query(
    'INSERT INTO messages (job_id, sender_user_id, body) VALUES ($1, $2, $3) RETURNING *',
    [job.id, req.session.userId, req.body.body.trim()]
  );

  const recipientUserId = job.client_user_id === req.session.userId ? job.provider_user_id : job.client_user_id;
  if (recipientUserId) {
    const senderName = job.client_user_id === req.session.userId ? (job.client_name || job.client_email) : job.provider_name;
    createNotification(recipientUserId, 'new_message', `New message from ${senderName}`, `/message-thread.html?jobId=${job.id}`);
  }

  res.json({ message: result.rows[0] });
}));

// --- Notifications ---

app.get('/api/notifications', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [req.session.userId]
  );
  const unreadResult = await pool.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [req.session.userId]
  );
  res.json({ notifications: result.rows, unreadCount: unreadResult.rows[0].count });
}));

app.post('/api/notifications/read', requireLogin, asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [req.session.userId]
  );
  res.json({ message: 'Marked as read.' });
}));

// --- 404 and error handling (must be last, after all routes) ---

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
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
