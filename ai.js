const axios = require('axios');
const FormData = require('form-data');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-70b-instruct';

const SYSTEM_PROMPT = `You are a knowledgeable botanist writing short, friendly plant profiles for a WhatsApp bot.
Given a plant's scientific name, common name, and family, write a concise description covering:
- A 1-2 sentence overview of what the plant is
- Native region / typical habitat
- Notable uses (medicinal, culinary, ornamental, etc.) if any are well known
- One basic care or growing tip if it's commonly cultivated

Keep it under 120 words total. Do not use markdown headers. Write in plain conversational sentences,
short paragraphs are fine. If you are not confident about a specific fact, omit it rather than guessing.`;

function buildUserPrompt({ scientificName, commonName, family, genus }) {
  return (
    `Plant details:\n` +
    `Scientific name: ${scientificName}\n` +
    `Common name: ${commonName || 'unknown'}\n` +
    `Family: ${family || 'unknown'}\n` +
    `Genus: ${genus || 'unknown'}\n\n` +
    `Write the description now.`
  );
}

async function callGroq(messages) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const { data } = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 300,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  return data.choices?.[0]?.message?.content?.trim();
}

async function callNvidia(messages) {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY not set');

  const { data } = await axios.post(
    'https://integrate.api.nvidia.com/v1/chat/completions',
    {
      model: NVIDIA_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 300,
    },
    {
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    }
  );

  return data.choices?.[0]?.message?.content?.trim();
}

const QUESTION_SYSTEM_PROMPT = `You are a plant expert assistant for a WhatsApp bot called Flora Scan.
Your job is to answer questions about plants only — topics like plant species, care, growth, diseases, soil, watering, pruning, identification, uses, habitats, and gardening.

Rules:
- If the question is about plants or gardening in any way, answer it accurately and helpfully in plain conversational language. Keep responses concise (under 200 words).
- Where relevant, tailor advice to Nigerian farming conditions, climate zones, and locally available inputs — but only where it genuinely applies; do not force "Nigeria" into every sentence.
- If the question is NOT about plants or gardening, respond with exactly this message and nothing else:
  "I'm only able to help with plant-related questions. 🌿 Send me a plant photo to identify it, or ask me anything about plants, gardening, or plant care!"
- Do not use markdown headers. Short paragraphs are fine.`;

const DISEASE_REPORT_SYSTEM_PROMPT = `You are an expert plant pathologist and agricultural extension officer writing reports for Nigerian farmers and gardeners via a WhatsApp bot called Flora Scan.

Given information about a detected plant disease/condition and the plant it affects, write a clear, structured report with the following sections — use the exact bold labels shown:

*🦠 Disease / Condition:* [name and one-sentence explanation of what it is]

*🔍 Possible Causes:* [2–4 bullet points covering pathogens, environmental stress, pests, or cultural factors]

*💊 Treatment Options:* [2–4 bullet points with specific fungicides, pesticides, or biological controls available in Nigeria where possible]

*🛡️ Preventive Measures:* [2–4 bullet points on cultural practices to prevent recurrence]

*🌾 Best Farming Practices:* [2–3 bullet points of good agronomic practices relevant to Nigerian conditions — rainy season timing, crop spacing, soil management, etc.]

Rules:
- Keep each section concise but actionable.
- Mention Nigerian-relevant products, seasons, or practices naturally where they apply — do not force "Nigeria" into every line.
- Preserve accurate plant origin and scientific information; do not falsely localise a plant's native region.
- Do not use markdown headers or horizontal rules — only the bold labels shown above.
- Write in plain, friendly language a smallholder farmer can understand.
- Total response should be under 350 words.`;

async function callAI(messages, maxTokens = 300) {
  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: GROQ_MODEL, messages, temperature: 0.4, max_tokens: maxTokens },
      {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 25000,
      }
    );
    const result = data.choices?.[0]?.message?.content?.trim();
    if (result) return result;
  } catch (err) {
    console.error('Groq failed:', err.response?.data?.error?.message || err.message);
  }

  try {
    const { data } = await axios.post(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      { model: NVIDIA_MODEL, messages, temperature: 0.4, max_tokens: maxTokens },
      {
        headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    const result = data.choices?.[0]?.message?.content?.trim();
    if (result) return result;
  } catch (err) {
    console.error('Nvidia NIM failed:', err.response?.data?.error?.message || err.message);
  }

  return null;
}

/**
 * Generates a natural-language plant description.
 * Tries Groq first, falls back to Nvidia NIM if Groq fails or is unconfigured.
 * Returns null if both fail or neither key is configured, so callers can degrade gracefully.
 */
async function generateDescription(plantInfo) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(plantInfo) },
  ];

  const result = await callAI(messages);
  if (result) return { text: result };
  return null;
}

/**
 * Answers a plant-related question.
 * Politely declines if the question is not about plants.
 * Accepts an optional history array of {role, content} objects for context.
 * Returns null if both AI providers fail.
 */
async function answerQuestion(question, history = []) {
  const messages = [
    { role: 'system', content: QUESTION_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: question },
  ];

  return callAI(messages);
}

/**
 * Generates a detailed disease report with Nigerian farming context.
 * Takes detected disease results and plant info.
 * Returns null if AI providers fail.
 */
async function generateDiseaseReport({ diseases, plantInfo }) {
  const topDisease = diseases?.[0];
  const diseaseName = topDisease?.description || topDisease?.name || 'Unknown condition';
  const plantName = plantInfo?.commonName || plantInfo?.scientificName || 'the plant';
  const scientificName = plantInfo?.scientificName || 'unknown';

  const userPrompt =
    `Plant affected: ${plantName} (${scientificName})\n` +
    `Detected condition: ${diseaseName} (confidence: ${topDisease?.score}%)\n` +
    (diseases?.length > 1
      ? `Other possible conditions: ${diseases.slice(1).map(d => `${d.description || d.name} (${d.score}%)`).join(', ')}\n`
      : '') +
    `\nWrite the full disease report now.`;

  const messages = [
    { role: 'system', content: DISEASE_REPORT_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  return callAI(messages, 600);
}

/**
 * Transcribes a voice note buffer to text using Groq Whisper.
 * mimeType should match the audio format (e.g. 'audio/ogg; codecs=opus').
 * Returns the transcript string, or null if transcription fails.
 */
async function transcribeAudio(audioBuffer, mimeType) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  // Pick a safe file extension so Groq recognises the format
  const ext = mimeType && mimeType.includes('mp4') ? 'm4a'
    : mimeType && mimeType.includes('mp3') ? 'mp3'
    : mimeType && mimeType.includes('webm') ? 'webm'
    : 'ogg'; // WhatsApp PTT is usually ogg/opus

  const form = new FormData();
  form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg' });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'text');

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          ...form.getHeaders(),
        },
        timeout: 30000,
      }
    );
    return typeof data === 'string' ? data.trim() : data?.text?.trim() || null;
  } catch (err) {
    console.error('Whisper transcription failed:', err.response?.data || err.message);
    return null;
  }
}

module.exports = { generateDescription, answerQuestion, generateDiseaseReport, transcribeAudio };
