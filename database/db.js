'use strict';
/**
 * Anugnya WhatsApp Sender — Database Module v2.3
 * database/db.js
 *
 * Abstractions:
 *   makeRepo()    — generic update + delete factory
 *   buildFilter() — dynamic WHERE builder (no prior positional args only)
 *   stmt()        — prepared statement cache
 *
 * Fix log v2.3:
 *   1. loadContactsFromList  — split null check (campaign vs no list)
 *   2. lockCampaign          — validate template + contact list before lock
 *   3. createSession         — delete old sessions before inserting new one
 *   4. importContactsToList  — INSERT inside loop uses stmt()
 *   5. 13 hot-path functions — getDb().prepare() → stmt() throughout
 *   6. getReplyAssets        — all three branches use stmt()
 *   7. getSendHistory        — campaignId branch uses stmt()
 *   8. logActivity           — uses stmt()
 */

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');

const DB_PATH     = path.join(__dirname, '..', 'data', 'anugnya-sender.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db    = null;
let _stmts = {};

// ============================================================================
// CORE
// ============================================================================

function init() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  seedAdmin();
  console.log('✅ Database initialised — anugnya-sender.db');
  return _db;
}

function getDb() {
  if (!_db) init();
  return _db;
}

/**
 * Prepared statement cache.
 * Static SQL strings are prepared once and reused on every call.
 * Dynamic SQL (variable column lists) must use getDb().prepare() inline.
 */
function stmt(sql) {
  if (!_stmts[sql]) _stmts[sql] = getDb().prepare(sql);
  return _stmts[sql];
}

// ============================================================================
// ABSTRACTIONS
// ============================================================================

/**
 * Generic update + delete factory.
 * get() omitted — each entity writes its own to control field exposure.
 * update() uses dynamic SQL (field list varies) — cannot use stmt().
 */
function makeRepo(table, allowedUpdateFields) {
  return {
    update(id, data) {
      const fields = Object.keys(data).filter(k => allowedUpdateFields.includes(k));
      if (!fields.length) return;
      const sets = fields.map(f => `${f} = @${f}`).join(', ');
      getDb().prepare(
        `UPDATE ${table} SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`
      ).run({ ...data, id });
    },
    delete(id) {
      stmt(`DELETE FROM ${table} WHERE id = ?`).run(id);
    }
  };
}

/**
 * Dynamic WHERE clause builder.
 * USE ONLY when base SQL has NO prior positional args.
 * Skips null and undefined values.
 */
function buildFilter(baseSql, filters = {}, tail = '') {
  const clauses = [], args = [];
  for (const [col, val] of Object.entries(filters)) {
    if (val !== null && val !== undefined) {
      clauses.push(`${col} = ?`);
      args.push(val);
    }
  }
  const where = clauses.length ? ' AND ' + clauses.join(' AND ') : '';
  return { sql: baseSql + where + tail, args };
}

// ============================================================================
// SEED ADMIN
// ============================================================================

function seedAdmin() {
  const existing = _db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existing) return;
  const email    = process.env.SEED_ADMIN_EMAIL    || 'admin@anugnyaholisticcare.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'changeme';
  const name     = process.env.SEED_ADMIN_NAME     || 'Admin';
  const hash     = bcrypt.hashSync(password, 12);
  _db.prepare(
    `INSERT INTO users (name, email, password, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 0)`
  ).run(name, email, hash);
  console.log(`✅ Seeded admin: ${email}`);
}

// ============================================================================
// SETTINGS
// ============================================================================

function getSetting(key) {
  return stmt('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

function setSetting(key, value) {
  getDb().prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value));
}

function getAllSettings() {
  return Object.fromEntries(
    stmt('SELECT key, value FROM settings').all().map(r => [r.key, r.value])
  );
}

// ============================================================================
// USERS
// get() written manually — never expose password hash externally.
// _getUserWithPassword() is internal-only for auth verification.
// ============================================================================

const _userRepo = makeRepo('users', ['name', 'role', 'is_active', 'must_change_password']);

function createUser(data) {
  const hash = bcrypt.hashSync(data.password, 12);
  try {
    const result = getDb().prepare(
      `INSERT INTO users (name, email, password, role, must_change_password)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      data.name,
      data.email.toLowerCase().trim(),
      hash,
      data.role || 'operator',
      data.must_change_password ? 1 : 0
    );
    return getUser(result.lastInsertRowid);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: users.email')) {
      throw new Error(`A user with email ${data.email} already exists.`);
    }
    throw err;
  }
}

function getUser(id) {
  return stmt(
    'SELECT id, name, email, role, is_active, must_change_password, last_login, created_at FROM users WHERE id = ?'
  ).get(id);
}

function getUserByEmail(email) {
  return stmt(
    'SELECT id, name, email, role, is_active, must_change_password, last_login, created_at FROM users WHERE email = ? AND is_active = 1'
  ).get(email.toLowerCase().trim());
}

function _getUserWithPassword(email) {
  return stmt('SELECT * FROM users WHERE email = ? AND is_active = 1')
    .get(email.toLowerCase().trim());
}

function getAllUsers() {
  return stmt(
    'SELECT id, name, email, role, is_active, must_change_password, last_login, created_at FROM users ORDER BY created_at ASC'
  ).all();
}

function updateUser(id, data) {
  _userRepo.update(id, data);
  return getUser(id);
}

function updatePassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 12);
  stmt(
    'UPDATE users SET password = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(hash, id);
}

function verifyPassword(email, password) {
  const user = _getUserWithPassword(email);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  updateLastLogin(user.id);
  return getUser(user.id);
}

function updateLastLogin(id) {
  stmt('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(id);
}

// ============================================================================
// SESSIONS
// FIX 3: Delete existing sessions for user before creating new one.
// Enforces single active session per user.
// ============================================================================

function createSession(userId) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  stmt('DELETE FROM sessions WHERE user_id = ?').run(userId);
  getDb().prepare(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(userId, token, expiresAt);
  return token;
}

function getSession(token) {
  return stmt(`
    SELECT s.*, u.id as user_id, u.name, u.email, u.role, u.is_active, u.must_change_password
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1
  `).get(token);
}

function deleteSession(token) {
  stmt('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteExpiredSessions() {
  stmt('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
}

// ============================================================================
// AUDIT TRAIL
// FIX 8: stmt() applied
// ============================================================================

function logActivity(userId, action, entityType, entityId, detail, ipAddress) {
  stmt(
    'INSERT INTO user_activity (user_id, action, entity_type, entity_id, detail, ip_address) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    userId,
    action,
    entityType || null,
    entityId   || null,
    detail     || null,
    ipAddress  || null
  );
}

function getActivity({ userId, action, entityType, entityId, limit = 100, offset = 0 } = {}) {
  const { sql, args } = buildFilter(
    `SELECT a.*, u.name as user_name, u.email as user_email
     FROM user_activity a
     JOIN users u ON u.id = a.user_id
     WHERE 1=1`,
    {
      'a.user_id':     userId     !== undefined ? userId     : null,
      'a.action':      action     !== undefined ? action     : null,
      'a.entity_type': entityType !== undefined ? entityType : null,
      'a.entity_id':   entityId   !== undefined ? entityId   : null
    },
    ' ORDER BY a.logged_at DESC LIMIT ? OFFSET ?'
  );
  return getDb().prepare(sql).all(...args, limit, offset);
}

// ============================================================================
// TEMPLATES
// ============================================================================

const _templateRepo = makeRepo('templates', [
  'name', 'language', 'category', 'status',
  'header_type', 'header_value', 'body_text',
  'footer_text', 'variable_map', 'button_url', 'button_label'
]);

function _parseTemplate(t) {
  if (!t) return null;
  try { t.variable_map = JSON.parse(t.variable_map || '{}'); } catch { t.variable_map = {}; }
  return t;
}

function createTemplate(data) {
  const result = getDb().prepare(`
    INSERT INTO templates
      (name, language, category, status, header_type, header_value,
       body_text, footer_text, variable_map, button_url, button_label, created_by)
    VALUES
      (@name, @language, @category, @status, @header_type, @header_value,
       @body_text, @footer_text, @variable_map, @button_url, @button_label, @created_by)
  `).run({
    name:         data.name,
    language:     data.language     || 'en',
    category:     data.category     || 'MARKETING',
    status:       data.status       || 'active',
    header_type:  data.header_type  || null,
    header_value: data.header_value || null,
    body_text:    data.body_text,
    footer_text:  data.footer_text  || null,
    variable_map: JSON.stringify(data.variable_map || {}),
    button_url:   data.button_url   || null,
    button_label: data.button_label || null,
    created_by:   data.created_by   || null
  });
  return getTemplate(result.lastInsertRowid);
}

function getTemplate(id) {
  return _parseTemplate(stmt('SELECT * FROM templates WHERE id = ?').get(id));
}

function getTemplateByName(name) {
  return _parseTemplate(stmt('SELECT * FROM templates WHERE name = ?').get(name));
}

function getAllTemplates() {
  return stmt('SELECT * FROM templates ORDER BY created_at DESC').all().map(_parseTemplate);
}

function updateTemplate(id, data) {
  if (data.variable_map && typeof data.variable_map === 'object') {
    data = { ...data, variable_map: JSON.stringify(data.variable_map) };
  }
  _templateRepo.update(id, data);
  return getTemplate(id);
}

function deleteTemplate(id) {
  const inUse = stmt(
    "SELECT id FROM campaigns WHERE template_id = ? AND status NOT IN ('draft','completed') LIMIT 1"
  ).get(id);
  if (inUse) throw new Error('Template is locked to an active campaign. Pause the campaign first.');
  _templateRepo.delete(id);
}

function isTemplateInUse(id) {
  return !!stmt(
    "SELECT id FROM campaigns WHERE template_id = ? AND status NOT IN ('draft','completed') LIMIT 1"
  ).get(id);
}

// ============================================================================
// CONTACT LISTS
// ============================================================================

const _listRepo = makeRepo('contact_lists', ['name', 'description', 'source']);

function createContactList(data) {
  const result = getDb().prepare(
    'INSERT INTO contact_lists (name, description, source, created_by) VALUES (?, ?, ?, ?)'
  ).run(data.name, data.description || null, data.source || null, data.created_by || null);
  return getContactList(result.lastInsertRowid);
}

function getContactList(id) {
  return stmt('SELECT * FROM contact_lists WHERE id = ?').get(id);
}

function getAllContactLists() {
  return stmt(`
    SELECT cl.*, COUNT(clm.id) as member_count
    FROM contact_lists cl
    LEFT JOIN contact_list_members clm ON clm.contact_list_id = cl.id
    GROUP BY cl.id
    ORDER BY cl.created_at DESC
  `).all();
}

function updateContactList(id, data) {
  _listRepo.update(id, data);
  return getContactList(id);
}

function deleteContactList(id) {
  const inUse = stmt(
    "SELECT id, name FROM campaigns WHERE contact_list_id = ? AND status NOT IN ('draft','completed') LIMIT 1"
  ).get(id);
  if (inUse) {
    throw new Error(`Contact list is in use by campaign "${inUse.name}". Pause or complete the campaign first.`);
  }
  _listRepo.delete(id);
}

function getContactListMembers(listId, { limit = 100, offset = 0 } = {}) {
  return stmt(`
    SELECT c.*, clm.added_at
    FROM contacts c
    JOIN contact_list_members clm ON clm.contact_id = c.id
    WHERE clm.contact_list_id = ?
    ORDER BY clm.added_at DESC
    LIMIT ? OFFSET ?
  `).all(listId, limit, offset);
}

// ============================================================================
// CONTACTS
// ============================================================================

function normalisePhone(raw, countryCode = '91') {
  if (!raw) return null;
  let phone = String(raw).trim().replace(/\.0+$/, '').replace(/\D/g, '');
  if (!phone) return null;
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length <= 10) phone = countryCode + phone.slice(-10);
  return phone;
}

function _cleanFirstName(raw) {
  return (raw || '')
    .replace(/^(Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)\s*/i, '')
    .trim();
}

function getOrCreateContact(phone, data = {}) {
  const existing = stmt('SELECT * FROM contacts WHERE phone = ?').get(phone);
  if (existing) return existing;
  const name      = data.name || '';
  const firstName = _cleanFirstName(data.first_name || name.split(/\s+/)[0] || '');
  const result = getDb().prepare(
    'INSERT INTO contacts (phone, name, first_name, email, source) VALUES (?, ?, ?, ?, ?)'
  ).run(phone, name, firstName, data.email || null, data.source || null);
  return stmt('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
}

function getContact(id) {
  return stmt('SELECT * FROM contacts WHERE id = ?').get(id);
}

function getContactByPhone(phone) {
  return stmt('SELECT * FROM contacts WHERE phone = ?').get(phone);
}

function getAllContacts({ limit = 100, offset = 0, search = null } = {}) {
  if (search) {
    const s = `%${search}%`;
    return getDb().prepare(
      'SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR first_name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(s, s, s, limit, offset);
  }
  return stmt('SELECT * FROM contacts ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function updateContact(id, data) {
  const allowed = ['name', 'first_name', 'email', 'notes', 'in_conversation', 'conversation_started_at'];
  const fields  = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) return getContact(id);
  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  getDb().prepare(`UPDATE contacts SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
    .run({ ...data, id });
  return getContact(id);
}

function markInConversation(contactId) {
  stmt(`
    UPDATE contacts
    SET in_conversation = 1,
        conversation_started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contactId);
}

function updateContactLastContacted(contactId) {
  stmt(
    'UPDATE contacts SET last_contacted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(contactId);
}

function getContactStats() {
  return stmt(`
    SELECT
      COUNT(*)                           as total,
      SUM(in_conversation = 1)           as in_conversation,
      SUM(last_contacted_at IS NOT NULL) as contacted,
      SUM(last_contacted_at IS NULL)     as never_contacted
    FROM contacts
  `).get();
}

// ============================================================================
// IMPORT CONTACTS TO LIST
// ============================================================================

function importContactsToList(listId, rows, sourceFileName, countryCode = '91') {
  const list = getContactList(listId);
  if (!list) throw new Error('Contact list not found.');

  const col = (row, aliases) => {
    const keys = Object.keys(row).map(k => k.toLowerCase().trim());
    for (const a of aliases) {
      const idx = keys.indexOf(a);
      if (idx !== -1) return String(Object.values(row)[idx] || '').trim();
    }
    return '';
  };

  const PHONE = ['phone', 'phone number', 'phonenumber', 'mobile', 'mobile number', 'cell', 'telephone', 'tel', 'whatsapp'];
  const NAME  = ['name', 'full name', 'fullname', 'contact name'];
  const FIRST = ['first name', 'firstname', 'first_name', 'given name'];
  const EMAIL = ['email', 'email address', 'emailaddress', 'e-mail'];

  let imported = 0, duplicates = 0, invalid = 0;

  getDb().transaction((rows) => {
    for (const row of rows) {
      const phone = normalisePhone(col(row, PHONE), countryCode);
      if (!phone) { invalid++; continue; }

      const nameRaw   = col(row, NAME);
      const firstName = _cleanFirstName(col(row, FIRST) || nameRaw.split(/\s+/)[0] || '');

      const contact = getOrCreateContact(phone, {
        name:       nameRaw || firstName,
        first_name: firstName,
        email:      col(row, EMAIL) || null,
        source:     sourceFileName || list.name
      });

      if (!contact) { invalid++; continue; }

      const already = stmt(
        'SELECT id FROM contact_list_members WHERE contact_list_id = ? AND contact_id = ?'
      ).get(listId, contact.id);

      if (already) { duplicates++; continue; }

      stmt(
        'INSERT INTO contact_list_members (contact_list_id, contact_id) VALUES (?, ?)'
      ).run(listId, contact.id);

      imported++;
    }
  })(rows);

  stmt(
    'UPDATE contact_lists SET total = (SELECT COUNT(*) FROM contact_list_members WHERE contact_list_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(listId, listId);

  return { imported, duplicates, invalid, total: rows.length };
}

// ============================================================================
// CAMPAIGNS
// ============================================================================

function _campaignBaseSql() {
  return `
    SELECT c.*,
      t.name   as template_name,
      t.status as template_status,
      cl.name  as contact_list_name,
      COUNT(cc.id)               as stat_total,
      SUM(cc.status = 'pending') as stat_pending,
      SUM(cc.status = 'queued')  as stat_queued,
      SUM(cc.status = 'sent')    as stat_sent,
      SUM(cc.status = 'failed')  as stat_failed,
      SUM(cc.status = 'skipped') as stat_skipped
    FROM campaigns c
    LEFT JOIN templates t          ON t.id  = c.template_id
    LEFT JOIN contact_lists cl     ON cl.id = c.contact_list_id
    LEFT JOIN campaign_contacts cc ON cc.campaign_id = c.id`;
}

function _shapeCampaign(row) {
  if (!row) return null;
  const {
    stat_total, stat_pending, stat_queued, stat_sent, stat_failed, stat_skipped,
    template_name, template_status, contact_list_name,
    ...campaign
  } = row;
  campaign.stats = {
    total:   stat_total   || 0,
    pending: stat_pending || 0,
    queued:  stat_queued  || 0,
    sent:    stat_sent    || 0,
    failed:  stat_failed  || 0,
    skipped: stat_skipped || 0
  };
  campaign.template = campaign.template_id
    ? { id: campaign.template_id, name: template_name, status: template_status }
    : null;
  campaign.contact_list = campaign.contact_list_id
    ? { id: campaign.contact_list_id, name: contact_list_name }
    : null;
  return campaign;
}

function getCampaign(id) {
  return _shapeCampaign(
    stmt(`${_campaignBaseSql()} WHERE c.id = ? GROUP BY c.id`).get(id)
  );
}

function getAllCampaigns() {
  return stmt(`${_campaignBaseSql()} GROUP BY c.id ORDER BY c.created_at DESC`)
    .all().map(_shapeCampaign);
}

const _campaignRepo = makeRepo('campaigns', [
  'name', 'status', 'template_id', 'template_locked', 'contact_list_id',
  'custom_message', 'batch_size', 'batch_interval_min', 'delay_min_sec',
  'delay_max_sec', 'daily_limit', 'sent_count', 'failed_count',
  'skipped_count', 'total_contacts'
]);

function createCampaign(data) {
  const s = getAllSettings();
  const result = getDb().prepare(`
    INSERT INTO campaigns
      (name, status, template_id, contact_list_id, custom_message,
       batch_size, batch_interval_min, delay_min_sec, delay_max_sec,
       daily_limit, created_by)
    VALUES
      (@name, 'draft', @template_id, @contact_list_id, @custom_message,
       @batch_size, @batch_interval_min, @delay_min_sec, @delay_max_sec,
       @daily_limit, @created_by)
  `).run({
    name:               data.name,
    template_id:        data.template_id        || null,
    contact_list_id:    data.contact_list_id    || null,
    custom_message:     data.custom_message     || null,
    batch_size:         data.batch_size         || +s.default_batch_size         || 10,
    batch_interval_min: data.batch_interval_min || +s.default_batch_interval_min  || 120,
    delay_min_sec:      data.delay_min_sec      || +s.default_delay_min_sec       || 20,
    delay_max_sec:      data.delay_max_sec      || +s.default_delay_max_sec       || 45,
    daily_limit:        data.daily_limit        || +s.default_daily_limit         || 50,
    created_by:         data.created_by         || null
  });
  return getCampaign(result.lastInsertRowid);
}

function updateCampaign(id, data) {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  if (campaign.template_locked && campaign.status === 'active') {
    if ('template_id' in data || 'contact_list_id' in data) {
      throw new Error('Campaign is active and locked. Pause it first to change template or contact list.');
    }
  }
  _campaignRepo.update(id, data);
  return getCampaign(id);
}

function lockCampaign(id) {
  const c = getCampaign(id);
  if (!c) throw new Error('Campaign not found.');
  if (!c.template_id) throw new Error('Assign a template to this campaign before activating it.');
  if (!c.contact_list_id) throw new Error('Assign a contact list to this campaign before activating it.');
  stmt(
    "UPDATE campaigns SET template_locked = 1, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
  return getCampaign(id);
}

function unlockCampaign(id) {
  stmt(
    "UPDATE campaigns SET template_locked = 0, status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
  return getCampaign(id);
}

function deleteCampaign(id) {
  const c = getCampaign(id);
  if (!c) return;
  if (c.status === 'active') throw new Error('Cannot delete an active campaign. Pause it first.');
  stmt('DELETE FROM campaigns WHERE id = ?').run(id);
}

// ============================================================================
// CAMPAIGN CONTACTS
// ============================================================================

function loadContactsFromList(campaignId) {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found.');
  if (!campaign.contact_list_id) throw new Error('Campaign has no contact list assigned.');

  const minDays   = parseInt(getSetting('min_days_between_contact')) || 30;
  const threshold = new Date(Date.now() - minDays * 24 * 60 * 60 * 1000).toISOString();

  const result = stmt(`
    INSERT OR IGNORE INTO campaign_contacts (campaign_id, contact_id, status)
    SELECT ?, c.id, 'pending'
    FROM contacts c
    JOIN contact_list_members clm ON clm.contact_id = c.id
    WHERE clm.contact_list_id = ?
      AND c.in_conversation = 0
      AND (c.last_contacted_at IS NULL OR c.last_contacted_at < ?)
  `).run(campaignId, campaign.contact_list_id, threshold);

  stmt(
    'UPDATE campaigns SET total_contacts = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(campaignId, campaignId);

  return { loaded: result.changes };
}

function getCampaignContacts(campaignId, { status = null, limit = 100, offset = 0 } = {}) {
  let sql  = `
    SELECT cc.*, c.phone, c.name, c.first_name, c.in_conversation, c.last_contacted_at
    FROM campaign_contacts cc
    JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.campaign_id = ?`;
  const args = [campaignId];
  if (status) { sql += ' AND cc.status = ?'; args.push(status); }
  sql += " ORDER BY CASE WHEN cc.status = 'queued' THEN cc.queued_at END ASC NULLS LAST, cc.id ASC LIMIT ? OFFSET ?";
  args.push(limit, offset);
  return getDb().prepare(sql).all(...args);
}

function getQueuedContacts(campaignId) {
  return stmt(`
    SELECT cc.*, c.phone, c.name, c.first_name, c.in_conversation
    FROM campaign_contacts cc
    JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.campaign_id = ? AND cc.status = 'queued'
    ORDER BY cc.queued_at ASC
  `).all(campaignId);
}

function pickContactsForReview(campaignId, count) {
  return stmt(`
    UPDATE campaign_contacts
    SET status = 'queued', queued_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT cc.id FROM campaign_contacts cc
      JOIN contacts c ON c.id = cc.contact_id
      WHERE cc.campaign_id = ?
        AND cc.status = 'pending'
        AND c.in_conversation = 0
      ORDER BY RANDOM() LIMIT ?
    )
  `).run(campaignId, count).changes;
}

function replenishQueue(campaignId, targetCount) {
  const current = stmt(
    "SELECT COUNT(*) as cnt FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued'"
  ).get(campaignId).cnt;
  const needed = targetCount - current;
  if (needed <= 0) return 0;
  return pickContactsForReview(campaignId, needed);
}

function clearQueue(campaignId) {
  return stmt(
    "UPDATE campaign_contacts SET status = 'pending', queued_at = NULL WHERE campaign_id = ? AND status = 'queued'"
  ).run(campaignId).changes;
}

function updateCampaignContactStatus(id, status, messageId, error) {
  stmt(`
    UPDATE campaign_contacts
    SET status     = ?,
        message_id = ?,
        error      = ?,
        sent_at    = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `).run(status, messageId || null, error || null, status, id);
}

function skipCampaignContact(id) {
  stmt("UPDATE campaign_contacts SET status = 'skipped' WHERE id = ?").run(id);
}

function resetFailed(campaignId) {
  return stmt(
    "UPDATE campaign_contacts SET status = 'pending', error = NULL WHERE campaign_id = ? AND status = 'failed'"
  ).run(campaignId).changes;
}

// ============================================================================
// REPLY ASSETS
// ============================================================================

const _assetRepo = makeRepo('reply_assets', [
  'name', 'type', 'content', 'file_path', 'url', 'campaign_id', 'is_global'
]);

function createReplyAsset(data) {
  const result = getDb().prepare(
    'INSERT INTO reply_assets (name, type, content, file_path, url, campaign_id, is_global, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    data.name, data.type,
    data.content     || null,
    data.file_path   || null,
    data.url         || null,
    data.campaign_id || null,
    data.is_global   ? 1 : 0,
    data.created_by  || null
  );
  return getReplyAsset(result.lastInsertRowid);
}

function getReplyAsset(id) {
  return stmt('SELECT * FROM reply_assets WHERE id = ?').get(id);
}

function getReplyAssets({ campaignId = null, includeGlobal = true } = {}) {
  if (campaignId && includeGlobal) {
    return stmt(
      'SELECT * FROM reply_assets WHERE campaign_id = ? OR is_global = 1 ORDER BY is_global DESC, name ASC'
    ).all(campaignId);
  }
  if (campaignId) {
    return stmt(
      'SELECT * FROM reply_assets WHERE campaign_id = ? ORDER BY name ASC'
    ).all(campaignId);
  }
  return stmt('SELECT * FROM reply_assets WHERE is_global = 1 ORDER BY name ASC').all();
}

function updateReplyAsset(id, data) {
  _assetRepo.update(id, data);
  return getReplyAsset(id);
}

function deleteReplyAsset(id) {
  const asset = getReplyAsset(id);
  if (asset?.file_path && fs.existsSync(asset.file_path)) {
    try { fs.unlinkSync(asset.file_path); } catch {}
  }
  _assetRepo.delete(id);
}

// ============================================================================
// INBOUND REPLIES
// ============================================================================

function createInboundReply(data) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = getDb().prepare(`
    INSERT INTO inbound_replies
      (phone, name, message, media_type, media_url, contact_id, campaign_id, window_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.phone,
    data.name        || null,
    data.message,
    data.media_type  || null,
    data.media_url   || null,
    data.contact_id  || null,
    data.campaign_id || null,
    expiresAt
  );
  return stmt('SELECT * FROM inbound_replies WHERE id = ?').get(result.lastInsertRowid);
}

function getInboundReply(id) {
  return stmt('SELECT * FROM inbound_replies WHERE id = ?').get(id);
}

function getReplyQueue({ status = null, limit = 100, offset = 0 } = {}) {
  const { sql, args } = buildFilter(
    'SELECT * FROM inbound_replies WHERE 1=1',
    { window_status: status !== undefined ? status : null },
    " ORDER BY CASE window_status WHEN 'urgent' THEN 1 WHEN 'open' THEN 2 WHEN 'expired' THEN 3 END ASC, received_at ASC LIMIT ? OFFSET ?"
  );
  return getDb().prepare(sql).all(...args, limit, offset);
}

function markReplied(id, replyText, replyAssetId, repliedBy) {
  stmt(`
    UPDATE inbound_replies
    SET replied        = 1,
        reply_text     = ?,
        reply_asset_id = ?,
        replied_by     = ?,
        replied_at     = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(replyText || null, replyAssetId || null, repliedBy || null, id);
}

function updateWindowStatuses() {
  stmt(`
    UPDATE inbound_replies
    SET window_status = CASE
      WHEN window_expires_at <= CURRENT_TIMESTAMP                         THEN 'expired'
      WHEN window_expires_at <= datetime(CURRENT_TIMESTAMP, '+1 hour')   THEN 'urgent'
      ELSE window_status
    END
    WHERE window_status != 'expired'
  `).run();
}

function getUnrepliedCount() {
  return stmt("SELECT COUNT(*) as cnt FROM inbound_replies WHERE replied = 0").get().cnt;
}

// ============================================================================
// META LOG
// ============================================================================

function logMeta(data) {
  stmt(`
    INSERT INTO meta_log
      (direction, type, phone, campaign_id, contact_id, payload, response, status_code, success, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.direction,
    data.type,
    data.phone       || null,
    data.campaign_id || null,
    data.contact_id  || null,
    data.payload     ? JSON.stringify(data.payload)  : null,
    data.response    ? JSON.stringify(data.response) : null,
    data.status_code || null,
    data.success     ? 1 : 0,
    data.error       || null
  );
}

function getMetaLog({ direction, type, campaignId, limit = 100, offset = 0 } = {}) {
  const { sql, args } = buildFilter(
    'SELECT * FROM meta_log WHERE 1=1',
    {
      direction:   direction  !== undefined ? direction  : null,
      type:        type       !== undefined ? type       : null,
      campaign_id: campaignId !== undefined ? campaignId : null
    },
    ' ORDER BY logged_at DESC LIMIT ? OFFSET ?'
  );
  return getDb().prepare(sql).all(...args, limit, offset);
}

// ============================================================================
// SEND HISTORY
// ============================================================================

function recordSendHistory(campaignId, campaignName, sent, failed, total) {
  const today = new Date().toISOString().split('T')[0];
  stmt(`
    INSERT INTO send_history (campaign_id, campaign_name, date, sent, failed, total)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, date) DO UPDATE SET
      sent   = excluded.sent,
      failed = excluded.failed,
      total  = excluded.total
  `).run(campaignId, campaignName || 'Unknown', today, sent, failed, total);
}

function getSendHistory({ campaignId = null, limit = 60 } = {}) {
  if (campaignId) {
    return stmt(
      'SELECT * FROM send_history WHERE campaign_id = ? ORDER BY date DESC LIMIT ?'
    ).all(campaignId, limit);
  }
  return stmt('SELECT * FROM send_history ORDER BY date DESC LIMIT ?').all(limit);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  init, getDb,
  // Settings
  getSetting, setSetting, getAllSettings,
  // Users
  createUser, getUser, getUserByEmail, getAllUsers, updateUser,
  updatePassword, verifyPassword, updateLastLogin,
  // Sessions
  createSession, getSession, deleteSession, deleteExpiredSessions,
  // Audit trail
  logActivity, getActivity,
  // Templates
  createTemplate, getTemplate, getTemplateByName, getAllTemplates,
  updateTemplate, deleteTemplate, isTemplateInUse,
  // Contact lists
  createContactList, getContactList, getAllContactLists,
  updateContactList, deleteContactList, getContactListMembers,
  // Contacts
  normalisePhone, getOrCreateContact, getContact, getContactByPhone,
  getAllContacts, updateContact, markInConversation,
  updateContactLastContacted, getContactStats,
  // Import
  importContactsToList,
  // Campaigns
  createCampaign, getCampaign, getAllCampaigns, updateCampaign,
  lockCampaign, unlockCampaign, deleteCampaign,
  // Campaign contacts
  loadContactsFromList, getCampaignContacts, getQueuedContacts,
  pickContactsForReview, replenishQueue, clearQueue,
  updateCampaignContactStatus, skipCampaignContact, resetFailed,
  // Reply assets
  createReplyAsset, getReplyAsset, getReplyAssets,
  updateReplyAsset, deleteReplyAsset,
  // Inbound replies
  createInboundReply, getInboundReply, getReplyQueue, markReplied,
  updateWindowStatuses, getUnrepliedCount,
  // Meta log
  logMeta, getMetaLog,
  // Send history
  recordSendHistory, getSendHistory
};
