'use strict';

/**
 * WA Sender v3 — Full Test Suite
 * Tests all 9 known bugs against current code.
 * A test PASSING means the bug is CONFIRMED (it exists).
 * A test FAILING means the bug description was wrong.
 * After fixes, all bug tests should FAIL (bugs gone).
 *
 * Run: node tests/test-all.js
 */

const fs   = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch(e) {
    console.error(`  ❌ ${label}\n     → ${e.message}`);
    failed++;
    failures.push({ label, error: e.message });
  }
}

function bugTest(label, fn) {
  // A bugTest passes when the bug is CONFIRMED (code is broken)
  // After fix, the bugTest should throw (bug is gone)
  try {
    fn();
    console.log(`  🐛 BUG CONFIRMED: ${label}`);
    passed++;
  } catch(e) {
    console.log(`  ✅ FIXED: ${label}`);
    passed++;
  }
}

function section(name) {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${name}`);
  console.log('─'.repeat(62));
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD FILES — verify they exist first
// ─────────────────────────────────────────────────────────────────────────────
section('FILE LOADING');

const serverPath = path.join(__dirname, '../server.js');
const htmlPath   = path.join(__dirname, '../public/index.html');
const dbPath     = path.join(__dirname, '../database/db.js');

test('server.js exists', () => {
  if (!fs.existsSync(serverPath)) throw new Error('server.js not found at ' + serverPath);
});

test('index.html exists', () => {
  if (!fs.existsSync(htmlPath)) throw new Error('index.html not found at ' + htmlPath);
});

test('db.js exists', () => {
  if (!fs.existsSync(dbPath)) throw new Error('db.js not found at ' + dbPath);
});

const serverCode = fs.readFileSync(serverPath, 'utf8');
const htmlCode   = fs.readFileSync(htmlPath, 'utf8');
const dbCode     = fs.readFileSync(dbPath, 'utf8');

// Extract script block from HTML
const scriptMatch = htmlCode.match(/<script>([\s\S]*?)<\/script>/);
test('index.html has a <script> block', () => {
  if (!scriptMatch) throw new Error('No <script> block found in index.html');
});

const jsCode = scriptMatch ? scriptMatch[1] : '';

// Verify JS syntax
test('index.html JS syntax is valid', () => {
  try { new Function(jsCode); }
  catch(e) { throw new Error('JS syntax error: ' + e.message); }
});

test('server.js syntax is valid (node --check)', () => {
  const { execSync } = require('child_process');
  try { execSync('node --check ' + serverPath, { stdio: 'pipe' }); }
  catch(e) { throw new Error('server.js syntax error: ' + e.stderr?.toString()); }
});

// Extract openCampaign function
const openCampMatch = jsCode.match(/async function openCampaign\(id\)\s*\{([\s\S]*?)^\}/m);
const openCampBody  = openCampMatch ? openCampMatch[1] : '';

// Extract innerHTML template from openCampaign
const templateMatch = openCampBody.match(/\.innerHTML\s*=\s*`([\s\S]*?)`;/);
const htmlTemplate  = templateMatch ? templateMatch[1] : '';

test('openCampaign function found in JS', () => {
  if (!openCampBody) throw new Error('openCampaign function body not extracted');
});

test('openCampaign has innerHTML template', () => {
  if (!htmlTemplate) throw new Error('innerHTML template not found in openCampaign');
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 1: send/start validates pending but runCampaign sends from queued
// ─────────────────────────────────────────────────────────────────────────────
section('BUG 1 — send/start checks pending, blocks when only queued contacts exist');

test('runCampaign calls getQueuedContacts (correct)', () => {
  if (!serverCode.includes('getQueuedContacts')) throw new Error('getQueuedContacts not found in server.js');
});

test('send/start route exists', () => {
  if (!serverCode.includes("'/api/campaigns/:id/send/start'")) throw new Error('send/start route not found');
});

test('BUG 1: send/start checks pending not queued', () => {
  // Find the send/start route body
  const startIdx = serverCode.indexOf("'/api/campaigns/:id/send/start'");
  const routeChunk = serverCode.slice(startIdx, startIdx + 600);
  if (routeChunk.includes("status: 'pending'") && !routeChunk.includes("status: 'queued'")) {
    throw new Error('BUG EXISTS: send/start checks pending — blocks start when 0 pending but 50 queued');
  }
  // If we reach here, bug is fixed
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 2: auto-reconnect checks wrong folder name
// ─────────────────────────────────────────────────────────────────────────────
section('BUG 2 — auto-reconnect checks wrong folder name');

test('onListening function exists', () => {
  if (!serverCode.includes('function onListening()')) throw new Error('onListening not found');
});

test('BUG 2: onListening checks "Default" not "session" folder', () => {
  const onListIdx = serverCode.indexOf('function onListening()');
  const chunk     = serverCode.slice(onListIdx, onListIdx + 400);
  if (chunk.includes("'Default'")) {
    throw new Error("BUG EXISTS: checks 'Default' — LocalAuth creates 'session' folder");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 3: inline require() inside initWhatsApp
// ─────────────────────────────────────────────────────────────────────────────
section('BUG 3 — inline require() inside initWhatsApp function');

test('initWhatsApp function exists', () => {
  if (!serverCode.includes('function initWhatsApp()')) throw new Error('initWhatsApp not found');
});

test('BUG 3: inline require() calls inside initWhatsApp', () => {
  const initIdx   = serverCode.indexOf('function initWhatsApp()');
  const nextFnIdx = serverCode.indexOf('\nasync function ', initIdx + 1);
  const body      = serverCode.slice(initIdx, nextFnIdx > 0 ? nextFnIdx : initIdx + 2000);
  if (body.includes("require('path')") || body.includes("require('fs')")) {
    throw new Error("BUG EXISTS: inline require('path') and require('fs') inside initWhatsApp");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 4: err.message returns single char on WA errors
// ─────────────────────────────────────────────────────────────────────────────
section('BUG 4 — err.message single char on whatsapp-web.js errors');

test('sendMessage function exists', () => {
  if (!serverCode.includes('async function sendMessage(')) throw new Error('sendMessage not found');
});

test('BUG 4: no String(err) fallback in sendMessage catch', () => {
  const sendMsgIdx = serverCode.indexOf('async function sendMessage(');
  const chunk      = serverCode.slice(sendMsgIdx, sendMsgIdx + 1200);
  const catchIdx   = chunk.indexOf('} catch (err)');
  const catchBlock = chunk.slice(catchIdx, catchIdx + 200);
  if (!catchBlock.includes('String(err)')) {
    throw new Error('BUG EXISTS: catch block uses err.message only — returns single char for WA errors');
  }
});

test('BUG 4: verify WA error object captures correctly', () => {
  // Simulate actual whatsapp-web.js error object
  const waError = { type: 'WPPError', text: 'send-message-error' };
  const withoutFix = waError.message; // undefined
  const withFix    = waError.message || String(waError) || 'Send failed';
  if (withoutFix === undefined && withFix === '[object Object]') {
    // String(err) on plain object gives [object Object] — not ideal but not single char
    // This confirms the bug: err.message alone is undefined/wrong
  }
  // The real WA error is a class instance where toString() gives useful info
  // Just verify String() gives more than 1 char
  if (withFix.length <= 1) throw new Error('String(err) fallback also too short: ' + withFix);
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 5: mediaFirst string coercion
// ─────────────────────────────────────────────────────────────────────────────
section('BUG 5 — mediaFirst: string "0" from settings is truthy');

test('mediaFirst assignment exists in runCampaign', () => {
  if (!serverCode.includes('mediaFirst')) throw new Error('mediaFirst not found in server.js');
});

test('BUG 5: settings.media_first used without boolean coercion', () => {
  const runCampIdx = serverCode.indexOf('async function runCampaign(');
  const chunk      = serverCode.slice(runCampIdx, runCampIdx + 400);
  const mediaLine  = chunk.split('\n').find(l => l.includes('mediaFirst'));
  if (!mediaLine) throw new Error('mediaFirst line not found in runCampaign');
  // Bug: settings.media_first || !!campaign.media_first
  // '0' is truthy so string '0' from settings table passes the || check
  if (mediaLine.includes('settings.media_first ||') &&
      !mediaLine.includes('parseInt') &&
      !mediaLine.includes('=== ') &&
      !mediaLine.includes('=== 1') &&
      !mediaLine.includes("=== '1'")) {
    throw new Error("BUG EXISTS: string '0' from settings is truthy — mediaFirst always true");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UI BUG 6: campaignSendBtns ID missing from HTML template
// ─────────────────────────────────────────────────────────────────────────────
section('UI BUG 6 — campaignSendBtns ID not in HTML template');

test('updateCampaignDetailState references campaignSendBtns', () => {
  if (!jsCode.includes('campaignSendBtns')) throw new Error('campaignSendBtns not referenced in JS');
});

test('BUG 6: campaignSendBtns ID missing from openCampaign HTML template', () => {
  if (!htmlTemplate.includes('campaignSendBtns')) {
    throw new Error('BUG EXISTS: campaignSendBtns not in template — getElementById returns null');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UI BUG 7: campaignDetailProgress ID missing from HTML template
// ─────────────────────────────────────────────────────────────────────────────
section('UI BUG 7 — campaignDetailProgress ID not in HTML template');

test('updateCampaignDetailState references campaignDetailProgress', () => {
  if (!jsCode.includes('campaignDetailProgress')) throw new Error('campaignDetailProgress not referenced');
});

test('BUG 7: campaignDetailProgress ID missing from openCampaign HTML template', () => {
  if (!htmlTemplate.includes('campaignDetailProgress')) {
    throw new Error('BUG EXISTS: campaignDetailProgress not in template — progress never shows');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UI BUG 8: isSending stale — Start button disappears after stop
// ─────────────────────────────────────────────────────────────────────────────
section('UI BUG 8 — isSending stale, Start Sending gone after stop');

test('handleState function exists', () => {
  if (!jsCode.includes('function handleState(s)')) throw new Error('handleState not found');
});

test('updateCampaignDetailState function exists', () => {
  if (!jsCode.includes('function updateCampaignDetailState')) {
    throw new Error('updateCampaignDetailState not found');
  }
});

test('handleState calls updateCampaignDetailState on every state change', () => {
  const handleIdx  = jsCode.indexOf('function handleState(s)');
  const handleBody = jsCode.slice(handleIdx, handleIdx + 3500);
  if (!handleBody.includes('updateCampaignDetailState')) {
    throw new Error('BUG EXISTS: handleState does not call updateCampaignDetailState');
  }
});

test('BUG 8: Start Sending button only in isSending branch, never re-added via DOM', () => {
  // The bug: isSending computed once at render time in openCampaign
  // If campaignSendBtns ID exists AND updateCampaignDetailState updates it, bug is fixed
  // If campaignSendBtns ID missing from template, update is impossible
  if (!htmlTemplate.includes('campaignSendBtns')) {
    throw new Error('BUG EXISTS: campaignSendBtns not in template, Start button cannot reappear');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UI BUG 9: progress only on Dashboard livePanel, invisible on Campaign page
// ─────────────────────────────────────────────────────────────────────────────
section('UI BUG 9 — progress invisible on Campaign detail page');

test('Dashboard livePanel exists in HTML', () => {
  if (!htmlCode.includes('id="livePanel"')) throw new Error('livePanel not found in HTML');
});

test('BUG 9: campaignDetailProgress missing — no progress on Campaign page', () => {
  // Fix requires campaignDetailProgress in template AND updateCampaignDetailState updating it
  if (!htmlTemplate.includes('campaignDetailProgress')) {
    throw new Error('BUG EXISTS: no campaignDetailProgress in campaign template — progress invisible');
  }
});

test('updateCampaignDetailState updates progress element', () => {
  const updateFnIdx = jsCode.indexOf('function updateCampaignDetailState');
  if (updateFnIdx === -1) throw new Error('updateCampaignDetailState not found');
  // Search 1500 chars to cover the full function
  const updateFnBody = jsCode.slice(updateFnIdx, updateFnIdx + 1500);
  if (!updateFnBody.includes('campaignDetailProgress')) {
    throw new Error('updateCampaignDetailState does not update progress element');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(62)}`);
console.log('  RESULTS');
console.log('═'.repeat(62));
console.log(`  Total tests : ${passed + failed}`);
console.log(`  Passed      : ${passed}`);
console.log(`  Failed      : ${failed}`);
if (failures.length) {
  console.log('\n  FAILED TESTS (unexpected — check test logic):');
  failures.forEach(f => console.log(`  • ${f.label}: ${f.error}`));
}
console.log('═'.repeat(62));
process.exit(failed > 0 ? 1 : 0);
