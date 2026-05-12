'use strict';
/**
 * Anugnya WhatsApp Sender — Contact Lists Routes v1.2
 * routes/contact-lists.js
 *
 * Routes:
 *   GET    /api/contact-lists              — list all
 *   GET    /api/contact-lists/:id/members  — get members (paginated)
 *   GET    /api/contact-lists/:id          — get one
 *   POST   /api/contact-lists              — create (admin only)
 *   PUT    /api/contact-lists/:id          — update (admin only)
 *   DELETE /api/contact-lists/:id          — delete (admin only)
 *   POST   /api/contact-lists/:id/import   — import contacts from file (admin only)
 *
 * Fix log v1.2:
 *   1. description and source trimmed on POST and PUT
 */

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const XLSX     = require('xlsx');
const db       = require('../database/db');
const { requireAuth, requireAdmin, logAction } = require('../middleware/auth');

// ============================================================================
// MULTER
// ============================================================================

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
const MAX_FILE_SIZE      = 10 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'tmp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `import-${Date.now()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

function uploadSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
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
  const limit  = Math.min(parseInt(query.limit,  10) || 100, 500);
  const offset = Math.max(parseInt(query.offset, 10) || 0,   0);
  return { limit, offset };
}

function trimOrNull(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s.length ? s : null;
}

function parseFile(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function cleanupUpload(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

// ============================================================================
// GET /api/contact-lists
// ============================================================================

router.get('/', requireAuth, (req, res) => {
  try {
    res.json(db.getAllContactLists());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/contact-lists/:id/members
// MUST be before /:id
// ============================================================================

router.get('/:id/members', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid contact list id.' });

    const list = db.getContactList(id);
    if (!list) return res.status(404).json({ error: 'Contact list not found.' });

    const { limit, offset } = parsePagination(req.query);
    const members = db.getContactListMembers(id, { limit, offset });

    res.json({ list, members, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/contact-lists/:id
// ============================================================================

router.get('/:id', requireAuth, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid contact list id.' });

    const list = db.getContactList(id);
    if (!list) return res.status(404).json({ error: 'Contact list not found.' });

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/contact-lists
// Admin only.
// ============================================================================

router.post('/', requireAdmin, (req, res) => {
  try {
    const name = trimOrNull(req.body.name);
    if (!name) return res.status(400).json({ error: 'name is required.' });

    const list = db.createContactList({
      name,
      description: trimOrNull(req.body.description),
      source:      trimOrNull(req.body.source),
      created_by:  req.user.user_id
    });

    logAction(req, 'contact_list_created', 'contact_list', list.id,
      `Created contact list "${list.name}"`);

    res.status(201).json(list);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: contact_lists.name')) {
      return res.status(409).json({
        error: `A contact list named "${trimOrNull(req.body.name)}" already exists.`
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PUT /api/contact-lists/:id
// Admin only.
// ============================================================================

router.put('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid contact list id.' });

    const existing = db.getContactList(id);
    if (!existing) return res.status(404).json({ error: 'Contact list not found.' });

    const updates = {};

    if (req.body.name !== undefined) {
      const name = trimOrNull(req.body.name);
      if (!name) return res.status(400).json({ error: 'name cannot be empty.' });
      updates.name = name;
    }

    if (req.body.description !== undefined) updates.description = trimOrNull(req.body.description);
    if (req.body.source      !== undefined) updates.source      = trimOrNull(req.body.source);

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided for update.' });
    }

    const list = db.updateContactList(id, updates);

    logAction(req, 'contact_list_updated', 'contact_list', id,
      `Updated contact list "${list.name}"`);

    res.json(list);
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: contact_lists.name')) {
      return res.status(409).json({
        error: `A contact list named "${trimOrNull(req.body.name)}" already exists.`
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DELETE /api/contact-lists/:id
// Admin only.
// ============================================================================

router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid contact list id.' });

    const list = db.getContactList(id);
    if (!list) return res.status(404).json({ error: 'Contact list not found.' });

    const name = list.name;
    db.deleteContactList(id);

    logAction(req, 'contact_list_deleted', 'contact_list', id,
      `Deleted contact list "${name}"`);

    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('in use by campaign')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POST /api/contact-lists/:id/import
// Admin only.
// ============================================================================

router.post('/:id/import', requireAdmin, uploadSingle('file'), (req, res) => {
  const filePath = req.file?.path || null;

  try {
    const id = parseId(req.params.id);
    if (!id) {
      cleanupUpload(filePath);
      return res.status(400).json({ error: 'Invalid contact list id.' });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded. Send an Excel or CSV file in the file field.'
      });
    }

    const list = db.getContactList(id);
    if (!list) {
      cleanupUpload(filePath);
      return res.status(404).json({ error: 'Contact list not found.' });
    }

    const countryCode = String(req.body.countryCode || '91').trim();
    if (!/^\d{1,4}$/.test(countryCode)) {
      cleanupUpload(filePath);
      return res.status(400).json({
        error: 'countryCode must be 1 to 4 digits (e.g. 91 for India).'
      });
    }

    const rows       = parseFile(filePath);
    const sourceFile = req.file.originalname;
    const result     = db.importContactsToList(id, rows, sourceFile, countryCode);

    cleanupUpload(filePath);

    logAction(req, 'contacts_imported', 'contact_list', id,
      `Imported ${result.imported} contacts into "${list.name}" from "${sourceFile}"`);

    res.json({
      ok:         true,
      imported:   result.imported,
      duplicates: result.duplicates,
      invalid:    result.invalid,
      total:      result.total,
      list:       db.getContactList(id)
    });
  } catch (err) {
    cleanupUpload(filePath);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
