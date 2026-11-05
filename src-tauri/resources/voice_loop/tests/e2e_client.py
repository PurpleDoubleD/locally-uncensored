"""Manual end to end run against a real sidecar, without a microphone.

Plays recorded speech into the sidecar over the same wire the webview uses
(protobuf frames on the WebSocket, RTVI messages inside), answers tool calls
like the app's bridge does, and prints the latency of every stage.

    python tests/e2e_client.py --port 47731 --token-env LU_VOICE_TOKEN \
        --llm-base-url http://127.0.0.1:11434/v1 --llm-model <model> \
        --wav question_with_tool.wav --wav plain_question.wav --barge-in interrupt.wav

Each --wav is one user turn (16 kHz mono PCM16). --barge-in is spoken into the
bot's answer to the last turn. Not collected by pytest.
"""

import argparse
import asyncio
import json
import os
import sys
import time
import wave

import httpx
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wire import RATE, audio_frame, client_ready, parse, tool_result  # noqa: E402

ORIGIN = "tauri://localhost"
CHUNK_SAMPLES = 512  # what the JS recorder sends

SYSTEM_PROMPT = (
    "You are a voice assistant on the user's computer. Your answers are spoken aloud, so reply in "
    "one or two short plain sentences without markdown. You cannot know the time or anything about "
    "the computer by yourself: when a tool can provide a fact, you must call the tool and never guess."
)

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_current_time",
        "description": "Returns the current local time on the user's computer.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}]


def read_wav(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return w.readframes(w.getnframes())


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.t0 = time.monotonic()
        self.events: list[tuple[float, str, dict]] = []
        self.audio_times: list[float] = []
        self.audio_bytes = 0
        self.pending_speech: bytes = b""
        self.speech_end_at: float | None = None
        self.bot_ready = asyncio.Event()
        self.tool_calls = 0
        self.tool_results_seen = 0
        self.stop = False

    def now(self) -> float:
        return time.monotonic() - self.t0

    async def mic(self):
        """Stream audio in real time: queued speech if there is any, else silence."""
        silence = b"\x00" * (CHUNK_SAMPLES * 2)
        step = CHUNK_SAMPLES / RATE
        next_at = time.monotonic()
        while not self.stop:
            if self.pending_speech:
                chunk, self.pending_speech = self.pending_speech[:CHUNK_SAMPLES * 2], self.pending_speech[CHUNK_SAMPLES * 2:]
                if not self.pending_speech:
                    self.speech_end_at = self.now()
                chunk = chunk.ljust(CHUNK_SAMPLES * 2, b"\x00")
            else:
                chunk = silence
            await self.ws.send(audio_frame(chunk))
            next_at += step
            await asyncio.sleep(max(0.0, next_at - time.monotonic()))

    async def receive(self):
        async for raw in self.ws:
            kind, payload = parse(raw)
            if kind == "audio":
                self.audio_times.append(self.now())
                self.audio_bytes += len(payload)
                continue
            if kind != "message":
                self.events.append((self.now(), "frame:" + kind, {}))
                continue
            message = payload
            type_, data = message.get("type"), message.get("data") or {}
            self.events.append((self.now(), type_, data))
            if type_ == "bot-ready":
                self.bot_ready.set()
            elif type_ == "llm-function-call-in-progress":
                # What the app's bridge does: run the tool, send the result.
                self.tool_calls += 1
                await asyncio.sleep(0.05)
                await self.ws.send(tool_result(
                    data, {"status": "completed", "text": "It is 14:32 on Tuesday.", "truncated": False},
                ))
            elif type_ == "llm-function-call-stopped":
                self.tool_results_seen += 1

    def first(self, type_: str, after: float) -> float | None:
        return next((t for t, e, _ in self.events if e == type_ and t >= after), None)

    def first_audio(self, after: float) -> float | None:
        return next((t for t in self.audio_times if t >= after), None)

    async def wait_quiet(self, after: float, timeout: float = 60.0) -> None:
        """Wait until the bot answered and then stopped speaking."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            stopped = [t for t, e, _ in self.events if e == "bot-stopped-speaking" and t >= after]
            if stopped and self.now() - stopped[-1] > 1.5 and self.now() - (self.audio_times[-1] if self.audio_times else 0) > 1.0:
                return
            await asyncio.sleep(0.1)
        raise TimeoutError("the bot did not finish answering")

    async def say(self, pcm: bytes) -> float:
        self.speech_end_at = None
        self.pending_speech = pcm
        while self.speech_end_at is None:
            await asyncio.sleep(0.01)
        return self.speech_end_at


def ms(a: float | None, b: float | None) -> str:
    return "n/a" if a is None or b is None else "%d ms" % round((b - a) * 1000)


def report_turn(c: Client, label: str, end: float) -> dict:
    stopped = c.first("user-stopped-speaking", end - 0.5)
    transcript = c.first("user-transcription", end - 0.5)
    llm_started = c.first("bot-llm-started", end)
    llm_text = c.first("bot-llm-text", end)
    tool = c.first("llm-function-call-in-progress", end)
    tts_started = c.first("bot-tts-started", end)
    audio = c.first_audio(end)
    print("\n== %s" % label)
    print("  end of speech -> turn end detected (VAD + Smart Turn): %s" % ms(end, stopped))
    print("  end of speech -> transcript (STT done):                %s" % ms(end, transcript))
    print("  end of speech -> LLM request started:                  %s" % ms(end, llm_started))
    if tool is not None:
        print("  end of speech -> tool call at client:                  %s" % ms(end, tool))
    print("  end of speech -> first LLM text:                       %s" % ms(end, llm_text))
    print("  end of speech -> TTS started:                          %s" % ms(end, tts_started))
    print("  end of speech -> FIRST AUDIO at client:                %s" % ms(end, audio))
    for t, e, d in c.events:
        if e == "server-message" and d.get("type") == "latency" and t >= end:
            stages = ", ".join("%s %d ms" % (s["key"], round(s["secs"] * 1000)) for s in d["stages"])
            print("  sidecar breakdown (total %d ms): %s" % (round(d["total_secs"] * 1000), stages))
            break
    return {"first_audio_ms": None if audio is None else round((audio - end) * 1000)}


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--token-env", default="LU_VOICE_TOKEN")
    p.add_argument("--llm-base-url", required=True)
    p.add_argument("--llm-model", required=True)
    p.add_argument("--llm-extra", default="{}")
    p.add_argument("--wav", action="append", default=[])
    p.add_argument("--barge-in")
    # Further session fields, e.g. '{"stt": {...}, "tts": {...}}' to hear and
    # speak through LFM3 Audio in Ollama or the LU Engine (N1).
    p.add_argument("--session-extra", default="{}")
    args = p.parse_args()

    base = "http://127.0.0.1:%d" % args.port
    headers = {"Origin": ORIGIN, "Authorization": "Bearer " + os.environ[args.token_env]}
    config = {
        "llm": {"base_url": args.llm_base_url, "model": args.llm_model, "extra": json.loads(args.llm_extra)},
        "system_prompt": SYSTEM_PROMPT,
        "tools": TOOLS,
        **json.loads(args.session_extra),
    }
    async with httpx.AsyncClient() as http:
        for _ in range(600):
            try:
                if (await http.get(base + "/health")).json()["state"] != "loading":
                    break
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.2)
        started = (await http.post(base + "/session", json=config, headers=headers))
        started.raise_for_status()
        start = started.json()

    url = "%s?token=%s" % (start["wsUrl"], start["token"])
    async with websockets.connect(url, additional_headers={"Origin": ORIGIN}, max_size=None) as ws:
        c = Client(ws)
        tasks = [asyncio.create_task(c.receive()), asyncio.create_task(c.mic())]
        await ws.send(client_ready())
        await asyncio.wait_for(c.bot_ready.wait(), 15)
        print("bot-ready after %d ms" % round(c.now() * 1000))
        await asyncio.sleep(1.0)

        ok = True
        for i, path in enumerate(args.wav):
            end = await c.say(read_wav(path))
            await c.wait_quiet(end)
            result = report_turn(c, "turn %d: %s" % (i + 1, os.path.basename(path)), end)
            ok = ok and result["first_audio_ms"] is not None

        if args.barge_in and args.wav:
            end = await c.say(read_wav(args.wav[-1]))
            while c.first("bot-started-speaking", end) is None:
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.6)
            cut_start = c.now()
            cut_end = await c.say(read_wav(args.barge_in))
            interrupted = c.first("user-started-speaking", cut_start)
            bot_stopped = c.first("bot-stopped-speaking", cut_start)
            # Audio still arriving well after the interruption would mean it did not stop.
            last_old_audio = max((t for t in c.audio_times if cut_start <= t < cut_end), default=None)
            await c.wait_quiet(cut_end)
            print("\n== barge-in")
            print("  interrupting speech began -> user-started-speaking: %s" % ms(cut_start, interrupted))
            print("  interrupting speech began -> bot-stopped-speaking:  %s" % ms(cut_start, bot_stopped))
            print("  interrupting speech began -> last old bot audio:    %s" % ms(cut_start, last_old_audio))
            report_turn(c, "turn after barge-in", cut_end)
            ok = ok and bot_stopped is not None and bot_stopped < cut_end

        print("\ntool calls relayed to client: %d, settled: %d" % (c.tool_calls, c.tool_results_seen))
        print("audio received: %.1f s" % (c.audio_bytes / 2 / 24000))
        heard = [d.get("text", "") for _, e, d in c.events if e == "user-transcription" and d.get("final", True)]
        said = "".join(d.get("text", "") for _, e, d in c.events if e == "bot-llm-text")
        print("heard: %s" % json.dumps(heard))
        print("said:  %s" % json.dumps(said[:400]))
        errors = [d for _, e, d in c.events if e == "error"]
        if errors:
            print("RTVI errors: %d" % len(errors))
            ok = False
        c.stop = True
        for t in tasks:
            t.cancel()
    return 0 if ok and c.tool_calls >= 1 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
