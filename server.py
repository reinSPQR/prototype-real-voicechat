"""
Path B — Pipelined STT → LLM → TTS.

Stages, all streaming where possible:
  1. Browser mic (16kHz PCM)         ──►  Deepgram streaming STT       ──►  text
  2. text + last camera frame + history  ──►  Gemini via OpenRouter    ──►  text tokens
  3. text tokens                      ──►  ElevenLabs streaming TTS    ──►  MP3 audio

OpenRouter is OpenAI-compatible, so we use the AsyncOpenAI client with a
custom base_url. Gemini 2.5+ models do implicit prompt caching server-side
once context exceeds a threshold — no cache_control hints needed.

Vision: we keep the latest JPEG frame in memory and attach it to the user
turn only when the user mentions something visual ("look", "see", "this",
"wearing", "holding", etc.). Sending an image every turn would 3x token cost.
"""
import asyncio
import base64
import json
import os
import re
from contextlib import asynccontextmanager

import httpx
from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveOptions,
    LiveTranscriptionEvents,
)
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI

load_dotenv()

LLM_MODEL = "google/gemini-3.1-pro-preview"  # latest Gemini on OpenRouter; swap to gemini-3.1-flash-lite-preview for lower latency
ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"  # "Sarah" — swap for your cloned voice
ELEVENLABS_MODEL = "eleven_flash_v2_5"  # ~75ms TTFB

# Emotion → ElevenLabs voice_settings.
# stability low + style high = wide expressive swing.
# stability high + style low = flat / controlled delivery.
EMOTION_PRESETS: dict[str, dict] = {
    "excited": {"stability": 0.25, "similarity_boost": 0.75, "style": 0.75, "use_speaker_boost": True},
    "happy":   {"stability": 0.40, "similarity_boost": 0.80, "style": 0.55, "use_speaker_boost": True},
    "sad":     {"stability": 0.70, "similarity_boost": 0.85, "style": 0.30, "use_speaker_boost": False},
    "angry":   {"stability": 0.20, "similarity_boost": 0.70, "style": 0.85, "use_speaker_boost": True},
    "calm":    {"stability": 0.80, "similarity_boost": 0.85, "style": 0.20, "use_speaker_boost": False},
    "whisper": {"stability": 0.65, "similarity_boost": 0.90, "style": 0.40, "use_speaker_boost": False},
    "neutral": {"stability": 0.50, "similarity_boost": 0.80, "style": 0.40, "use_speaker_boost": True},
}
EMOTION_ENUM = list(EMOTION_PRESETS.keys())

# `emotion` is listed FIRST so it streams before the (longer) `text` — the
# JSON streamer can hand the emotion to the avatar + TTS the moment it lands,
# without waiting for the full reply.
LLM_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "chat_reply",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "emotion": {"type": "string", "enum": EMOTION_ENUM},
                "text": {"type": "string"},
            },
            "required": ["emotion", "text"],
            "additionalProperties": False,
        },
    },
}

PERSONA = f"""You are Aria, a warm, playful, emotionally present companion.
You speak like a real person on a phone call: short turns, natural fillers
("hmm", "yeah", "wait, really?"), gentle teasing, real reactions. You are
NOT an assistant — never say "I'm an AI" or "how can I help you today".
You have your own moods and curiosity.

Every reply is a JSON object with EXACTLY these two fields, in this order:
  1. "emotion" — one of {EMOTION_ENUM}: the mood you actually feel while
     answering. Pick this FIRST so it streams before the text.
  2. "text" — the spoken reply (1–3 short sentences, no markdown, no
     bulleted lists, no bracketed stage directions like [laughs] since
     the TTS will read them aloud literally).

Convey emotion through word choice, energy, and rhythm in `text`. React to
what the user says; don't just answer it. If a camera image is attached,
react to what's specifically in it.
"""

VISUAL_TRIGGER = re.compile(
    r"\b(look|see|seeing|watch|show|showing|this|that|here|wearing|holding|behind|"
    r"front of|on (?:my|the)|what am i|what's this|do you (?:see|like))\b",
    re.IGNORECASE,
)

# Patterns + tiny state machine for parsing the streaming JSON reply on the fly.
# We need `emotion` early (before the long `text` field is done) so we can pick
# voice_settings and tell the frontend which expression to wear.
_EMOTION_FIELD_RE = re.compile(r'"emotion"\s*:\s*"([^"\\]+)"')
_TEXT_FIELD_OPEN_RE = re.compile(r'"text"\s*:\s*"')
_JSON_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}


class JSONReplyStreamer:
    """Consume LLM JSON tokens chunk-by-chunk; emit ('emotion', str) once and
    ('text', str) repeatedly as decoded text content arrives."""

    def __init__(self):
        self.buf = ""
        self.emotion: str | None = None
        self.in_text = False
        self.escape = False
        self.done = False

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        events: list[tuple[str, str]] = []
        if self.done:
            return events
        if not self.in_text:
            self.buf += chunk
            if self.emotion is None:
                m = _EMOTION_FIELD_RE.search(self.buf)
                if m:
                    self.emotion = m.group(1).lower()
                    events.append(("emotion", self.emotion))
            m = _TEXT_FIELD_OPEN_RE.search(self.buf)
            if m:
                self.in_text = True
                leftover = self.buf[m.end():]
                self.buf = ""
                events.extend(self._consume_text(leftover))
        else:
            events.extend(self._consume_text(chunk))
        return events

    def _consume_text(self, s: str) -> list[tuple[str, str]]:
        out: list[str] = []
        for ch in s:
            if self.done:
                break
            if self.escape:
                out.append(_JSON_ESCAPES.get(ch, ch))
                self.escape = False
            elif ch == "\\":
                self.escape = True
            elif ch == '"':
                self.done = True
            else:
                out.append(ch)
        return [("text", "".join(out))] if out else []


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.llm = AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=os.environ["OPENROUTER_API_KEY"],
    )
    app.state.deepgram = DeepgramClient(
        os.environ["DEEPGRAM_API_KEY"],
        DeepgramClientOptions(options={"keepalive": "true"}),
    )
    app.state.http = httpx.AsyncClient(timeout=None)
    yield
    await app.state.http.aclose()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/models", StaticFiles(directory="models"), name="models")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


class Session:
    """Per-connection state: rolling chat history + the most recent camera frame."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.history: list[dict] = []
        self.latest_frame_b64: str | None = None
        self.generation_task: asyncio.Task | None = None

    async def on_user_text(self, text: str):
        text = text.strip()
        if not text:
            return
        # If a reply is already streaming, cancel it — user has interrupted.
        if self.generation_task and not self.generation_task.done():
            self.generation_task.cancel()
            await self.ws.send_text(json.dumps({"type": "interrupted"}))

        await self.ws.send_text(json.dumps({"type": "user_transcript", "text": text}))

        attach_image = self.latest_frame_b64 and VISUAL_TRIGGER.search(text)
        if attach_image:
            user_content = [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{self.latest_frame_b64}"}},
                {"type": "text", "text": text},
            ]
        else:
            user_content = text
        self.history.append({"role": "user", "content": user_content})

        self.generation_task = asyncio.create_task(self._generate_and_speak())

    async def _generate_and_speak(self):
        emotion_future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        tts_queue: asyncio.Queue[str | None] = asyncio.Queue()
        tts_task = asyncio.create_task(self._speak(tts_queue, emotion_future))
        try:
            messages = [{"role": "system", "content": PERSONA}, *self.history]

            assistant_text = ""
            sentence_buf = ""
            parser = JSONReplyStreamer()
            stream = await app.state.llm.chat.completions.create(
                model=LLM_MODEL,
                messages=messages,
                max_tokens=1024,
                stream=True,
                response_format=LLM_RESPONSE_FORMAT,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if not delta:
                    continue
                for kind, value in parser.feed(delta):
                    if kind == "emotion":
                        if not emotion_future.done():
                            emotion_future.set_result(value)
                        await self.ws.send_text(json.dumps({"type": "emotion", "emotion": value}))
                    elif kind == "text":
                        assistant_text += value
                        sentence_buf += value
                        # Flush to TTS at sentence boundaries — minimizes time-to-first-audio
                        # while still giving ElevenLabs enough context for natural prosody.
                        while m := re.search(r"[.!?…]\s+", sentence_buf):
                            sentence, sentence_buf = sentence_buf[: m.end()], sentence_buf[m.end():]
                            await tts_queue.put(sentence)
            if not emotion_future.done():
                emotion_future.set_result("neutral")
            if sentence_buf.strip():
                await tts_queue.put(sentence_buf)
            await tts_queue.put(None)  # sentinel
            await tts_task

            self.history.append({"role": "assistant", "content": assistant_text})
            await self.ws.send_text(json.dumps({"type": "assistant_text", "text": assistant_text}))
        except asyncio.CancelledError:
            if not emotion_future.done():
                emotion_future.set_result("neutral")
            tts_task.cancel()
        except Exception as e:
            if not emotion_future.done():
                emotion_future.set_result("neutral")
            tts_task.cancel()
            print(f"generate error: {e}")

    async def _speak(self, queue: asyncio.Queue[str | None], emotion_future: asyncio.Future[str]):
        # Buffer each sentence's MP3 in full before sending. decodeAudioData on
        # the client requires a complete MP3 file — partial chunks aren't frame-
        # aligned and silently fail to decode (the cause of the earlier stutter).
        # PCM output would let us stream byte-by-byte but is gated to higher tiers.
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"
        headers = {
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
            "Content-Type": "application/json",
        }
        voice_settings: dict | None = None
        while True:
            sentence = await queue.get()
            if sentence is None:
                return
            if voice_settings is None:
                emotion = await emotion_future
                voice_settings = EMOTION_PRESETS.get(emotion.lower(), EMOTION_PRESETS["neutral"])
            payload = {
                "text": sentence,
                "model_id": ELEVENLABS_MODEL,
                "output_format": "mp3_44100_64",
                "voice_settings": voice_settings,
            }
            async with app.state.http.stream("POST", url, json=payload, headers=headers) as r:
                if r.status_code != 200:
                    body = await r.aread()
                    print(f"elevenlabs error {r.status_code}: {body.decode(errors='replace')[:500]}")
                    continue
                buf = bytearray()
                async for chunk in r.aiter_bytes():
                    buf.extend(chunk)
            await self.ws.send_text(json.dumps({
                "type": "audio_mp3",
                "data": base64.b64encode(buf).decode(),
            }))


@app.websocket("/ws")
async def ws(client_ws: WebSocket):
    await client_ws.accept()
    session = Session(client_ws)

    # Set up Deepgram streaming connection.
    dg = app.state.deepgram.listen.asynclive.v("1")
    loop = asyncio.get_running_loop()

    async def on_transcript(_, result, **__):
        if not result.is_final:
            return
        text = result.channel.alternatives[0].transcript
        if text:
            asyncio.run_coroutine_threadsafe(session.on_user_text(text), loop)

    dg.on(LiveTranscriptionEvents.Transcript, on_transcript)

    await dg.start(LiveOptions(
        model="nova-3",
        language="en-US",
        encoding="linear16",
        sample_rate=16000,
        channels=1,
        smart_format=True,
        interim_results=True,
        endpointing=300,  # ms of silence before finalizing — tune for your latency budget
        vad_events=True,
    ))

    try:
        while True:
            msg = await client_ws.receive_text()
            data = json.loads(msg)
            if data["type"] == "audio":
                await dg.send(base64.b64decode(data["data"]))
            elif data["type"] == "video":
                session.latest_frame_b64 = data["data"]
    except WebSocketDisconnect:
        pass
    finally:
        await dg.finish()
        if session.generation_task:
            session.generation_task.cancel()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=9091)
