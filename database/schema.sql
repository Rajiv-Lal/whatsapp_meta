-- ============================================================================
-- Anugnya WhatsApp Sender — Database Schema v1.0
-- Engine: better-sqlite3 (SQLite)
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================================
-- SETTINGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('default_batch_size',          '10'),
  ('default_delay_min_sec',       '20'),
  ('default_delay_max_sec',       '45'),
  ('default_batch_interval_min',  '120'),
  ('default_daily_limit',         '50'),
  ('min_days_between_contact',    '30'),
  ('schema_version',              '1');

-- ============================================================================
-- USERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  email                TEXT    NOT NULL UNIQUE,
  password             TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'operator'
                       CHECK (role IN ('admin', 'operator')),
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login           DATETIME,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token      TEXT    NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token   ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================================
-- USER_ACTIVITY
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  action      TEXT    NOT NULL,
  entity_type TEXT,
  entity_id   INTEGER,
  detail      TEXT,
  ip_address  TEXT,
  logged_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_user   ON user_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON user_activity(action);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON user_activity(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_time   ON user_activity(logged_at);

-- ============================================================================
-- TEMPLATES
-- ============================================================================

CREATE TABLE IF NOT EXISTS templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  language     TEXT    NOT NULL DEFAULT 'en',
  category     TEXT    NOT NULL DEFAULT 'MARKETING',
  status       TEXT    NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'pending', 'rejected', 'paused')),
  header_type  TEXT    CHECK (header_type IN ('image', 'video', 'document', 'text')),
  header_value TEXT,
  body_text    TEXT    NOT NULL,
  footer_text  TEXT,
  variable_map TEXT    NOT NULL DEFAULT '{}',
  button_url   TEXT,
  button_label TEXT,
  created_by   INTEGER,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_status ON templates(status);

-- ============================================================================
-- CONTACT_LISTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  source      TEXT,
  total       INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================================
-- CONTACTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS contacts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  phone                   TEXT    NOT NULL UNIQUE,
  name                    TEXT,
  first_name              TEXT,
  email                   TEXT,
  source                  TEXT,
  in_conversation         INTEGER NOT NULL DEFAULT 0,
  conversation_started_at DATETIME,
  last_contacted_at       DATETIME,
  notes                   TEXT,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_phone           ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_in_conversation ON contacts(in_conversation);

-- ============================================================================
-- CONTACT_LIST_MEMBERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS contact_list_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_list_id INTEGER NOT NULL,
  contact_id      INTEGER NOT NULL,
  added_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (contact_list_id, contact_id),
  FOREIGN KEY (contact_list_id) REFERENCES contact_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id)      REFERENCES contacts(id)      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clm_list    ON contact_list_members(contact_list_id);
CREATE INDEX IF NOT EXISTS idx_clm_contact ON contact_list_members(contact_id);

-- ============================================================================
-- CAMPAIGNS
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaigns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  template_id         INTEGER,
  template_locked     INTEGER NOT NULL DEFAULT 0,
  contact_list_id     INTEGER,
  custom_message      TEXT,
  batch_size          INTEGER NOT NULL DEFAULT 10,
  batch_interval_min  INTEGER NOT NULL DEFAULT 120,
  delay_min_sec       INTEGER NOT NULL DEFAULT 20,
  delay_max_sec       INTEGER NOT NULL DEFAULT 45,
  daily_limit         INTEGER NOT NULL DEFAULT 50,
  total_contacts      INTEGER NOT NULL DEFAULT 0,
  sent_count          INTEGER NOT NULL DEFAULT 0,
  failed_count        INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  created_by          INTEGER,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id)     REFERENCES templates(id)      ON DELETE SET NULL,
  FOREIGN KEY (contact_list_id) REFERENCES contact_lists(id)  ON DELETE SET NULL,
  FOREIGN KEY (created_by)      REFERENCES users(id)          ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status   ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_template ON campaigns(template_id);

-- ============================================================================
-- CAMPAIGN_CONTACTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  contact_id  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'skipped')),
  message_id  TEXT,
  queued_at   DATETIME,
  sent_at     DATETIME,
  error       TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, contact_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id)  REFERENCES contacts(id)  ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cc_campaign_status ON campaign_contacts(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_contact         ON campaign_contacts(contact_id);

-- ============================================================================
-- REPLY_ASSETS
-- ============================================================================

CREATE TABLE IF NOT EXISTS reply_assets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL
              CHECK (type IN ('text', 'pdf', 'image', 'video', 'link', 'calendar')),
  content     TEXT,
  file_path   TEXT,
  url         TEXT,
  campaign_id INTEGER,
  is_global   INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id)     ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_campaign ON reply_assets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_assets_global   ON reply_assets(is_global);

-- ============================================================================
-- INBOUND_REPLIES
-- ============================================================================

CREATE TABLE IF NOT EXISTS inbound_replies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  phone             TEXT    NOT NULL,
  name              TEXT,
  message           TEXT    NOT NULL,
  media_type        TEXT,
  media_url         TEXT,
  contact_id        INTEGER,
  campaign_id       INTEGER,
  window_expires_at DATETIME NOT NULL,
  window_status     TEXT    NOT NULL DEFAULT 'open'
                    CHECK (window_status IN ('open', 'urgent', 'expired')),
  replied           INTEGER NOT NULL DEFAULT 0,
  reply_text        TEXT,
  reply_asset_id    INTEGER,
  replied_at        DATETIME,
  replied_by        INTEGER,
  received_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contact_id)     REFERENCES contacts(id)     ON DELETE SET NULL,
  FOREIGN KEY (campaign_id)    REFERENCES campaigns(id)    ON DELETE SET NULL,
  FOREIGN KEY (reply_asset_id) REFERENCES reply_assets(id) ON DELETE SET NULL,
  FOREIGN KEY (replied_by)     REFERENCES users(id)        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_replies_phone   ON inbound_replies(phone);
CREATE INDEX IF NOT EXISTS idx_replies_status  ON inbound_replies(window_status);
CREATE INDEX IF NOT EXISTS idx_replies_contact ON inbound_replies(contact_id);
CREATE INDEX IF NOT EXISTS idx_replies_window  ON inbound_replies(window_expires_at);
CREATE INDEX IF NOT EXISTS idx_replies_replied ON inbound_replies(replied);

-- ============================================================================
-- META_LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS meta_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  direction   TEXT    NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  type        TEXT    NOT NULL,
  phone       TEXT,
  campaign_id INTEGER,
  contact_id  INTEGER,
  payload     TEXT,
  response    TEXT,
  status_code INTEGER,
  success     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  logged_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id)  REFERENCES contacts(id)  ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_meta_log_direction ON meta_log(direction);
CREATE INDEX IF NOT EXISTS idx_meta_log_type      ON meta_log(type);
CREATE INDEX IF NOT EXISTS idx_meta_log_phone     ON meta_log(phone);
CREATE INDEX IF NOT EXISTS idx_meta_log_campaign  ON meta_log(campaign_id);
CREATE INDEX IF NOT EXISTS idx_meta_log_time      ON meta_log(logged_at);

-- ============================================================================
-- SEND_HISTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS send_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL,
  campaign_name TEXT,
  date          TEXT    NOT NULL,
  sent          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, date),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_campaign ON send_history(campaign_id);
CREATE INDEX IF NOT EXISTS idx_history_date     ON send_history(date);
