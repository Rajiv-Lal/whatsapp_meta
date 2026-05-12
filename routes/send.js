'use strict';
/**
 * Anugnya WhatsApp Sender — Send Engine + Routes v1.5
 * routes/send.js
 *
 * IMPORTANT: server.js must call require('dotenv').config() BEFORE
 * requiring this module — env vars are read at module load time.
 *
 * Fix log v1.5:
 *   0. sendMetaMessage removed — now imports sendTemplateMessage from utils/meta
 *   1. res.json() wrapped in try/catch — non-JSON Meta responses handled
 *      gracefully, always logged, descriptive error returned
 *   2. POST /pause blocked when status is 'stopping'
 */

const express = require('express');
const db      = require('../database/db');
const { requireAuth, requireAdmin, logAction } = require('../middleware/auth');
const { sendTemplateMessage }                  = require('../utils/meta');


// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randDelay(minSec, maxSec) {
  return (minSec + Math.random() * (maxSec - minSec)) * 1000;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getFirstName(contact) {
  return (contact.first_name || contact.name || 'Friend')
    .toString().trim().split(/\s+/)[0] || 'Friend';
}

/**
 * Safely merge update into sending state.
 * Guards against null sending object before spreading.
 */
function updateSending(getState, setState, update) {
  const cur = getState().sending || {};
  setState({ sending: { ...cur, ...update } });
}

/**
 * Interruptible sleep for batch intervals.
 * Polls every 10 seconds so stop requests are honoured within 10s
 * rather than waiting the full interval (up to 120 minutes).
 */
async function interruptibleSleep(ms, getState) {
  const POLL = 10 * 1000;
  let waited = 0;
  while (waited < ms) {
    if (getState().sending?.stopRequested) break;
    await sleep(Math.min(POLL, ms - waited));
    waited += POLL;
  }
}

// ============================================================================
// SEND ENGINE — CAMPAIGN SEND
// ============================================================================

async function runCampaignSend(campaign, getState, setState, broadcast) {
  const contacts = db.getQueuedContacts(campaign.id);

  if (!contacts.length) {
    broadcast({ type: 'log', msg: '❌ No queued contacts. Pick contacts first.', level: 'error' });
    setState({ sending: null });
    return;
  }

  const batches = chunk(contacts, campaign.batch_size || 10);

  setState({
    sending: {
      campaignId:    campaign.id,
      campaignName:  campaign.name,
      status:        'sending',
      currentBatch:  1,
      totalBatches:  batches.length,
      sent:          0,
      failed:        0,
      total:         contacts.length,
      startTime:     new Date().toISOString(),
      nextBatchAt:   null,
      stopRequested: false
    }
  });

  broadcast({ type: 'state', ...getState() });
  broadcast({ type: 'log', msg: `📤 Starting "${campaign.name}" — ${contacts.length} contacts in ${batches.length} batch(es)` });

  for (let b = 0; b < batches.length; b++) {
    if (getState().sending?.stopRequested) {
      broadcast({ type: 'log', msg: '🛑 Stopped.' });
      break;
    }

    // Wait while paused — check stop every 2s
    while (getState().sending?.status === 'paused') {
      await sleep(2000);
      if (getState().sending?.stopRequested) break;
    }
    if (getState().sending?.stopRequested) break;

    updateSending(getState, setState, { currentBatch: b + 1, status: 'sending' });
    broadcast({ type: 'state', ...getState() });
    broadcast({ type: 'log', msg: `\n📦 Batch ${b + 1} of ${batches.length}` });

    for (const contact of batches[b]) {
      if (getState().sending?.stopRequested) break;

      const firstName = getFirstName(contact);
      const phone     = String(contact.phone).replace(/\D/g, '');

      try {
        const messageId = await sendTemplateMessage(phone, firstName, campaign.id, contact.contact_id);
        db.updateCampaignContactStatus(contact.id, 'sent', messageId, null);
        db.updateContactLastContacted(contact.contact_id);

        updateSending(getState, setState, { sent: (getState().sending?.sent || 0) + 1 });
        broadcast({ type: 'log', msg: `  ✅ ${firstName} (${phone})` });
        broadcast({ type: 'contact_sent', phone, name: firstName, status: 'sent' });

      } catch (err) {
        db.updateCampaignContactStatus(contact.id, 'failed', null, err.message);
        updateSending(getState, setState, { failed: (getState().sending?.failed || 0) + 1 });
        broadcast({ type: 'log', msg: `  ❌ ${firstName} (${phone}): ${err.message}`, level: 'error' });
        broadcast({ type: 'contact_sent', phone, name: firstName, status: 'failed' });
      }

      broadcast({ type: 'state', ...getState() });

      // Delay between contacts — skip delay after last contact in batch
      const isLastInBatch = contact === batches[b][batches[b].length - 1];
      if (!isLastInBatch) {
        const delay = randDelay(campaign.delay_min_sec || 20, campaign.delay_max_sec || 45);
        broadcast({ type: 'log', msg: `  ⏳ ${Math.round(delay / 1000)}s` });
        await sleep(delay);
      }
    }

    // Checkpoint — record running totals after each batch in case of crash
    const s = getState().sending || {};
    db.recordSendHistory(campaign.id, campaign.name, s.sent || 0, s.failed || 0, s.total || 0);

    // Interruptible batch interval — stop responds within 10s
    if (b < batches.length - 1 && !getState().sending?.stopRequested) {
      const intervalMs = (campaign.batch_interval_min || 120) * 60 * 1000;
      const nextAt     = new Date(Date.now() + intervalMs).toISOString();
      updateSending(getState, setState, { nextBatchAt: nextAt });
      broadcast({ type: 'log', msg: `⏰ Next batch at ${new Date(nextAt).toLocaleTimeString('en-IN')}` });
      broadcast({ type: 'state', ...getState() });
      await interruptibleSleep(intervalMs, getState);
    }
  }

  // Final record and cleanup
  const final = getState().sending || {};
  db.recordSendHistory(campaign.id, campaign.name, final.sent || 0, final.failed || 0, final.total || 0);

  // Only update campaign status if stopped — preserves admin changes made mid-send
  if (final.stopRequested) {
    db.updateCampaign(campaign.id, { status: 'paused' });
    broadcast({ type: 'log', msg: `\n🛑 Stopped — Sent: ${final.sent || 0} | Failed: ${final.failed || 0}` });
  } else {
    broadcast({ type: 'log', msg: `\n🎉 Done — Sent: ${final.sent || 0} | Failed: ${final.failed || 0}` });
  }

  setState({ sending: null });
  broadcast({ type: 'state', ...getState() });
}

// ============================================================================
// SEND ENGINE — MANUAL SEND
// ============================================================================

async function runManualSend(campaign, count, getState, setState, broadcast) {
  const contacts = db.getQueuedContacts(campaign.id).slice(0, count);

  if (!contacts.length) {
    broadcast({ type: 'log', msg: '❌ No queued contacts.', level: 'error' });
    setState({ sending: null });
    return;
  }

  setState({
    sending: {
      campaignId:    campaign.id,
      campaignName:  campaign.name,
      status:        'sending',
      currentBatch:  1,
      totalBatches:  1,
      sent:          0,
      failed:        0,
      total:         contacts.length,
      startTime:     new Date().toISOString(),
      nextBatchAt:   null,
      stopRequested: false
    }
  });

  broadcast({ type: 'state', ...getState() });
  broadcast({ type: 'log', msg: `📤 Manual send — ${contacts.length} contact(s)` });

  for (const contact of contacts) {
    if (getState().sending?.stopRequested) break;

    const firstName = getFirstName(contact);
    const phone     = String(contact.phone).replace(/\D/g, '');

    try {
      const messageId = await sendTemplateMessage(phone, firstName, campaign.id, contact.contact_id);
      db.updateCampaignContactStatus(contact.id, 'sent', messageId, null);
      db.updateContactLastContacted(contact.contact_id);

      updateSending(getState, setState, { sent: (getState().sending?.sent || 0) + 1 });
      broadcast({ type: 'log', msg: `  ✅ ${firstName} (${phone})` });
      broadcast({ type: 'contact_sent', phone, name: firstName, status: 'sent' });

    } catch (err) {
      db.updateCampaignContactStatus(contact.id, 'failed', null, err.message);
      updateSending(getState, setState, { failed: (getState().sending?.failed || 0) + 1 });
      broadcast({ type: 'log', msg: `  ❌ ${firstName} (${phone}): ${err.message}`, level: 'error' });
      broadcast({ type: 'contact_sent', phone, name: firstName, status: 'failed' });
    }

    broadcast({ type: 'state', ...getState() });

    const isLast = contact === contacts[contacts.length - 1];
    if (!isLast) {
      const delay = randDelay(campaign.delay_min_sec || 20, campaign.delay_max_sec || 45);
      broadcast({ type: 'log', msg: `  ⏳ ${Math.round(delay / 1000)}s` });
      await sleep(delay);
    }
  }

  const final = getState().sending || {};
  db.recordSendHistory(campaign.id, campaign.name, final.sent || 0, final.failed || 0, final.total || 0);
  broadcast({ type: 'log', msg: `\n🎉 Manual send done — Sent: ${final.sent || 0} | Failed: ${final.failed || 0}` });
  setState({ sending: null });
  broadcast({ type: 'state', ...getState() });
}

// ============================================================================
// FACTORY — createSendRouter
// getState()        — returns current full state object
// setState(updates) — merges updates into state (server.js implements this)
// broadcast(data)   — sends JSON to all WebSocket clients
// ============================================================================

module.exports = function createSendRouter(getState, setState, broadcast) {
  const router = express.Router();

  // --------------------------------------------------------------------------
  // GET /api/send/status
  // --------------------------------------------------------------------------
  router.get('/status', requireAuth, (req, res) => {
    res.json(getState());
  });

  // --------------------------------------------------------------------------
  // POST /api/send/start
  // --------------------------------------------------------------------------
  router.post('/start', requireAdmin, (req, res) => {
    try {
      const campaignId = parseInt(req.body.campaignId, 10);
      if (!campaignId) return res.status(400).json({ error: 'campaignId is required.' });

      const state = getState();
      if (state.sending) {
        return res.status(409).json({
          error: `Campaign "${state.sending.campaignName}" is already sending. Stop it first.`
        });
      }

      const campaign = db.getCampaign(campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

      if (campaign.status !== 'active') {
        return res.status(409).json({
          error: 'Campaign must be active (locked) before sending. Lock the campaign first.'
        });
      }

      logAction(req, 'send_started', 'campaign', campaignId,
        `Started send for campaign "${campaign.name}"`);

      runCampaignSend(campaign, getState, setState, broadcast).catch(err => {
        broadcast({ type: 'log', msg: `❌ Send engine error: ${err.message}`, level: 'error' });
        setState({ sending: null });
        broadcast({ type: 'state', ...getState() });
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/send/pause
  // FIX 2: Blocked when status is 'stopping' — prevents confusing state.
  // --------------------------------------------------------------------------
  router.post('/pause', requireAdmin, (req, res) => {
    try {
      const campaignId = parseInt(req.body.campaignId, 10);
      if (!campaignId) return res.status(400).json({ error: 'campaignId is required.' });

      const state = getState();
      if (!state.sending || state.sending.campaignId !== campaignId) {
        return res.status(409).json({ error: 'No active send for this campaign.' });
      }

      if (state.sending.status === 'stopping') {
        return res.status(409).json({
          error: 'Campaign is stopping. Wait for it to finish before pausing.'
        });
      }

      const newStatus    = state.sending.status === 'paused' ? 'sending' : 'paused';
      const campaignName = state.sending.campaignName;

      setState({ sending: { ...state.sending, status: newStatus } });
      broadcast({ type: 'state', ...getState() });
      broadcast({ type: 'log', msg: newStatus === 'paused' ? '⏸ Send paused.' : '▶️ Send resumed.' });

      logAction(req, newStatus === 'paused' ? 'send_paused' : 'send_resumed',
        'campaign', campaignId,
        `${newStatus === 'paused' ? 'Paused' : 'Resumed'} send for campaign "${campaignName}"`);

      res.json({ ok: true, status: newStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/send/stop
  // --------------------------------------------------------------------------
  router.post('/stop', requireAdmin, (req, res) => {
    try {
      const campaignId = parseInt(req.body.campaignId, 10);
      if (!campaignId) return res.status(400).json({ error: 'campaignId is required.' });

      const state = getState();
      if (!state.sending || state.sending.campaignId !== campaignId) {
        return res.status(409).json({ error: 'No active send for this campaign.' });
      }

      const campaignName = state.sending.campaignName;
      setState({ sending: { ...state.sending, stopRequested: true, status: 'stopping' } });
      broadcast({ type: 'state', ...getState() });
      broadcast({ type: 'log', msg: '🛑 Stop requested — finishing current contact.' });

      logAction(req, 'send_stopped', 'campaign', campaignId,
        `Stopped send for campaign "${campaignName}"`);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/send/manual
  // --------------------------------------------------------------------------
  router.post('/manual', requireAdmin, (req, res) => {
    try {
      const campaignId = parseInt(req.body.campaignId, 10);
      if (!campaignId) return res.status(400).json({ error: 'campaignId is required.' });

      const state = getState();
      if (state.sending) {
        return res.status(409).json({
          error: `Campaign "${state.sending.campaignName}" is already sending. Stop it first.`
        });
      }

      const campaign = db.getCampaign(campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

      if (campaign.status !== 'active') {
        return res.status(409).json({
          error: 'Campaign must be active (locked) before sending.'
        });
      }

      const count = Math.min(Math.max(parseInt(req.body.count, 10) || 1, 1), 50);

      logAction(req, 'send_manual', 'campaign', campaignId,
        `Manual send of ${count} contact(s) for campaign "${campaign.name}"`);

      runManualSend(campaign, count, getState, setState, broadcast).catch(err => {
        broadcast({ type: 'log', msg: `❌ Manual send error: ${err.message}`, level: 'error' });
        setState({ sending: null });
        broadcast({ type: 'state', ...getState() });
      });

      res.json({ ok: true, sending: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
