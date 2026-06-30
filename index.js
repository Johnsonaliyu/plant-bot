require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const FormData = require('form-data');
const readline = require('readline');
const { generateDescription } = require('./ai');

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
  // "organs" tells PlantNet what part of the plant is in the photo.
  // "auto" lets PlantNet figure it out; you can also hint with 'leaf', 'flower', 'fruit', 'bark'.
  form.append('images', imageBuffer, { filename: 'plant.jpg', contentType: 'image/jpeg' });
  form.append('organs', 'auto');

  const url = `https://my-api.plantnet.org/v2/identify/${PLANTNET_PROJECT}?api-key=${PLANTNET_API_KEY}&include-related-images=false&no-reject=false`;

  const { data } = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 20000,
  });

  if (!data.results || data.results.length === 0) {
    return null;
  }

  // Take the top 3 candidate matches
  return data.results.slice(0, 3).map((r) => ({
    score: (r.score * 100).toFixed(1),
    scientificName: r.species.scientificNameWithoutAuthor,
    commonNames: r.species.commonNames || [],
    family: r.species.family?.scientificNameWithoutAuthor,
    genus: r.species.genus?.scientificNameWithoutAuthor,
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

// ---------- WhatsApp bot ----------
let isRestarting = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Plant ID Bot', 'Chrome', '1.0.0'],
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
            text: '🔍 Identifying your plant, one moment...',
          });

          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          const matches = await identifyPlant(buffer);

          if (!matches) {
            await sock.sendMessage(remoteJid, { text: NOT_FOUND_MESSAGE });
            continue;
          }

          const top = matches[0];

          // Send identification result immediately
          await sock.sendMessage(remoteJid, {
            text: formatHeader(top) + formatAlternates(matches),
          });

          // Then generate and send a richer AI description (Groq -> Nvidia fallback)
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

        if (text) {
          await sock.sendMessage(remoteJid, {
            text:
              '🌱 Hi! Send me a clear photo of a plant (leaf, flower, or fruit) ' +
              'and I will identify it and tell you about it.',
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
