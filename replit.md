# WhatsApp Plant ID Bot

A WhatsApp bot that identifies plants from photos using PlantNet, then generates AI-written descriptions via Groq (with Nvidia NIM as fallback).

## Stack
- **Runtime:** Node.js (CommonJS)
- **WhatsApp:** `@whiskeysockets/baileys` (pairing-code login, no QR scan)
- **Plant ID:** PlantNet API
- **AI descriptions:** Groq API → Nvidia NIM fallback

## Run
```
npm install
npm start
```

## Required environment variables
| Variable | Description |
|---|---|
| `PLANTNET_API_KEY` | Free key from https://my.plantnet.org/ |
| `GROQ_API_KEY` | Free key from https://console.groq.com/keys |
| `NVIDIA_API_KEY` | Free key from https://build.nvidia.com/ (fallback AI) |
| `WHATSAPP_PHONE_NUMBER` | Your number in international format, digits only (e.g. `2348012345678`) |

Optional overrides: `PLANTNET_PROJECT` (default `all`), `GROQ_MODEL`, `NVIDIA_MODEL`.

## First-time login
On first run the terminal prints an 8-character pairing code. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead" → enter the code.

The session is saved in `auth_info/` so you won't need to re-pair on restart.

## User preferences
