// WhatsApp Contact Validator — 500 contact batch
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs   = require('fs');
const path = require('path');

const BASE    = path.join(process.env.HOME, 'Desktop/whatsapp-sender');
const MASTER  = path.join(BASE, 'whatsapp_final.json');
const SESSION = path.join(BASE, 'session');
const LOG     = path.join(BASE, 'validation_log.txt');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min=2000, max=4000) { return Math.floor(Math.random()*(max-min))+min; }

function log(msg) {
  const line = `[${new Date().toLocaleString('en-IN')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

async function validate() {
  const data    = JSON.parse(fs.readFileSync(MASTER));
  const pending = data.filter(r => String(r.status||'pending').trim() === 'pending').slice(0, 500);
  log(`📋 Checking first ${pending.length} pending contacts`);
  log(`⏱  Estimated time: ${Math.round(pending.length * 3 / 60)} minutes`);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
  });

  client.on('qr', qr => { console.log('Scan QR in terminal:'); require('qrcode-terminal').generate(qr, {small:true}); });

  client.on('ready', async () => {
    log('✅ WhatsApp connected — starting validation');
    let valid = 0, invalid = 0, errors = 0;

    for (let i = 0; i < pending.length; i++) {
      const contact = pending[i];
      const phone   = String(contact['Phone Number']||'').trim();
      const name    = String(contact.Name||'').trim();

      try {
        const isOn = await client.isRegisteredUser(`${phone}@c.us`);
        if (isOn) {
          valid++;
          if (i % 10 === 0) process.stdout.write(`✅ ${i+1}/${pending.length} valid so far\r`);
        } else {
          const idx = data.findIndex(r => String(r['Phone Number']||'').trim() === phone);
          if (idx !== -1) data[idx].status = 'skip';
          invalid++;
        }
      } catch (e) {
        errors++;
        log(`⚠️ ${name} (${phone}) — ${e.message}`);
      }

      if ((i+1) % 50 === 0) {
        fs.writeFileSync(MASTER, JSON.stringify(data));
        log(`💾 ${i+1}/500 checked — ✅ ${valid} valid, ❌ ${invalid} not on WhatsApp`);
      }

      await sleep(randDelay(2000, 4000));
    }

    fs.writeFileSync(MASTER, JSON.stringify(data));
    log(`\n🎉 Batch complete`);
    log(`   ✅ On WhatsApp:     ${valid} (${Math.round(valid/pending.length*100)}%)`);
    log(`   ❌ Not on WhatsApp: ${invalid} (${Math.round(invalid/pending.length*100)}%)`);
    log(`   ⚠️  Errors:          ${errors}`);

    await client.destroy();
    process.exit(0);
  });

  client.on('auth_failure', () => { log('❌ Auth failed'); process.exit(1); });
  client.initialize();
}

validate().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
