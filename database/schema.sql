-- ============================================================================
-- WhatsApp Sender v3 — Database Schema
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- SETTINGS — global defaults and app configuration
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Global defaults (auto mode pulls from these)
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('default_country_code',     '91'),   -- prepended when phone has no country code
  ('default_batch_size',       '10'),   -- contacts per batch
  ('default_batch_interval_min','120'), -- minutes between batches
  ('default_delay_min',        '15'),   -- seconds min between messages
  ('default_delay_max',        '40'),   -- seconds max between messages
  ('default_daily_limit',      '50'),   -- max sends per day per campaign
  ('default_media_first',      '0'),    -- 0=text first, 1=media first
  ('default_wa_check',         '0'),    -- 0=skip WA check, 1=check before send
  ('whatsapp_status',          'disconnected');

-- ============================================================================
-- CAMPAIGNS
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,

  -- Message content
  message_template      TEXT,           -- supports {name} {first_name} placeholders
  salutation            TEXT,           -- e.g. "Namaste", "Hi", "Dear"
  signature             TEXT,           -- appended to message

  -- Media
  media_path            TEXT,           -- path to uploaded file
  media_type            TEXT CHECK (media_type IN ('image','video','document', NULL)),
  media_original_name   TEXT,           -- original filename shown in UI
  media_first           INTEGER DEFAULT 0, -- 0=text first, 1=media first

  -- Mode
  auto_mode             INTEGER DEFAULT 1, -- 1=use settings defaults, 0=use campaign values

  -- Pace controls (used when auto_mode = 0)
  country_code          TEXT,
  batch_size            INTEGER,
  batch_interval_min    INTEGER,
  delay_min             INTEGER,
  delay_max             INTEGER,
  daily_limit           INTEGER,

  -- WhatsApp check
  wa_check_enabled      INTEGER DEFAULT 0, -- check if number is WA registered before send

  -- Status
  status                TEXT DEFAULT 'draft'
                        CHECK (status IN ('draft','active','paused','completed')),

  -- Stats (cached — updated after each send)
  total_contacts        INTEGER DEFAULT 0,
  total_sent            INTEGER DEFAULT 0,
  total_failed          INTEGER DEFAULT 0,
  total_skipped         INTEGER DEFAULT 0,
  total_noweb           INTEGER DEFAULT 0,

  -- Timestamps
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- ============================================================================
-- CAMPAIGN CONTACTS — imported from Excel/CSV per campaign
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL,

  -- Contact data (from imported file)
  phone        TEXT NOT NULL,           -- normalised phone number with country code
  phone_raw    TEXT,                    -- original phone as imported
  name         TEXT,                    -- full name
  first_name   TEXT,                    -- extracted or provided
  last_name    TEXT,
  email        TEXT,
  label        TEXT,                    -- label/tag column from source file if present
  source       TEXT,                    -- source file name
  extra_data   TEXT,                    -- JSON string of any additional columns

  -- WhatsApp validation
  wa_valid     INTEGER,                 -- NULL=unchecked, 1=registered, 0=not registered
  wa_checked_at DATETIME,

  -- Send status
  status       TEXT DEFAULT 'pending'
               CHECK (status IN ('pending','sent','failed','skipped','noweb')),
  sent_at      DATETIME,
  error        TEXT,

  -- Timestamps
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cc_campaign    ON campaign_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cc_status      ON campaign_contacts(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_phone       ON campaign_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_cc_label       ON campaign_contacts(campaign_id, label);
CREATE INDEX IF NOT EXISTS idx_cc_wa_valid    ON campaign_contacts(campaign_id, wa_valid);

-- ============================================================================
-- SEND HISTORY — full audit log of every send attempt
-- ============================================================================

CREATE TABLE IF NOT EXISTS send_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id          INTEGER,
  campaign_contact_id  INTEGER,
  campaign_name        TEXT,
  phone                TEXT,
  name                 TEXT,
  label                TEXT,
  status               TEXT NOT NULL,  -- sent / failed / skipped / noweb
  error                TEXT,
  sent_at              DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campaign_id)         REFERENCES campaigns(id)         ON DELETE SET NULL,
  FOREIGN KEY (campaign_contact_id) REFERENCES campaign_contacts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_history_campaign ON send_history(campaign_id);
CREATE INDEX IF NOT EXISTS idx_history_date     ON send_history(sent_at);
CREATE INDEX IF NOT EXISTS idx_history_phone    ON send_history(phone);
