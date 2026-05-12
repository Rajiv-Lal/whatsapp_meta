'use strict';
/**
 * Anugnya WhatsApp Sender — Meta Cloud API Utility v1.1
 * utils/meta.js
 *
 * Shared Meta API functions used by:
 *   routes/send.js    — sendTemplateMessage()
 *   routes/replies.js — sendFreeTextMessage()
 *
 * IMPORTANT: server.js must call require('dotenv').config() BEFORE
 * requiring this module — env vars are read at module load time.
 *
 * Exports:
 *   sendTemplateMessage(phone, firstName, campaignId, contactId)
 *   sendFreeTextMessage(phone, text, contactId)
 *
 * Fix log v1.1:
 *   1. META_BASE_URL moved inside makeMetaRequest — avoids undefined in URL
 *   2. replyId removed from sendFreeTextMessage — was unused
 */

const db = require('../database/db');

// ============================================================================
// MODULE-LEVEL CONFIG
// Read once at module load. server.js must load dotenv before requiring this.
// URL is built inside makeMetaRequest after the null guard fires.
// ============================================================================

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const TEMPLATE_NAME   = process.env.TEMPLATE_NAME || 'introducing_anugnya';

// ============================================================================
// CORE — makeMetaRequest
// Shared HTTP call to Meta Cloud API.
// Validates credentials, handles JSON parse safety, logs every call.
// Returns parsed response data on success.
// Throws descriptive error on failure.
// ============================================================================

async function makeMetaRequest(payload, logData) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error('PHONE_NUMBER_ID or ACCESS_TOKEN not configured. Check .env file.');
  }

  // URL built here — after guard — so PHONE_NUMBER_ID is confirmed not null
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(payload)
  });

  // Safely parse JSON — Meta can return HTML on gateway errors
  let data = null;
  try { data = await res.json(); } catch {}

  // Always log regardless of outcome
  db.logMeta({
    direction:   'outbound',
    type:        logData.type,
    phone:       logData.phone       || null,
    campaign_id: logData.campaign_id || null,
    contact_id:  logData.contact_id  || null,
    payload,
    response:    data,
    status_code: res.status,
    success:     res.ok,
    error:       res.ok ? null : (data?.error?.message || `HTTP ${res.status}`)
  });

  if (!res.ok) {
    throw new Error(data?.error?.message || `Meta API error ${res.status}`);
  }

  return data;
}

// ============================================================================
// sendTemplateMessage
// Sends the approved WhatsApp template to a contact.
// Used by the send engine for outbound campaign messages.
//
// NOTE: Components hardcoded for one body variable ({{1}} = firstName).
// If TEMPLATE_NAME changes to a different variable count, update this function
// to build components dynamically from template.variable_map in the DB.
//
// Returns: Meta message ID string, or null.
// Throws:  Error with descriptive message on failure.
// ============================================================================

async function sendTemplateMessage(phone, firstName, campaignId, contactId) {
  const payload = {
    messaging_product: 'whatsapp',
    to:   phone,
    type: 'template',
    template: {
      name:     TEMPLATE_NAME,
      language: { code: 'en' },
      components: [{
        type:       'body',
        parameters: [{ type: 'text', text: firstName || 'Friend' }]
      }]
    }
  };

  const data = await makeMetaRequest(payload, {
    type:        'send_template',
    phone,
    campaign_id: campaignId || null,
    contact_id:  contactId  || null
  });

  return data?.messages?.[0]?.id || null;
}

// ============================================================================
// sendFreeTextMessage
// Sends a free text reply within the 24-hour customer service window.
// Used by the reply queue when responding to an inbound message.
// Only valid within 24 hours of the contact's last inbound message.
//
// Returns: Meta message ID string, or null.
// Throws:  Error with descriptive message on failure.
// ============================================================================

async function sendFreeTextMessage(phone, text, contactId) {
  if (!text || !String(text).trim()) {
    throw new Error('Message text cannot be empty.');
  }

  const payload = {
    messaging_product: 'whatsapp',
    to:   phone,
    type: 'text',
    text: { body: String(text).trim() }
  };

  const data = await makeMetaRequest(payload, {
    type:       'send_reply',
    phone,
    campaign_id: null,
    contact_id:  contactId || null
  });

  return data?.messages?.[0]?.id || null;
}

module.exports = { sendTemplateMessage, sendFreeTextMessage };
