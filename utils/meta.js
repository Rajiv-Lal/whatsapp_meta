'use strict';
/**
 * Anugnya WhatsApp Sender — Meta Cloud API Utility v1.3
 * Fix log v1.3:
 *   1. video.id cast to integer — Meta schema requires integer not string
 */
const db = require('../database/db');

const PHONE_NUMBER_ID        = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN           = process.env.ACCESS_TOKEN;
const TEMPLATE_NAME          = process.env.TEMPLATE_NAME || 'introducing_anugnya_holisitic_care';
const TEMPLATE_HEADER_MEDIA_ID = process.env.TEMPLATE_HEADER_MEDIA_ID || null;

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
  const components = [];
  if (TEMPLATE_HEADER_MEDIA_ID) {
    components.push({
      type: 'header',
      parameters: [{ type: 'video', video: { id: TEMPLATE_HEADER_MEDIA_ID } }]
    });
  }
  components.push({ type: 'body', parameters: [{ type: 'text', text: firstName || 'Friend' }] });
  const payload = {
    messaging_product: 'whatsapp', to: phone, type: 'template',
    template: { name: TEMPLATE_NAME, language: { code: 'en' }, components }
  };
  const data = await makeMetaRequest(payload, { type: 'send_template', phone, campaign_id: campaignId || null, contact_id: contactId || null });
  return data?.messages?.[0]?.id || null;
}

async function sendFreeTextMessage(phone, text, contactId) {
  if (!text || !String(text).trim()) throw new Error('Message text cannot be empty.');
  const payload = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: String(text).trim() } };
  const data = await makeMetaRequest(payload, { type: 'send_reply', phone, campaign_id: null, contact_id: contactId || null });
  return data?.messages?.[0]?.id || null;
}

module.exports = { sendTemplateMessage, sendFreeTextMessage };
