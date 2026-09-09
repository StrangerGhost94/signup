const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory "database" — resets on every restart/deploy.
// Good enough for a starter project; swap for a real DB later.
const users = [];

// Seed data for handyman workers. Swap for a real DB later.
const workers = [
  { id: 1, name: 'James Okello', category: 'Plumbing', location: 'Kampala Central', rating: 4.8, phone: '+256701111111', bio: 'Pipe repairs, leak fixes, bathroom installs. 8 years experience.' },
  { id: 2, name: 'Sarah Nambi', category: 'Electrical', location: 'Ntinda', rating: 4.9, phone: '+256702222222', bio: 'Wiring, sockets, fault diagnosis. Licensed electrician.' },
  { id: 3, name: 'Moses Kato', category: 'Carpentry', location: 'Bugolobi', rating: 4.6, phone: '+256703333333', bio: 'Furniture repair, custom shelving, door fitting.' },
  { id: 4, name: 'Grace Auma', category: 'Painting', location: 'Kololo', rating: 4.7, phone: '+256704444444', bio: 'Interior and exterior painting, feature walls.' },
  { id: 5, name: 'Peter Ssali', category: 'Cleaning', location: 'Naalya', rating: 4.5, phone: '+256705555555', bio: 'Deep cleaning, move-in/move-out cleaning, offices.' },
  { id: 6, name: 'Ruth Achieng', category: 'Gardening', location: 'Muyenga', rating: 4.8, phone: '+256706666666', bio: 'Landscaping, lawn care, hedge trimming.' },
  { id: 7, name: 'David Wamala', category: 'Moving', location: 'Kansanga', rating: 4.4, phone: '+256707777777', bio: 'House and office moving, has own truck.' },
  { id: 8, name: 'Betty Nakato', category: 'Plumbing', location: 'Kyanja', rating: 4.6, phone: '+256708888888', bio: 'Kitchen and bathroom plumbing specialist.' },
  { id: 9, name: 'Isaac Mugisha', category: 'Electrical', location: 'Bukoto', rating: 4.7, phone: '+256709999999', bio: 'Generator installs, solar wiring, home rewiring.' },
  { id: 10, name: 'Florence Atim', category: 'Carpentry', location: 'Nakawa', rating: 4.5, phone: '+256700000001', bio: 'Kitchen cabinets, wardrobes, general woodwork.' }
];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

function requireLogin(req, res, next) {
  if (!req.session.userEmail) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

// --- Auth routes ---

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (users.find(u => u.email === email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  users.push({ email, passwordHash });

  req.session.userEmail = email;
  res.json({ message: 'Account created.', email });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  req.session.userEmail = email;
  res.json({ message: 'Logged in.', email });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out.' });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userEmail) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  res.json({ email: req.session.userEmail });
});

// --- Worker search routes (protected: must be logged in) ---

app.get('/api/categories', requireLogin, (req, res) => {
  const categories = [...new Set(workers.map(w => w.category))].sort();
  res.json({ categories });
});

app.get('/api/workers', requireLogin, (req, res) => {
  const { search, category } = req.query;
  let results = workers;

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
