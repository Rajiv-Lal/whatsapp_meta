'use strict';
require('dotenv').config();

const REQUIRED_ENV = ['PHONE_NUMBER_ID', 'ACCESS_TOKEN', 'WEBHOOK_VERIFY_TOKEN'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) console.warn(`⚠️  WARNING: ${key} is not set in .env`);
}

const http         = require('http');
const path         = require('path');
const express      = require('express');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const db = require('./database/db');
const { requireAuth, requireAdmin, logAction } = require('./middleware/auth');
const createSendRouter = require('./routes/send');
const { replyRouter, assetRouter } = require('./routes/replies');

db.init();

let _state = { api: 'ready', sending: null };
function getState()        { return _state; }
function setState(updates) { _state = { ..._state, ...updates }; }

const app    = express();
const server = http.createServer(app);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT          = parseInt(process.env.PORT, 10) || 3000;

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => { ws.send(JSON.stringify({ type: 'state', ...getState() })); });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { try { client.send(msg); } catch {} }
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use('/api/templates',     require('./routes/templates'));
app.use('/api/contact-lists', require('./routes/contact-lists'));
app.use('/api/campaigns',     require('./routes/campaigns'));
app.use('/api/send',          createSendRouter(getState, setState, broadcast));
app.use('/api/replies',       replyRouter);
app.use('/api/reply-assets',  assetRouter);

app.post('/api/auth/login', (req, res) => {
  try {
    const email    = String(req.body.email    || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    const user = db.verifyPassword(email, password);
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    const token = db.createSession(user.id);
    res.cookie('session_token', token, { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 });
    logAction(req, 'login', 'user', user.id, `Login: ${email}`);
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  try {
    const token = req.cookies?.session_token || req.headers['x-session-token'];
    if (token) db.deleteSession(token);
    res.clearCookie('session_token');
    logAction(req, 'logout', 'user', req.user.user_id, `Logout: ${req.user.email}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  try { res.json(db.getUser(req.user.user_id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  try {
    const newPassword = String(req.body.newPassword || '').trim();
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    db.updatePassword(req.user.user_id, newPassword);
    logAction(req, 'password_changed', 'user', req.user.user_id, 'Password changed');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users', requireAdmin, (req, res) => {
  try { res.json(db.getAllUsers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAdmin, (req, res) => {
  try {
    const name     = String(req.body.name     || '').trim();
    const email    = String(req.body.email    || '').toLowerCase().trim();
    const password = String(req.body.password || '').trim();
    const role     = req.body.role || 'operator';
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!['admin', 'operator'].includes(role)) return res.status(400).json({ error: 'role must be admin or operator.' });
    const user = db.createUser({ name, email, password, role, must_change_password: req.body.must_change_password ? 1 : 0 });
    logAction(req, 'user_created', 'user', user.id, `Created user: ${email}`);
    res.status(201).json(user);
  } catch (err) {
    if (err.message?.includes('already exists')) return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid user id.' });
    const existing = db.getUser(id);
    if (!existing) return res.status(404).json({ error: 'User not found.' });
    const ALLOWED = ['name', 'role', 'is_active', 'must_change_password'];
    const updates = {};
    for (const key of ALLOWED) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
    if (updates.role && !['admin', 'operator'].includes(updates.role)) return res.status(400).json({ error: 'role must be admin or operator.' });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields provided for update.' });
    const user = db.updateUser(id, updates);
    logAction(req, 'user_updated', 'user', id, `Updated user: ${existing.email}`);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid user id.' });
    const existing = db.getUser(id);
    if (!existing) return res.status(404).json({ error: 'User not found.' });
    const newPassword = String(req.body.newPassword || '').trim();
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    db.updatePassword(id, newPassword);
    db.updateUser(id, { must_change_password: 1 });
    logAction(req, 'password_reset', 'user', id, `Reset password for: ${existing.email}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings', requireAuth, (req, res) => {
  try { res.json(db.getAllSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', requireAdmin, (req, res) => {
  try {
    const ALLOWED_SETTINGS = [
      'default_batch_size', 'default_delay_min_sec', 'default_delay_max_sec',
      'default_batch_interval_min', 'default_daily_limit', 'min_days_between_contact'
    ];
    const updates = {};
    for (const key of ALLOWED_SETTINGS) {
      if (req.body[key] !== undefined) {
        const val = parseInt(req.body[key], 10);
        if (isNaN(val) || val < 0) return res.status(400).json({ error: `${key} must be a positive integer.` });
        updates[key] = val;
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid settings provided.' });
    for (const [key, val] of Object.entries(updates)) db.setSetting(key, val);
    logAction(req, 'settings_updated', null, null, `Updated settings: ${Object.keys(updates).join(', ')}`);
    res.json(db.getAllSettings());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/meta-log', requireAdmin, (req, res) => {
  try {
    const direction  = req.query.direction  || undefined;
    const type       = req.query.type       || undefined;
    const campaignId = req.query.campaignId ? parseInt(req.query.campaignId, 10) : undefined;
    const limit      = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(db.getMetaLog({ direction, type, campaignId, limit }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// CONTACTS — update contact fields (first name, name, email, notes)
app.put("/api/contacts/:id", requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "Invalid contact id." });
    const allowed = { first_name: req.body.first_name, name: req.body.name, email: req.body.email, notes: req.body.notes };
    const updates = {};
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined) updates[k] = String(v).trim();
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: "No valid fields provided." });
    const contact = db.updateContact(id, updates);
    res.json(contact);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/status', requireAuth, (req, res) => {
  try {
    res.json({ ...getState(), unreadReplies: db.getUnrepliedCount(), uptime: process.uptime(), nodeVersion: process.version, timestamp: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/webhook/wa', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️  Webhook verification failed');
  res.status(403).send('Forbidden');
});

app.post('/webhook/wa', (req, res) => {
  res.status(200).send('OK');
  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value    = change.value;
        const messages = value?.messages || [];
        const contacts = value?.contacts || [];
        for (const msg of messages) {
          if (msg.type !== 'text') continue;
          const phone  = msg.from;
          const text   = msg.text?.body || '';
          const waName = contacts.find(c => c.wa_id === phone)?.profile?.name || null;
          db.logMeta({ direction: 'inbound', type: 'text_reply', phone, campaign_id: null, contact_id: null, payload: msg, response: null, status_code: null, success: 1, error: null });
          const contact   = db.getContactByPhone(phone);
          const contactId = contact?.id || null;
          if (contact && !contact.in_conversation) db.markInConversation(contact.id);
          const reply = db.createInboundReply({ phone, name: waName, message: text, media_type: null, media_url: null, contact_id: contactId, campaign_id: null });
          broadcast({ type: 'inbound_reply', reply });
          broadcast({ type: 'log', msg: `📩 Reply from ${waName || phone}: "${text.slice(0, 60)}"`, level: 'info' });
        }
      }
    }
  } catch (err) { console.error('Webhook error:', err.message); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

setInterval(() => { try { db.updateWindowStatuses(); } catch (err) { console.error('updateWindowStatuses error:', err.message); } }, 30 * 60 * 1000);
setInterval(() => { try { db.deleteExpiredSessions(); } catch (err) { console.error('deleteExpiredSessions error:', err.message); } }, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`✅ Anugnya Sender running on port ${PORT}`);
  console.log(`   Environment : ${IS_PRODUCTION ? 'production' : 'development'}`);
  console.log(`   Dashboard   : ${IS_PRODUCTION ? 'https://sender.anugnyaholisticcare.com' : `http://localhost:${PORT}`}`);
  console.log(`   Webhook URL : ${IS_PRODUCTION ? 'https://sender.anugnyaholisticcare.com/webhook/wa' : `http://localhost:${PORT}/webhook/wa`}`);
});
