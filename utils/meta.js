'use strict';
/**
 * Anugnya WhatsApp Sender — Meta Cloud API Utility v1.4
 * Fix log v1.4:
 *   1. Header is now driven by the campaign's TEMPLATE record
 *      (templates.header_type + templates.header_value), not env.
 *   2. Media header uses a public URL (link), not a media id —
 *      no 30-day expiry, no re-upload. header_value holds the URL.
 *   3. Header type follows the approved template format (image/video/document),
 *      preventing #132012 format mismatch. text/no-header templates send body only.
 */
const db = require('../database/db');

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.ACCESS_TOKEN;
const TEMPLATE_NAME   = process.env.TEMPLATE_NAME || 'introducing_anugnya_holisitic_care';

// Header formats that carry media via a public URL.
const MEDIA_HEADER_TYPES = ['image', 'video', 'document'];

// Build the Meta header component from a template's header_type + header_value.
// Returns null when the template has no media header (text or none).
function buildHeaderComponent(template) {
  if (!template) return null;
  const type = template.header_type;
  const url  = template.header_value;
  if (!type || !MEDIA_HEADER_TYPES.includes(type) || !url) return null;
  return { type: 'header', parameters: [{ type, [type]: { link: url } }] };
}

async function makeMetaRequest(payload, logData) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error('PHONE_NUMBER_ID or ACCESS_TOKEN not configured.');
  }
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let data = null;
  try { data = await res.json(); } catch {}
  db.logMeta({
    direction: 'outbound', type: logData.type,
    phone: logData.phone || null, campaign_id: logData.campaign_id || null,
    contact_id: logData.contact_id || null,
    payload, response: data, status_code: res.status, success: res.ok,
    error: res.ok ? null : (data?.error?.message || `HTTP ${res.status}`)
  });
  if (!res.ok) throw new Error(data?.error?.message || `Meta API error ${res.status}`);
  return data;
}

async function sendTemplateMessage(phone, firstName, campaignId, contactId) {
  // Resolve the template tied to this campaign. The header (image/video/document)
  // comes from the template record — templates.header_type + templates.header_value.
  let template = null;
  if (campaignId) {
    const campaign = db.getCampaign(campaignId);
    if (campaign && campaign.template_id) {
      template = db.getTemplate(campaign.template_id);
    }
  }

  const templateName = template?.name     || TEMPLATE_NAME;
  const languageCode = template?.language || 'en';

  const components = [];
  const header = buildHeaderComponent(template);
  if (header) components.push(header);
  components.push({ type: 'body', parameters: [{ type: 'text', text: firstName || 'Friend' }] });

  const payload = {
    messaging_product: 'whatsapp',
    to:   phone,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components }
  };
  const data = await makeMetaRequest(payload, {
    type: 'send_template', phone,
    campaign_id: campaignId || null, contact_id: contactId || null
  });
  return data?.messages?.[0]?.id || null;
}

async function sendFreeTextMessage(phone, text, contactId) {
  if (!text || !String(text).trim()) throw new Error('Message text cannot be empty.');
  const payload = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: String(text).trim() } };
  const data = await makeMetaRequest(payload, { type: 'send_reply', phone, campaign_id: null, contact_id: contactId || null });
  return data?.messages?.[0]?.id || null;
}

module.exports = { sendTemplateMessage, sendFreeTextMessage };
