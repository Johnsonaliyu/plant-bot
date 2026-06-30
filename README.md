# WhatsApp Plant ID Bot

Send a photo of a plant on WhatsApp, get its name (via PlantNet) plus a rich AI-written description (via Groq, with Nvidia NIM as fallback).

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Get API keys:
   - PlantNet (free): https://my.plantnet.org/
   - Groq (free): https://console.groq.com/keys
   - Nvidia NIM (free): https://build.nvidia.com/

3. Copy `.env.example` to `.env` and fill in your keys, plus your WhatsApp number:
   ```
   cp .env.example .env
   ```
   `WHATSAPP_PHONE_NUMBER` should be in international format, digits only, no `+` (e.g. `2348012345678`). If you leave it blank, the bot will prompt you for it in the terminal on first run.

4. Run the bot:
   ```
   npm start
   ```

5. **Pairing code login** (no QR scan needed): the terminal will print an 8-character pairing code after a few seconds. On your phone, open WhatsApp > Settings > Linked Devices > Link a Device > "Link with phone number instead", and enter the code shown.

6. Send a plant photo to that WhatsApp number from any chat. The bot replies in two messages:
   - Identification (name, scientific name, family, confidence, alternates) from PlantNet
   - A short AI-written description (overview, habitat, uses, care tip) from Groq, falling back to Nvidia NIM if Groq is unavailable

## How the AI fallback works

`ai.js` tries Groq first using `GROQ_MODEL` (default `llama-3.3-70b-versatile`). If that call fails or `GROQ_API_KEY` isn't set, it automatically tries Nvidia NIM using `NVIDIA_MODEL` (default `meta/llama-3.1-70b-instruct`). If both fail, the bot still sends the PlantNet identification and just lets the user know the extra description isn't available right now — it never blocks the core identification on the AI step.

## Notes

- Auth session is saved in `auth_info/` so you don't need to re-pair every restart. Don't commit this folder — it holds your WhatsApp session credentials (already in `.gitignore`).
- `organs: 'auto'` lets PlantNet figure out if it's a leaf, flower, fruit, or bark. For better accuracy, you can hardcode `'flower'` or `'leaf'` if you know users will mostly photograph one part.
- PlantNet's free tier has a daily request quota (500/day at last check) — fine for testing, check their pricing page if you expect heavier traffic.
- To deploy long-term (so it doesn't depend on your phone/laptop staying on), this runs well on Railway, same as your other Baileys bots.
- Swap models any time by changing `GROQ_MODEL` / `NVIDIA_MODEL` in `.env` — no code changes needed.

