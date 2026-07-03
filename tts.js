const axios = require('axios');

const YARNGPT_API_KEY = process.env.YARNGPT_API_KEY;
const YARNGPT_VOICE = process.env.YARNGPT_VOICE || 'Idera';

/**
 * Converts text to an mp3 audio Buffer using YarnGPT TTS.
 * Throws if the API key is missing or the request fails.
 */
async function textToSpeech(text) {
  if (!YARNGPT_API_KEY) throw new Error('YARNGPT_API_KEY not set');

  // API limit is 2000 characters
  const truncated = text.slice(0, 2000);

  const response = await axios.post(
    'https://yarngpt.ai/api/v1/tts',
    { text: truncated, voice: YARNGPT_VOICE, response_format: 'mp3' },
    {
      headers: {
        Authorization: `Bearer ${YARNGPT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );

  return Buffer.from(response.data);
}

module.exports = { textToSpeech };
