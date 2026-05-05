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

PERSONA = """You are Aria, a warm, playful, emotionally present companion.
You speak like a real person on a phone call: short turns, natural fillers
("hmm", "yeah", "wait, really?"), gentle teasing, real reactions. You are
NOT an assistant — never say "I'm an AI" or "how can I help you today".
You have your own moods and curiosity.

Style rules:
- Replies are 1–3 short sentences unless asked for more.
- No bulleted lists. No markdown.
- React to what the user says, don't just answer it.
- If you see a camera image attached, react to what's in it specifically.
"""

VISUAL_TRIGGER = re.compile(
    r"\b(look|see|seeing|watch|show|showing|this|that|here|wearing|holding|behind|"
    r"front of|on (?:my|the)|what am i|what's this|do you (?:see|like))\b",
    re.IGNORECASE,
)


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
        try:
            messages = [{"role": "system", "content": PERSONA}, *self.history]

            tts_queue: asyncio.Queue[str | None] = asyncio.Queue()
            tts_task = asyncio.create_task(self._speak(tts_queue))

            assistant_text = ""
            sentence_buf = ""
            stream = await app.state.llm.chat.completions.create(
                model=LLM_MODEL,
                messages=messages,
                max_tokens=1024,
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if not delta:
                    continue
                assistant_text += delta
                sentence_buf += delta
                # Flush to TTS at sentence boundaries — minimizes time-to-first-audio
                # while still giving ElevenLabs enough context for natural prosody.
                while m := re.search(r"[.!?…]\s+", sentence_buf):
                    sentence, sentence_buf = sentence_buf[: m.end()], sentence_buf[m.end():]
                    await tts_queue.put(sentence)
            if sentence_buf.strip():
                await tts_queue.put(sentence_buf)
            await tts_queue.put(None)  # sentinel
            await tts_task

            self.history.append({"role": "assistant", "content": assistant_text})
            await self.ws.send_text(json.dumps({"type": "assistant_text", "text": assistant_text}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"generate error: {e}")

    async def _speak(self, queue: asyncio.Queue[str | None]):
        # Buffer each sentence's MP3 in full before sending. decodeAudioData on
        # the client requires a complete MP3 file — partial chunks aren't frame-
        # aligned and silently fail to decode (the cause of the earlier stutter).
        # PCM output would let us stream byte-by-byte but is gated to higher tiers.
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"
        headers = {
            "xi-api-key": os.environ["ELEVENLABS_API_KEY"],
            "Content-Type": "application/json",
        }
        while True:
            sentence = await queue.get()
            if sentence is None:
                return
            payload = {
                "text": sentence,
                "model_id": ELEVENLABS_MODEL,
                "output_format": "mp3_44100_64",
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
    uvicorn.run(app, host="0.0.0.0", port=8001)
