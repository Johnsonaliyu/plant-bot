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
const { generateDescription, answerQuestion, generateDiseaseReport, transcribeAudio } = require('./ai');
const { textToSpeech } = require('./tts');

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

  const url = `https://my-api.plantnet.org/v2/diseases/identify?api-key=${PLANTNET_API_KEY}&include-related-images=false&no-reject=true&nb-results=5`;

  try {
    const { data } = await axios.post(url, form, {
      headers: form.getHeaders(),
      timeout: 20000,
    });

    console.log('Disease API raw results:', JSON.stringify(data.results?.slice(0, 3)));

    if (!data.results || data.results.length === 0) return null;

    return data.results.map((r) => ({
      score: (r.score * 100).toFixed(1),
      name: r.name,
      description: r.description || null,
    }));
  } catch (err) {
    console.error('Disease API error:', err.response?.status, err.response?.data || err.message);
    return null;
  }
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
  if (parseFloat(top.score) < 5) return null; // skip only if extremely low confidence

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

// ---------- Conversation memory ----------
// Stores per-user context: last identified plant + recent message history
const MAX_HISTORY = 10; // max messages kept (5 exchanges)
const MEMORY_TTL_MS = 30 * 60 * 1000; // forget after 30 min of inactivity

const userMemory = new Map(); // remoteJid -> { lastPlant, messages, updatedAt }

function getMemory(jid) {
  const entry = userMemory.get(jid);
  if (!entry) return { lastPlant: null, messages: [] };
  // Expire stale entries
  if (Date.now() - entry.updatedAt > MEMORY_TTL_MS) {
    userMemory.delete(jid);
    return { lastPlant: null, messages: [] };
  }
  return entry;
}

function setMemory(jid, patch) {
  const current = getMemory(jid);
  userMemory.set(jid, { ...current, ...patch, updatedAt: Date.now() });
}

function pushMessage(jid, role, content) {
  const mem = getMemory(jid);
  const messages = [...mem.messages, { role, content }].slice(-MAX_HISTORY);
  setMemory(jid, { messages });
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

        const isVoiceNote =
          messageType === 'audioMessage' &&
          msg.message.audioMessage?.ptt === true;

        if (isImage) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await sock.sendMessage(remoteJid, {
            text: '🔍 Scanning your plant, one moment...',
          });

          const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });

          // Check if the user asked about disease in their caption
          const caption =
            msg.message.imageMessage?.caption ||
            msg.message.viewOnceMessageV2?.message?.imageMessage?.caption || '';
          const isDiseaseQuery = /disease|condition|sick|infection|infected|pest|blight|rot|wilt|spot|mold|mould|fungus|fungi|affect/i.test(caption);

          if (isDiseaseQuery) {
            // Run plant ID and disease detection in parallel
            const [plantResult, diseaseResult] = await Promise.allSettled([
              identifyPlant(buffer),
              identifyDisease(buffer),
            ]);

            const plantMatches = plantResult.status === 'fulfilled' ? plantResult.value : null;
            const diseases = diseaseResult.status === 'fulfilled' ? diseaseResult.value : null;

            const plantInfo = plantMatches?.[0]
              ? {
                  scientificName: plantMatches[0].scientificName,
                  commonName: plantMatches[0].commonNames[0] || null,
                  family: plantMatches[0].family,
                }
              : null;

            // If plant was identified, show its name first
            if (plantInfo) {
              await sock.sendMessage(remoteJid, {
                text:
                  `🌿 *Plant identified:* ${plantInfo.commonName || plantInfo.scientificName}` +
                  ` (_${plantInfo.scientificName}_)\n` +
                  `*Confidence:* ${plantMatches[0].score}%\n\n` +
                  `🔬 Running disease analysis...`,
              });
            }

            await sock.sendPresenceUpdate('composing', remoteJid);

            if (!diseases || diseases.length === 0 || parseFloat(diseases[0].score) < 5) {
              await sock.sendMessage(remoteJid, {
                text: '✅ No significant disease or condition was detected on this plant. It appears healthy! For best results, send a close-up photo of the affected leaf, stem, or fruit.',
              });
              continue;
            }

            // Generate detailed AI disease report
            const report = await generateDiseaseReport({ diseases, plantInfo });

            if (report) {
              await sock.sendMessage(remoteJid, { text: report });
            } else {
              // Fallback to basic formatted result
              const diseaseText = formatDiseaseResult(diseases);
              await sock.sendMessage(remoteJid, {
                text: diseaseText
                  ? `🦠 *Disease Scan Result:*\n${diseaseText}`
                  : '⚠️ Disease scan completed but detailed analysis is unavailable right now. Please try again.',
              });
            }
            continue;
          }

          // Standard plant identification
          const plantMatches = await identifyPlant(buffer);

          if (!plantMatches) {
            await sock.sendMessage(remoteJid, { text: NOT_FOUND_MESSAGE });
            continue;
          }

          const top = plantMatches[0];
          const idText = formatHeader(top) + formatAlternates(plantMatches);

          await sock.sendMessage(remoteJid, { text: idText });

          // Then generate and send AI description
          await sock.sendPresenceUpdate('composing', remoteJid);
          const description = await generateDescription({
            scientificName: top.scientificName,
            commonName: top.commonNames[0],
            family: top.family,
            genus: top.genus,
          });

          const descText = description
            ? `📖 *About this plant:*\n\n${description.text}`
            : "Couldn't fetch extra details right now, but the identification above is solid. Try again later for the full description.";

          await sock.sendMessage(remoteJid, { text: descText });

          // Save identified plant + bot reply into memory
          setMemory(remoteJid, {
            lastPlant: {
              scientificName: top.scientificName,
              commonName: top.commonNames[0] || null,
              family: top.family,
            },
          });
          pushMessage(remoteJid, 'assistant', `${idText}\n\n${descText}`);
          continue;
        }

        if (isVoiceNote) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await sock.sendMessage(remoteJid, { text: '🎙️ Got your voice note, give me a moment...' });

          const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
            logger,
            reuploadRequest: sock.updateMediaMessage,
          });
          const mimeType = msg.message.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

          // Transcribe voice note
          const transcript = await transcribeAudio(audioBuffer, mimeType);
          if (!transcript) {
            await sock.sendMessage(remoteJid, {
              text: "Sorry, I couldn't make out that voice note. Please try again or type your question.",
            });
            continue;
          }

          // Answer with conversation memory
          const mem = getMemory(remoteJid);
          let questionWithContext = transcript;
          if (mem.lastPlant) {
            const { commonName, scientificName } = mem.lastPlant;
            questionWithContext =
              `[Context: the user previously identified a ${commonName || scientificName} (${scientificName})]\n` +
              transcript;
          }

          const answer = await answerQuestion(questionWithContext, mem.messages);
          const replyText = answer ||
            "I'm only able to help with plant-related questions. Send me a plant photo to identify it, or ask me anything about plants, gardening, or plant care!";

          // Reply as a voice note; fall back to text if TTS fails
          try {
            await sock.sendPresenceUpdate('recording', remoteJid);
            const audioReply = await textToSpeech(replyText);
            await sock.sendMessage(remoteJid, {
              audio: audioReply,
              mimetype: 'audio/ogg; codecs=opus',
              ptt: true,
            });
          } catch (ttsErr) {
            console.error('TTS failed, falling back to text:', ttsErr.message);
            await sock.sendMessage(remoteJid, { text: replyText });
          }

          // Store exchange in memory
          pushMessage(remoteJid, 'user', transcript);
          pushMessage(remoteJid, 'assistant', replyText);
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
            `I'm *Flora Scan*, your smart plant assistant built by *Aliu Johnson Temitope*, a fellow of the *3MTT Airtel NextGen Program* (Fellow ID: FE/23/24184818).\n\n` +
            `*Here's what I can do for you:*\n` +
            `📸 *Identify plants* — Send me a clear photo of any plant (leaf, flower, fruit, or bark) and I'll tell you exactly what it is.\n` +
            `📖 *Plant details* — Get the scientific name, common names, family, and confidence score.\n` +
            `🦠 *Disease detection* — I'll automatically check your plant photo for signs of disease or infection.\n` +
            `🌱 *Care & uses* — Learn about a plant's habitat, medicinal or culinary uses, and care tips.\n` +
            `💬 *Plant Q&A* — Ask me any question about plants, gardening, or plant care and I'll answer accurately.\n` +
            `🎙️ *Voice notes* — Send me a voice note and I'll reply with a voice note too!\n\n` +
            `_Just send a plant photo, voice note, or type your plant question to get started!_ 🌻`;

          await sock.sendMessage(remoteJid, { text: intro });
          continue;
        }

        // Answer plant questions with conversation history for context
        await sock.sendPresenceUpdate('composing', remoteJid);
        const mem = getMemory(remoteJid);

        // Build a context note if we know the last plant
        let questionWithContext = text;
        if (mem.lastPlant) {
          const { commonName, scientificName } = mem.lastPlant;
          questionWithContext =
            `[Context: the user previously identified a ${commonName || scientificName} (${scientificName})]\n` +
            text;
        }

        const answer = await answerQuestion(questionWithContext, mem.messages);
        const replyText = answer ||
          "I'm only able to help with plant-related questions. 🌿 Send me a plant photo to identify it, or ask me anything about plants, gardening, or plant care!";

        await sock.sendMessage(remoteJid, { text: replyText });

        // Store this exchange in memory
        pushMessage(remoteJid, 'user', text);
        pushMessage(remoteJid, 'assistant', replyText);
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
