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

  try {
    const result = await callGroq(messages);
    if (result) return { text: result, source: 'Groq' };
  } catch (err) {
    console.error('Groq description failed:', err.response?.data?.error?.message || err.message);
  }

  try {
    const result = await callNvidia(messages);
    if (result) return { text: result, source: 'Nvidia NIM' };
  } catch (err) {
    console.error('Nvidia description failed:', err.response?.data?.error?.message || err.message);
  }

  return null;
}

module.exports = { generateDescription };
