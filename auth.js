'use strict';
/**
 * Anugnya WhatsApp Sender — Auth Middleware v1.2
 * middleware/auth.js
 *
 * Exports:
 *   requireAuth        — any logged-in user
 *   requireAdmin       — admin role only (composes on requireAuth)
 *   requireRole(role)  — specific role check (composes on requireAuth)
 *   logAction()        — audit trail convenience wrapper
 *
 * Session token read from:
 *   1. Cookie: session_token     (browser — requires cookie-parser in server.js)
 *   2. Header: x-session-token  (API / programmatic access)
 *
 * On failure : 401 or 403 JSON { error, code }
 * On success : req.user populated with safe user + session object
 *
 * Fix log v1.2:
 *   1. must_change_password extracted to enforceMustChangePassword() — no duplication
 *   2. requireAdmin and requireRole compose on requireAuth — no duplicated session logic
 *   3. entityId coerced to integer in logAction
 */

const db = require('../database/db');

// Password change route — the only route accessible when must_change_password = 1
const CHANGE_PASSWORD_PATH = '/api/auth/change-password';

// ============================================================================
// TOKEN EXTRACTION
// ============================================================================

function extractToken(req) {
  if (req.cookies?.session_token) return req.cookies.session_token;
  const header = req.headers['x-session-token'];
  if (header) return header;
  return null;
}

// ============================================================================
// CORE SESSION CHECK
// db.getSession() already filters expired sessions and inactive users.
// ============================================================================

function checkSession(req) {
  const token = extractToken(req);
  if (!token) {
    return { error: 'No session token provided. Please log in.', code: 'NO_TOKEN' };
  }
  const session = db.getSession(token);
  if (!session) {
    return { error: 'Session expired or invalid. Please log in again.', code: 'INVALID_SESSION' };
  }
  return { user: session };
}

// ============================================================================
// HELPER — enforceMustChangePassword
// Returns true and sends 403 if password change is required.
// Single definition — no duplication across middleware.
// ============================================================================

function enforceMustChangePassword(user, req, res) {
  if (user.must_change_password && req.path !== CHANGE_PASSWORD_PATH) {
    res.status(403).json({
      error: 'You must change your password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED'
    });
    return true;
  }
  return false;
}

// ============================================================================
// MIDDLEWARE — requireAuth
// Gate for any authenticated user.
// All other middleware composes on top of this one.
// ============================================================================

function requireAuth(req, res, next) {
  const result = checkSession(req);

  if (result.error) {
    return res.status(401).json({ error: result.error, code: result.code });
  }

  if (enforceMustChangePassword(result.user, req, res)) return;

  req.user = result.user;
  next();
}

// ============================================================================
// MIDDLEWARE — requireAdmin
// Composes on requireAuth — inherits all auth logic automatically.
// Only adds the role check on top.
// ============================================================================

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'This action requires administrator access.',
        code: 'INSUFFICIENT_ROLE'
      });
    }
    next();
  });
}

// ============================================================================
// MIDDLEWARE — requireRole(role)
// Composes on requireAuth — inherits all auth logic automatically.
// Roles are schema-controlled: 'admin', 'operator'.
// ============================================================================

function requireRole(role) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role !== role) {
        return res.status(403).json({
          error: `This action requires ${role} access.`,
          code: 'INSUFFICIENT_ROLE'
        });
      }
      next();
    });
  };
}

// ============================================================================
// HELPER — logAction
// Audit trail wrapper. Always call after requireAuth.
// req.user is guaranteed to exist at this point.
// ============================================================================

function logAction(req, action, entityType, entityId, detail) {
  if (!req.user) return;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket?.remoteAddress
           || null;
  db.logActivity(
    req.user.user_id,
    action,
    entityType            || null,
    entityId ? parseInt(entityId) : null,
    detail                || null,
    ip
  );
}

module.exports = { requireAuth, requireAdmin, requireRole, logAction };
