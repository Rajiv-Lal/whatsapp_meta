'use strict';

const db = require('./database/db');
const fs = require('fs');

db.init();

const raw      = JSON.parse(fs.readFileSync('/Users/rajivlal/Desktop/whatsapp-sender-users/data/contacts.json'));
const contacts = raw.contacts || raw;

const campaignId = 1;
let imported = 0;
let skipped  = 0;

const stmt = db.getDb().prepare(
  'INSERT OR IGNORE INTO campaign_contacts (campaign_id, phone, phone_raw, name, first_name, email, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

const insertMany = db.getDb().transaction((rows) => {
  for (const c of rows) {
    const phone = String(c.phone || '').trim().replace(/\.0+$/, '').replace(/\D/g, '');
    if (!phone) { skipped++; continue; }
    const status = c.contact_count > 0 ? 'sent' : 'pending';
    stmt.run(campaignId, phone, c.phone, c.name || '', c.first_name || '', c.email || '', c.source || '', status);
    imported++;
  }
});

insertMany(contacts);

db.getDb().prepare('UPDATE campaigns SET total_contacts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(imported, campaignId);

console.log('✅ Import complete');
console.log('   Total rows:     ', contacts.length);
console.log('   Imported:       ', imported);
console.log('   Skipped:        ', skipped);
console.log('   Marked sent:    ', contacts.filter(c => c.contact_count > 0).length);
console.log('   Marked pending: ', contacts.filter(c => c.contact_count === 0).length);
