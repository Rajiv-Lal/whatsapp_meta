'use strict';
/**
 * Anugnya WhatsApp Sender — Campaigns Routes v1.2
 * routes/campaigns.js
 *
 * Fix log v1.2:
 *   1. POST /lock returns 404 for not-found, 400 for validation errors
 *   2. POST /queue/clear blocked when campaign is active
 *   3. POST /reset-failed blocked when campaign is active
 */

const express = require('express');
const router  = express.Router();
const db      = require('../database/db');
const { requireAuth, requireAdmin, logAction } = require('../middleware/auth');

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_CONTACT_STATUSES = ['pending', 'queued', 'sent', 'failed', 'skipped'];

const ALLOWED_CAMPAIGN_FIELDS = [
  'name', 'template_id', 'contact_list_id', 'custom_message',
  'batch_size', 'batch_interval_min', 'delay_min_sec',
  'delay_max_sec', 'daily_limit'
];

// ============================================================================
// HELPERS
// ============================================================================

function parseId(param) {
  const id = parseInt(param, 10);
  return isNaN(id) ? null : id;
}

function parsePagination(query) {
  const limit  = Math.min(parseInt(query.limit,  10) || 100, 500);
  const offset = Math.max(parseInt(query.offset, 10) || 0,   0);
  return { limit, offset };
}

function validateDelays(body) {
  const min = parseInt(body.delay_min_sec, 10);
  const max = parseInt(body.delay_max_sec, 10);
  if (!isNaN(min) && !isNaN(max) && min >= max) {
    return 'delay_min_sec must be less than delay_max_sec.';
  }
  return null;
}

function clampCount(val, defaultVal = 50, min = 1, max = 500) {
  return Math.min(Math.max(parseInt(val, 10) || defaultVal, min), max);
}

// ============================================================================
// GET /api/campaigns
// ============================================================================

router.get('/', requireAuth, (req, res) => {
  try {
    res.json(db.getAllCampaigns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/campaigns/:id/contacts — MUST be before /:id
// ============================================================================

router.get('/:id/contacts', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    const status = req.query.status || null;
    if (status && !VALID_CONTACT_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_CONTACT_STATUSES.join(', ')}.`
      });
    }

    const { limit, offset } = parsePagination(req.query);
    res.json(db.getCampaignContacts(id, { status, limit, offset }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/campaigns/:id/queue — MUST be before /:id
// ============================================================================

router.get('/:id/queue', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    res.json(db.getQueuedContacts(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/campaigns/:id/history — MUST be before /:id
// ============================================================================

router.get('/:id/history', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    res.json(db.getSendHistory({ campaignId: id, limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/campaigns/:id
// ============================================================================

router.get('/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns
// ============================================================================

router.post('/', requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const delayError = validateDelays(req.body);
    if (delayError) return res.status(400).json({ error: delayError });

    const campaign = db.createCampaign({
      name,
      template_id:        req.body.template_id        || null,
      contact_list_id:    req.body.contact_list_id    || null,
      custom_message:     req.body.custom_message     || null,
      batch_size:         req.body.batch_size         || null,
      batch_interval_min: req.body.batch_interval_min || null,
      delay_min_sec:      req.body.delay_min_sec      || null,
      delay_max_sec:      req.body.delay_max_sec      || null,
      daily_limit:        req.body.daily_limit        || null,
      created_by:         req.user.user_id
    });

    logAction(req, 'campaign_created', 'campaign', campaign.id,
      `Created campaign "${campaign.name}"`);

    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/lock
// FIX 1: 404 for not-found, 400 for validation failures.
// ============================================================================

router.post('/:id/lock', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.lockCampaign(id);

    logAction(req, 'campaign_locked', 'campaign', id,
      `Locked and activated campaign "${campaign.name}"`);

    res.json(campaign);
  } catch (err) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message?.includes('Assign a template') ||
        err.message?.includes('Assign a contact list')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/unlock
// ============================================================================

router.post('/:id/unlock', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    const campaign = db.unlockCampaign(id);

    logAction(req, 'campaign_unlocked', 'campaign', id,
      `Unlocked and paused campaign "${campaign.name}"`);

    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/load-contacts
// Blocked when active to prevent race conditions.
// ============================================================================

router.post('/:id/load-contacts', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    if (campaign.status === 'active') {
      return res.status(409).json({
        error: 'Cannot reload contacts while campaign is active. Pause the campaign first.'
      });
    }

    const result = db.loadContactsFromList(id);

    logAction(req, 'campaign_contacts_loaded', 'campaign', id,
      `Loaded ${result.loaded} contacts into campaign "${campaign.name}"`);

    res.json({ ok: true, loaded: result.loaded });
  } catch (err) {
    if (err.message?.includes('not found') ||
        err.message?.includes('no contact list')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/pick
// Blocked when active to prevent queue interference.
// ============================================================================

router.post('/:id/pick', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    if (campaign.status === 'active') {
      return res.status(409).json({
        error: 'Cannot pick contacts while campaign is active. Use replenish instead, or pause first.'
      });
    }

    const count  = clampCount(req.body.count);
    const picked = db.pickContactsForReview(id, count);
    const queued = db.getQueuedContacts(id);

    logAction(req, 'campaign_contacts_picked', 'campaign', id,
      `Picked ${picked} contacts into queue for campaign "${campaign.name}"`);

    res.json({ picked, totalQueued: queued.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/queue/replenish
// Allowed while active — safely tops up queue without disrupting send.
// ============================================================================

router.post('/:id/queue/replenish', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    const count  = clampCount(req.body.count);
    const added  = db.replenishQueue(id, count);
    const queued = db.getQueuedContacts(id);

    res.json({ added, totalQueued: queued.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/queue/clear
// FIX 2: Blocked when active to prevent removing mid-send contacts.
// ============================================================================

router.post('/:id/queue/clear', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    if (campaign.status === 'active') {
      return res.status(409).json({
        error: 'Cannot clear queue while campaign is active. Pause the campaign first.'
      });
    }

    const cleared = db.clearQueue(id);

    logAction(req, 'campaign_queue_cleared', 'campaign', id,
      `Cleared ${cleared} contacts from queue for campaign "${campaign.name}"`);

    res.json({ cleared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/contacts/:cid/skip
// cid = campaign_contacts.id (NOT contacts.id)
// ============================================================================

router.post('/:id/contacts/:cid/skip', requireAdmin, (req, res) => {
  try {
    const id  = parseId(req.params.id);
    const cid = parseId(req.params.cid);
    if (!id)  return res.status(400).json({ error: 'Invalid campaign id.' });
    if (!cid) return res.status(400).json({ error: 'Invalid contact id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    db.skipCampaignContact(cid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/campaigns/:id/reset-failed
// FIX 3: Blocked when active to prevent unintended re-sends.
// ============================================================================

router.post('/:id/reset-failed', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    if (campaign.status === 'active') {
      return res.status(409).json({
        error: 'Cannot reset failed contacts while campaign is active. Pause the campaign first.'
      });
    }

    const reset = db.resetFailed(id);
    res.json({ reset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/campaigns/:id
// ============================================================================

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    if (!db.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });

    const delayError = validateDelays(req.body);
    if (delayError) return res.status(400).json({ error: delayError });

    const updates = {};
    for (const key of ALLOWED_CAMPAIGN_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.name !== undefined) {
      updates.name = String(updates.name).trim();
      if (!updates.name) return res.status(400).json({ error: 'name cannot be empty.' });
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const campaign = db.updateCampaign(id, updates);

    logAction(req, 'campaign_updated', 'campaign', id,
      `Updated campaign "${campaign.name}"`);

    res.json(campaign);
  } catch (err) {
    if (err.message?.includes('active and locked')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DELETE /api/campaigns/:id
// ============================================================================

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid campaign id.' });

    const campaign = db.getCampaign(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

    const name = campaign.name;
    db.deleteCampaign(id);

    logAction(req, 'campaign_deleted', 'campaign', id,
      `Deleted campaign "${name}"`);

    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('Cannot delete an active campaign')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
