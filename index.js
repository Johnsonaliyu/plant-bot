require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const FormData = require('form-data');
const readline = require('readline');
const { generateDescription, answerQuestion } = require('./ai');

const PLANTNET_API_KEY = process.env.PLANTNET_API_KEY;
const PLANTNET_PROJECT = process.env.PLANTNET_PROJECT || 'all';
const WHATSAPP_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER;

if (!PLANTNET_API_KEY) {
  console.error('Missing PLANTNET_API_KEY in .env — get one free at https://my.plantnet.org/');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

// ---------- PlantNet identification ----------
async function identifyPlant(imageBuffer) {
  const form = new FormData();
  form.append('images', imageBuffer, { filename: 'plant.jpg', contentType: 'image/jpeg' });
  form.append('organs', 'auto');

  const url = `https://my-api.plantnet.org/v2/identify/${PLANTNET_PROJECT}?api-key=${PLANTNET_API_KEY}&include-related-images=false&no-reject=false`;

  const { data } = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 20000,
  });

  if (!data.results || data.results.length === 0) return null;

  return data.results.slice(0, 3).map((r) => ({
    score: (r.score * 100).toFixed(1),
    scientificName: r.species.scientificNameWithoutAuthor,
    commonNames: r.species.commonNames || [],
    family: r.species.family?.scientificNameWithoutAuthor,
    genus: r.species.genus?.scientificNameWithoutAuthor,
  }));
}

// ---------- PlantNet disease identification ----------
async function identifyDisease(imageBuffer) {
  const form = new FormData();
  form.append('images', imageBuffer, { filename: 'plant.jpg', contentType: 'image/jpeg' });

  const url = `https://my-api.plantnet.org/v2/diseases/identify?api-key=${PLANTNET_API_KEY}&include-related-images=false&no-reject=true&nb-results=3`;

  const { data } = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 20000,
  });

  if (!data.results || data.results.length === 0) return null;

  return data.results.map((r) => ({
    score: (r.score * 100).toFixed(1),
    name: r.name,
    description: r.description || null,
  }));
}

// ---------- Format reply text ----------
function formatHeader(top) {
  const commonName = top.commonNames[0] || 'No common name found';
  let reply = `🌿 *Plant identified!*\n\n`;
  reply += `*Name:* ${commonName}\n`;
  reply += `*Scientific name:* _${top.scientificName}_\n`;
  if (top.family) reply += `*Family:* ${top.family}\n`;
  reply += `*Confidence:* ${top.score}%\n`;

  if (top.commonNames.length > 1) {
    reply += `*Also known as:* ${top.commonNames.slice(1, 4).join(', ')}\n`;
  }
  return reply;
}

function formatAlternates(matches) {
  if (matches.length <= 1) return '';
  let reply = `\n_Other possible matches:_\n`;
  matches.slice(1).forEach((m) => {
    reply += `• ${m.commonNames[0] || m.scientificName} (${m.score}%)\n`;
  });
  return reply;
}

const NOT_FOUND_MESSAGE =
  "I couldn't confidently identify this plant. 🌱\n\n" +
  'Tips for a better shot:\n' +
  '• Get close to a single leaf or flower\n' +
  '• Use good natural light\n' +
  '• Avoid blurry or shadowed photos\n\n' +
  'Try sending another photo!';

// ---------- Format disease results ----------
function formatDiseaseResult(diseases) {
  if (!diseases || diseases.length === 0) return null;

  const top = diseases[0];
  if (parseFloat(top.score) < 20) return null; // skip if confidence too low

  let reply = `\n🦠 *Disease Check:*\n`;
  reply += `*Most likely:* ${top.description || top.name} _(${top.score}% confidence)_\n`;

  if (diseases.length > 1) {
    reply += `\n_Other possible conditions:_\n`;
    diseases.slice(1).forEach((d) => {
      reply += `• ${d.description || d.name} (${d.score}%)\n`;
    });
  }

  return reply;
}

// ---------- WhatsApp bot ----------
let isRestarting = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
  });

  // ---- Pairing code login (instead of QR) ----
  let pairingRequested = false;
  if (!sock.authState.creds.registered) {
    let phoneNumber = WHATSAPP_PHONE_NUMBER;
    if (!phoneNumber) {
      phoneNumber = await ask(
        'Enter your WhatsApp number with country code, digits only (e.g. 2348012345678): '
      );
    }
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.length < 7) {
      console.error('Phone number looks invalid. Please restart and enter a valid number.');
      process.exit(1);
    }

    // Request pairing code after the WebSocket connection is established
    setTimeout(async () => {
      if (pairingRequested) return;
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n==============================');
        console.log(`Your WhatsApp pairing code: ${code}`);
        console.log('Open WhatsApp > Linked Devices > Link a Device > Link with phone number instead');
        console.log('Enter this code there.');
        console.log('==============================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err.message);
      }
    }, 5000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out.');
      if (shouldReconnect && !isRestarting) {
        isRestarting = true;
        startBot().finally(() => { isRestarting = false; });
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp bot connected and ready.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];

        const isImage =
          messageType === 'imageMessage' ||
          (messageType === 'viewOnceMessageV2' &&
            msg.message.viewOnceMessageV2?.message?.imageMessage);

        if (isImage) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await sock.sendMessage(remoteJid, {
            text: '🔍 Scanning your plant, one moment...',
          });

          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });

          // Run plant ID and disease check in parallel
          const [matches, diseases] = await Promise.allSettled([
            identifyPlant(buffer),
            identifyDisease(buffer),
          ]);

          const plantMatches = matches.status === 'fulfilled' ? matches.value : null;
          const diseaseMatches = diseases.status === 'fulfilled' ? diseases.value : null;

          if (!plantMatches) {
            await sock.sendMessage(remoteJid, { text: NOT_FOUND_MESSAGE });
            continue;
          }

          const top = plantMatches[0];

          // Send plant identification result
          let plantMsg = formatHeader(top) + formatAlternates(plantMatches);

          // Append disease results if found
          const diseaseText = formatDiseaseResult(diseaseMatches);
          if (diseaseText) plantMsg += diseaseText;

          await sock.sendMessage(remoteJid, { text: plantMsg });

          // Then generate and send AI description
          await sock.sendPresenceUpdate('composing', remoteJid);
          const description = await generateDescription({
            scientificName: top.scientificName,
            commonName: top.commonNames[0],
            family: top.family,
            genus: top.genus,
          });

          if (description) {
            await sock.sendMessage(remoteJid, {
              text: `📖 *About this plant:*\n\n${description.text}`,
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: "Couldn't fetch extra details right now, but the identification above is solid. Try again later for the full description.",
            });
          }
          continue;
        }

        const text =
          msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) continue;

        const isGreeting = /^(hi+|hello+|hey+|howdy|good\s*(morning|afternoon|evening|day|night)|what'?s up|sup|greetings|yo|hiya|helo|hy|hei|hai)\b/i.test(text.trim());

        if (isGreeting) {
          const name = msg.pushName ? msg.pushName.split(' ')[0] : 'there';
          const intro =
            `🌿 Good day, *${name}!*\n\n` +
            `I'm *Flora Scan*, built by *Aliu Johnson Temitope*, a fellow of the *3MTT Airtel NextGen Program* (Fellow ID: FE/23/24184818).\n\n` +
            `*Here's what I can do for you:*\n` +
            `📸 *Identify plants* — Send me a clear photo of any plant (leaf, flower, fruit, or bark) and I'll tell you exactly what it is.\n` +
            `📖 *Plant details* — Get the scientific name, common names, family, and confidence score.\n` +
            `🦠 *Disease detection* — I'll automatically check your plant photo for signs of disease or infection.\n` +
            `🌱 *Care & uses* — Learn about a plant's habitat, medicinal or culinary uses, and care tips.\n` +
            `💬 *Plant Q&A* — Ask me any question about plants, gardening, or plant care and I'll answer accurately.\n\n` +
            `_Just send a plant photo or type your plant question to get started!_ 🌻`;

          await sock.sendMessage(remoteJid, { text: intro });
          continue;
        }

        // Answer plant questions or decline off-topic ones
        await sock.sendPresenceUpdate('composing', remoteJid);
        const answer = await answerQuestion(text);
        if (answer) {
          await sock.sendMessage(remoteJid, { text: answer });
        } else {
          await sock.sendMessage(remoteJid, {
            text: "I'm only able to help with plant-related questions. 🌿 Send me a plant photo to identify it, or ask me anything about plants, gardening, or plant care!",
          });
        }
      } catch (err) {
        console.error('Error handling message:', err.message);
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: '⚠️ Something went wrong identifying that plant. Please try again with a clearer photo.',
          });
        } catch (sendErr) {
          console.error('Failed to send error reply:', sendErr.message);
        }
      }
    }
  });
}

startBot().catch((err) => {
  console.error('Failed to start bot:', err);
});
