const axios = require('axios');

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
- If the question is NOT about plants or gardening, respond with exactly this message and nothing else:
  "I'm only able to help with plant-related questions. 🌿 Send me a plant photo to identify it, or ask me anything about plants, gardening, or plant care!"
- Do not use markdown headers. Short paragraphs are fine.`;

async function callAI(messages) {
  try {
    const result = await callGroq(messages);
    if (result) return result;
  } catch (err) {
    console.error('Groq failed:', err.response?.data?.error?.message || err.message);
  }

  try {
    const result = await callNvidia(messages);
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
 * Returns null if both AI providers fail.
 */
async function answerQuestion(question) {
  const messages = [
    { role: 'system', content: QUESTION_SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];

  return callAI(messages);
}

module.exports = { generateDescription, answerQuestion };
