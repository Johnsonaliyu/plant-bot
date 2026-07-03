const axios = require('axios');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YARNGPT_API_KEY = process.env.YARNGPT_API_KEY;
const YARNGPT_VOICE = process.env.YARNGPT_VOICE || 'Idera';

/**
 * Converts an MP3 Buffer to OGG/Opus using ffmpeg.
 * WhatsApp PTT voice notes require ogg/opus to play correctly.
 */
function mp3ToOggOpus(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const tmpIn  = path.join(os.tmpdir(), `tts_in_${Date.now()}.mp3`);
    const tmpOut = path.join(os.tmpdir(), `tts_out_${Date.now()}.ogg`);

    fs.writeFileSync(tmpIn, mp3Buffer);

    execFile(
      'ffmpeg',
      ['-y', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '64k', tmpOut],
      (err) => {
        // Clean up input file regardless
        try { fs.unlinkSync(tmpIn); } catch (_) {}

        if (err) {
          try { fs.unlinkSync(tmpOut); } catch (_) {}
          return reject(new Error(`ffmpeg conversion failed: ${err.message}`));
        }

        const buf = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch (_) {}
        resolve(buf);
      }
    );
  });
}

/**
 * Converts text to an OGG/Opus audio Buffer ready for WhatsApp PTT.
 * Fetches MP3 from YarnGPT then re-encodes with ffmpeg.
 * Throws if the API key is missing or any step fails.
 */
async function textToSpeech(text) {
  if (!YARNGPT_API_KEY) throw new Error('YARNGPT_API_KEY not set');

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

  const mp3 = Buffer.from(response.data);
  return mp3ToOggOpus(mp3);
}

module.exports = { textToSpeech };
