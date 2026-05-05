# Path B — Pipelined STT → LLM → TTS

You own each stage, so you choose the voice (clone any actress in ElevenLabs),
the model (any LLM via OpenRouter — Gemini 3.1 Pro by default), and the speech
recognizer. Cost per minute is meaningfully lower than Path A; latency is
meaningfully higher.

## Architecture

```
[Browser]                 [server.py]                       [Cloud]
  mic 16kHz PCM ──┐
                  ├─► WebSocket /ws ─┬─► Deepgram (nova-3) ──► transcript
  camera @1fps ───┘                  │
                                     ├─► Gemini 3.1 Pro (OpenRouter) ──► text stream
                                     │   (image attached on visual cues)
                                     │
                                     └─► ElevenLabs Flash v2.5 ─► MP3 stream
  speaker ◄── MP3 chunks ◄──────────────────────────────────────┘
```

Two optimizations that move this from 2s latency to ~800ms:

1. **Deepgram interim + endpointing=300ms** — finalize the transcript fast.
2. **Sentence-flushing to TTS** — start synthesizing the first sentence while
   the LLM is still generating the rest. The user hears the opening syllables
   before the model has finished planning the reply.

Gemini 2.5+ on OpenRouter does implicit prompt caching server-side once the
context is large enough — no `cache_control` hints needed.

## Vision

Sending a JPEG frame on every turn would 3x token cost. We keep the latest
frame in memory and attach it only when the user message contains a visual
trigger word (`look`, `this`, `wearing`, etc. — see `VISUAL_TRIGGER`). For
production, replace the regex with an intent classifier or always-on with
heavy resizing (Gemini accepts images down to ~512px on the long side).

## Run

```bash
cd prototype-path-b
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in all three keys
python server.py
```

Open <http://localhost:8001>.

## Knobs

- `LLM_MODEL` — any model on OpenRouter. `google/gemini-3.1-pro-preview` for
  capability, `google/gemini-3.1-flash-lite-preview` for speed, or anything
  else (Claude, GPT, Llama) by changing the model string.
- `ELEVENLABS_VOICE_ID` — the differentiator. Clone the voice you actually want.
- `ELEVENLABS_MODEL` — `eleven_flash_v2_5` (~75ms TTFB, slightly less expressive)
  vs `eleven_turbo_v2_5` (~250ms, more nuanced). Pick per the moment.
- `endpointing` in Deepgram options — lower = snappier turn-taking but more
  false interruptions on filler pauses.

## Caveats

- Echo cancellation is browser-default. If she hears herself she'll loop.
  Use headphones, or pipe through LiveKit/Daily for proper AEC.
- MP3 chunk decoding via `decodeAudioData` occasionally drops a fragment
  (chunks aren't always self-contained). For production, decode on the
  server with `ffmpeg` and stream PCM, or use ElevenLabs' `pcm_22050` output.
- Barge-in is naive: any new finalized transcript cancels the in-flight reply.
  Tune endpointing + add VAD on the server for fewer false cuts.
