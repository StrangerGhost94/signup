const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const nodemailer = require('nodemailer');
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const pushConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails('mailto:support@handylink.example', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('Push notifications not configured — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable them.');
}
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
  'Moving': 165000,
  'Mechanical': 125000,
  'Realtor': 175000,
  'Construction': 1150000
};

const SEED_PROVIDERS = [
  { name: 'James Okello', category: 'Plumbing', location: 'Kampala Central', rating: 4.8, phone: '+256701111111', bio: 'Pipe repairs, leak fixes, bathroom installs. 8 years experience.' },
  { name: 'Sarah Nambi', category: 'Electrical', location: 'Ntinda', rating: 4.9, phone: '+256702222222', bio: 'Wiring, sockets, fault diagnosis. Licensed electrician.' },
  { name: 'Moses Kato', category: 'Carpentry', location: 'Bugolobi', rating: 4.6, phone: '+256703333333', bio: 'Furniture repair, custom shelving, door fitting.' },
  { name: 'Grace Auma', category: 'Painting', location: 'Kololo', rating: 4.7, phone: '+256704444444', bio: 'Interior and exterior painting, feature walls.' },
  { name: 'Peter Ssali', category: 'Cleaning', location: 'Naalya', rating: 4.5, phone: '+256705555555', bio: 'Deep cleaning, move-in/move-out cleaning, offices.' },
  { name: 'Ruth Achieng', category: 'Construction', location: 'Muyenga', rating: 4.8, phone: '+256706666666', bio: 'Renovations, extensions, site supervision.' },
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
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS experience_years INTEGER
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
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
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

  // Migration: richer location metadata (spec section 3). accuracy/
  // updated_at let the matching engine judge how fresh/trustworthy a
  // location is; formatted_address/city/district are the human-readable
  // fields shown to customers instead of raw coordinates.
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS location_accuracy NUMERIC`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS formatted_address TEXT`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS city TEXT`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS district TEXT`);

  // Migration: operating radius and travel preferences (spec section 4).
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS service_radius_km INTEGER DEFAULT 10`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS long_distance_jobs_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS emergency_travel_enabled BOOLEAN NOT NULL DEFAULT FALSE`);

  // Migration: professional type (section 2) and availability (section 11).
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS professional_type TEXT
    CHECK (professional_type IN ('individual','employee','company'))`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS availability_status TEXT NOT NULL DEFAULT 'available_later'
    CHECK (availability_status IN ('available_now','available_today','available_later','not_available'))`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS accepts_emergency BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS accepts_same_day BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS weekly_schedule JSONB`);

  // Migration: pricing preferences (section 10) — structured, not one
  // forced universal price. The AI pricing engine still produces the
  // estimate; this is what the provider does with it.
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS pricing_methods JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS callout_fee INTEGER`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS inspection_fee INTEGER`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS hourly_rate INTEGER`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS minimum_charge INTEGER`);
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS provides_own_materials TEXT
    CHECK (provides_own_materials IN ('yes','no','depends'))`);

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

  // "Schedule" urgency previously had no way to actually record when —
  // this is the real date/time a scheduled job is booked for.
  await pool.query(`
    ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMP
  `);

  // ============================================================
  // JOB STATE MACHINE, TIMELINE & OFFERS
  // Real states matching the full service-management lifecycle, a
  // system-events timeline kept separate from Messages, and genuine
  // multi-provider quote comparison. All additive/safe — the existing
  // direct-booking flow (a job created with one provider already chosen)
  // keeps working exactly as before; "awaiting_offers" is a new,
  // optional path for jobs posted without picking a provider first.
  // ============================================================

  // provider_id becomes nullable — an open job (awaiting offers) has no
  // assigned provider yet. Every existing job already has one, so this
  // is safe: nothing currently NULL becomes NULL as a result.
  await pool.query(`ALTER TABLE job_requests ALTER COLUMN provider_id DROP NOT NULL`);

  // Widen the status enum to the full real lifecycle.
  await pool.query(`ALTER TABLE job_requests DROP CONSTRAINT IF EXISTS job_requests_status_check`);
  await pool.query(`
    ALTER TABLE job_requests ADD CONSTRAINT job_requests_status_check CHECK (status IN (
      'awaiting_offers', 'requested', 'accepted', 'on_the_way', 'arrived', 'in_progress',
      'awaiting_payment', 'completed', 'declined', 'cancelled'
    ))
  `);

  // Timeline: every meaningful state change or system event on a job,
  // shown to the customer as a job timeline — deliberately separate
  // from the messages table, which stays for actual conversation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_events (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Competing quotes from multiple providers on an open (awaiting_offers)
  // job. Kept distinct from price_change_requests, which is for
  // renegotiating an already-accepted, already-assigned job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_offers (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      labour_amount INTEGER NOT NULL,
      materials_amount INTEGER NOT NULL DEFAULT 0,
      total_amount INTEGER NOT NULL,
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(job_id, provider_id)
    )
  `);

  // Migration: the actually-agreed price, separate from the original
  // estimate. NULL means "no price change has ever been approved — the
  // original estimate stands." Only ever set via an accepted price-change
  // request, never directly by a provider.
  await pool.query(`
    ALTER TABLE job_requests ADD COLUMN IF NOT EXISTS final_amount INTEGER
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

  // Migration: sub-category ratings (spec section 9) and a lightweight
  // suspicious-pattern flag for admin review — never auto-hides a review,
  // just marks it for a human to look at.
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS quality_rating INTEGER CHECK (quality_rating BETWEEN 1 AND 5)`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS punctuality_rating INTEGER CHECK (punctuality_rating BETWEEN 1 AND 5)`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS professionalism_rating INTEGER CHECK (professionalism_rating BETWEEN 1 AND 5)`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS communication_rating INTEGER CHECK (communication_rating BETWEEN 1 AND 5)`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS price_fairness_rating INTEGER CHECK (price_fairness_rating BETWEEN 1 AND 5)`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS flagged_suspicious BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS flag_reason TEXT`);

  // Migration: account-level status, usable for both clients and
  // providers — distinct from providers.approval_status, which only
  // governs whether a provider can appear in search/receive jobs.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'NORMAL'`);

  // Migration: real location tracking for clients too — previously only
  // providers had this, and clients had nothing (the UI just showed a
  // hardcoded "Kampala"). Mirrors the providers.latitude/longitude etc.
  // fields added earlier.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude NUMERIC`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude NUMERIC`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_accuracy NUMERIC`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMP`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS formatted_address TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS district TEXT`);

  // Simple master toggle for now — real and checked by createNotification
  // below, not decorative. Per-category granularity can be added later
  // without touching this column.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE`);

  // Granular categories instead of one all-or-nothing switch, plus an
  // optional quiet-hours window that silences push (but keeps the
  // in-app notification waiting) rather than losing it outright.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_categories JSONB NOT NULL DEFAULT '{"jobs":true,"messages":true,"offers":true,"payments":true}'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_start SMALLINT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_end SMALLINT`);

  // Real push notifications — delivered to the device even when the app
  // isn't open, unlike the in-app bell (which only works while a tab is
  // active and polling). One row per subscribed device/browser.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'other' CHECK (label IN ('home','work','other')),
      address_text TEXT NOT NULL,
      notes TEXT DEFAULT '',
      latitude NUMERIC,
      longitude NUMERIC,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_user_id, provider_id)
    )
  `);


  // Migration: lightweight off-platform-payment / scam-language flag on
  // messages — detected, never auto-blocked, visible to admins only.
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS flag_reason TEXT`);

  // ============================================================
  // TRUST, VERIFICATION, SAFETY & ANTI-FRAUD — PHASE 1
  // Schema and architecture only. No onboarding/admin/UI wiring
  // yet — that's Phases 2-9. Every new table here is additive;
  // nothing existing is altered except providers.approval_status
  // below, which grandfathers all current providers safely.
  // ============================================================

  // Formal service catalog (source of truth for verification; the
  // client-facing category list in categories.js is unaffected).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Per-service verification: a provider can offer several services,
  // each independently PENDING/VERIFIED/REJECTED/etc.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_services (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      verification_status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (verification_status IN ('PENDING','IN_REVIEW','VERIFIED','REJECTED','SUSPENDED','EXPIRED')),
      verified_by INTEGER REFERENCES users(id),
      verified_at TIMESTAMP,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(provider_id, service_id)
    )
  `);

  // ============================================================
  // HANDYMAN PROFILE & INTELLIGENT MATCHING — PHASE 1 (schema only)
  // ============================================================

  // Sub-service taxonomy, admin-configurable (no code deploy needed to
  // add one — same pattern as `services` itself).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS specialties (
      id SERIAL PRIMARY KEY,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(service_id, slug)
    )
  `);

  // Which specialties a provider claims, per service they offer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS worker_service_specialties (
      id SERIAL PRIMARY KEY,
      worker_service_id INTEGER NOT NULL REFERENCES worker_services(id) ON DELETE CASCADE,
      specialty_id INTEGER NOT NULL REFERENCES specialties(id) ON DELETE CASCADE,
      UNIQUE(worker_service_id, specialty_id)
    )
  `);

  // Section 20's critical distinction: this is HANDYMAN-REPORTED
  // experience per service, kept deliberately separate from the
  // PLATFORM-MEASURED completed-job count already computable from
  // job_requests. Neither ever overwrites the other.
  await pool.query(`ALTER TABLE worker_services ADD COLUMN IF NOT EXISTS reported_experience_level TEXT
    CHECK (reported_experience_level IN ('less_than_1','1_2','3_5','6_10','10_plus'))`);
  await pool.query(`ALTER TABLE worker_services ADD COLUMN IF NOT EXISTS reported_jobs_range TEXT
    CHECK (reported_jobs_range IN ('0_10','11_25','26_50','51_100','101_250','250_plus'))`);

  // Portfolio: supporting evidence, explicitly not proof of qualification
  // on its own (spec section 9).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      photo TEXT NOT NULL,
      job_type TEXT,
      description TEXT DEFAULT '',
      approx_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Configurable weight profiles for the matching engine (Phase 3), keyed
  // by scenario so emergency/planned/technical jobs can weigh factors
  // differently, per spec section 15. Admin-editable, not hard-coded
  // into application logic once Phase 3 reads from this table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matching_weight_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      skill_weight INTEGER NOT NULL DEFAULT 30,
      reliability_weight INTEGER NOT NULL DEFAULT 25,
      distance_weight INTEGER NOT NULL DEFAULT 15,
      price_weight INTEGER NOT NULL DEFAULT 15,
      experience_weight INTEGER NOT NULL DEFAULT 10,
      availability_weight INTEGER NOT NULL DEFAULT 5,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Identity / phone / business verification — independent of skill verification.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verifications (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('identity', 'phone', 'business')),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','IN_REVIEW','VERIFIED','REJECTED','SUSPENDED','EXPIRED')),
      submitted_at TIMESTAMP,
      reviewed_at TIMESTAMP,
      reviewed_by INTEGER REFERENCES users(id),
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(provider_id, type)
    )
  `);

  // Sensitive documents (ID photos, selfies, etc). Deliberately has no
  // public-facing GET route anywhere in this phase — admin-only access
  // is enforced when Phase 3 builds the review dashboard. Never joined
  // into any provider-listing or search query.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_documents (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      verification_type TEXT NOT NULL CHECK (verification_type IN ('identity','phone','business','skill','credential')),
      document_type TEXT NOT NULL,
      file_data TEXT NOT NULL,
      uploaded_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Professional credentials/licenses, optionally tied to a specific service.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credentials (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      credential_type TEXT NOT NULL,
      issuing_organization TEXT,
      credential_number TEXT,
      issue_date DATE,
      expiry_date DATE,
      evidence_document TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','IN_REVIEW','VERIFIED','REJECTED','SUSPENDED','EXPIRED')),
      reviewed_by INTEGER REFERENCES users(id),
      verified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Append-only audit trail. No UPDATE/DELETE route will ever be built
  // against this table from a normal user-facing interface.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Safety reports — works in both directions (client reports worker,
  // worker reports client), per the spec's worker-protection section.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES job_requests(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      attachment TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED','DISMISSED')),
      admin_notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS disputes (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      raised_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED','DISMISSED')),
      resolution_notes TEXT DEFAULT '',
      resolved_by INTEGER REFERENCES users(id),
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS suspensions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      start_date TIMESTAMP DEFAULT NOW(),
      end_date TIMESTAMP,
      admin_id INTEGER REFERENCES users(id),
      notes TEXT DEFAULT '',
      appeal_status TEXT NOT NULL DEFAULT 'NONE' CHECK (appeal_status IN ('NONE','REQUESTED','REVIEWED')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Price change requests: a worker cannot silently rebill — this table
  // is the audit trail. Wiring the accept/decline UI flow is Phase 5.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_change_requests (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      requested_by INTEGER NOT NULL REFERENCES users(id),
      original_amount INTEGER NOT NULL,
      new_amount INTEGER NOT NULL,
      labour_amount INTEGER,
      materials_amount INTEGER,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED')),
      decided_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Payment architecture, ready for a real processor (Mobile Money, card,
  // bank) to be plugged in later. No processor is integrated in Phase 1 —
  // this only gives every future transaction somewhere correct to land,
  // including honestly-marked CASH transactions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
      client_user_id INTEGER NOT NULL REFERENCES users(id),
      provider_id INTEGER NOT NULL REFERENCES providers(id),
      amount INTEGER NOT NULL,
      platform_fee INTEGER NOT NULL DEFAULT 0,
      method TEXT NOT NULL CHECK (method IN ('mobile_money','card','bank','cash')),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED','REFUNDED')),
      reference_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // --- Safe, additive approval-gate migration ---
  // Add the column nullable first, so it doesn't fail against existing rows.
  await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS approval_status TEXT`);
  // Grandfather every existing provider (including seed data) as already
  // approved — nothing currently visible in search or able to accept jobs
  // is affected by turning this gate on.
  await pool.query(`UPDATE providers SET approval_status = 'APPROVED' WHERE approval_status IS NULL`);
  // Only NOW set the default and NOT NULL, so new signups going forward
  // start PENDING and existing rows are untouched by this line.
  await pool.query(`ALTER TABLE providers ALTER COLUMN approval_status SET DEFAULT 'PENDING'`);
  await pool.query(`ALTER TABLE providers ALTER COLUMN approval_status SET NOT NULL`);

  // Seed the formal services catalog from the existing category list,
  // and back-fill worker_services + verifications for existing providers
  // so later phases (trust badges, admin dashboard) have consistent data
  // instead of holes for every account that predates this feature.
  const SERVICE_SEED = ['Plumbing', 'Electrical', 'Carpentry', 'Painting', 'Cleaning', 'Moving', 'Mechanical', 'Realtor', 'Construction'];
  for (const name of SERVICE_SEED) {
    await pool.query(
      `INSERT INTO services (name, slug) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
      [name, name.toLowerCase()]
    );
  }

  // Removing a service safely means deactivating it, not deleting it —
  // any existing provider, booking, or specialty tied to Gardening keeps
  // working exactly as it did; it just no longer appears as a selectable
  // option for anyone new.
  await pool.query(`UPDATE services SET active = FALSE WHERE name = 'Gardening'`);

  // Seed the specialty taxonomy (spec section 5), admin-editable from
  // here on — this is a one-time bootstrap, not a hard-coded limit.
  const SPECIALTY_SEED = {
    'Plumbing': ['Sink repair', 'Pipe leaks', 'Toilet repair', 'Drain blockage', 'Tap/faucet repair', 'Water heater', 'Water tank installation', 'Pipe installation', 'Bathroom plumbing'],
    'Electrical': ['Socket/switch repair', 'Lighting', 'Wiring', 'Circuit breaker', 'Fault finding', 'Generator installation', 'Solar'],
    'Carpentry': ['Furniture repair', 'Door repair', 'Cabinet installation', 'Shelving', 'Woodwork'],
    'Painting': ['Interior painting', 'Exterior painting', 'Wall preparation', 'Repainting', 'Decorative painting'],
    'Cleaning': ['Deep cleaning', 'Move-in/move-out cleaning', 'Office cleaning', 'Post-construction cleaning'],
    'Moving': ['House moving', 'Office moving', 'Furniture moving', 'Packing'],
    'Mechanical': ['Engine repair', 'Brake service', 'Diagnostics', 'General maintenance'],
    'Realtor': ['Property viewing', 'Rental listing', 'Property valuation', 'Tenant sourcing', 'Sale negotiation'],
    'Construction': ['Foundation work', 'Roofing', 'Masonry', 'Renovation', 'Extension/additions', 'Site supervision']
  };
  for (const [serviceName, specs] of Object.entries(SPECIALTY_SEED)) {
    const svcRow = await pool.query('SELECT id FROM services WHERE name = $1', [serviceName]);
    if (svcRow.rows.length === 0) continue;
    for (const specName of specs) {
      const slug = specName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      await pool.query(
        `INSERT INTO specialties (service_id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (service_id, slug) DO NOTHING`,
        [svcRow.rows[0].id, specName, slug]
      );
    }
  }

  // Seed the three example weight profiles from spec section 15. Admins
  // can add more or edit these once Phase 5's admin UI exists — the
  // matching engine (Phase 3) will read from this table, not a
  // hard-coded formula.
  const WEIGHT_PROFILE_SEED = [
    { name: 'emergency', skill: 30, reliability: 20, distance: 25, price: 5, experience: 10, availability: 10 },
    { name: 'planned', skill: 25, reliability: 25, distance: 10, price: 15, experience: 20, availability: 5 },
    { name: 'technical', skill: 35, reliability: 25, distance: 10, price: 5, experience: 20, availability: 5 },
    { name: 'default', skill: 30, reliability: 25, distance: 15, price: 15, experience: 10, availability: 5 }
  ];
  for (const w of WEIGHT_PROFILE_SEED) {
    await pool.query(
      `INSERT INTO matching_weight_profiles (name, skill_weight, reliability_weight, distance_weight, price_weight, experience_weight, availability_weight, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (name) DO NOTHING`,
      [w.name, w.skill, w.reliability, w.distance, w.price, w.experience, w.availability, w.name === 'default']
    );
  }

  const existingProviders = await pool.query('SELECT id, category FROM providers');
  for (const p of existingProviders.rows) {
    const svc = await pool.query('SELECT id FROM services WHERE name = $1', [p.category]);
    if (svc.rows.length > 0) {
      await pool.query(
        `INSERT INTO worker_services (provider_id, service_id, verification_status, verified_at)
         VALUES ($1, $2, 'VERIFIED', NOW()) ON CONFLICT (provider_id, service_id) DO NOTHING`,
        [p.id, svc.rows[0].id]
      );
    }
    for (const type of ['identity', 'phone']) {
      await pool.query(
        `INSERT INTO verifications (provider_id, type, status, reviewed_at)
         VALUES ($1, $2, 'VERIFIED', NOW()) ON CONFLICT (provider_id, type) DO NOTHING`,
        [p.id, type]
      );
    }
  }

  // ============================================================
  // AI JOB ASSESSMENT & PRICING ENGINE — PHASES 1-4
  // The AI identifies WHAT a job is; this pricing engine (not the AI)
  // determines HOW MUCH it costs, using admin-configurable rules. If no
  // AI provider is configured, or the AI call fails, the app falls back
  // to exactly the static per-category estimate that already existed —
  // nothing about the existing request/matches flow breaks.
  // ============================================================

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id SERIAL PRIMARY KEY,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      job_type TEXT NOT NULL DEFAULT 'general',
      labour_min INTEGER NOT NULL,
      labour_max INTEGER NOT NULL,
      materials_min INTEGER NOT NULL DEFAULT 0,
      materials_max INTEGER NOT NULL DEFAULT 0,
      urgency_now_fee INTEGER NOT NULL DEFAULT 0,
      urgency_today_fee INTEGER NOT NULL DEFAULT 0,
      urgency_schedule_fee INTEGER NOT NULL DEFAULT 0,
      distance_5_10_fee INTEGER NOT NULL DEFAULT 0,
      distance_10plus_fee INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(service_id, job_type)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_assessments (
      id SERIAL PRIMARY KEY,
      client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id INTEGER REFERENCES job_requests(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      photos JSONB NOT NULL DEFAULT '[]',
      service TEXT,
      job_type TEXT,
      problem_summary TEXT,
      complexity TEXT CHECK (complexity IN ('EASY','MEDIUM','COMPLEX','UNKNOWN')),
      likely_materials JSONB NOT NULL DEFAULT '[]',
      labour_min INTEGER, labour_max INTEGER,
      materials_min INTEGER, materials_max INTEGER,
      total_min INTEGER, total_max INTEGER,
      confidence TEXT CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
      requires_inspection BOOLEAN NOT NULL DEFAULT TRUE,
      questions JSONB NOT NULL DEFAULT '[]',
      ai_raw_response JSONB,
      source TEXT NOT NULL DEFAULT 'FALLBACK' CHECK (source IN ('AI','FALLBACK')),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Migration: track where the shown price actually came from (pricing
  // rules vs real historical job data), for admin transparency. Uses
  // ALTER, not the CREATE TABLE above, since that table may already
  // exist from an earlier deploy.
  await pool.query(`ALTER TABLE job_assessments ADD COLUMN IF NOT EXISTS pricing_source TEXT`);
  await pool.query(`ALTER TABLE job_assessments ADD COLUMN IF NOT EXISTS pricing_sample_count INTEGER`);

  // Seed pricing rules from the existing static estimate ranges, split
  // roughly 60% labour / 40% materials as an editable starting point —
  // this is exactly the "existing pricing" the pricing engine now reads
  // instead of ever letting the AI invent a number.
  const PRICING_SEED = {
    'Plumbing': { lMin: 18000, lMax: 36000, mMin: 12000, mMax: 24000 },
    'Electrical': { lMin: 24000, lMax: 48000, mMin: 16000, mMax: 32000 },
    'Carpentry': { lMin: 21000, lMax: 54000, mMin: 14000, mMax: 36000 },
    'Painting': { lMin: 90000, lMax: 300000, mMin: 60000, mMax: 200000 },
    'Cleaning': { lMin: 15000, lMax: 42000, mMin: 10000, mMax: 28000 },
    'Moving': { lMin: 48000, lMax: 150000, mMin: 32000, mMax: 100000 },
    'Mechanical': { lMin: 30000, lMax: 120000, mMin: 20000, mMax: 80000 },
    'Realtor': { lMin: 35000, lMax: 210000, mMin: 15000, mMax: 90000 },
    'Construction': { lMin: 120000, lMax: 800000, mMin: 180000, mMax: 1200000 }
  };
  for (const [name, r] of Object.entries(PRICING_SEED)) {
    const svc = await pool.query('SELECT id FROM services WHERE name = $1', [name]);
    if (svc.rows.length > 0) {
      await pool.query(
        `INSERT INTO pricing_rules (service_id, job_type, labour_min, labour_max, materials_min, materials_max, urgency_now_fee, urgency_today_fee, distance_5_10_fee, distance_10plus_fee)
         VALUES ($1, 'general', $2, $3, $4, $5, 15000, 5000, 5000, 10000)
         ON CONFLICT (service_id, job_type) DO NOTHING`,
        [svc.rows[0].id, r.lMin, r.lMax, r.mMin, r.mMax]
      );
    }
  }


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

  // Fix every foreign key to users(id) that was created with no ON
  // DELETE behavior at all — Postgres defaults those to NO ACTION,
  // which blocks deleting a user outright (a constraint violation) the
  // moment they have any related row, which is true for nearly any real
  // account. This is the actual cause of admin user-deletion failing.
  // Looked up dynamically rather than guessing Postgres's auto-generated
  // constraint names, then recreated with the semantically correct
  // action: SET NULL for "who reviewed/actioned this" audit-style
  // references (the record should survive, just anonymized), CASCADE
  // for core participant references (the row belongs to that user).
  const FK_FIXES = [
    { table: 'worker_services', column: 'verified_by', action: 'SET NULL' },
    { table: 'verifications', column: 'reviewed_by', action: 'SET NULL' },
    { table: 'credentials', column: 'reviewed_by', action: 'SET NULL' },
    { table: 'disputes', column: 'resolved_by', action: 'SET NULL' },
    { table: 'suspensions', column: 'admin_id', action: 'SET NULL' },
    { table: 'price_change_requests', column: 'requested_by', action: 'CASCADE' },
    { table: 'payments', column: 'client_user_id', action: 'CASCADE' }
  ];
  for (const fix of FK_FIXES) {
    try {
      const constraintResult = await pool.query(`
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1 AND kcu.column_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
      `, [fix.table, fix.column]);
      if (constraintResult.rows.length === 0) continue;
      const constraintName = constraintResult.rows[0].constraint_name;

      // SET NULL requires the column itself to allow NULL.
      if (fix.action === 'SET NULL') {
        await pool.query(`ALTER TABLE ${fix.table} ALTER COLUMN ${fix.column} DROP NOT NULL`);
      }
      await pool.query(`ALTER TABLE ${fix.table} DROP CONSTRAINT "${constraintName}"`);
      await pool.query(`ALTER TABLE ${fix.table} ADD CONSTRAINT ${fix.table}_${fix.column}_fkey
        FOREIGN KEY (${fix.column}) REFERENCES users(id) ON DELETE ${fix.action}`);
    } catch (err) {
      console.error(`Failed to fix FK ${fix.table}.${fix.column}:`, err.message);
    }
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Always revalidate HTML/JS/CSS with the server before using any
    // cached copy — this is what guarantees a deploy is visible on the
    // very next page load instead of a browser or PWA silently serving
    // a stale version it cached from before the update.
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

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

// AI calls cost real money per request — cap much more tightly than
// general auth actions to prevent runaway spend from abuse or accidental
// retry loops (see spec section 19, "cost control").
const aiAssessLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many assessment requests. Please wait a few minutes and try again.' }
});

async function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  // Combined into one query: checks account status (must be current, not
  // stale from when they logged in) and updates presence in the same trip.
  const result = await pool.query(
    'UPDATE users SET last_active_at = NOW() WHERE id = $1 RETURNING account_status',
    [req.session.userId]
  ).catch(() => null);
  if (result && result.rows[0] && (result.rows[0].account_status === 'SUSPENDED' || result.rows[0].account_status === 'BANNED')) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'This account has been suspended.' });
  }
  next();
}

// Maps a notification's internal type to one of the 4 user-facing
// categories. Defaults unmatched/future types to 'jobs' deliberately —
// a notification should never silently bypass the user's preferences
// just because it's a new type nobody's categorized yet.
function categorizeNotificationType(type) {
  if (type === 'new_message') return 'messages';
  if (type === 'new_offer' || type === 'offer_accepted' || type === 'offer_declined') return 'offers';
  if (type === 'payment_recorded') return 'payments';
  return 'jobs';
}

function pushTitleForCategory(category) {
  return { jobs: 'Job update', messages: 'New message', offers: 'Offer update', payments: 'Payment update' }[category] || 'HandyLink';
}

// Quiet hours use the server's local hour — a real limitation, since
// the server doesn't know each user's actual timezone. Good enough for
// a single-country marketplace; would need a stored user timezone to
// be fully correct elsewhere.
function isWithinQuietHours(startHour, endHour) {
  if (startHour == null || endHour == null || startHour === endHour) return false;
  const currentHour = new Date().getHours();
  if (startHour < endHour) return currentHour >= startHour && currentHour < endHour;
  return currentHour >= startHour || currentHour < endHour; // wraps past midnight
}

async function createNotification(userId, type, body, link) {
  try {
    const pref = await pool.query(
      'SELECT notifications_enabled, notification_categories, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1',
      [userId]
    );
    if (pref.rows.length === 0) return;
    const user = pref.rows[0];
    if (user.notifications_enabled === false) return; // master switch, respected here not just in the UI

    const category = categorizeNotificationType(type);
    const categories = user.notification_categories || {};
    if (categories[category] === false) return; // this category specifically turned off

    await pool.query(
      'INSERT INTO notifications (user_id, type, body, link) VALUES ($1, $2, $3, $4)',
      [userId, type, body, link || null]
    );

    // Quiet hours silence the push, not the notification itself — it's
    // still there waiting in the bell when they next open the app.
    if (!isWithinQuietHours(user.quiet_hours_start, user.quiet_hours_end)) {
      sendPushToUser(userId, pushTitleForCategory(category), body, link);
    }
  } catch (err) {
    console.error('Notification creation failed:', err);
  }
}

// Delivers to the device even when no tab is open — this is what makes
// notifications actually arrive on the phone, not just show up next time
// someone happens to open the app. Silently does nothing if push isn't
// configured (no VAPID keys) or the user has no subscribed device.
async function sendPushToUser(userId, title, body, link) {
  if (!pushConfigured) return;
  try {
    const subs = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
    const payload = JSON.stringify({ title, body, url: link || '/' });
    for (const sub of subs.rows) {
      const pushSubscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      webpush.sendNotification(pushSubscription, payload).catch(async (err) => {
        // 404/410 means the browser has permanently invalidated this
        // subscription (uninstalled, permission revoked, etc.) — clean
        // it up rather than retry a dead endpoint forever.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]).catch(() => {});
        } else {
          console.error('Push send failed:', err.message);
        }
      });
    }
  } catch (err) {
    console.error('Push lookup failed:', err.message);
  }
}

// The one place a job timeline entry gets written — kept deliberately
// separate from messages, which stay for actual conversation between
// the two parties. Every real state change calls this.
async function recordJobEvent(jobId, eventType, description, actorUserId) {
  try {
    await pool.query(
      'INSERT INTO job_events (job_id, event_type, description, actor_user_id) VALUES ($1, $2, $3, $4)',
      [jobId, eventType, description, actorUserId || null]
    );
  } catch (err) {
    console.error('Job event recording failed:', err);
  }
}

// Append-only audit trail. Call this from every sensitive admin/system
// action (verification decisions, suspensions, price-change resolution,
// payment status changes) once those actions exist in later phases.
// Never logs raw sensitive document contents — only IDs and short notes.
async function createAuditLog(actorUserId, action, targetType, targetId, notes) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, notes) VALUES ($1, $2, $3, $4, $5)',
      [actorUserId || null, action, targetType || null, targetId || null, notes || '']
    );
  } catch (err) {
    console.error('Audit log write failed:', err);
  }
}

// ============================================================
// CENTRALIZED APPROVAL ENGINE
// Every admin approve/reject/suspend/reinstate action in the app —
// provider applications, identity/phone verification, per-service skill
// verification, and account-level suspension — goes through this one
// function. One state machine (PENDING/IN_REVIEW/VERIFIED-or-APPROVED/
// REJECTED/SUSPENDED), one guaranteed sequence on every decision:
//   update the record → audit log → notify the affected user
// No endpoint is allowed to update a status column, write an audit log,
// or send an approval-related notification outside this function. That
// is what actually prevents the "different screens, different logic,
// stale badges" failure mode — not a naming convention.
// ============================================================

const APPROVAL_ENTITIES = {
  provider_application: {
    validDecisions: ['APPROVED', 'REJECTED', 'SUSPENDED'],
    async apply(entityId, decision) {
      const result = await pool.query(
        `UPDATE providers SET approval_status = $1 WHERE id = $2 RETURNING user_id`,
        [decision, entityId]
      );
      if (result.rows.length === 0) return null;
      return { notifyUserId: result.rows[0].user_id, auditTargetType: 'provider' };
    },
    messages: {
      APPROVED: () => 'Your HandyLink application has been approved! You can now receive jobs.',
      REJECTED: (reason) => `Your application was not approved: ${reason}`,
      SUSPENDED: (reason) => `Your account has been suspended: ${reason}`
    },
    links: { APPROVED: '/provider-dashboard.html', REJECTED: '/provider-profile.html', SUSPENDED: '/provider-profile.html' },
    // Reinstating a provider is the same transition as approving them —
    // one code path, not a separate "reinstate" implementation.
    reinstateDecision: 'APPROVED'
  },

  verification: {
    validDecisions: ['VERIFIED', 'REJECTED'],
    async apply(entityId, decision, reviewerId, reason) {
      const result = await pool.query(
        `UPDATE verifications SET status = $1, reviewed_at = NOW(), reviewed_by = $2, notes = $3
         WHERE id = $4 RETURNING provider_id, type`,
        [decision, reviewerId, reason || '', entityId]
      );
      if (result.rows.length === 0) return null;
      const providerUser = await pool.query('SELECT user_id FROM providers WHERE id = $1', [result.rows[0].provider_id]);
      return { notifyUserId: providerUser.rows[0]?.user_id, auditTargetType: 'verification', extra: result.rows[0].type };
    },
    messages: {
      VERIFIED: (reason, extra) => `Your ${extra} verification was approved.`,
      REJECTED: (reason, extra) => `Your ${extra} verification was rejected${reason ? `: ${reason}` : '.'}`
    },
    links: { VERIFIED: '/provider-profile.html', REJECTED: '/provider-profile.html' }
  },

  skill_verification: {
    validDecisions: ['VERIFIED', 'REJECTED'],
    async apply(entityId, decision, reviewerId, reason) {
      const result = await pool.query(
        `UPDATE worker_services SET verification_status = $1, verified_by = $2, verified_at = NOW(), notes = $3
         WHERE id = $4 RETURNING provider_id, service_id`,
        [decision, reviewerId, reason || '', entityId]
      );
      if (result.rows.length === 0) return null;
      const svcName = await pool.query('SELECT name FROM services WHERE id = $1', [result.rows[0].service_id]);
      const providerUser = await pool.query('SELECT user_id FROM providers WHERE id = $1', [result.rows[0].provider_id]);
      return { notifyUserId: providerUser.rows[0]?.user_id, auditTargetType: 'worker_service', extra: svcName.rows[0]?.name || 'service' };
    },
    messages: {
      VERIFIED: (reason, extra) => `Your ${extra} verification was approved.`,
      REJECTED: (reason, extra) => `Your ${extra} verification was rejected${reason ? `: ${reason}` : '.'}`
    },
    links: { VERIFIED: '/provider-profile.html', REJECTED: '/provider-profile.html' }
  },

  user_account: {
    validDecisions: ['SUSPENDED', 'NORMAL'],
    async apply(entityId, decision, reviewerId, reason) {
      const result = await pool.query(`UPDATE users SET account_status = $1 WHERE id = $2 RETURNING id`, [decision, entityId]);
      if (result.rows.length === 0) return null;
      if (decision === 'SUSPENDED') {
        await pool.query('INSERT INTO suspensions (user_id, reason, admin_id) VALUES ($1,$2,$3)', [entityId, reason, reviewerId]);
      } else {
        await pool.query(`UPDATE suspensions SET active = FALSE, end_date = NOW() WHERE user_id = $1 AND active = TRUE`, [entityId]);
      }
      return { notifyUserId: entityId, auditTargetType: 'user' };
    },
    messages: {
      SUSPENDED: (reason) => `Your account has been suspended: ${reason}`,
      NORMAL: () => 'Your account has been reinstated.'
    },
    links: { SUSPENDED: '/support.html', NORMAL: '/dashboard.html' },
    reinstateDecision: 'NORMAL'
  }
};

async function processApprovalDecision({ entityType, entityId, decision, reviewerId, reason }) {
  const config = APPROVAL_ENTITIES[entityType];
  if (!config) return { error: 'Unknown approval entity type.', status: 400 };
  if (!config.validDecisions.includes(decision)) {
    return { error: 'Invalid decision for this item.', status: 400 };
  }
  if (decision === 'REJECTED' && !isNonEmpty(reason)) {
    return { error: 'Please provide a reason.', status: 400 };
  }

  const applied = await config.apply(entityId, decision, reviewerId, reason);
  if (!applied) return { error: 'Item not found.', status: 404 };

  // One guaranteed sequence, every time, for every entity type:
  await createAuditLog(reviewerId, `${entityType.toUpperCase()}_${decision}`, applied.auditTargetType, entityId, reason || '');
  if (applied.notifyUserId) {
    const messageFn = config.messages[decision];
    const link = config.links[decision];
    createNotification(applied.notifyUserId, `${entityType}_${decision.toLowerCase()}`, messageFn(reason, applied.extra), link);
  }

  return { ok: true };
}

// Clean seam for a real identity-verification provider (e.g. Smile
// Identity, Onfido). No provider is configured yet, so every submission
// just lands as PENDING for manual admin review — nothing here fakes an
// automatic "verified" result. Swap the body of `verify()` for a real
// API call once credentials exist; nothing else needs to change.
// Reverse geocoding — turns raw GPS coordinates into a human-readable
// area, so what's ever shown publicly is "Ntinda, Kampala" rather than
// exact coordinates. Uses OpenStreetMap's Nominatim, which needs no API
// key. Their usage policy requires a descriptive User-Agent and asks
// callers not to hammer it — fine here since this only runs when a user
// explicitly sets their location, not on every request.
async function reverseGeocode(lat, lng) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`,
      { headers: { 'User-Agent': 'HandyLink-Uganda/1.0 (marketplace app)' }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!response.ok) return { formattedAddress: null, city: null, district: null };
    const data = await response.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || null;
    const district = addr.county || addr.state_district || addr.state || null;
    return { formattedAddress: data.display_name || null, city, district };
  } catch (err) {
    console.error('Reverse geocoding failed:', err.message);
    return { formattedAddress: null, city: null, district: null };
  }
}

const identityVerificationProvider = {
  name: 'manual-review-only',
  async verify(/* documentPayload */) {
    return { automated: false, status: 'PENDING', note: 'No verification provider configured — awaiting manual admin review.' };
  }
};

// --- AI job assessment: classifier + strict schema validation ---
// The AI's only job is to say WHAT the job is (service, job type,
// complexity, likely materials). It never gets the final say on price —
// see computePricingEngine() below, which is the only source of the
// numbers actually shown to the customer.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;
// Configurable so a different free model can be swapped in via env var
// alone if this one is ever retired — OpenRouter's free-tier lineup
// changes over time, so it's worth checking openrouter.ai/models
// (filtered to "free") occasionally rather than assuming this stays
// available forever. This one supports images; a text-only free model
// would still work for the classifier but would silently ignore photos.
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-11b-vision-instruct:free';
const VALID_SERVICES = ['Plumbing', 'Electrical', 'Carpentry', 'Painting', 'Cleaning', 'Moving', 'Mechanical', 'Realtor', 'Construction', 'General Handyman', 'Other'];
// Spec section 17: work that can injure someone or cause real damage if
// done badly — booking one of these requires the provider to be VERIFIED
// for that exact service, not just generally approved on the platform.
const HIGH_RISK_SERVICES = ['Electrical', 'Mechanical', 'Construction'];

function distanceKmServer(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => v === null || v === undefined || isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const VALID_COMPLEXITY = ['EASY', 'MEDIUM', 'COMPLEX', 'UNKNOWN'];
const VALID_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];

function validateAssessmentShape(obj) {
  if (!obj || typeof obj !== 'object') return 'Response was not an object.';
  if (!VALID_SERVICES.includes(obj.service)) return 'Invalid or missing service.';
  if (typeof obj.job_type !== 'string' || !obj.job_type) return 'Missing job_type.';
  if (typeof obj.problem_summary !== 'string' || !obj.problem_summary) return 'Missing problem_summary.';
  if (!VALID_COMPLEXITY.includes(obj.complexity)) return 'Invalid complexity.';
  if (!Array.isArray(obj.likely_materials)) return 'likely_materials must be an array.';
  if (!VALID_CONFIDENCE.includes(obj.confidence)) return 'Invalid confidence.';
  if (typeof obj.requires_inspection !== 'boolean') return 'requires_inspection must be a boolean.';
  if (!Array.isArray(obj.questions)) return 'questions must be an array.';
  if (obj.questions.length > 5) return 'Too many questions.';
  return null;
}

const AI_SYSTEM_PROMPT = `You are a job classifier for HandyLink, a home-services marketplace in Uganda. A customer describes a problem, optionally with photos. Your ONLY job is to identify what kind of job this is — never estimate prices, HandyLink's own pricing engine does that.

Respond with ONLY a JSON object, no other text, matching exactly this shape:
{
  "service": one of ["Plumbing","Electrical","Carpentry","Painting","Cleaning","Moving","Mechanical","Realtor","Construction","General Handyman","Other"],
  "job_type": short string, e.g. "Kitchen sink leak",
  "problem_summary": one or two sentences, using cautious language ("appears to be", "likely", "cannot confirm without inspection") — never claim certainty, especially from a photo,
  "complexity": one of ["EASY","MEDIUM","COMPLEX","UNKNOWN"] — use UNKNOWN rather than guessing,
  "likely_materials": array of short strings, can be empty,
  "confidence": one of ["HIGH","MEDIUM","LOW"],
  "requires_inspection": boolean,
  "questions": array of at most 3-5 short follow-up questions if genuinely important information is missing, else empty array
}

For anything involving electrical work, gas, structural/load-bearing work, or other dangerous work, set requires_inspection to true and do not suggest the customer attempt it themselves in problem_summary.
Never include a price, currency amount, or cost figure anywhere in your response.`;

async function callAiJobClassifier(description, photos) {
  if (!OPENROUTER_API_KEY) {
    return { ok: false, reason: 'not_configured' };
  }

  const imageParts = (photos || []).slice(0, 3)
    .filter(photo => /^data:image\/\w+;base64,.+$/.test(photo))
    .map(photo => ({ type: 'image_url', image_url: { url: photo } }));
  const userContent = imageParts.length > 0
    ? [{ type: 'text', text: description }, ...imageParts]
    : description; // plain string when there's no image — safest, universally-supported shape

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://handylink.example',
          'X-Title': 'HandyLink'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          max_tokens: 700,
          messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: userContent }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '(no body)');
        console.error(`[AI CLASSIFIER] OpenRouter HTTP ${response.status} on attempt ${attempt + 1}:`, bodyText);
        continue;
      }
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';
      let parsed;
      try {
        parsed = JSON.parse(text.trim().replace(/^```json\s*|\s*```$/g, ''));
      } catch (err) {
        console.error(`[AI CLASSIFIER] Response wasn't valid JSON on attempt ${attempt + 1}. Raw text:`, text);
        continue; // retry once on invalid JSON
      }
      const error = validateAssessmentShape(parsed);
      if (error) {
        console.error(`[AI CLASSIFIER] Schema validation failed on attempt ${attempt + 1}:`, error, 'Parsed:', JSON.stringify(parsed));
        continue; // retry once on schema mismatch
      }
      return { ok: true, assessment: parsed, raw: data };
    } catch (err) {
      console.error(`[AI CLASSIFIER] Request threw on attempt ${attempt + 1}:`, err.message);
    }
  }
  return { ok: false, reason: 'ai_failed' };
}

// The pricing engine: the only thing allowed to produce the numbers shown
// to a customer. Reads admin-configurable pricing_rules; if none exist
// for a service, falls back to the flat ESTIMATE_MIDPOINTS-derived range.
// Historical marketplace pricing (AI spec Phase 7). Excludes any job with
// a dispute record, or a report against either party that hasn't been
// dismissed — a conservative reading of "don't use suspicious
// transactions." Uses percentiles rather than a mean so one unusually
// expensive job can't drag the estimate around.
const HISTORICAL_MIN_SAMPLE = 5;

async function getHistoricalPricing(serviceName) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS sample_size,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)::int AS median,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY amount)::int AS p25,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY amount)::int AS p75
     FROM (
       SELECT COALESCE(jr.final_amount, jr.estimate_amount) AS amount
       FROM job_requests jr
       WHERE jr.category = $1 AND jr.status = 'completed'
         AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.job_id = jr.id)
         AND NOT EXISTS (
           SELECT 1 FROM reports r WHERE r.job_id = jr.id AND r.status != 'DISMISSED'
         )
     ) sub`,
    [serviceName]
  );
  return result.rows[0];
}

async function computePricingEngine({ serviceName, urgency, distanceKm }) {
  const svc = await pool.query('SELECT id FROM services WHERE name = $1', [serviceName]);
  let rule = null;
  if (svc.rows.length > 0) {
    const ruleResult = await pool.query(
      `SELECT * FROM pricing_rules WHERE service_id = $1 AND job_type = 'general' AND active = TRUE`,
      [svc.rows[0].id]
    );
    rule = ruleResult.rows[0] || null;
  }

  if (!rule) {
    const midpoint = ESTIMATE_MIDPOINTS[serviceName] || 40000;
    return {
      labourMin: Math.round(midpoint * 0.5), labourMax: Math.round(midpoint * 0.9),
      materialsMin: Math.round(midpoint * 0.3), materialsMax: Math.round(midpoint * 0.6),
      totalMin: Math.round(midpoint * 0.8), totalMax: Math.round(midpoint * 1.5),
      source: 'fallback_midpoint'
    };
  }

  let urgencyFee = 0;
  if (urgency === 'now') urgencyFee = rule.urgency_now_fee;
  else if (urgency === 'today') urgencyFee = rule.urgency_today_fee;
  else if (urgency === 'schedule') urgencyFee = rule.urgency_schedule_fee;

  let distanceFee = 0;
  if (typeof distanceKm === 'number') {
    if (distanceKm > 10) distanceFee = rule.distance_10plus_fee;
    else if (distanceKm > 5) distanceFee = rule.distance_5_10_fee;
  }

  const historical = await getHistoricalPricing(serviceName);
  if (historical && historical.sample_size >= HISTORICAL_MIN_SAMPLE) {
    // Real completed-job data exists and passed the exclusion filters —
    // prefer it over the static formula, but keep the labour/materials
    // split proportioned the same way the admin-configured rule does,
    // so the breakdown shown to a customer stays coherent.
    const ruleLabourShare = rule.labour_min / (rule.labour_min + rule.materials_min || 1);
    return {
      labourMin: Math.round(historical.p25 * ruleLabourShare),
      labourMax: Math.round(historical.p75 * ruleLabourShare),
      materialsMin: Math.round(historical.p25 * (1 - ruleLabourShare)),
      materialsMax: Math.round(historical.p75 * (1 - ruleLabourShare)),
      totalMin: historical.p25,
      totalMax: historical.p75,
      source: 'historical',
      historicalSampleSize: historical.sample_size
    };
  }

  return {
    labourMin: rule.labour_min + urgencyFee,
    labourMax: rule.labour_max + urgencyFee,
    materialsMin: rule.materials_min,
    materialsMax: rule.materials_max,
    totalMin: rule.labour_min + rule.materials_min + urgencyFee + distanceFee,
    totalMax: rule.labour_max + rule.materials_max + urgencyFee + distanceFee,
    source: 'pricing_rules'
  };
}

function requireRole(role) {
  return async (req, res, next) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    if (req.session.role !== role) {
      return res.status(403).json({ error: 'Not authorized for this action.' });
    }
    const result = await pool.query(
      'UPDATE users SET last_active_at = NOW() WHERE id = $1 RETURNING account_status',
      [req.session.userId]
    ).catch(() => null);
    if (result && result.rows[0] && (result.rows[0].account_status === 'SUSPENDED' || result.rows[0].account_status === 'BANNED')) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'This account has been suspended.' });
    }
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
  let selectedServices = [];
  if (role === 'provider') {
    const {
      category, location, bio, photo, services, experienceYears, idDocument, selfie,
      professionalType, latitude, longitude, locationAccuracy,
      serviceRadiusKm, longDistanceJobsEnabled, emergencyTravelEnabled,
      pricingMethods, calloutFee, inspectionFee, hourlyRate, minimumCharge, providesOwnMaterials,
      availabilityStatus, acceptsEmergency, acceptsSameDay
    } = req.body;

    // `services` can be plain name strings (older clients) or structured
    // objects carrying specialties/experience per service — normalize to
    // the structured shape either way.
    const rawServices = Array.isArray(services) && services.length > 0
      ? services
      : (isNonEmpty(category) ? [category] : []);
    const structuredServices = rawServices.map(s =>
      typeof s === 'string'
        ? { name: s, specialties: [], experienceLevel: null, jobsRange: null }
        : { name: s.name, specialties: Array.isArray(s.specialties) ? s.specialties : [], experienceLevel: s.experienceLevel || null, jobsRange: s.jobsRange || null }
    ).filter(s => isNonEmpty(s.name));

    if (structuredServices.length === 0 || !isNonEmpty(location)) {
      return res.status(400).json({ error: 'Please select at least one service and fill in the area you serve.' });
    }
    if (!isValidPhoto(photo)) {
      return res.status(400).json({ error: 'That photo is too large or in an unsupported format.' });
    }
    if (!isValidPhoto(idDocument) || !isValidPhoto(selfie)) {
      return res.status(400).json({ error: 'One of your verification uploads is too large or in an unsupported format.' });
    }
    const validExperienceLevels = ['less_than_1', '1_2', '3_5', '6_10', '10_plus'];
    const validJobsRanges = ['0_10', '11_25', '26_50', '51_100', '101_250', '250_plus'];
    for (const s of structuredServices) {
      if (s.experienceLevel && !validExperienceLevels.includes(s.experienceLevel)) {
        return res.status(400).json({ error: `Invalid experience level for ${s.name}.` });
      }
      if (s.jobsRange && !validJobsRanges.includes(s.jobsRange)) {
        return res.status(400).json({ error: `Invalid jobs-completed range for ${s.name}.` });
      }
    }
    const validPricingMethods = ['fixed', 'labour_materials', 'hourly', 'callout_repair', 'quote_after_inspection'];
    const cleanPricingMethods = Array.isArray(pricingMethods) ? pricingMethods.filter(m => validPricingMethods.includes(m)) : [];

    selectedServices = structuredServices.map(s => s.name);
    providerFields = {
      name: name.trim(),
      category: structuredServices[0].name.trim(), // primary/display category, kept for existing search compatibility
      location: location.trim(),
      phone: phone.trim(),
      bio: isNonEmpty(bio) ? bio.trim() : '',
      photo: isNonEmpty(photo) ? photo : null,
      experienceYears: Number.isInteger(experienceYears) && experienceYears >= 0 ? experienceYears : null,
      idDocument: isNonEmpty(idDocument) ? idDocument : null,
      selfie: isNonEmpty(selfie) ? selfie : null,
      structuredServices,
      professionalType: ['individual', 'employee', 'company'].includes(professionalType) ? professionalType : null,
      latitude: typeof latitude === 'number' ? latitude : null,
      longitude: typeof longitude === 'number' ? longitude : null,
      locationAccuracy: typeof locationAccuracy === 'number' ? locationAccuracy : null,
      serviceRadiusKm: Number.isInteger(serviceRadiusKm) ? serviceRadiusKm : 10,
      longDistanceJobsEnabled: !!longDistanceJobsEnabled,
      emergencyTravelEnabled: !!emergencyTravelEnabled,
      pricingMethods: cleanPricingMethods,
      calloutFee: Number.isInteger(calloutFee) ? calloutFee : null,
      inspectionFee: Number.isInteger(inspectionFee) ? inspectionFee : null,
      hourlyRate: Number.isInteger(hourlyRate) ? hourlyRate : null,
      minimumCharge: Number.isInteger(minimumCharge) ? minimumCharge : null,
      providesOwnMaterials: ['yes', 'no', 'depends'].includes(providesOwnMaterials) ? providesOwnMaterials : null,
      availabilityStatus: ['available_now', 'available_today', 'available_later', 'not_available'].includes(availabilityStatus) ? availabilityStatus : 'available_later',
      acceptsEmergency: !!acceptsEmergency,
      acceptsSameDay: acceptsSameDay !== false
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
      const providerResult = await client.query(
        `INSERT INTO providers (
           user_id, name, category, location, phone, bio, rating, photo, experience_years,
           professional_type, latitude, longitude, location_accuracy, location_updated_at,
           service_radius_km, long_distance_jobs_enabled, emergency_travel_enabled,
           pricing_methods, callout_fee, inspection_fee, hourly_rate, minimum_charge, provides_own_materials,
           availability_status, accepts_emergency, accepts_same_day
         ) VALUES ($1,$2,$3,$4,$5,$6,5.0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         RETURNING id`,
        [
          userId, providerFields.name, providerFields.category, providerFields.location, providerFields.phone,
          providerFields.bio, providerFields.photo, providerFields.experienceYears,
          providerFields.professionalType, providerFields.latitude, providerFields.longitude, providerFields.locationAccuracy,
          providerFields.latitude !== null ? new Date() : null,
          providerFields.serviceRadiusKm, providerFields.longDistanceJobsEnabled, providerFields.emergencyTravelEnabled,
          JSON.stringify(providerFields.pricingMethods), providerFields.calloutFee, providerFields.inspectionFee,
          providerFields.hourlyRate, providerFields.minimumCharge, providerFields.providesOwnMaterials,
          providerFields.availabilityStatus, providerFields.acceptsEmergency, providerFields.acceptsSameDay
        ]
      );
      const providerId = providerResult.rows[0].id;

      for (const svc of providerFields.structuredServices) {
        const svcResult = await client.query('SELECT id FROM services WHERE name = $1', [svc.name.trim()]);
        if (svcResult.rows.length === 0) continue;
        const wsResult = await client.query(
          `INSERT INTO worker_services (provider_id, service_id, verification_status, reported_experience_level, reported_jobs_range)
           VALUES ($1, $2, 'PENDING', $3, $4)
           ON CONFLICT (provider_id, service_id) DO UPDATE SET reported_experience_level = $3, reported_jobs_range = $4
           RETURNING id`,
          [providerId, svcResult.rows[0].id, svc.experienceLevel, svc.jobsRange]
        );
        const workerServiceId = wsResult.rows[0].id;

        for (const specialtyName of svc.specialties) {
          const specResult = await client.query(
            'SELECT id FROM specialties WHERE service_id = $1 AND name = $2',
            [svcResult.rows[0].id, specialtyName]
          );
          if (specResult.rows.length > 0) {
            await client.query(
              `INSERT INTO worker_service_specialties (worker_service_id, specialty_id) VALUES ($1, $2)
               ON CONFLICT (worker_service_id, specialty_id) DO NOTHING`,
              [workerServiceId, specResult.rows[0].id]
            );
          }
        }
      }

      // Phone verification always starts PENDING — no SMS/OTP provider is
      // configured yet, so this awaits manual admin review (Phase 3).
      await client.query(
        `INSERT INTO verifications (provider_id, type, status, submitted_at) VALUES ($1, 'phone', 'PENDING', NOW())
         ON CONFLICT (provider_id, type) DO NOTHING`,
        [providerId]
      );

      // Identity verification: only marked "submitted" if they actually
      // uploaded something at signup. Otherwise it stays untouched so the
      // profile page can prompt them to submit it later (handles the
      // "incomplete verification" edge case without blocking signup).
      if (providerFields.idDocument || providerFields.selfie) {
        await client.query(
          `INSERT INTO verifications (provider_id, type, status, submitted_at) VALUES ($1, 'identity', 'IN_REVIEW', NOW())
           ON CONFLICT (provider_id, type) DO UPDATE SET status = 'IN_REVIEW', submitted_at = NOW()`,
          [providerId]
        );
        if (providerFields.idDocument) {
          await client.query(
            `INSERT INTO verification_documents (provider_id, verification_type, document_type, file_data) VALUES ($1, 'identity', 'id_document', $2)`,
            [providerId, providerFields.idDocument]
          );
        }
        if (providerFields.selfie) {
          await client.query(
            `INSERT INTO verification_documents (provider_id, verification_type, document_type, file_data) VALUES ($1, 'identity', 'selfie', $2)`,
            [providerId, providerFields.selfie]
          );
        }
      }
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

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

app.post('/api/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.account_status === 'SUSPENDED' || user.account_status === 'BANNED') {
      return res.status(403).json({ error: 'This account has been suspended. Contact Support if you think this is a mistake.' });
    }

    // One-time, config-driven admin bootstrap: an account whose email is
    // listed in ADMIN_EMAILS is elevated to the admin role on next login.
    // There is no public signup path to the admin role — this is the only
    // way an account becomes admin, and it requires a Railway env var
    // only you control.
    if (ADMIN_EMAILS.includes(email) && user.role !== 'admin') {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', user.id]);
      user = { ...user, role: 'admin' };
      createAuditLog(user.id, 'ADMIN_ROLE_GRANTED', 'user', user.id, 'Elevated via ADMIN_EMAILS on login.');
    }

    const expectedRole = req.body.expectedRole;
    if (expectedRole && user.role !== 'admin' && expectedRole !== user.role) {
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
  const result = await pool.query(
    'SELECT id, email, role, name, phone, created_at, latitude, longitude, city, district, notifications_enabled, notification_categories, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1',
    [req.session.userId]
  );
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

// Unified location capture for BOTH roles — this is the one real place
// coordinates get saved. Requires an actual GPS fix from the browser
// (never a hard-coded default), captures accuracy and a timestamp
// alongside it, and reverse-geocodes into a human-readable area before
// storing. Raw lat/lng are never returned to any OTHER user — only the
// reverse-geocoded city/district ever gets shown publicly.
// Reverse-geocodes coordinates into a human address, with no side
// effects — unlike /api/me/location, this doesn't save anything to the
// user's profile. Meant for autofilling any location field on demand
// (job posting, saved addresses, etc.), not just "my current location."
// Location lives on a different table depending on role (providers vs
// users) — this gives the frontend one place to check "how stale is
// my saved location" regardless of which table actually holds it, so
// it can skip re-pinging GPS when a recent reading already exists.
app.get('/api/me/location-freshness', requireLogin, asyncHandler(async (req, res) => {
  if (req.session.role === 'provider') {
    const result = await pool.query('SELECT location_updated_at FROM providers WHERE user_id = $1', [req.session.userId]);
    return res.json({ locationUpdatedAt: result.rows[0]?.location_updated_at || null });
  }
  const result = await pool.query('SELECT location_updated_at FROM users WHERE id = $1', [req.session.userId]);
  res.json({ locationUpdatedAt: result.rows[0]?.location_updated_at || null });
}));

app.get('/api/geocode/reverse', requireLogin, asyncHandler(async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  const result = await reverseGeocode(lat, lng);
  if (!result.formattedAddress) {
    return res.status(502).json({ error: 'Couldn\u2019t determine an address for that location.' });
  }
  res.json(result);
}));

app.post('/api/me/location', requireLogin, asyncHandler(async (req, res) => {
  const { latitude, longitude, accuracy } = req.body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ error: 'A real GPS reading is required — latitude and longitude must be numbers.' });
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'That doesn\u2019t look like a valid coordinate.' });
  }
  const acc = (typeof accuracy === 'number' && !isNaN(accuracy)) ? accuracy : null;

  const geo = await reverseGeocode(latitude, longitude);

  if (req.session.role === 'provider') {
    const providerId = await getProviderIdForUser(req.session.userId);
    if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });
    await pool.query(
      `UPDATE providers SET latitude = $1, longitude = $2, location_accuracy = $3, location_updated_at = NOW(),
         formatted_address = $4, city = $5, district = $6 WHERE id = $7`,
      [latitude, longitude, acc, geo.formattedAddress, geo.city, geo.district, providerId]
    );
  } else {
    await pool.query(
      `UPDATE users SET latitude = $1, longitude = $2, location_accuracy = $3, location_updated_at = NOW(),
         formatted_address = $4, city = $5, district = $6 WHERE id = $7`,
      [latitude, longitude, acc, geo.formattedAddress, geo.city, geo.district, req.session.userId]
    );
  }

  await createAuditLog(req.session.userId, 'LOCATION_UPDATED', req.session.role, req.session.userId, geo.city || 'reverse-geocode unavailable');
  res.json({ message: 'Location updated.', city: geo.city, district: geo.district, formattedAddress: geo.formattedAddress });
}));

// --- Addresses ---

app.get('/api/addresses', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.session.userId]);
  res.json({ addresses: result.rows });
}));

app.post('/api/addresses', requireLogin, asyncHandler(async (req, res) => {
  const { label, addressText, notes, latitude, longitude, isDefault } = req.body;
  if (!['home', 'work', 'other'].includes(label)) {
    return res.status(400).json({ error: 'Please choose a valid address label.' });
  }
  if (!isNonEmpty(addressText)) {
    return res.status(400).json({ error: 'Please enter the address.' });
  }
  if (isDefault) {
    await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.session.userId]);
  }
  const result = await pool.query(
    `INSERT INTO addresses (user_id, label, address_text, notes, latitude, longitude, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.session.userId, label, addressText.trim(), notes ? notes.trim() : '', typeof latitude === 'number' ? latitude : null, typeof longitude === 'number' ? longitude : null, !!isDefault]
  );
  res.json({ address: result.rows[0] });
}));

app.put('/api/addresses/:id', requireLogin, asyncHandler(async (req, res) => {
  const { label, addressText, notes, isDefault } = req.body;
  if (label && !['home', 'work', 'other'].includes(label)) {
    return res.status(400).json({ error: 'Please choose a valid address label.' });
  }
  if (isDefault) {
    await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [req.session.userId]);
  }
  const result = await pool.query(
    `UPDATE addresses SET label = COALESCE($1, label), address_text = COALESCE($2, address_text),
       notes = COALESCE($3, notes), is_default = COALESCE($4, is_default)
     WHERE id = $5 AND user_id = $6 RETURNING *`,
    [label || null, isNonEmpty(addressText) ? addressText.trim() : null, notes != null ? notes.trim() : null, isDefault, req.params.id, req.session.userId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Address not found.' });
  res.json({ address: result.rows[0] });
}));

app.delete('/api/addresses/:id', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.session.userId]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Address not found.' });
  res.json({ message: 'Address removed.' });
}));

// --- Saved handymen (favorites) ---

app.get('/api/favorites', requireRole('client'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT p.id, p.name, p.category, p.location, p.rating, p.photo, f.created_at AS saved_at
    FROM favorites f JOIN providers p ON p.id = f.provider_id
    WHERE f.client_user_id = $1 ORDER BY f.created_at DESC
  `, [req.session.userId]);
  res.json({ favorites: result.rows });
}));

app.post('/api/favorites', requireRole('client'), asyncHandler(async (req, res) => {
  const { providerId } = req.body;
  if (!Number.isInteger(providerId)) {
    return res.status(400).json({ error: 'Please specify a provider.' });
  }
  const providerCheck = await pool.query('SELECT id FROM providers WHERE id = $1', [providerId]);
  if (providerCheck.rows.length === 0) return res.status(404).json({ error: 'Provider not found.' });

  await pool.query(
    'INSERT INTO favorites (client_user_id, provider_id) VALUES ($1, $2) ON CONFLICT (client_user_id, provider_id) DO NOTHING',
    [req.session.userId, providerId]
  );
  res.json({ message: 'Saved.' });
}));

app.delete('/api/favorites/:providerId', requireRole('client'), asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM favorites WHERE client_user_id = $1 AND provider_id = $2', [req.session.userId, req.params.providerId]);
  res.json({ message: 'Removed.' });
}));

// --- Notification preferences ---

app.put('/api/me/notification-preferences', requireLogin, asyncHandler(async (req, res) => {
  const { notificationsEnabled, categories, quietHoursStart, quietHoursEnd } = req.body;

  const validCategories = ['jobs', 'messages', 'offers', 'payments'];
  let cleanCategories = null;
  if (categories && typeof categories === 'object') {
    cleanCategories = {};
    validCategories.forEach(c => { cleanCategories[c] = categories[c] !== false; });
  }

  const startHour = Number.isInteger(quietHoursStart) && quietHoursStart >= 0 && quietHoursStart <= 23 ? quietHoursStart : null;
  const endHour = Number.isInteger(quietHoursEnd) && quietHoursEnd >= 0 && quietHoursEnd <= 23 ? quietHoursEnd : null;

  await pool.query(
    `UPDATE users SET
       notifications_enabled = COALESCE($1, notifications_enabled),
       notification_categories = COALESCE($2, notification_categories),
       quiet_hours_start = $3, quiet_hours_end = $4
     WHERE id = $5`,
    [typeof notificationsEnabled === 'boolean' ? notificationsEnabled : null, cleanCategories ? JSON.stringify(cleanCategories) : null, startHour, endHour, req.session.userId]
  );
  res.json({ message: 'Preferences updated.' });
}));

app.get('/api/notifications/unread-count', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.session.userId]);
  res.json({ count: result.rows[0].count });
}));

// --- Push notifications (real device delivery, not just in-app) ---

app.get('/api/push/vapid-public-key', requireLogin, asyncHandler(async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: 'Push notifications aren\u2019t configured on this server.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
}));

app.post('/api/push/subscribe', requireLogin, asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!isNonEmpty(endpoint) || !keys || !isNonEmpty(keys.p256dh) || !isNonEmpty(keys.auth)) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [req.session.userId, endpoint, keys.p256dh, keys.auth]
  );
  res.json({ message: 'Subscribed.' });
}));

app.post('/api/push/unsubscribe', requireLogin, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (isNonEmpty(endpoint)) {
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.session.userId]);
  }
  res.json({ message: 'Unsubscribed.' });
}));

// --- Personal history: reviews written, reports filed, payments made ---

app.get('/api/me/reviews', requireRole('client'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT r.*, p.name AS provider_name, p.category, jr.description AS job_description
    FROM reviews r JOIN providers p ON p.id = r.provider_id JOIN job_requests jr ON jr.id = r.job_id
    WHERE r.client_user_id = $1 ORDER BY r.created_at DESC
  `, [req.session.userId]);
  res.json({ reviews: result.rows });
}));

app.get('/api/me/reports', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT r.*, u.email AS reported_email
    FROM reports r JOIN users u ON u.id = r.reported_user_id
    WHERE r.reporter_user_id = $1 ORDER BY r.created_at DESC
  `, [req.session.userId]);
  res.json({ reports: result.rows });
}));

app.get('/api/me/payments', requireRole('client'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT pay.*, p.name AS provider_name, jr.category, jr.description AS job_description
    FROM payments pay JOIN providers p ON p.id = pay.provider_id JOIN job_requests jr ON jr.id = pay.job_id
    WHERE pay.client_user_id = $1 ORDER BY pay.created_at DESC
  `, [req.session.userId]);
  res.json({ payments: result.rows });
}));

app.put('/api/me/password', requireLogin, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters and include a letter and a number.' });
  }
  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  const valid = await bcrypt.compare(currentPassword || '', result.rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);
  res.json({ message: 'Password updated.' });
}));

app.delete('/api/me', requireLogin, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.session.userId]);
  req.session.destroy(() => {});
  res.json({ message: 'Account deleted.' });
}));

app.post('/api/support', requireLogin, authLimiter, asyncHandler(async (req, res) => {
  const { subject, body } = req.body;
  if (!isNonEmpty(subject) || !isNonEmpty(body)) {
    return res.status(400).json({ error: 'Please fill in a subject and message.' });
  }
  const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
  const email = userResult.rows[0].email;

  await pool.query(
    'INSERT INTO support_messages (user_id, email, subject, body) VALUES ($1, $2, $3, $4)',
    [req.session.userId, email, subject.trim(), body.trim()]
  );

  if (mailTransport && process.env.SUPPORT_EMAIL) {
    mailTransport.sendMail({
      from: MAIL_FROM,
      to: process.env.SUPPORT_EMAIL,
      replyTo: email,
      subject: `[HandyLink Support] ${subject.trim()}`,
      text: `From: ${email}\n\n${body.trim()}`
    }).catch(err => console.error('Support email failed:', err));
  }

  res.json({ message: 'Your message has been sent. We\u2019ll get back to you soon.' });
}));

// --- Client-facing: browse/search providers ---

app.get('/api/categories', requireLogin, asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT DISTINCT category FROM providers ORDER BY category');
  res.json({ categories: result.rows.map(r => r.category) });
}));

// Public — the taxonomy itself isn't sensitive, and the worker signup
// wizard needs this before the account (and any session) exists.
app.get('/api/specialties', asyncHandler(async (req, res) => {
  const { service } = req.query;
  if (!isNonEmpty(service)) {
    return res.status(400).json({ error: 'Please specify a service.' });
  }
  const result = await pool.query(
    `SELECT sp.name FROM specialties sp
     JOIN services s ON s.id = sp.service_id
     WHERE s.name = $1 AND sp.active = TRUE ORDER BY sp.name`,
    [service]
  );
  res.json({ specialties: result.rows.map(r => r.name) });
}));

app.get('/api/workers', requireLogin, asyncHandler(async (req, res) => {
  const { search, category, lat, lng } = req.query;
  const myLat = lat !== undefined ? parseFloat(lat) : null;
  const myLng = lng !== undefined ? parseFloat(lng) : null;
  const result = await pool.query(`
    SELECT p.*,
      COALESCE((SELECT status FROM verifications WHERE provider_id = p.id AND type = 'identity'), 'PENDING') AS identity_status,
      COALESCE((SELECT status FROM verifications WHERE provider_id = p.id AND type = 'phone'), 'PENDING') AS phone_status,
      (SELECT COUNT(*)::int FROM job_requests WHERE provider_id = p.id AND status = 'completed') AS completed_jobs,
      EXISTS(
        SELECT 1 FROM worker_services ws JOIN services s ON s.id = ws.service_id
        WHERE ws.provider_id = p.id AND s.name = p.category AND ws.verification_status = 'VERIFIED'
      ) AS category_verified,
      (
        SELECT COALESCE(array_agg(s.name ORDER BY s.name), ARRAY[]::text[])
        FROM worker_services ws JOIN services s ON s.id = ws.service_id
        WHERE ws.provider_id = p.id AND ws.verification_status = 'VERIFIED'
      ) AS verified_services
    FROM providers p
    WHERE p.approval_status = 'APPROVED'
    ORDER BY p.rating DESC, p.name
  `);
  let results = result.rows;

  // Distance is computed here, server-side, from whatever coordinates
  // the calling client sent for ITS OWN location — never from the
  // provider's raw coordinates being sent to the browser to compute
  // there. Those get stripped below regardless of whether a distance
  // could be computed.
  results = results.map(w => ({
    ...w,
    distanceKm: (myLat !== null && myLng !== null) ? distanceKmServer(myLat, myLng, w.latitude, w.longitude) : null
  }));

  if (category) {
    results = results.filter(w => w.category.toLowerCase() === category.toLowerCase());
    // Same rule matches.html already enforces: an unverified provider
    // shouldn't even be shown for a high-risk service, since they'd be
    // rejected at booking time anyway. Consistent everywhere, not just
    // in the job-specific matching flow.
    if (HIGH_RISK_SERVICES.includes(category)) {
      results = results.filter(w => w.category_verified);
    }
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

  // Never send exact coordinates to a customer's browser — only the
  // already-computed distance and the reverse-geocoded area name.
  results = results.map(({ latitude, longitude, ...safe }) => safe);
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

app.get('/api/provider/verification-status', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerResult = await pool.query('SELECT id, approval_status FROM providers WHERE user_id = $1', [req.session.userId]);
  if (providerResult.rows.length === 0) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }
  const providerId = providerResult.rows[0].id;

  const verifications = await pool.query('SELECT type, status, submitted_at, notes FROM verifications WHERE provider_id = $1', [providerId]);
  const services = await pool.query(
    `SELECT ws.id, s.name, ws.verification_status, ws.notes FROM worker_services ws
     JOIN services s ON s.id = ws.service_id WHERE ws.provider_id = $1 ORDER BY s.name`,
    [providerId]
  );
  const credentials = await pool.query(
    'SELECT credential_type, issuing_organization, status, expiry_date FROM credentials WHERE provider_id = $1 ORDER BY created_at DESC',
    [providerId]
  );
  const jobCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM job_requests WHERE provider_id = $1 AND status = 'completed'`,
    [providerId]
  );

  res.json({
    approvalStatus: providerResult.rows[0].approval_status,
    verifications: verifications.rows,
    services: services.rows,
    credentials: credentials.rows,
    completedJobs: jobCount.rows[0].count
  });
}));

app.post('/api/provider/verification/identity', requireRole('provider'), asyncHandler(async (req, res) => {
  const { idDocument, selfie } = req.body;
  if (!isNonEmpty(idDocument) && !isNonEmpty(selfie)) {
    return res.status(400).json({ error: 'Please upload at least one document.' });
  }
  if (!isValidPhoto(idDocument) || !isValidPhoto(selfie)) {
    return res.status(400).json({ error: 'One of your uploads is too large or in an unsupported format.' });
  }

  const providerResult = await pool.query('SELECT id FROM providers WHERE user_id = $1', [req.session.userId]);
  if (providerResult.rows.length === 0) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }
  const providerId = providerResult.rows[0].id;

  await pool.query(
    `INSERT INTO verifications (provider_id, type, status, submitted_at) VALUES ($1, 'identity', 'IN_REVIEW', NOW())
     ON CONFLICT (provider_id, type) DO UPDATE SET status = 'IN_REVIEW', submitted_at = NOW(), reviewed_at = NULL, reviewed_by = NULL`,
    [providerId]
  );
  if (idDocument) {
    await pool.query(
      `INSERT INTO verification_documents (provider_id, verification_type, document_type, file_data) VALUES ($1, 'identity', 'id_document', $2)`,
      [providerId, idDocument]
    );
  }
  if (selfie) {
    await pool.query(
      `INSERT INTO verification_documents (provider_id, verification_type, document_type, file_data) VALUES ($1, 'identity', 'selfie', $2)`,
      [providerId, selfie]
    );
  }

  res.json({ message: 'Submitted for review.' });
}));

// Resubmission for a rejected skill — the same right a rejected identity
// verification already has (spec's "Allow Resubmission where
// applicable"). Only moves a REJECTED item back into review; can't be
// used to touch a VERIFIED or PENDING one.
app.post('/api/provider/services/:workerServiceId/resubmit', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  const result = await pool.query(
    `UPDATE worker_services SET verification_status = 'IN_REVIEW', notes = $1, verified_by = NULL, verified_at = NULL
     WHERE id = $2 AND provider_id = $3 AND verification_status = 'REJECTED' RETURNING service_id`,
    [isNonEmpty(req.body.notes) ? req.body.notes.trim() : '', req.params.workerServiceId, providerId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'This service isn\u2019t in a rejected state, or doesn\u2019t belong to you.' });
  }
  res.json({ message: 'Resubmitted for review.' });
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

// Fixes a real gap: service radius, pricing preferences, and availability
// were only ever collected once at signup with no way to change them
// afterward. This is the one place they can be updated.
app.put('/api/provider/settings', requireRole('provider'), asyncHandler(async (req, res) => {
  const {
    serviceRadiusKm, longDistanceJobsEnabled, emergencyTravelEnabled,
    pricingMethods, calloutFee, inspectionFee, hourlyRate, minimumCharge, providesOwnMaterials,
    availabilityStatus, acceptsEmergency, acceptsSameDay
  } = req.body;

  const validPricingMethods = ['fixed', 'labour_materials', 'hourly', 'callout_repair', 'quote_after_inspection'];
  const cleanPricingMethods = Array.isArray(pricingMethods) ? pricingMethods.filter(m => validPricingMethods.includes(m)) : [];
  const validAvailability = ['available_now', 'available_today', 'available_later', 'not_available'];

  const result = await pool.query(
    `UPDATE providers SET
       service_radius_km = COALESCE($1, service_radius_km),
       long_distance_jobs_enabled = COALESCE($2, long_distance_jobs_enabled),
       emergency_travel_enabled = COALESCE($3, emergency_travel_enabled),
       pricing_methods = $4,
       callout_fee = $5, inspection_fee = $6, hourly_rate = $7, minimum_charge = $8,
       provides_own_materials = COALESCE($9, provides_own_materials),
       availability_status = COALESCE($10, availability_status),
       accepts_emergency = COALESCE($11, accepts_emergency),
       accepts_same_day = COALESCE($12, accepts_same_day)
     WHERE user_id = $13 RETURNING *`,
    [
      Number.isInteger(serviceRadiusKm) ? serviceRadiusKm : null,
      typeof longDistanceJobsEnabled === 'boolean' ? longDistanceJobsEnabled : null,
      typeof emergencyTravelEnabled === 'boolean' ? emergencyTravelEnabled : null,
      JSON.stringify(cleanPricingMethods),
      Number.isInteger(calloutFee) ? calloutFee : null,
      Number.isInteger(inspectionFee) ? inspectionFee : null,
      Number.isInteger(hourlyRate) ? hourlyRate : null,
      Number.isInteger(minimumCharge) ? minimumCharge : null,
      ['yes', 'no', 'depends'].includes(providesOwnMaterials) ? providesOwnMaterials : null,
      validAvailability.includes(availabilityStatus) ? availabilityStatus : null,
      typeof acceptsEmergency === 'boolean' ? acceptsEmergency : null,
      typeof acceptsSameDay === 'boolean' ? acceptsSameDay : null,
      req.session.userId
    ]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'No provider profile found.' });
  res.json({ provider: result.rows[0] });
}));

// --- Portfolio ---

app.get('/api/provider/portfolio', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });
  const result = await pool.query(
    `SELECT pi.*, s.name AS service_name FROM portfolio_items pi
     LEFT JOIN services s ON s.id = pi.service_id
     WHERE pi.provider_id = $1 ORDER BY pi.created_at DESC`,
    [providerId]
  );
  res.json({ items: result.rows });
}));

app.post('/api/provider/portfolio', requireRole('provider'), asyncHandler(async (req, res) => {
  const { photo, serviceName, jobType, description, approxDate } = req.body;
  if (!isNonEmpty(photo)) {
    return res.status(400).json({ error: 'Please add a photo.' });
  }
  if (!isValidPhoto(photo)) {
    return res.status(400).json({ error: 'That photo is too large or in an unsupported format.' });
  }
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  let serviceId = null;
  if (isNonEmpty(serviceName)) {
    const svc = await pool.query('SELECT id FROM services WHERE name = $1', [serviceName]);
    serviceId = svc.rows[0]?.id || null;
  }

  const result = await pool.query(
    `INSERT INTO portfolio_items (provider_id, service_id, photo, job_type, description, approx_date)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [providerId, serviceId, photo, isNonEmpty(jobType) ? jobType.trim() : null, isNonEmpty(description) ? description.trim() : '', isNonEmpty(approxDate) ? approxDate : null]
  );
  res.json({ item: result.rows[0] });
}));

app.delete('/api/provider/portfolio/:id', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });
  const result = await pool.query('DELETE FROM portfolio_items WHERE id = $1 AND provider_id = $2 RETURNING id', [req.params.id, providerId]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found.' });
  res.json({ message: 'Removed.' });
}));

// --- Client-facing: create and view bookings ---

const VALID_URGENCY = ['now', 'today', 'schedule'];

// "Schedule" requires an actual future date/time — reject anything else
// rather than silently accepting a meaningless "schedule" with no when.
function validateScheduledFor(urgency, scheduledFor) {
  if (urgency !== 'schedule') return { ok: true, value: null };
  if (!isNonEmpty(scheduledFor)) return { ok: false, error: 'Please choose a date and time.' };
  const date = new Date(scheduledFor);
  if (isNaN(date.getTime())) return { ok: false, error: 'That date/time isn\u2019t valid.' };
  if (date.getTime() <= Date.now()) return { ok: false, error: 'Please choose a time in the future.' };
  return { ok: true, value: date };
}


app.post('/api/jobs/assess', requireRole('client'), aiAssessLimiter, asyncHandler(async (req, res) => {
  const { description, photos, category, urgency, distanceKm } = req.body;
  if (!isNonEmpty(description)) {
    return res.status(400).json({ error: 'Please describe the job.' });
  }
  if (description.length > 3000) {
    return res.status(400).json({ error: 'Please keep the description under 3000 characters.' });
  }
  if (photos && (!Array.isArray(photos) || photos.length > 5 || photos.some(p => !isValidPhoto(p)))) {
    return res.status(400).json({ error: 'Please upload at most 5 photos, each a reasonable size.' });
  }
  if (urgency && !VALID_URGENCY.includes(urgency)) {
    return res.status(400).json({ error: 'Invalid urgency value.' });
  }

  const aiResult = await callAiJobClassifier(description, photos);
  let assessment, source;

  if (aiResult.ok) {
    assessment = aiResult.assessment;
    source = 'AI';
  } else {
    // Graceful fallback: use the category the client already picked (if
    // any) so the existing flow keeps working exactly as it did before
    // AI existed. This is the "marketplace must still function without
    // AI" requirement, not a special case bolted on separately.
    assessment = {
      service: VALID_SERVICES.includes(category) ? category : 'General Handyman',
      job_type: 'General',
      problem_summary: 'Automatic assessment isn\u2019t available right now — a pro will assess this in person.',
      complexity: 'UNKNOWN',
      likely_materials: [],
      confidence: 'LOW',
      requires_inspection: true,
      questions: []
    };
    source = 'FALLBACK';
  }

  const pricing = await computePricingEngine({ serviceName: assessment.service, urgency, distanceKm });

  const result = await pool.query(
    `INSERT INTO job_assessments
       (client_user_id, description, photos, service, job_type, problem_summary, complexity, likely_materials,
        labour_min, labour_max, materials_min, materials_max, total_min, total_max, confidence, requires_inspection,
        questions, ai_raw_response, source, pricing_source, pricing_sample_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      req.session.userId, description.trim(), JSON.stringify(photos || []),
      assessment.service, assessment.job_type, assessment.problem_summary, assessment.complexity,
      JSON.stringify(assessment.likely_materials || []),
      pricing.labourMin, pricing.labourMax, pricing.materialsMin, pricing.materialsMax,
      pricing.totalMin, pricing.totalMax, assessment.confidence, assessment.requires_inspection,
      JSON.stringify(assessment.questions || []),
      aiResult.ok ? JSON.stringify(aiResult.raw) : null,
      source,
      pricing.source,
      pricing.historicalSampleSize || null
    ]
  );

  const row = result.rows[0];
  const { ai_raw_response, photos: _photos, ...clientSafeAssessment } = row;
  res.json({ assessment: clientSafeAssessment });
}));

// --- Open jobs & multi-provider offers (customer posts without picking
// one specific provider; several providers can quote, customer compares
// and picks). Coexists with the direct-booking flow above — neither
// replaces the other. ---

app.post('/api/jobs/open', requireRole('client'), asyncHandler(async (req, res) => {
  const { category, description, urgency, location, locationNotes, assessmentId, scheduledFor } = req.body;
  if (!isNonEmpty(category) || !isNonEmpty(description) || !isNonEmpty(location)) {
    return res.status(400).json({ error: 'Please fill in the job description and location.' });
  }
  if (!VALID_URGENCY.includes(urgency)) {
    return res.status(400).json({ error: 'Please choose when you need this done.' });
  }
  const scheduleCheck = validateScheduledFor(urgency, scheduledFor);
  if (!scheduleCheck.ok) {
    return res.status(400).json({ error: scheduleCheck.error });
  }

  let estimateAmount = ESTIMATE_MIDPOINTS[category.trim()] || 40000;
  let linkedAssessment = null;
  if (assessmentId) {
    const assessResult = await pool.query('SELECT * FROM job_assessments WHERE id = $1 AND client_user_id = $2', [assessmentId, req.session.userId]);
    if (assessResult.rows.length > 0) {
      linkedAssessment = assessResult.rows[0];
      estimateAmount = Math.round((linkedAssessment.total_min + linkedAssessment.total_max) / 2);
    }
  }

  const result = await pool.query(
    `INSERT INTO job_requests (client_user_id, provider_id, category, description, urgency, location, location_notes, estimate_amount, status, scheduled_for)
     VALUES ($1, NULL, $2,$3,$4,$5,$6,$7,'awaiting_offers',$8) RETURNING *`,
    [req.session.userId, category.trim(), description.trim(), urgency, location.trim(), isNonEmpty(locationNotes) ? locationNotes.trim() : '', estimateAmount, scheduleCheck.value]
  );
  const job = result.rows[0];

  if (linkedAssessment) {
    await pool.query('UPDATE job_assessments SET job_id = $1 WHERE id = $2', [job.id, linkedAssessment.id]);
  }
  await recordJobEvent(job.id, 'posted', `Job posted — open for offers: ${category.trim()}`, req.session.userId);

  // Notify eligible providers: approved, offering this service, and
  // (for high-risk services) verified specifically for it.
  const eligibleQuery = HIGH_RISK_SERVICES.includes(category.trim())
    ? `SELECT p.user_id FROM providers p JOIN worker_services ws ON ws.provider_id = p.id JOIN services s ON s.id = ws.service_id
       WHERE p.approval_status = 'APPROVED' AND s.name = $1 AND ws.verification_status = 'VERIFIED'`
    : `SELECT p.user_id FROM providers p WHERE p.approval_status = 'APPROVED' AND p.category = $1`;
  const eligible = await pool.query(eligibleQuery, [category.trim()]);
  eligible.rows.forEach(p => {
    createNotification(p.user_id, 'new_open_job', `New ${category.trim()} job open for offers`, '/provider-dashboard.html');
  });

  res.json({ job });
}));

app.get('/api/jobs/open', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });
  const providerRow = await pool.query('SELECT category FROM providers WHERE id = $1', [providerId]);
  const category = providerRow.rows[0]?.category;

  const result = await pool.query(`
    SELECT jr.*, u.email AS client_email,
      (SELECT id FROM job_offers WHERE job_id = jr.id AND provider_id = $2) AS my_offer_id,
      (SELECT status FROM job_offers WHERE job_id = jr.id AND provider_id = $2) AS my_offer_status
    FROM job_requests jr JOIN users u ON u.id = jr.client_user_id
    WHERE jr.status = 'awaiting_offers' AND jr.category = $1
    ORDER BY jr.created_at DESC
  `, [category, providerId]);
  res.json({ jobs: result.rows });
}));

app.post('/api/jobs/:id/offers', requireRole('provider'), asyncHandler(async (req, res) => {
  const { labourAmount, materialsAmount, message } = req.body;
  const labour = parseInt(labourAmount, 10);
  const materials = parseInt(materialsAmount, 10) || 0;
  if (!Number.isInteger(labour) || labour < 0) {
    return res.status(400).json({ error: 'Please enter a valid labour amount.' });
  }

  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  const statusCheck = await pool.query('SELECT approval_status FROM providers WHERE id = $1', [providerId]);
  if (statusCheck.rows[0]?.approval_status !== 'APPROVED') {
    return res.status(403).json({ error: 'Your account isn\u2019t approved to submit offers right now.' });
  }

  const jobResult = await pool.query(`SELECT * FROM job_requests WHERE id = $1 AND status = 'awaiting_offers'`, [req.params.id]);
  if (jobResult.rows.length === 0) {
    return res.status(404).json({ error: 'This job is no longer open for offers.' });
  }
  const job = jobResult.rows[0];

  if (HIGH_RISK_SERVICES.includes(job.category)) {
    const skillCheck = await pool.query(
      `SELECT verification_status FROM worker_services ws JOIN services s ON s.id = ws.service_id
       WHERE ws.provider_id = $1 AND s.name = $2`,
      [providerId, job.category]
    );
    if (skillCheck.rows.length === 0 || skillCheck.rows[0].verification_status !== 'VERIFIED') {
      return res.status(403).json({ error: `${job.category} requires verified skill to submit an offer.` });
    }
  }

  const total = labour + materials;
  const result = await pool.query(
    `INSERT INTO job_offers (job_id, provider_id, labour_amount, materials_amount, total_amount, message)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (job_id, provider_id) DO UPDATE SET labour_amount = $3, materials_amount = $4, total_amount = $5, message = $6, status = 'PENDING'
     RETURNING *`,
    [req.params.id, providerId, labour, materials, total, isNonEmpty(message) ? message.trim() : '']
  );

  await recordJobEvent(req.params.id, 'offer_submitted', `New offer received: UGX ${total.toLocaleString()}`, req.session.userId);
  createNotification(job.client_user_id, 'new_offer', `New offer for your ${job.category} job: UGX ${total.toLocaleString()}`, '/client-jobs.html');
  res.json({ offer: result.rows[0] });
}));

app.get('/api/jobs/:id/offers', requireLogin, asyncHandler(async (req, res) => {
  const jobResult = await pool.query('SELECT * FROM job_requests WHERE id = $1', [req.params.id]);
  if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found.' });
  const job = jobResult.rows[0];

  if (req.session.role === 'client') {
    if (job.client_user_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized.' });
    const result = await pool.query(`
      SELECT jo.*, p.name AS provider_name, p.photo AS provider_photo, p.rating, p.experience_years
      FROM job_offers jo JOIN providers p ON p.id = jo.provider_id
      WHERE jo.job_id = $1 AND jo.status != 'WITHDRAWN' ORDER BY jo.total_amount ASC
    `, [req.params.id]);
    return res.json({ offers: result.rows });
  }

  const providerId = await getProviderIdForUser(req.session.userId);
  const result = await pool.query('SELECT * FROM job_offers WHERE job_id = $1 AND provider_id = $2', [req.params.id, providerId]);
  res.json({ offers: result.rows });
}));

app.post('/api/jobs/:id/offers/:offerId/accept', requireRole('client'), asyncHandler(async (req, res) => {
  const jobResult = await pool.query(
    `SELECT * FROM job_requests WHERE id = $1 AND client_user_id = $2 AND status = 'awaiting_offers'`,
    [req.params.id, req.session.userId]
  );
  if (jobResult.rows.length === 0) return res.status(404).json({ error: 'This job can\u2019t accept an offer right now.' });

  const offerResult = await pool.query(
    `SELECT * FROM job_offers WHERE id = $1 AND job_id = $2 AND status = 'PENDING'`,
    [req.params.offerId, req.params.id]
  );
  if (offerResult.rows.length === 0) return res.status(404).json({ error: 'This offer is no longer available.' });
  const offer = offerResult.rows[0];

  await pool.query(
    `UPDATE job_requests SET provider_id = $1, status = 'accepted', final_amount = $2, updated_at = NOW() WHERE id = $3`,
    [offer.provider_id, offer.total_amount, req.params.id]
  );
  await pool.query(`UPDATE job_offers SET status = 'ACCEPTED' WHERE id = $1`, [offer.id]);
  const declined = await pool.query(
    `UPDATE job_offers SET status = 'DECLINED' WHERE job_id = $1 AND id != $2 AND status = 'PENDING' RETURNING provider_id`,
    [req.params.id, offer.id]
  );

  const providerUser = await pool.query('SELECT user_id, name FROM providers WHERE id = $1', [offer.provider_id]);
  await recordJobEvent(req.params.id, 'offer_accepted', `Offer accepted: UGX ${offer.total_amount.toLocaleString()} — ${providerUser.rows[0]?.name}`, req.session.userId);
  if (providerUser.rows[0]) {
    createNotification(providerUser.rows[0].user_id, 'offer_accepted', 'Your offer was accepted! The job is booked.', '/provider-dashboard.html');
  }
  for (const d of declined.rows) {
    const declinedProvider = await pool.query('SELECT user_id FROM providers WHERE id = $1', [d.provider_id]);
    if (declinedProvider.rows[0]) {
      createNotification(declinedProvider.rows[0].user_id, 'offer_declined', 'A customer chose another pro for this job.', '/provider-dashboard.html');
    }
  }

  res.json({ message: 'Offer accepted — job booked.' });
}));

app.get('/api/jobs/:id/timeline', requireLogin, asyncHandler(async (req, res) => {
  const jobResult = await pool.query(
    `SELECT jr.client_user_id, p.user_id AS provider_user_id FROM job_requests jr LEFT JOIN providers p ON p.id = jr.provider_id WHERE jr.id = $1`,
    [req.params.id]
  );
  if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found.' });
  const job = jobResult.rows[0];
  if (job.client_user_id !== req.session.userId && job.provider_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  const result = await pool.query('SELECT * FROM job_events WHERE job_id = $1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ events: result.rows });
}));

// Backs the customer Jobs dashboard's four filters. Mapping:
//   offers    -> awaiting_offers (posted, comparing quotes)
//   upcoming  -> requested, accepted (booked/confirmed, work not started)
//   active    -> on_the_way, arrived, in_progress, awaiting_payment (underway or just finished)
//   completed -> completed, declined, cancelled (terminal)
const JOB_FILTER_STATUSES = {
  offers: ['awaiting_offers'],
  upcoming: ['requested', 'accepted'],
  active: ['on_the_way', 'arrived', 'in_progress', 'awaiting_payment'],
  completed: ['completed', 'declined', 'cancelled']
};

app.get('/api/jobs/mine', requireRole('client'), asyncHandler(async (req, res) => {
  const filter = req.query.filter;
  const statuses = JOB_FILTER_STATUSES[filter];
  if (filter && !statuses) {
    return res.status(400).json({ error: 'Invalid filter.' });
  }

  const result = await pool.query(
    `SELECT jr.*, p.name AS provider_name, p.phone AS provider_phone, p.photo AS provider_photo, p.user_id AS provider_user_id,
            (r.id IS NOT NULL) AS reviewed,
            pcr.id AS pending_price_change_id, pcr.new_amount AS pending_new_amount, pcr.reason AS pending_price_reason,
            (SELECT COUNT(*)::int FROM job_offers WHERE job_id = jr.id AND status = 'PENDING') AS offer_count
     FROM job_requests jr
     LEFT JOIN providers p ON p.id = jr.provider_id
     LEFT JOIN reviews r ON r.job_id = jr.id
     LEFT JOIN price_change_requests pcr ON pcr.job_id = jr.id AND pcr.status = 'PENDING'
     WHERE jr.client_user_id = $1 ${statuses ? 'AND jr.status = ANY($2)' : ''}
     ORDER BY jr.created_at DESC`,
    statuses ? [req.session.userId, statuses] : [req.session.userId]
  );
  res.json({ jobs: result.rows });
}));

app.post('/api/bookings', requireRole('client'), async (req, res) => {
  const { providerId, category, description, urgency, location, locationNotes, assessmentId, scheduledFor } = req.body;

  if (!providerId || !isNonEmpty(category) || !isNonEmpty(description) || !isNonEmpty(location)) {
    return res.status(400).json({ error: 'Please fill in the job description and location.' });
  }
  if (!VALID_URGENCY.includes(urgency)) {
    return res.status(400).json({ error: 'Please choose when you need this done.' });
  }
  const scheduleCheck = validateScheduledFor(urgency, scheduledFor);
  if (!scheduleCheck.ok) {
    return res.status(400).json({ error: scheduleCheck.error });
  }

  try {
    const providerCheck = await pool.query('SELECT id, user_id, name, approval_status FROM providers WHERE id = $1', [providerId]);
    if (providerCheck.rows.length === 0) {
      return res.status(404).json({ error: 'That provider no longer exists.' });
    }
    if (providerCheck.rows[0].approval_status !== 'APPROVED') {
      return res.status(403).json({ error: 'This provider isn\u2019t approved to receive jobs yet.' });
    }

    // High-risk services (spec section 17): electrical/mechanical work can
    // injure someone or damage property if done badly. Only a provider
    // specifically VERIFIED for that exact service — not just APPROVED
    // in general — can be booked for it. Enforced here server-side, not
    // just hidden in the UI.
    if (HIGH_RISK_SERVICES.includes(category.trim())) {
      const skillCheck = await pool.query(
        `SELECT ws.verification_status FROM worker_services ws
         JOIN services s ON s.id = ws.service_id
         WHERE ws.provider_id = $1 AND s.name = $2`,
        [providerId, category.trim()]
      );
      if (skillCheck.rows.length === 0 || skillCheck.rows[0].verification_status !== 'VERIFIED') {
        return res.status(403).json({ error: `${category.trim()} is a higher-risk service — this provider isn\u2019t verified for it yet. Please choose a verified pro.` });
      }
    }

    let estimateAmount = ESTIMATE_MIDPOINTS[category.trim()] || 40000;
    let linkedAssessment = null;
    if (assessmentId) {
      const assessResult = await pool.query(
        'SELECT * FROM job_assessments WHERE id = $1 AND client_user_id = $2',
        [assessmentId, req.session.userId]
      );
      if (assessResult.rows.length > 0) {
        linkedAssessment = assessResult.rows[0];
        estimateAmount = Math.round((linkedAssessment.total_min + linkedAssessment.total_max) / 2);
      }
    }

    const result = await pool.query(
      `INSERT INTO job_requests (client_user_id, provider_id, category, description, urgency, location, location_notes, estimate_amount, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.session.userId, providerId, category.trim(), description.trim(), urgency, location.trim(), isNonEmpty(locationNotes) ? locationNotes.trim() : '', estimateAmount, scheduleCheck.value]
    );

    if (linkedAssessment) {
      await pool.query('UPDATE job_assessments SET job_id = $1 WHERE id = $2', [result.rows[0].id, linkedAssessment.id]);
    }

    await recordJobEvent(result.rows[0].id, 'posted', `Job posted — ${category.trim()}, matched to ${providerCheck.rows[0].name}`, req.session.userId);

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
    `SELECT jr.*, p.name AS provider_name, p.phone AS provider_phone, p.user_id AS provider_user_id,
            (r.id IS NOT NULL) AS reviewed,
            pcr.id AS pending_price_change_id, pcr.new_amount AS pending_new_amount, pcr.reason AS pending_price_reason
     FROM job_requests jr
     JOIN providers p ON p.id = jr.provider_id
     LEFT JOIN reviews r ON r.job_id = jr.id
     LEFT JOIN price_change_requests pcr ON pcr.job_id = jr.id AND pcr.status = 'PENDING'
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
    `SELECT jr.*, u.email AS client_email,
            pcr.id AS pending_price_change_id, pcr.status AS pending_price_status,
            (SELECT id FROM payments WHERE job_id = jr.id) AS payment_id,
            ja.complexity AS ai_complexity, ja.likely_materials AS ai_materials, ja.confidence AS ai_confidence,
            ja.labour_min AS ai_labour_min, ja.labour_max AS ai_labour_max,
            ja.materials_min AS ai_materials_min, ja.materials_max AS ai_materials_max,
            ja.total_min AS ai_total_min, ja.total_max AS ai_total_max
     FROM job_requests jr
     JOIN users u ON u.id = jr.client_user_id
     LEFT JOIN price_change_requests pcr ON pcr.job_id = jr.id AND pcr.status = 'PENDING'
     LEFT JOIN job_assessments ja ON ja.job_id = jr.id
     WHERE jr.provider_id = $1
     ORDER BY jr.created_at DESC`,
    [providerId]
  );
  res.json({ jobs: result.rows });
}));

const JOB_EVENT_LABELS = {
  accepted: 'Job accepted — booked',
  declined: 'Job declined',
  on_the_way: 'Pro is on the way',
  arrived: 'Pro has arrived',
  in_progress: 'Work started',
  awaiting_payment: 'Work completed — awaiting payment',
  cancelled: 'Job cancelled'
};

async function updateJobStatus(req, res, { from, to }) {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }

  if (to === 'accepted') {
    const statusCheck = await pool.query('SELECT approval_status FROM providers WHERE id = $1', [providerId]);
    if (statusCheck.rows[0]?.approval_status !== 'APPROVED') {
      return res.status(403).json({ error: 'Your account isn\u2019t approved to accept jobs right now.' });
    }
  }

  const fromStates = Array.isArray(from) ? from : [from];
  const result = await pool.query(
    `UPDATE job_requests SET status = $1, updated_at = NOW()
     WHERE id = $2 AND provider_id = $3 AND status = ANY($4)
     RETURNING *`,
    [to, req.params.id, providerId, fromStates]
  );

  if (result.rows.length === 0) {
    return res.status(409).json({ error: 'This job is no longer in a state that allows that action.' });
  }

  const job = result.rows[0];
  await recordJobEvent(job.id, `status_${to}`, JOB_EVENT_LABELS[to] || `Status changed to ${to}`, req.session.userId);

  const messages = {
    accepted: 'Your job request was accepted',
    declined: 'Your job request was declined',
    on_the_way: 'Your pro is on the way',
    arrived: 'Your pro has arrived',
    in_progress: 'Your job has started',
    awaiting_payment: 'Your job is complete — payment is now due',
    cancelled: 'Your job was cancelled'
  };
  if (messages[to]) {
    createNotification(job.client_user_id, `job_${to}`, `${messages[to]} — ${job.category}`, '/client-jobs.html');
  }

  res.json({ job });
}

app.get('/api/provider/earnings', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) {
    return res.status(404).json({ error: 'No provider profile found.' });
  }

  const completedResult = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(COALESCE(final_amount, estimate_amount)), 0)::int AS total
     FROM job_requests WHERE provider_id = $1 AND status = 'completed'`,
    [providerId]
  );
  const providerResult = await pool.query('SELECT rating FROM providers WHERE id = $1', [providerId]);
  const recentResult = await pool.query(
    `SELECT jr.id, jr.category, jr.description, COALESCE(jr.final_amount, jr.estimate_amount) AS estimate_amount, jr.updated_at, u.email AS client_email,
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
app.put('/api/provider/jobs/:id/on-the-way', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: 'accepted', to: 'on_the_way' })
);
app.put('/api/provider/jobs/:id/arrived', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: ['accepted', 'on_the_way'], to: 'arrived' })
);
app.put('/api/provider/jobs/:id/start', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: ['accepted', 'on_the_way', 'arrived'], to: 'in_progress' })
);

// Handyman quote system (AI spec Phase 5): instead of only Accept/Decline,
// a provider can accept the job while proposing a different price. This
// deliberately reuses price_change_requests rather than a parallel
// mechanism — the customer's approval step is identical either way, and
// "cannot force the customer to accept a different amount" is enforced
// by the exact same code path already audited in the trust/safety phase.
app.put('/api/provider/jobs/:id/accept-with-quote', requireRole('provider'), asyncHandler(async (req, res) => {
  const { labourAmount, materialsAmount, reason } = req.body;
  const labour = parseInt(labourAmount, 10);
  const materials = parseInt(materialsAmount, 10);
  if (!Number.isInteger(labour) || labour < 0 || !Number.isInteger(materials) || materials < 0) {
    return res.status(400).json({ error: 'Please enter valid labour and materials amounts.' });
  }
  if (!isNonEmpty(reason)) {
    return res.status(400).json({ error: 'Please explain your quote to the client.' });
  }

  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  const statusCheck = await pool.query('SELECT approval_status FROM providers WHERE id = $1', [providerId]);
  if (statusCheck.rows[0]?.approval_status !== 'APPROVED') {
    return res.status(403).json({ error: 'Your account isn\u2019t approved to accept jobs right now.' });
  }

  const jobResult = await pool.query(
    `UPDATE job_requests SET status = 'accepted', updated_at = NOW()
     WHERE id = $1 AND provider_id = $2 AND status = 'requested'
     RETURNING *`,
    [req.params.id, providerId]
  );
  if (jobResult.rows.length === 0) {
    return res.status(409).json({ error: 'This job is no longer in a state that allows that action.' });
  }
  const job = jobResult.rows[0];
  const newAmount = labour + materials;

  const pcResult = await pool.query(
    `INSERT INTO price_change_requests (job_id, requested_by, original_amount, new_amount, labour_amount, materials_amount, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [job.id, req.session.userId, job.estimate_amount, newAmount, labour, materials, reason.trim()]
  );

  await createAuditLog(req.session.userId, 'JOB_ACCEPTED_WITH_QUOTE', 'job', job.id, `${job.estimate_amount} -> ${newAmount}`);
  await recordJobEvent(job.id, 'status_accepted', 'Job accepted — booked, with a revised quote pending your approval', req.session.userId);
  await createNotification(
    job.client_user_id,
    'quote_submitted',
    `Your pro accepted the ${job.category} job and quoted UGX ${newAmount.toLocaleString()} — review and approve.`,
    '/dashboard.html#recentJobs'
  );

  res.json({ job, priceChange: pcResult.rows[0] });
}));
app.put('/api/provider/jobs/:id/complete', requireRole('provider'), (req, res) =>
  updateJobStatus(req, res, { from: ['accepted', 'on_the_way', 'arrived', 'in_progress'], to: 'awaiting_payment' })
);

// --- Price change protection ---
// A provider cannot bill more than the original estimate unless the
// client has explicitly accepted a price-change request. job_requests.
// final_amount is the only field earnings/payment logic ever reads —
// providers cannot write to it directly, only through this approval flow.

app.post('/api/jobs/:id/price-change', requireRole('provider'), asyncHandler(async (req, res) => {
  const { labourAmount, materialsAmount, reason } = req.body;
  const labour = parseInt(labourAmount, 10);
  const materials = parseInt(materialsAmount, 10);
  if (!Number.isInteger(labour) || labour < 0 || !Number.isInteger(materials) || materials < 0) {
    return res.status(400).json({ error: 'Please enter valid labour and materials amounts.' });
  }
  if (!isNonEmpty(reason)) {
    return res.status(400).json({ error: 'Please explain why the price is changing.' });
  }

  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  const jobResult = await pool.query(
    `SELECT * FROM job_requests WHERE id = $1 AND provider_id = $2 AND status = 'accepted'`,
    [req.params.id, providerId]
  );
  if (jobResult.rows.length === 0) {
    return res.status(404).json({ error: 'This job isn\u2019t in a state that allows a price change.' });
  }
  const job = jobResult.rows[0];

  const existingPending = await pool.query(
    `SELECT id FROM price_change_requests WHERE job_id = $1 AND status = 'PENDING'`,
    [req.params.id]
  );
  if (existingPending.rows.length > 0) {
    return res.status(409).json({ error: 'There\u2019s already a pending price change request for this job.' });
  }

  const originalAmount = job.final_amount ?? job.estimate_amount;
  const newAmount = labour + materials;

  const result = await pool.query(
    `INSERT INTO price_change_requests (job_id, requested_by, original_amount, new_amount, labour_amount, materials_amount, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, req.session.userId, originalAmount, newAmount, labour, materials, reason.trim()]
  );

  await createAuditLog(req.session.userId, 'PRICE_CHANGE_REQUESTED', 'job', req.params.id, `${originalAmount} -> ${newAmount}: ${reason.trim()}`);
  await recordJobEvent(req.params.id, 'price_change_requested', `Price change requested: UGX ${newAmount.toLocaleString()} — ${reason.trim()}`, req.session.userId);
  await createNotification(job.client_user_id, 'price_change_requested', `Your pro requested a price change for ${job.category}: UGX ${newAmount.toLocaleString()}`, '/dashboard.html#recentJobs');

  res.json({ priceChange: result.rows[0] });
}));

app.get('/api/jobs/:id/price-changes', requireLogin, asyncHandler(async (req, res) => {
  // Either party on the job can view its price-change history.
  const jobResult = await pool.query(
    `SELECT jr.*, p.user_id AS provider_user_id FROM job_requests jr JOIN providers p ON p.id = jr.provider_id WHERE jr.id = $1`,
    [req.params.id]
  );
  if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found.' });
  const job = jobResult.rows[0];
  if (job.client_user_id !== req.session.userId && job.provider_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  const result = await pool.query('SELECT * FROM price_change_requests WHERE job_id = $1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ priceChanges: result.rows });
}));

app.post('/api/price-changes/:id/decide', requireRole('client'), asyncHandler(async (req, res) => {
  const { decision } = req.body; // 'ACCEPTED' or 'DECLINED'
  if (!['ACCEPTED', 'DECLINED'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid decision.' });
  }

  const pcResult = await pool.query(
    `SELECT pcr.*, jr.client_user_id, jr.category FROM price_change_requests pcr
     JOIN job_requests jr ON jr.id = pcr.job_id
     WHERE pcr.id = $1 AND pcr.status = 'PENDING'`,
    [req.params.id]
  );
  if (pcResult.rows.length === 0) {
    return res.status(404).json({ error: 'This price change request is no longer pending.' });
  }
  const pc = pcResult.rows[0];
  if (pc.client_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  await pool.query(
    'UPDATE price_change_requests SET status = $1, decided_at = NOW() WHERE id = $2',
    [decision, req.params.id]
  );

  if (decision === 'ACCEPTED') {
    await pool.query('UPDATE job_requests SET final_amount = $1 WHERE id = $2', [pc.new_amount, pc.job_id]);
  }

  await createAuditLog(req.session.userId, `PRICE_CHANGE_${decision}`, 'job', pc.job_id, `UGX ${pc.new_amount}`);
  await recordJobEvent(pc.job_id, `price_change_${decision.toLowerCase()}`, `Price change of UGX ${pc.new_amount.toLocaleString()} ${decision === 'ACCEPTED' ? 'accepted' : 'declined'}`, req.session.userId);

  const providerUser = await pool.query(
    `SELECT p.user_id FROM job_requests jr JOIN providers p ON p.id = jr.provider_id WHERE jr.id = $1`,
    [pc.job_id]
  );
  if (providerUser.rows[0]) {
    createNotification(
      providerUser.rows[0].user_id,
      'price_change_decided',
      `Your price change for ${pc.category} was ${decision === 'ACCEPTED' ? 'accepted' : 'declined'}.`,
      '/provider-my-jobs.html'
    );
  }

  res.json({ message: decision === 'ACCEPTED' ? 'Price change accepted.' : 'Price change declined.' });
}));

// --- Payments (cash only for now — no processor integrated) ---

app.post('/api/jobs/:id/payment', requireRole('provider'), asyncHandler(async (req, res) => {
  const { method } = req.body;
  if (method !== 'cash') {
    return res.status(400).json({ error: 'Only cash payments can be recorded until a payment processor is connected.' });
  }

  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });

  const jobResult = await pool.query(
    `SELECT * FROM job_requests WHERE id = $1 AND provider_id = $2 AND status = 'awaiting_payment'`,
    [req.params.id, providerId]
  );
  if (jobResult.rows.length === 0) {
    return res.status(404).json({ error: 'This job isn\u2019t awaiting payment, or doesn\u2019t belong to you.' });
  }
  const job = jobResult.rows[0];
  const existingPayment = await pool.query('SELECT id FROM payments WHERE job_id = $1', [req.params.id]);
  if (existingPayment.rows.length > 0) {
    return res.status(409).json({ error: 'A payment has already been recorded for this job.' });
  }

  const amount = job.final_amount ?? job.estimate_amount;
  const result = await pool.query(
    `INSERT INTO payments (job_id, client_user_id, provider_id, amount, method, status)
     VALUES ($1,$2,$3,$4,'cash','COMPLETED') RETURNING *`,
    [req.params.id, job.client_user_id, providerId, amount]
  );
  await pool.query(`UPDATE job_requests SET status = 'completed', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  await recordJobEvent(job.id, 'payment_recorded', `Payment of UGX ${amount.toLocaleString()} recorded (cash)`, req.session.userId);
  await recordJobEvent(job.id, 'status_completed', 'Job completed', req.session.userId);

  await createAuditLog(req.session.userId, 'PAYMENT_RECORDED_CASH', 'job', req.params.id, `UGX ${amount}`);
  await createNotification(job.client_user_id, 'payment_recorded', `Your pro marked UGX ${amount.toLocaleString()} as paid in cash for ${job.category}.`, '/client-jobs.html');

  res.json({ payment: result.rows[0] });
}));

// --- Reviews ---

app.post('/api/reviews', requireRole('client'), async (req, res) => {
  const { jobId, rating, comment, qualityRating, punctualityRating, professionalismRating, communicationRating, priceFairnessRating } = req.body;
  const ratingNum = parseInt(rating, 10);

  if (!jobId || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Please give a rating between 1 and 5.' });
  }
  const subRatings = { qualityRating, punctualityRating, professionalismRating, communicationRating, priceFairnessRating };
  for (const [key, val] of Object.entries(subRatings)) {
    if (val !== undefined && val !== null && (!Number.isInteger(val) || val < 1 || val > 5)) {
      return res.status(400).json({ error: `${key} must be between 1 and 5.` });
    }
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

    // Suspicious-pattern flag (spec section 9's "fraud detection for
    // review patterns"): flags, never blocks. A real job — booking,
    // travel, doing the work — realistically takes longer than a few
    // minutes end to end.
    const minutesFromCreationToCompletion = (new Date(job.updated_at) - new Date(job.created_at)) / 60000;
    let flagReason = null;
    if (minutesFromCreationToCompletion < 10) {
      flagReason = 'Job was created and completed within 10 minutes.';
    }

    await client.query(
      `INSERT INTO reviews (job_id, client_user_id, provider_id, rating, comment,
         quality_rating, punctuality_rating, professionalism_rating, communication_rating, price_fairness_rating,
         flagged_suspicious, flag_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        jobId, req.session.userId, job.provider_id, ratingNum, isNonEmpty(comment) ? comment.trim() : '',
        qualityRating || null, punctualityRating || null, professionalismRating || null,
        communicationRating || null, priceFairnessRating || null,
        !!flagReason, flagReason
      ]
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
            p.name AS provider_name, p.photo AS provider_photo, uc.email AS client_email, uc.name AS client_name,
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
            CASE WHEN jr.client_user_id = $1 THEN p.photo ELSE NULL END AS other_party_photo,
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
  const otherPartyPhoto = job.client_user_id === req.session.userId ? job.provider_photo : null;
  res.json({
    messages: result.rows,
    job: { id: job.id, category: job.category, otherPartyName, otherPartyPhoto, otherPartyLastActive: job.other_last_active }
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

  // Detect, never auto-block, attempts to move the transaction off-platform
  // or other scam-pattern language (spec section 12). A human reviews
  // flagged messages — this never censors or delays delivery.
  const SUSPICIOUS_PATTERNS = [
    /pay(ment)? (me |him |her )?(directly|outside|off.?the.?app|off.?platform)/i,
    /\bwhats ?app\b.{0,15}(me|number|contact)/i,
    /send (money|cash) (to|via)/i,
    /\bmobile ?money\b.{0,20}\b(0\d{9}|\+256\d{9})\b/i,
    /\b(0\d{9}|\+256\d{9})\b.{0,20}\bmobile ?money\b/i,
    /avoid (the )?(fee|commission|platform)/i
  ];
  const matchedPattern = SUSPICIOUS_PATTERNS.find(p => p.test(req.body.body));

  const result = await pool.query(
    'INSERT INTO messages (job_id, sender_user_id, body, flagged, flag_reason) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [job.id, req.session.userId, req.body.body.trim(), !!matchedPattern, matchedPattern ? 'Possible off-platform payment language' : null]
  );

  const recipientUserId = job.client_user_id === req.session.userId ? job.provider_user_id : job.client_user_id;
  if (recipientUserId) {
    const senderName = job.client_user_id === req.session.userId ? (job.client_name || job.client_email) : job.provider_name;
    createNotification(recipientUserId, 'new_message', `New message from ${senderName}`, `/message-thread.html?jobId=${job.id}`);
  }

  res.json({ message: result.rows[0] });
}));

// --- Admin: pricing controls (AI spec Phase 8) ---

app.get('/api/admin/pricing-rules', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT pr.*, s.name AS service_name FROM pricing_rules pr
     JOIN services s ON s.id = pr.service_id ORDER BY s.name`
  );
  res.json({ rules: result.rows });
}));

app.put('/api/admin/pricing-rules/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const numericFields = ['labour_min', 'labour_max', 'materials_min', 'materials_max',
    'urgency_now_fee', 'urgency_today_fee', 'urgency_schedule_fee',
    'distance_5_10_fee', 'distance_10plus_fee'];
  const updates = [];
  const values = [];
  for (const f of numericFields) {
    if (req.body[f] !== undefined) {
      const n = Number(req.body[f]);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: `${f} must be a non-negative whole number.` });
      }
      values.push(n);
      updates.push(`${f} = $${values.length}`);
    }
  }
  if (req.body.active !== undefined) {
    values.push(!!req.body.active);
    updates.push(`active = $${values.length}`);
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }
  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE pricing_rules SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Pricing rule not found.' });

  await createAuditLog(req.session.userId, 'PRICING_RULE_UPDATED', 'pricing_rule', req.params.id, JSON.stringify(req.body));
  res.json({ rule: result.rows[0] });
}));

app.get('/api/admin/pricing-insights', requireRole('admin'), asyncHandler(async (req, res) => {
  const services = await pool.query('SELECT id, name FROM services ORDER BY name');
  const insights = [];
  for (const s of services.rows) {
    const historical = await getHistoricalPricing(s.name);
    insights.push({ service: s.name, ...historical });
  }

  // Jobs where the AI/pricing-engine estimate diverged significantly
  // (>25%) from what the job actually settled at — the spec's "jobs
  // where AI estimates were significantly different from final prices."
  const divergent = await pool.query(`
    SELECT ja.id AS assessment_id, jr.id AS job_id, ja.service, ja.job_type,
           ja.total_min, ja.total_max, COALESCE(jr.final_amount, jr.estimate_amount) AS final_amount,
           jr.updated_at
    FROM job_assessments ja
    JOIN job_requests jr ON jr.id = ja.job_id
    WHERE jr.status = 'completed'
      AND (
        COALESCE(jr.final_amount, jr.estimate_amount) < ja.total_min * 0.75
        OR COALESCE(jr.final_amount, jr.estimate_amount) > ja.total_max * 1.25
      )
    ORDER BY jr.updated_at DESC
    LIMIT 20
  `);

  res.json({ insights, divergentJobs: divergent.rows });
}));

// --- Admin: verification & trust dashboard ---

app.get('/api/admin/applications', requireRole('admin'), asyncHandler(async (req, res) => {
  const statusFilter = req.query.status; // optional: PENDING, APPROVED, REJECTED, SUSPENDED
  const params = [];
  let where = '';
  if (statusFilter) {
    where = 'WHERE p.approval_status = $1';
    params.push(statusFilter);
  }

  const result = await pool.query(
    `SELECT p.id, p.name, p.category, p.location, p.rating, p.approval_status, p.experience_years, p.created_at, p.photo,
            u.email, u.phone,
            (SELECT COUNT(*)::int FROM job_requests jr WHERE jr.provider_id = p.id AND jr.status = 'completed') AS completed_jobs,
            (SELECT COUNT(*)::int FROM reports WHERE reported_user_id = u.id) AS report_count,
            (SELECT COUNT(*)::int FROM disputes d JOIN job_requests jr2 ON jr2.id = d.job_id WHERE jr2.provider_id = p.id) AS dispute_count
     FROM providers p
     JOIN users u ON u.id = p.user_id
     ${where}
     ORDER BY p.created_at DESC`,
    params
  );
  res.json({ applications: result.rows });
}));

app.get('/api/admin/providers/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const providerId = req.params.id;
  const providerResult = await pool.query(
    `SELECT p.*, u.email, u.phone AS user_phone, u.created_at AS account_created_at
     FROM providers p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
    [providerId]
  );
  if (providerResult.rows.length === 0) {
    return res.status(404).json({ error: 'Provider not found.' });
  }
  const provider = providerResult.rows[0];

  const verifications = await pool.query('SELECT * FROM verifications WHERE provider_id = $1', [providerId]);
  const services = await pool.query(
    `SELECT ws.id, s.name, ws.verification_status, ws.notes, ws.verified_at FROM worker_services ws
     JOIN services s ON s.id = ws.service_id WHERE ws.provider_id = $1 ORDER BY s.name`,
    [providerId]
  );
  const credentials = await pool.query('SELECT * FROM credentials WHERE provider_id = $1 ORDER BY created_at DESC', [providerId]);
  // Documents are only ever returned to an authenticated admin, never to
  // any other role or any public-facing endpoint.
  const documents = await pool.query(
    'SELECT id, verification_type, document_type, file_data, uploaded_at FROM verification_documents WHERE provider_id = $1 ORDER BY uploaded_at DESC',
    [providerId]
  );
  const jobStats = await pool.query(
    `SELECT
       COUNT(*)::int AS total_jobs,
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
       COUNT(*) FILTER (WHERE status = 'declined')::int AS declined_jobs,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_jobs
     FROM job_requests WHERE provider_id = $1`,
    [providerId]
  );
  const reports = await pool.query(
    `SELECT r.*, ru.email AS reporter_email FROM reports r JOIN users ru ON ru.id = r.reporter_user_id
     WHERE r.reported_user_id = $1 ORDER BY r.created_at DESC`,
    [provider.user_id]
  );
  const disputes = await pool.query(
    `SELECT d.* FROM disputes d JOIN job_requests jr ON jr.id = d.job_id WHERE jr.provider_id = $1 ORDER BY d.created_at DESC`,
    [providerId]
  );
  const suspensions = await pool.query('SELECT * FROM suspensions WHERE user_id = $1 ORDER BY created_at DESC', [provider.user_id]);
  const auditHistory = await pool.query(
    `SELECT al.*, u.email AS actor_email FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id
     WHERE al.target_type = 'provider' AND al.target_id = $1 ORDER BY al.created_at DESC LIMIT 30`,
    [providerId]
  );

  res.json({
    provider, verifications: verifications.rows, services: services.rows, credentials: credentials.rows,
    documents: documents.rows, jobStats: jobStats.rows[0], reports: reports.rows, disputes: disputes.rows,
    suspensions: suspensions.rows, auditHistory: auditHistory.rows
  });
}));

app.post('/api/admin/providers/:id/approve', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'provider_application', entityId: req.params.id, decision: 'APPROVED', reviewerId: req.session.userId, reason: req.body.notes });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Provider approved.' });
}));

app.post('/api/admin/providers/:id/reject', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'provider_application', entityId: req.params.id, decision: 'REJECTED', reviewerId: req.session.userId, reason: req.body.reason });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Provider rejected.' });
}));

// Not a status transition — no change to the approval state machine, so
// it stays outside the engine, but still follows the same audit+notify
// pattern by hand since it's a one-off.
app.post('/api/admin/providers/:id/request-info', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!isNonEmpty(req.body.message)) {
    return res.status(400).json({ error: 'Please describe what\u2019s needed.' });
  }
  const result = await pool.query('SELECT user_id FROM providers WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Provider not found.' });

  await createAuditLog(req.session.userId, 'PROVIDER_INFO_REQUESTED', 'provider', req.params.id, req.body.message);
  await createNotification(result.rows[0].user_id, 'more_info_requested', `HandyLink needs more information: ${req.body.message}`, '/provider-profile.html');
  res.json({ message: 'Request sent.' });
}));

app.post('/api/admin/providers/:id/suspend', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'provider_application', entityId: req.params.id, decision: 'SUSPENDED', reviewerId: req.session.userId, reason: req.body.reason });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Provider suspended.' });
}));

app.post('/api/admin/providers/:id/reinstate', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'provider_application', entityId: req.params.id, decision: APPROVAL_ENTITIES.provider_application.reinstateDecision, reviewerId: req.session.userId, reason: req.body.notes });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Provider reinstated.' });
}));

app.post('/api/admin/verifications/:id/decide', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'verification', entityId: req.params.id, decision: req.body.decision, reviewerId: req.session.userId, reason: req.body.notes });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Verification updated.' });
}));

app.post('/api/admin/worker-services/:id/decide', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'skill_verification', entityId: req.params.id, decision: req.body.decision, reviewerId: req.session.userId, reason: req.body.notes });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Service verification updated.' });
}));

// --- Reports & disputes (spec sections 13-14) ---

const REPORT_CATEGORIES = [
  'identity_mismatch', 'suspected_scam', 'unsafe_behavior', 'harassment', 'threatening_behavior',
  'unauthorized_price_increase', 'poor_workmanship', 'property_damage', 'worker_did_not_arrive',
  'customer_fraud', 'unsafe_location', 'non_payment', 'fake_job', 'suspicious_behavior', 'other'
];

app.post('/api/reports', requireLogin, asyncHandler(async (req, res) => {
  const { reportedUserId, jobId, category, description, attachment } = req.body;
  if (!Number.isInteger(reportedUserId)) {
    return res.status(400).json({ error: 'Please specify who this report is about.' });
  }
  if (!REPORT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Please choose a valid report category.' });
  }
  if (!isNonEmpty(description)) {
    return res.status(400).json({ error: 'Please describe what happened.' });
  }
  if (description.length > 2000) {
    return res.status(400).json({ error: 'Please keep the description under 2000 characters.' });
  }
  if (attachment && !isValidPhoto(attachment)) {
    return res.status(400).json({ error: 'That attachment is too large or in an unsupported format.' });
  }
  if (reportedUserId === req.session.userId) {
    return res.status(400).json({ error: 'You can\u2019t report yourself.' });
  }

  const reportedUser = await pool.query('SELECT id FROM users WHERE id = $1', [reportedUserId]);
  if (reportedUser.rows.length === 0) {
    return res.status(404).json({ error: 'That user doesn\u2019t exist.' });
  }

  // If a jobId is provided, the reporter must actually be a participant.
  if (jobId) {
    const jobCheck = await pool.query(
      `SELECT jr.id FROM job_requests jr JOIN providers p ON p.id = jr.provider_id
       WHERE jr.id = $1 AND (jr.client_user_id = $2 OR p.user_id = $2)`,
      [jobId, req.session.userId]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You\u2019re not a participant on that job.' });
    }
  }

  const result = await pool.query(
    `INSERT INTO reports (reporter_user_id, reported_user_id, job_id, category, description, attachment)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.session.userId, reportedUserId, jobId || null, category, description.trim(), isNonEmpty(attachment) ? attachment : null]
  );

  await createAuditLog(req.session.userId, 'REPORT_FILED', 'report', result.rows[0].id, category);
  res.json({ message: 'Report submitted. Our team will review it.', reportId: result.rows[0].id });
}));

app.post('/api/disputes', requireLogin, asyncHandler(async (req, res) => {
  const { jobId, reason } = req.body;
  if (!isNonEmpty(reason)) {
    return res.status(400).json({ error: 'Please explain the issue.' });
  }
  if (reason.length > 2000) {
    return res.status(400).json({ error: 'Please keep this under 2000 characters.' });
  }

  const jobCheck = await pool.query(
    `SELECT jr.id FROM job_requests jr JOIN providers p ON p.id = jr.provider_id
     WHERE jr.id = $1 AND (jr.client_user_id = $2 OR p.user_id = $2)`,
    [jobId, req.session.userId]
  );
  if (jobCheck.rows.length === 0) {
    return res.status(403).json({ error: 'You\u2019re not a participant on that job.' });
  }

  const existing = await pool.query(`SELECT id FROM disputes WHERE job_id = $1 AND status IN ('OPEN','UNDER_REVIEW')`, [jobId]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'There\u2019s already an open dispute for this job.' });
  }

  const result = await pool.query(
    'INSERT INTO disputes (job_id, raised_by, reason) VALUES ($1,$2,$3) RETURNING id',
    [jobId, req.session.userId, reason.trim()]
  );
  await createAuditLog(req.session.userId, 'DISPUTE_RAISED', 'dispute', result.rows[0].id, `job ${jobId}`);
  res.json({ message: 'Dispute filed. Our team will review it.', disputeId: result.rows[0].id });
}));

app.get('/api/admin/reports', requireRole('admin'), asyncHandler(async (req, res) => {
  const statusFilter = req.query.status;
  const params = [];
  let where = '';
  if (statusFilter) { where = 'WHERE r.status = $1'; params.push(statusFilter); }
  const result = await pool.query(
    `SELECT r.*, ru.email AS reporter_email, rd.email AS reported_email
     FROM reports r
     JOIN users ru ON ru.id = r.reporter_user_id
     JOIN users rd ON rd.id = r.reported_user_id
     ${where}
     ORDER BY r.created_at DESC`,
    params
  );
  res.json({ reports: result.rows });
}));

app.post('/api/admin/reports/:id/resolve', requireRole('admin'), asyncHandler(async (req, res) => {
  const { status, adminNotes } = req.body;
  if (!['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const result = await pool.query(
    'UPDATE reports SET status = $1, admin_notes = $2 WHERE id = $3 RETURNING id',
    [status, adminNotes || '', req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found.' });
  await createAuditLog(req.session.userId, 'REPORT_RESOLVED', 'report', req.params.id, `${status}: ${adminNotes || ''}`);
  res.json({ message: 'Report updated.' });
}));

app.get('/api/admin/disputes', requireRole('admin'), asyncHandler(async (req, res) => {
  const statusFilter = req.query.status;
  const params = [];
  let where = '';
  if (statusFilter) { where = 'WHERE d.status = $1'; params.push(statusFilter); }
  const result = await pool.query(
    `SELECT d.*, u.email AS raised_by_email, jr.category, jr.description AS job_description
     FROM disputes d
     JOIN users u ON u.id = d.raised_by
     JOIN job_requests jr ON jr.id = d.job_id
     ${where}
     ORDER BY d.created_at DESC`,
    params
  );
  res.json({ disputes: result.rows });
}));

app.post('/api/admin/disputes/:id/resolve', requireRole('admin'), asyncHandler(async (req, res) => {
  const { status, resolutionNotes } = req.body;
  if (!['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  const result = await pool.query(
    `UPDATE disputes SET status = $1, resolution_notes = $2, resolved_by = $3,
       resolved_at = CASE WHEN $1 IN ('RESOLVED','DISMISSED') THEN NOW() ELSE resolved_at END
     WHERE id = $4 RETURNING id`,
    [status, resolutionNotes || '', req.session.userId, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found.' });
  await createAuditLog(req.session.userId, 'DISPUTE_RESOLVED', 'dispute', req.params.id, `${status}: ${resolutionNotes || ''}`);
  res.json({ message: 'Dispute updated.' });
}));

// --- Fraud detection & reliability scoring (spec sections 15-16) ---

// Server-side only, never user-editable. Weighted from real data:
// completion history, responsiveness (decline rate), customer ratings,
// disputes against them, and whether they're actually verified.
async function computeReliabilityScore(providerId) {
  const stats = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
       COUNT(*)::int AS total
     FROM job_requests WHERE provider_id = $1`,
    [providerId]
  );
  const s = stats.rows[0];

  const providerResult = await pool.query('SELECT rating, approval_status FROM providers WHERE id = $1', [providerId]);
  const provider = providerResult.rows[0];
  if (!provider) return null;

  const disputeCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM disputes d JOIN job_requests jr ON jr.id = d.job_id WHERE jr.provider_id = $1`,
    [providerId]
  );
  const verifiedServiceCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM worker_services WHERE provider_id = $1 AND verification_status = 'VERIFIED'`,
    [providerId]
  );

  let score = 50; // baseline
  score += Math.min(s.completed * 2, 30); // up to +30 for a solid completion history
  const declineRate = s.total > 0 ? s.declined / s.total : 0;
  score -= Math.round(declineRate * 20); // penalize frequent declines
  if (provider.rating) score += Math.round((provider.rating - 3) * 5); // rating above/below 3 shifts score
  score -= Math.min(disputeCount.rows[0].count * 8, 24); // disputes hurt, capped
  if (provider.approval_status === 'APPROVED') score += 5;
  score += Math.min(verifiedServiceCount.rows[0].count * 3, 9); // verified skills help, capped

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, completed: s.completed, declined: s.declined, disputes: disputeCount.rows[0].count, verifiedServices: verifiedServiceCount.rows[0].count };
}

app.get('/api/provider/reliability', requireRole('provider'), asyncHandler(async (req, res) => {
  const providerId = await getProviderIdForUser(req.session.userId);
  if (!providerId) return res.status(404).json({ error: 'No provider profile found.' });
  const result = await computeReliabilityScore(providerId);
  res.json(result);
}));

// ============================================================
// INTELLIGENT MATCHING ENGINE (spec sections 14-19)
// Hard filters first (eligibility), then weighted scoring (ranking).
// Never exposes raw scores to the customer — only labels + plain-
// language explanations. Weights come from matching_weight_profiles,
// not a hard-coded formula, so Phase 5's admin UI can tune them later.
// ============================================================

async function getWeightProfile(urgency, complexity, isHighRisk) {
  let profileName = 'default';
  if (urgency === 'now') profileName = 'emergency';
  else if (isHighRisk || complexity === 'COMPLEX') profileName = 'technical';
  else if (urgency === 'schedule') profileName = 'planned';

  const result = await pool.query('SELECT * FROM matching_weight_profiles WHERE name = $1', [profileName]);
  if (result.rows.length > 0) return result.rows[0];
  const fallback = await pool.query('SELECT * FROM matching_weight_profiles WHERE is_default = TRUE LIMIT 1');
  return fallback.rows[0] || { skill_weight: 30, reliability_weight: 25, distance_weight: 15, price_weight: 15, experience_weight: 10, availability_weight: 5 };
}

// Bayesian-ish shrinkage: pulls a rating toward a neutral prior when a
// provider has few jobs, so 5.0★ from 2 jobs doesn't beat 4.8★ from 250
// (spec section 14B's explicit example).
function adjustedRating(rating, jobCount) {
  const PRIOR = 4.0;
  const PRIOR_WEIGHT = 8;
  const r = rating || PRIOR;
  return ((r * jobCount) + (PRIOR * PRIOR_WEIGHT)) / (jobCount + PRIOR_WEIGHT);
}

app.get('/api/matching/candidates', requireRole('client'), asyncHandler(async (req, res) => {
  const { category, urgency, lat, lng, complexity, estimateMin, estimateMax } = req.query;
  if (!isNonEmpty(category)) {
    return res.status(400).json({ error: 'Please specify a category.' });
  }
  const myLat = lat !== undefined ? parseFloat(lat) : null;
  const myLng = lng !== undefined ? parseFloat(lng) : null;
  const isHighRisk = HIGH_RISK_SERVICES.includes(category);

  // --- Hard filters (spec section 19): eligibility, not scoring ---
  const eligible = await pool.query(`
    SELECT p.*,
      ws.verification_status AS skill_status,
      ws.reported_experience_level, ws.reported_jobs_range,
      COALESCE((SELECT status FROM verifications WHERE provider_id = p.id AND type = 'identity'), 'PENDING') AS identity_status,
      COALESCE((SELECT status FROM verifications WHERE provider_id = p.id AND type = 'phone'), 'PENDING') AS phone_status,
      (SELECT COUNT(*)::int FROM job_requests WHERE provider_id = p.id AND category = $1 AND status = 'completed') AS category_completed_jobs,
      (SELECT COUNT(*)::int FROM job_requests WHERE provider_id = p.id AND status = 'completed') AS total_completed_jobs,
      (SELECT COUNT(*)::int FROM job_requests WHERE provider_id = p.id AND status = 'declined') AS total_declined,
      (SELECT COUNT(*)::int FROM job_requests WHERE provider_id = p.id) AS total_requests,
      (SELECT COUNT(*)::int FROM disputes d JOIN job_requests jr ON jr.id = d.job_id WHERE jr.provider_id = p.id) AS dispute_count,
      (SELECT array_agg(sp.name) FROM worker_service_specialties wss
        JOIN specialties sp ON sp.id = wss.specialty_id WHERE wss.worker_service_id = ws.id) AS specialties
    FROM providers p
    JOIN worker_services ws ON ws.provider_id = p.id
    JOIN services s ON s.id = ws.service_id
    WHERE p.approval_status = 'APPROVED' AND s.name = $1
  `, [category]);

  let candidates = eligible.rows.filter(p => {
    // High-risk services hard-require VERIFIED for that exact skill —
    // no amount of proximity or price can substitute (spec section 19).
    if (isHighRisk && p.skill_status !== 'VERIFIED') return false;
    // Outside their stated service radius, unless they've opted into
    // long-distance jobs and this is one (checked loosely — real routing
    // distance is computed below, this just excludes the obviously out
    // of range once we know the distance).
    return true;
  });

  const weights = await getWeightProfile(urgency, complexity, isHighRisk);
  const totalWeight = weights.skill_weight + weights.reliability_weight + weights.distance_weight +
    weights.price_weight + weights.experience_weight + weights.availability_weight;

  const EXPERIENCE_SCORES = { 'less_than_1': 20, '1_2': 45, '3_5': 65, '6_10': 85, '10_plus': 100 };
  const JOBS_SCORES = { '0_10': 10, '11_25': 30, '26_50': 50, '51_100': 70, '101_250': 85, '250_plus': 100 };

  const favoritesResult = await pool.query('SELECT provider_id FROM favorites WHERE client_user_id = $1', [req.session.userId]);
  const favoriteIds = new Set(favoritesResult.rows.map(r => r.provider_id));

  const scored = candidates.map(p => {
    const dist = (myLat !== null && myLng !== null && p.latitude !== null)
      ? distanceKmServer(myLat, myLng, p.latitude, p.longitude) : null;

    // Outside their radius and not opted into long-distance jobs — treat
    // as a hard filter here rather than in the SQL above, since we need
    // the computed distance to know.
    if (dist !== null && dist > p.service_radius_km && !p.long_distance_jobs_enabled) {
      return null;
    }

    // A. Skill match (has the service + verified bonus + specialty match)
    let skillScore = 50;
    if (p.skill_status === 'VERIFIED') skillScore = 90;
    else if (p.skill_status === 'IN_REVIEW') skillScore = 60;
    skillScore = Math.min(100, skillScore + (p.category_completed_jobs > 0 ? 10 : 0));

    // B. Reliability, with Bayesian shrinkage on rating + decline/dispute penalties
    const adjRating = adjustedRating(parseFloat(p.rating), p.total_completed_jobs);
    let reliabilityScore = (adjRating / 5) * 100;
    const declineRate = p.total_requests > 0 ? p.total_declined / p.total_requests : 0;
    reliabilityScore -= declineRate * 20;
    reliabilityScore -= Math.min(p.dispute_count * 10, 30);
    reliabilityScore = Math.max(0, Math.min(100, reliabilityScore));

    // C. Distance — closer is better, but capped contribution, not dominant
    let distanceScore = 50;
    if (dist !== null) {
      distanceScore = Math.max(0, 100 - (dist / Math.max(p.service_radius_km, 1)) * 100);
    }

    // D. Price/value — thin signal without real transaction history yet;
    // if the provider has a stated hourly/callout fee, compare loosely
    // against the job's own estimate range; otherwise neutral.
    let priceScore = 50;
    if (estimateMin && estimateMax && (p.hourly_rate || p.callout_fee)) {
      const providerIndicator = p.callout_fee || p.hourly_rate;
      const mid = (parseInt(estimateMin, 10) + parseInt(estimateMax, 10)) / 2;
      const ratio = providerIndicator / Math.max(mid, 1);
      priceScore = Math.max(0, 100 - Math.abs(1 - ratio) * 80);
    }

    // E. Relevant experience — the SPECIFIC service, not total years
    const experienceScore = Math.round(
      ((EXPERIENCE_SCORES[p.reported_experience_level] || 40) +
       (JOBS_SCORES[p.reported_jobs_range] || 20) +
       Math.min(p.category_completed_jobs * 5, 40)) / 3
    );

    // F. Availability — adjusted for urgency
    let availabilityScore = 40;
    if (p.availability_status === 'available_now') availabilityScore = 100;
    else if (p.availability_status === 'available_today') availabilityScore = 75;
    else if (p.availability_status === 'not_available') availabilityScore = 0;
    if (urgency === 'now' && !p.accepts_emergency) availabilityScore = Math.min(availabilityScore, 30);
    if (urgency === 'today' && !p.accepts_same_day) availabilityScore = Math.min(availabilityScore, 40);

    const overall = totalWeight > 0 ? (
      skillScore * weights.skill_weight +
      reliabilityScore * weights.reliability_weight +
      distanceScore * weights.distance_weight +
      priceScore * weights.price_weight +
      experienceScore * weights.experience_weight +
      availabilityScore * weights.availability_weight
    ) / totalWeight : 50;

    return {
      id: p.id, name: p.name, category: p.category, location: p.location, phone: p.phone, bio: p.bio,
      photo: p.photo, rating: p.rating,
      experience_years: p.experience_years, availability_status: p.availability_status,
      category_verified: p.skill_status === 'VERIFIED', specialties: p.specialties || [],
      identity_status: p.identity_status, phone_status: p.phone_status,
      completed_jobs: p.total_completed_jobs, similar_jobs: p.category_completed_jobs, distanceKm: dist,
      isFavorite: favoriteIds.has(p.id),
      _scores: { skillScore, reliabilityScore, distanceScore, priceScore, experienceScore, availabilityScore, overall }
    };
  }).filter(Boolean);

  scored.sort((a, b) => b._scores.overall - a._scores.overall);
  const top = scored.slice(0, 10);

  // Labels + plain-language reasons — never the raw score itself (section 16).
  const labeled = new Set();
  top.forEach((c, i) => {
    if (i === 0) { c.matchLabel = 'Best Match'; labeled.add(c.id); }
  });
  const byReliability = [...top].filter(c => !labeled.has(c.id)).sort((a, b) => b._scores.reliabilityScore - a._scores.reliabilityScore)[0];
  if (byReliability) { byReliability.matchLabel = 'Highly Rated'; labeled.add(byReliability.id); }
  const byPrice = [...top].filter(c => !labeled.has(c.id)).sort((a, b) => b._scores.priceScore - a._scores.priceScore)[0];
  if (byPrice) { byPrice.matchLabel = 'Best Value'; labeled.add(byPrice.id); }

  top.forEach(c => {
    const reasons = [];
    if (c._scores.skillScore >= 85) reasons.push(`strong match for ${category.toLowerCase()}`);
    if (c._scores.reliabilityScore >= 80) reasons.push('highly rated');
    if (c.distanceKm !== null && c.distanceKm < 5) reasons.push('nearby');
    if (c.availability_status === 'available_now') reasons.push('available now');
    if (c._scores.experienceScore >= 75) reasons.push('extensive relevant experience');
    c.whyRecommended = reasons.length > 0
      ? `${c.name.split(' ')[0]} is a ${reasons.join(', ')}.`
      : `${c.name.split(' ')[0]} offers ${category.toLowerCase()} services in your area.`;
    delete c._scores; // never sent to the client
  });

  res.json({ candidates: top, weightProfileUsed: weights.name || 'default' });
}));

app.post('/api/admin/users/:id/suspend', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'user_account', entityId: req.params.id, decision: 'SUSPENDED', reviewerId: req.session.userId, reason: req.body.reason });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'User suspended.' });
}));

app.post('/api/admin/users/:id/reinstate', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await processApprovalDecision({ entityType: 'user_account', entityId: req.params.id, decision: APPROVAL_ENTITIES.user_account.reinstateDecision, reviewerId: req.session.userId, reason: req.body.notes });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'User reinstated.' });
}));

// Hard delete — different from suspension, which is reversible and keeps
// the account's history intact. This permanently removes the account and
// (via existing ON DELETE CASCADE foreign keys) everything tied to it.
// An admin can never delete their own account through this route.
app.delete('/api/admin/users/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.userId) {
    return res.status(400).json({ error: 'You can\u2019t delete your own admin account from here.' });
  }
  const userResult = await pool.query('SELECT email, role FROM users WHERE id = $1', [req.params.id]);
  if (userResult.rows.length === 0) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const target = userResult.rows[0];

  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  await createAuditLog(req.session.userId, 'USER_DELETED', 'user', req.params.id, `${target.role}: ${target.email}`);
  res.json({ message: 'User deleted.' });
}));

app.get('/api/admin/flagged-messages', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT m.id, m.job_id, m.body, m.flag_reason, m.created_at, u.email AS sender_email
    FROM messages m JOIN users u ON u.id = m.sender_user_id
    WHERE m.flagged = TRUE
    ORDER BY m.created_at DESC LIMIT 50
  `);
  res.json({ messages: result.rows });
}));

// --- Global audit log: the one "show me everything that happened" screen ---

// --- Global users directory (all clients and providers, one screen) ---

// Online-status thresholds, based on last_active_at which is already
// updated on every authenticated request — this is real presence data,
// not a guess.
const ONLINE_NOW_MINUTES = 5;
const RECENTLY_ACTIVE_MINUTES = 30;

app.get('/api/admin/overview-stats', requireRole('admin'), asyncHandler(async (req, res) => {
  const [users, onlineNow, recentlyActive, providers, jobsToday, pendingApps, openReports, openDisputes, jobsTotal] = await Promise.all([
    pool.query(`SELECT role, COUNT(*)::int AS count FROM users GROUP BY role`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE last_active_at >= NOW() - INTERVAL '${ONLINE_NOW_MINUTES} minutes'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE last_active_at >= NOW() - INTERVAL '${RECENTLY_ACTIVE_MINUTES} minutes' AND last_active_at < NOW() - INTERVAL '${ONLINE_NOW_MINUTES} minutes'`),
    pool.query(`SELECT approval_status, COUNT(*)::int AS count FROM providers GROUP BY approval_status`),
    pool.query(`SELECT COUNT(*)::int AS count FROM job_requests WHERE created_at >= CURRENT_DATE`),
    pool.query(`SELECT COUNT(*)::int AS count FROM providers WHERE approval_status = 'PENDING'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM reports WHERE status = 'OPEN'`),
    pool.query(`SELECT COUNT(*)::int AS count FROM disputes WHERE status = 'OPEN'`),
    pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(COALESCE(final_amount, estimate_amount)), 0)::int AS total_value FROM job_requests WHERE status = 'completed'`)
  ]);

  const usersByRole = {};
  users.rows.forEach(r => { usersByRole[r.role] = r.count; });
  const providersByStatus = {};
  providers.rows.forEach(r => { providersByStatus[r.approval_status] = r.count; });

  res.json({
    usersByRole,
    onlineNow: onlineNow.rows[0].count,
    recentlyActive: recentlyActive.rows[0].count,
    providersByStatus,
    jobsToday: jobsToday.rows[0].count,
    pendingApplications: pendingApps.rows[0].count,
    openReports: openReports.rows[0].count,
    openDisputes: openDisputes.rows[0].count,
    completedJobsCount: jobsTotal.rows[0].count,
    completedJobsValue: jobsTotal.rows[0].total_value
  });
}));

app.get('/api/admin/user-locations', requireRole('admin'), asyncHandler(async (req, res) => {
  const clients = await pool.query(`
    SELECT id, name, email, 'client' AS role, latitude, longitude, city, district, last_active_at
    FROM users WHERE role = 'client' AND latitude IS NOT NULL AND longitude IS NOT NULL
  `);
  const providers = await pool.query(`
    SELECT p.id, p.name, u.email, 'provider' AS role, p.latitude, p.longitude, p.city, p.district, u.last_active_at, p.approval_status, p.category
    FROM providers p JOIN users u ON u.id = p.user_id
    WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
  `);
  const now = Date.now();
  const withStatus = (row) => {
    const lastActive = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;
    const minutesAgo = (now - lastActive) / 60000;
    const status = minutesAgo <= ONLINE_NOW_MINUTES ? 'online' : minutesAgo <= RECENTLY_ACTIVE_MINUTES ? 'recent' : 'offline';
    return { ...row, status };
  };
  res.json({
    users: [...clients.rows, ...providers.rows].map(withStatus)
  });
}));

app.get('/api/admin/users', requireRole('admin'), asyncHandler(async (req, res) => {
  const { search, role, status, beforeId } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

  const conditions = [];
  const params = [];

  if (role) {
    params.push(role);
    conditions.push(`u.role = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`u.account_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  if (beforeId) {
    params.push(beforeId);
    conditions.push(`u.id < $${params.length}`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit + 1);

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.phone, u.role, u.account_status, u.created_at, u.last_active_at,
            p.id AS provider_id, p.approval_status, p.rating, p.category
     FROM users u LEFT JOIN providers p ON p.user_id = u.id
     ${where}
     ORDER BY u.id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const users = hasMore ? result.rows.slice(0, limit) : result.rows;
  res.json({ users, hasMore });
}));

// Visit this while logged in as admin to see exactly why the AI
// assessment might be falling back — the real HTTP status and error
// body from OpenRouter, not just a generic "not working."
app.get('/api/admin/ai-status', requireRole('admin'), asyncHandler(async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.json({ configured: false, message: 'OPENROUTER_API_KEY is not set on this server.' });
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://handylink.example',
        'X-Title': 'HandyLink'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with only the word: ok' }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const bodyText = await response.text();
    if (!response.ok) {
      return res.json({ configured: true, model: OPENROUTER_MODEL, success: false, httpStatus: response.status, responseBody: bodyText });
    }
    return res.json({ configured: true, model: OPENROUTER_MODEL, success: true, responseBody: bodyText });
  } catch (err) {
    return res.json({ configured: true, model: OPENROUTER_MODEL, success: false, error: err.message });
  }
}));

app.get('/api/admin/audit-log-actions', requireRole('admin'), asyncHandler(async (req, res) => {
  const result = await pool.query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  res.json({ actions: result.rows.map(r => r.action) });
}));

app.get('/api/admin/audit-logs', requireRole('admin'), asyncHandler(async (req, res) => {
  const { search, action, targetType, from, to, beforeId } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  const conditions = [];
  const params = [];

  if (action) {
    params.push(action);
    conditions.push(`al.action = $${params.length}`);
  }
  if (targetType) {
    params.push(targetType);
    conditions.push(`al.target_type = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`al.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`al.created_at <= $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(al.action ILIKE $${params.length} OR al.notes ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (beforeId) {
    params.push(beforeId);
    conditions.push(`al.id < $${params.length}`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit + 1); // fetch one extra to know if there's more

  const result = await pool.query(
    `SELECT al.*, u.email AS actor_email
     FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_user_id
     ${where}
     ORDER BY al.id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const logs = hasMore ? result.rows.slice(0, limit) : result.rows;
  res.json({ logs, hasMore });
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
