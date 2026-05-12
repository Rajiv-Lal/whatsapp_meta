'use strict';
/**
 * Anugnya WhatsApp Sender — Templates Routes v1.2
 * routes/templates.js
 *
 * Routes:
 *   GET    /api/templates             — list (admin: all, operator: active only)
 *   GET    /api/templates/:id/in-use  — check if locked to active campaign
 *   GET    /api/templates/:id         — get one (operator: active only)
 *   POST   /api/templates             — create (admin only)
 *   PUT    /api/templates/:id         — update (admin only)
 *   DELETE /api/templates/:id         — delete (admin only)
 *
 * Fix log v1.2:
 *   1. ALLOWED_UPDATE_FIELDS moved to module level constant
 *   2. UNIQUE error messages use trimmed name in POST and PUT
 */

const express  = require('express');
const router   = express.Router();
const db       = require('../database/db');
const { requireAuth, requireAdmin, logAction } = require('../middleware/auth');

// ============================================================================
// CONSTANTS
// ============================================================================

const VALID_STATUSES          = ['active', 'pending', 'rejected', 'paused'];
const VALID_HEADER_TYPES      = ['image', 'video', 'document', 'text'];
const ALLOWED_UPDATE_FIELDS   = [
  'name', 'language', 'category', 'status',
  'header_type', 'header_value', 'body_text',
  'footer_text', 'variable_map', 'button_url', 'button_label'
];

// ============================================================================
// HELPERS
// ============================================================================

function parseId(param) {
  const id = parseInt(param, 10);
  return isNaN(id) ? null : id;
}

function validateBody(body, isCreate = false) {
  const errors = [];

  if (isCreate) {
    if (!body.name      || !String(body.name).trim())      errors.push('name is required.');
    if (!body.body_text || !String(body.body_text).trim()) errors.push('body_text is required.');
  }

  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    errors.push(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  if (body.header_type !== undefined && body.header_type !== null &&
      !VALID_HEADER_TYPES.includes(body.header_type)) {
    errors.push(`Invalid header_type. Must be one of: ${VALID_HEADER_TYPES.join(', ')}.`);
  }

  return errors;
}

// ============================================================================
// GET /api/templates
// Admin   → all templates (all statuses)
// Operator → active templates only
// ============================================================================

router.get('/', requireAuth, (req, res) => {
  try {
    let templates = db.getAllTemplates();
    if (req.user.role !== 'admin') {
      templates = templates.filter(t => t.status === 'active');
    }
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/templates/:id/in-use
// MUST be defined before /:id to prevent Express route conflict.
// Returns { inUse: boolean }
// ============================================================================

router.get('/:id/in-use', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template id.' });

    const template = db.getTemplate(id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    res.json({ inUse: db.isTemplateInUse(id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/templates/:id
// Admin   → any status
// Operator → active only (404 for inactive — do not reveal existence)
// ============================================================================

router.get('/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template id.' });

    const template = db.getTemplate(id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    if (req.user.role !== 'admin' && template.status !== 'active') {
      return res.status(404).json({ error: 'Template not found.' });
    }

    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/templates
// Admin only.
// ============================================================================

router.post('/', requireAdmin, (req, res) => {
  try {
    const errors = validateBody(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const name = String(req.body.name).trim();

    const template = db.createTemplate({
      name,
      body_text:    String(req.body.body_text).trim(),
      language:     req.body.language     || 'en',
      category:     req.body.category     || 'MARKETING',
      status:       req.body.status       || 'active',
      header_type:  req.body.header_type  || null,
      header_value: req.body.header_value || null,
      footer_text:  req.body.footer_text  || null,
      variable_map: req.body.variable_map || {},
      button_url:   req.body.button_url   || null,
      button_label: req.body.button_label || null,
      created_by:   req.user.user_id
    });

    logAction(req, 'template_created', 'template', template.id,
      `Created template "${template.name}"`);

    res.status(201).json(template);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: templates.name')) {
      const name = String(req.body.name || '').trim();
      return res.status(409).json({ error: `A template named "${name}" already exists.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/templates/:id
// Admin only. Updates any subset of allowed fields.
// Blocks status downgrade if template is locked to active campaign.
// ============================================================================

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template id.' });

    const existing = db.getTemplate(id);
    if (!existing) return res.status(404).json({ error: 'Template not found.' });

    const errors = validateBody(req.body, false);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    // Block status downgrade while template is locked to active campaign
    const newStatus = req.body.status;
    if (newStatus && ['rejected', 'paused'].includes(newStatus) && db.isTemplateInUse(id)) {
      return res.status(409).json({
        error: 'Cannot change status to rejected or paused while template is locked to an active campaign.'
      });
    }

    const updates = {};
    for (const key of ALLOWED_UPDATE_FIELDS) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const template = db.updateTemplate(id, updates);

    logAction(req, 'template_updated', 'template', id,
      `Updated template "${template.name}"`);

    res.json(template);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: templates.name')) {
      const name = String(req.body.name || '').trim();
      return res.status(409).json({ error: `A template named "${name}" already exists.` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DELETE /api/templates/:id
// Admin only.
// db.deleteTemplate() throws when template is in use — caught as 409.
// ============================================================================

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid template id.' });

    const template = db.getTemplate(id);
    if (!template) return res.status(404).json({ error: 'Template not found.' });

    const name = template.name;
    db.deleteTemplate(id);

    logAction(req, 'template_deleted', 'template', id,
      `Deleted template "${name}"`);

    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('locked to an active campaign')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
