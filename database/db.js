'use strict';

/**
 * WhatsApp Sender v3 — Database Module
 * database/db.js
 *
 * Wraps better-sqlite3. All queries are synchronous.
 * Import: const db = require('./database/db');
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH     = path.join(__dirname, '..', 'data', 'wa-sender.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _db = null;

// ============================================================================
// INIT
// ============================================================================

function init() {
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  _db.exec(schema);

  console.log('✅ Database initialised — wa-sender.db');
  return _db;
}

function getDb() {
  if (!_db) init();
  return _db;
}

// ============================================================================
// SETTINGS
// ============================================================================

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ============================================================================
// CAMPAIGNS
// ============================================================================

function createCampaign(data) {
  const stmt = getDb().prepare(`
    INSERT INTO campaigns (
      name, message_template, salutation, signature,
      media_path, media_type, media_original_name, media_first,
      auto_mode, country_code, batch_size, batch_interval_min,
      delay_min, delay_max, daily_limit, wa_check_enabled, status
    ) VALUES (
      @name, @message_template, @salutation, @signature,
      @media_path, @media_type, @media_original_name, @media_first,
      @auto_mode, @country_code, @batch_size, @batch_interval_min,
      @delay_min, @delay_max, @daily_limit, @wa_check_enabled, @status
    )
  `);
  const result = stmt.run({
    name:               data.name || 'New Campaign',
    message_template:   data.message_template   || null,
    salutation:         data.salutation         || null,
    signature:          data.signature          || null,
    media_path:         data.media_path         || null,
    media_type:         data.media_type         || null,
    media_original_name: data.media_original_name || null,
    media_first:        data.media_first        ? 1 : 0,
    auto_mode:          data.auto_mode !== false ? 1 : 0,
    country_code:       data.country_code       || null,
    batch_size:         data.batch_size         || null,
    batch_interval_min: data.batch_interval_min || null,
    delay_min:          data.delay_min          || null,
    delay_max:          data.delay_max          || null,
    daily_limit:        data.daily_limit        || null,
    wa_check_enabled:   data.wa_check_enabled   ? 1 : 0,
    status:             data.status             || 'draft'
  });
  return getCampaign(result.lastInsertRowid);
}

function getCampaign(id) {
  const campaign = getDb().prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return null;
  return withStats(campaign);
}

function getAllCampaigns() {
  const campaigns = getDb().prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  return campaigns.map(withStats);
}

function withStats(campaign) {
  // Live stats from campaign_contacts
  const stats = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(status = 'pending')  as pending,
      SUM(status = 'sent')     as sent,
      SUM(status = 'failed')   as failed,
      SUM(status = 'skipped')  as skipped,
      SUM(status = 'noweb')    as noweb
    FROM campaign_contacts WHERE campaign_id = ?
  `).get(campaign.id);
  return { ...campaign, stats: stats || {} };
}

function updateCampaign(id, data) {
  const allowed = [
    'name', 'message_template', 'salutation', 'signature',
    'media_path', 'media_type', 'media_original_name', 'media_first',
    'auto_mode', 'country_code', 'batch_size', 'batch_interval_min',
    'delay_min', 'delay_max', 'daily_limit', 'wa_check_enabled', 'status'
  ];
  const fields = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) return getCampaign(id);

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  getDb().prepare(`UPDATE campaigns SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
    .run({ ...data, id });
  return getCampaign(id);
}

function deleteCampaign(id) {
  // Media file cleanup
  const c = getCampaign(id);
  if (c?.media_path && fs.existsSync(c.media_path)) {
    try { fs.unlinkSync(c.media_path); } catch {}
  }
  getDb().prepare('DELETE FROM campaigns WHERE id = ?').run(id);
}

/**
 * Get effective pace settings for a campaign.
 * Auto mode → pull from settings table.
 * Manual mode → use campaign values.
 */
function getCampaignSettings(id) {
  const c = getCampaign(id);
  if (!c) return null;

  if (c.auto_mode) {
    return {
      country_code:       getSetting('default_country_code')      || '91',
      batch_size:         parseInt(getSetting('default_batch_size'))       || 10,
      batch_interval_min: parseInt(getSetting('default_batch_interval_min')) || 120,
      delay_min:          parseInt(getSetting('default_delay_min'))          || 15,
      delay_max:          parseInt(getSetting('default_delay_max'))          || 40,
      daily_limit:        parseInt(getSetting('default_daily_limit'))        || 50,
      media_first:        getSetting('default_media_first') === '1',
      wa_check_enabled:   getSetting('default_wa_check') === '1'
    };
  }

  return {
    country_code:       c.country_code       || getSetting('default_country_code') || '91',
    batch_size:         c.batch_size         || 10,
    batch_interval_min: c.batch_interval_min || 120,
    delay_min:          c.delay_min          || 15,
    delay_max:          c.delay_max          || 40,
    daily_limit:        c.daily_limit        || 50,
    media_first:        !!c.media_first,
    wa_check_enabled:   !!c.wa_check_enabled
  };
}

// ============================================================================
// CAMPAIGN CONTACTS
// ============================================================================

/**
 * Normalise a phone number.
 * - Remove non-digits and .0 suffixes from Excel
 * - If number is less than 11 digits, prepend country code
 * - If number already has country code (>10 digits), keep as-is
 */
function normalisePhone(raw, countryCode = '91') {
  if (!raw) return null;
  let phone = String(raw).trim().replace(/\.0+$/, '').replace(/\D/g, '');
  if (!phone) return null;
  // Strip leading zero from 11-digit numbers (e.g. 09876543210 → 9876543210)
  if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length <= 10) phone = countryCode + phone.slice(-10);
  return phone;
}

/**
 * Import contacts from a parsed array of rows (already parsed from Excel/CSV).
 * Flexible column name matching.
 * Returns { imported, duplicates, invalid }
 */
function importContacts(campaignId, rows, sourceFileName, countryCode = '91') {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const effectiveCountryCode = countryCode || getSetting('default_country_code') || '91';

  // Column name aliases
  const phoneAliases     = ['phone', 'phone number', 'phonenumber', 'mobile', 'mobile number', 'cell', 'telephone', 'tel', 'whatsapp'];
  const nameAliases      = ['name', 'full name', 'fullname', 'contact name'];
  const firstNameAliases = ['first name', 'firstname', 'first_name', 'given name'];
  const lastNameAliases  = ['last name', 'lastname', 'last_name', 'surname', 'family name'];
  const emailAliases     = ['email', 'email address', 'emailaddress', 'e-mail'];
  const labelAliases     = ['label', 'tag', 'category', 'group', 'type', 'labels', 'tags'];
  const sourceAliases    = ['source', 'source file', 'from'];

  function getCol(row, aliases) {
    const keys = Object.keys(row).map(k => k.toLowerCase().trim());
    for (const alias of aliases) {
      const idx = keys.indexOf(alias);
      if (idx !== -1) return String(Object.values(row)[idx] || '').trim();
    }
    return '';
  }

  function getExtraData(row, usedKeys) {
    const extra = {};
    for (const [k, v] of Object.entries(row)) {
      if (!usedKeys.includes(k.toLowerCase().trim()) && v !== '' && v !== null && v !== undefined) {
        extra[k] = v;
      }
    }
    return Object.keys(extra).length ? JSON.stringify(extra) : null;
  }

  const insertStmt = getDb().prepare(`
    INSERT INTO campaign_contacts
      (campaign_id, phone, phone_raw, name, first_name, last_name, email, label, source, extra_data)
    VALUES
      (@campaign_id, @phone, @phone_raw, @name, @first_name, @last_name, @email, @label, @source, @extra_data)
  `);

  let imported   = 0;
  let duplicates = 0;
  let invalid    = 0;

  const importMany = getDb().transaction((rows) => {
    for (const row of rows) {
      const phoneRaw = getCol(row, phoneAliases);
      const phone    = normalisePhone(phoneRaw, effectiveCountryCode);

      if (!phone) { invalid++; continue; }

      // Check duplicate within this campaign
      const exists = getDb().prepare(
        'SELECT id FROM campaign_contacts WHERE campaign_id = ? AND phone = ?'
      ).get(campaignId, phone);
      if (exists) { duplicates++; continue; }

      const nameRaw      = getCol(row, nameAliases);
      const firstNameRaw = getCol(row, firstNameAliases);
      const lastNameRaw  = getCol(row, lastNameAliases);

      // Extract first name from full name if not provided separately
      let firstName = firstNameRaw || nameRaw.split(/\s+/)[0] || '';
      // Remove common titles
      firstName = firstName.replace(/^(Dr\.?|Prof\.?|Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)\s*/i, '').trim();

      const lastName = lastNameRaw || nameRaw.split(/\s+/).slice(1).join(' ') || '';

      const usedKeys = [...phoneAliases, ...nameAliases, ...firstNameAliases,
                        ...lastNameAliases, ...emailAliases, ...labelAliases, ...sourceAliases];

      insertStmt.run({
        campaign_id: campaignId,
        phone,
        phone_raw:   phoneRaw,
        name:        nameRaw    || firstName,
        first_name:  firstName,
        last_name:   lastName,
        email:       getCol(row, emailAliases)  || null,
        label:       getCol(row, labelAliases)  || null,
        source:      getCol(row, sourceAliases) || sourceFileName || null,
        extra_data:  getExtraData(row, usedKeys)
      });

      imported++;
    }
  });

  importMany(rows);

  // Update total_contacts on campaign
  getDb().prepare(`
    UPDATE campaigns SET
      total_contacts = (SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = ?),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(campaignId, campaignId);

  return { imported, duplicates, invalid, total: rows.length };
}

/**
 * Get contacts for a campaign with optional filters.
 */
function getCampaignContacts(campaignId, { status = null, label = null, wa_valid = null, exclude_sent = false, search = null, limit = 100, offset = 0 } = {}) {
  let query  = 'SELECT * FROM campaign_contacts WHERE campaign_id = ?';
  const args = [campaignId];

  if (status)            { query += ' AND status = ?';                        args.push(status); }
  if (exclude_sent)      { query += " AND status != 'sent'"; }
  if (label)             { query += ' AND label = ?';                         args.push(label); }
  if (wa_valid !== null) { query += ' AND wa_valid = ?';                      args.push(wa_valid); }
  if (search)            { query += ' AND (name LIKE ? OR phone LIKE ? OR first_name LIKE ?)'; args.push('%'+search+'%','%'+search+'%','%'+search+'%'); }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as cnt');
  const total = getDb().prepare(countQuery).get(...args).cnt;

  // Queued contacts ordered by send order, everything else by id
  query += " ORDER BY CASE WHEN status = 'queued' THEN queued_at ELSE NULL END ASC NULLS LAST, id ASC LIMIT ? OFFSET ?";
  args.push(limit, offset);

  return { contacts: getDb().prepare(query).all(...args), total };
}

/**
 * Get pending contacts for sending (respects daily limit).
 */
function getPendingContacts(campaignId, limit) {
  return getDb().prepare(`
    SELECT * FROM campaign_contacts
    WHERE campaign_id = ? AND status = 'pending'
    ORDER BY id
    LIMIT ?
  `).all(campaignId, limit);
}

/**
 * Update status of a single contact.
 */
function updateContactStatus(id, status, error = null) {
  getDb().prepare(`
    UPDATE campaign_contacts
    SET status = ?, error = ?, sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `).run(status, error, status, id);
}

/**
 * Mark all contacts with a given phone as wa_valid.
 */
function setWaValid(campaignId, phone, valid) {
  getDb().prepare(`
    UPDATE campaign_contacts SET wa_valid = ?, wa_checked_at = CURRENT_TIMESTAMP
    WHERE campaign_id = ? AND phone = ?
  `).run(valid ? 1 : 0, campaignId, phone);
}

/**
 * Get distinct labels for a campaign.
 */
function getCampaignLabels(campaignId) {
  return getDb().prepare(`
    SELECT DISTINCT label FROM campaign_contacts
    WHERE campaign_id = ? AND label IS NOT NULL AND label != ''
    ORDER BY label
  `).all(campaignId).map(r => r.label);
}

/**
 * Reset all failed contacts back to pending (for retry).
 */
function resetFailed(campaignId) {
  return getDb().prepare(`
    UPDATE campaign_contacts SET status = 'pending', error = NULL
    WHERE campaign_id = ? AND status = 'failed'
  `).run(campaignId).changes;
}

/**
 * Delete all contacts from a campaign.
 */
function clearContacts(campaignId) {
  getDb().prepare('DELETE FROM campaign_contacts WHERE campaign_id = ?').run(campaignId);
  getDb().prepare('UPDATE campaigns SET total_contacts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(campaignId);
}

// ============================================================================
// QUEUE — PICK / REVIEW WORKFLOW
// ============================================================================

/**
 * Pick N pending contacts into the review queue (pending → queued).
 * Shuffles pending pool so different contacts are picked each time.
 */
function pickContactsForReview(campaignId, count) {
  const pending = getDb().prepare(
    "SELECT id FROM campaign_contacts WHERE campaign_id = ? AND status = 'pending' ORDER BY RANDOM() LIMIT ?"
  ).all(campaignId, count);

  if (!pending.length) return 0;

  const stmt = getDb().prepare(
    "UPDATE campaign_contacts SET status = 'queued', queued_at = CURRENT_TIMESTAMP WHERE id = ?"
  );

  const pickMany = getDb().transaction((rows) => {
    for (const row of rows) stmt.run(row.id);
  });

  pickMany(pending);
  return pending.length;
}

/**
 * Get all queued contacts for a campaign (today's review list).
 */
function getQueuedContacts(campaignId) {
  return getDb().prepare(
    "SELECT * FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued' ORDER BY queued_at ASC"
  ).all(campaignId);
}

/**
 * Replenish queue to targetCount by picking more from pending.
 */
function replenishQueue(campaignId, targetCount) {
  const currentQueued = getDb().prepare(
    "SELECT COUNT(*) as cnt FROM campaign_contacts WHERE campaign_id = ? AND status = 'queued'"
  ).get(campaignId).cnt;

  const needed = targetCount - currentQueued;
  if (needed <= 0) return 0;
  return pickContactsForReview(campaignId, needed);
}

/**
 * Clear queue — move all queued contacts back to pending.
 */
function clearQueue(campaignId) {
  const result = getDb().prepare(
    "UPDATE campaign_contacts SET status = 'pending', queued_at = NULL WHERE campaign_id = ? AND status = 'queued'"
  ).run(campaignId);
  return result.changes;
}

/**
 * Skip a contact — marks as skipped in this campaign.
 * Record is preserved and can be reused in other campaigns.
 */
function skipContact(id) {
  getDb().prepare(
    "UPDATE campaign_contacts SET status = 'skipped' WHERE id = ?"
  ).run(id);
}

// ============================================================================
// SEND HISTORY
// ============================================================================

function recordHistory(data) {
  getDb().prepare(`
    INSERT INTO send_history (campaign_id, campaign_contact_id, campaign_name, phone, name, label, status, error)
    VALUES (@campaign_id, @campaign_contact_id, @campaign_name, @phone, @name, @label, @status, @error)
  `).run({
    campaign_id:         data.campaign_id         || null,
    campaign_contact_id: data.campaign_contact_id || null,
    campaign_name:       data.campaign_name       || null,
    phone:               data.phone               || null,
    name:                data.name                || null,
    label:               data.label               || null,
    status:              data.status              || 'unknown',
    error:               data.error               || null
  });
}

function getHistory({ limit = 200, campaign_id = null } = {}) {
  if (campaign_id) {
    return getDb().prepare(`
      SELECT * FROM send_history WHERE campaign_id = ?
      ORDER BY sent_at DESC LIMIT ?
    `).all(campaign_id, limit);
  }
  return getDb().prepare('SELECT * FROM send_history ORDER BY sent_at DESC LIMIT ?').all(limit);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  init,
  getDb,

  // Settings
  getSetting,
  setSetting,
  getAllSettings,

  // Campaigns
  createCampaign,
  getCampaign,
  getAllCampaigns,
  updateCampaign,
  deleteCampaign,
  getCampaignSettings,

  // Contacts
  normalisePhone,
  importContacts,
  getCampaignContacts,
  getPendingContacts,
  updateContactStatus,
  setWaValid,
  getCampaignLabels,
  resetFailed,
  clearContacts,

  // History
  recordHistory,
  getHistory,

  // Queue
  pickContactsForReview,
  getQueuedContacts,
  replenishQueue,
  clearQueue,
  skipContact
};
