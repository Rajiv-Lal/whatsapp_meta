'use strict';
/**
 * Anugnya WhatsApp Sender — Replies + Reply Assets Routes v1.2
 * routes/replies.js
 *
 * Reply Queue Routes (/api/replies):
 *   GET  /api/replies/count        — unread count
 *   GET  /api/replies              — get queue (filterable, paginated)
 *   GET  /api/replies/:id          — get one reply
 *   POST /api/replies/:id/reply    — send reply to contact
 *   POST /api/replies/:id/dismiss  — mark as read without replying
 *
 * Reply Assets Routes (/api/reply-assets):
 *   GET    /api/reply-assets        — list assets
 *   POST   /api/reply-assets        — create asset (admin)
 *   PUT    /api/reply-assets/:id    — update asset (admin)
 *   DELETE /api/reply-assets/:id    — delete asset (admin)
 *
 * Fix log v1.2:
 *   3. markInConversation removed from reply route — belongs in webhook handler only
 *   1. Window expiry checked against actual timestamp not cached status field
 *   2. Link and calendar assets allowed as replies via asset.url
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const db      = require('../database/db');
const { sendFreeTextMessage } = require('../utils/meta');
const { requireAuth, requireAdmin, logAction } = require('../middleware/auth');

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_REPLY_STATUSES = ['open', 'urgent', 'expired'];
const VALID_ASSET_TYPES    = ['text', 'pdf', 'image', 'video', 'link', 'calendar'];

// Asset types that can be sent as free text replies
const SENDABLE_ASSET_TYPES = {
  text:     asset => asset.content,
  link:     asset => asset.url,
  calendar: asset => asset.url
};

// ============================================================================
// MULTER — for reply asset file uploads
// ============================================================================

const ALLOWED_ASSET_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.mp4', '.mov'];
const MAX_ASSET_SIZE            = 20 * 1024 * 1024;

const assetStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'assets');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `asset-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const assetFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_ASSET_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${ALLOWED_ASSET_EXTENSIONS.join(', ')}`));
  }
};

const assetUpload = multer({
  storage:    assetStorage,
  fileFilter: assetFileFilter,
  limits:     { fileSize: MAX_ASSET_SIZE }
});

function uploadAssetSingle(fieldName) {
  return (req, res, next) => {
    assetUpload.single(fieldName)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function parseId(param) {
  const id = parseInt(param, 10);
  return isNaN(id) ? null : id;
}

function parsePagination(query) {
  const limit  = Math.min(parseInt(query.limit,  10) || 50, 200);
  const offset = Math.max(parseInt(query.offset, 10) || 0,   0);
  return { limit, offset };
}

function cleanupUpload(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

/**
 * FIX 1: Check actual expiry timestamp — not cached window_status field.
 * window_status is updated on a 30-min timer and may be stale.
 */
function isWindowExpired(reply) {
  return new Date(reply.window_expires_at) <= new Date();
}

// ============================================================================
// REPLY QUEUE ROUTER
// ============================================================================

const replyRouter = express.Router();

// GET /api/replies/count — MUST be before /:id
replyRouter.get('/count', requireAuth, (req, res) => {
  try {
    res.json({ count: db.getUnrepliedCount() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/replies
replyRouter.get('/', requireAuth, (req, res) => {
  try {
    const status = req.query.status || null;
    if (status && !VALID_REPLY_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Must be one of: ${VALID_REPLY_STATUSES.join(', ')}.`
      });
    }
    const { limit, offset } = parsePagination(req.query);
    res.json(db.getReplyQueue({ status, limit, offset }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/replies/:id
replyRouter.get('/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reply id.' });

    const reply = db.getInboundReply(id);
    if (!reply) return res.status(404).json({ error: 'Reply not found.' });

    res.json(reply);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/replies/:id/reply
replyRouter.post('/:id/reply', requireAuth, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reply id.' });

    const reply = db.getInboundReply(id);
    if (!reply) return res.status(404).json({ error: 'Reply not found.' });

    if (reply.replied) {
      return res.status(409).json({ error: 'This reply has already been sent.' });
    }

    // FIX 1: Check actual timestamp — not cached status field
    if (isWindowExpired(reply)) {
      return res.status(409).json({
        error: 'The 24-hour reply window has expired. Use a template message to re-engage.'
      });
    }

    // Resolve reply text — from body.text or from a reply asset
    let replyText    = null;
    let replyAssetId = null;

    if (req.body.text && String(req.body.text).trim()) {
      replyText = String(req.body.text).trim();

    } else if (req.body.assetId) {
      const assetId = parseId(req.body.assetId);
      if (!assetId) return res.status(400).json({ error: 'Invalid assetId.' });

      const asset = db.getReplyAsset(assetId);
      if (!asset) return res.status(404).json({ error: 'Reply asset not found.' });

      // FIX 2: Allow text, link, and calendar assets — extract sendable content
      const getContent = SENDABLE_ASSET_TYPES[asset.type];
      if (!getContent) {
        return res.status(400).json({
          error: 'Only text, link, and calendar assets can be sent as free text replies.'
        });
      }

      const content = getContent(asset);
      if (!content) {
        return res.status(400).json({
          error: `Asset "${asset.name}" has no content to send.`
        });
      }

      replyText    = content;
      replyAssetId = assetId;
    }

    if (!replyText) {
      return res.status(400).json({
        error: 'Either text or a text/link/calendar asset id must be provided.'
      });
    }

    const messageId = await sendFreeTextMessage(reply.phone, replyText, reply.contact_id);

    db.markReplied(id, replyText, replyAssetId, req.user.user_id);

    logAction(req, 'reply_sent', 'inbound_reply', id,
      `Replied to ${reply.phone}: "${replyText.slice(0, 50)}${replyText.length > 50 ? '...' : ''}"`);

    res.json({ ok: true, messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/replies/:id/dismiss
replyRouter.post('/:id/dismiss', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid reply id.' });

    const reply = db.getInboundReply(id);
    if (!reply) return res.status(404).json({ error: 'Reply not found.' });

    db.markReplied(id, null, null, req.user.user_id);

    logAction(req, 'reply_dismissed', 'inbound_reply', id,
      `Dismissed reply from ${reply.phone}`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// REPLY ASSETS ROUTER
// ============================================================================

const assetRouter = express.Router();

// GET /api/reply-assets
assetRouter.get('/', requireAuth, (req, res) => {
  try {
    const campaignId    = req.query.campaignId ? parseId(req.query.campaignId) : null;
    const includeGlobal = req.query.includeGlobal !== 'false';
    res.json(db.getReplyAssets({ campaignId, includeGlobal }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reply-assets
assetRouter.post('/', requireAdmin, uploadAssetSingle('file'), (req, res) => {
  const filePath = req.file?.path || null;
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      cleanupUpload(filePath);
      return res.status(400).json({ error: 'name is required.' });
    }

    const type = String(req.body.type || '').trim();
    if (!type || !VALID_ASSET_TYPES.includes(type)) {
      cleanupUpload(filePath);
      return res.status(400).json({
        error: `type is required. Must be one of: ${VALID_ASSET_TYPES.join(', ')}.`
      });
    }

    if (type === 'text' && !req.body.content) {
      cleanupUpload(filePath);
      return res.status(400).json({ error: 'content is required for text assets.' });
    }

    if (['link', 'calendar'].includes(type) && !req.body.url) {
      cleanupUpload(filePath);
      return res.status(400).json({ error: 'url is required for link and calendar assets.' });
    }

    if (['pdf', 'image', 'video'].includes(type) && !req.file) {
      return res.status(400).json({ error: `A file upload is required for ${type} assets.` });
    }

    const campaignId = req.body.campaign_id ? parseId(req.body.campaign_id) : null;

    // Only file-based types use the uploaded file.
    // Clean up any stray upload for text/link/calendar types.
    const needsFile  = ['pdf', 'image', 'video'].includes(type);
    const actualPath = needsFile ? filePath : null;
    if (filePath && !needsFile) cleanupUpload(filePath);

    const asset = db.createReplyAsset({
      name,
      type,
      content:     req.body.content || null,
      file_path:   actualPath,
      url:         req.body.url     || null,
      campaign_id: campaignId,
      is_global:   req.body.is_global === 'true' || req.body.is_global === true,
      created_by:  req.user.user_id
    });

    logAction(req, 'reply_asset_created', 'reply_asset', asset.id,
      `Created ${type} asset "${name}"`);

    res.status(201).json(asset);
  } catch (err) {
    cleanupUpload(filePath);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/reply-assets/:id
assetRouter.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const existing = db.getReplyAsset(id);
    if (!existing) return res.status(404).json({ error: 'Reply asset not found.' });

    const ALLOWED = ['name', 'content', 'url', 'campaign_id', 'is_global'];
    const updates = {};
    for (const key of ALLOWED) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.name !== undefined) {
      updates.name = String(updates.name).trim();
      if (!updates.name) return res.status(400).json({ error: 'name cannot be empty.' });
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const asset = db.updateReplyAsset(id, updates);

    logAction(req, 'reply_asset_updated', 'reply_asset', id,
      `Updated asset "${asset.name}"`);

    res.json(asset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reply-assets/:id
assetRouter.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid asset id.' });

    const asset = db.getReplyAsset(id);
    if (!asset) return res.status(404).json({ error: 'Reply asset not found.' });

    const name = asset.name;
    db.deleteReplyAsset(id);

    logAction(req, 'reply_asset_deleted', 'reply_asset', id,
      `Deleted asset "${name}"`);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { replyRouter, assetRouter };
