"""Speech services that run on the models already loaded in this process.

Pipecat's own Whisper and Pocket TTS services load their model in the
constructor, which would cost seconds at every session start. These two take
the shared instances from engines.py instead.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any

import numpy as np
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, InputAudioRawFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.pocket_tts.tts import PocketTTSSettings
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator
from pipecat.utils.time import time_now_iso8601

from .log import safe_error_text


# The private field of TTSService that holds its text aggregator. A test
# fails if a Pipecat upgrade renames it, because speech would then quietly go
# back to whole sentences.
AGGREGATOR_FIELD = "_text_aggregator"

# The first piece of an answer may end at a comma when it has at least this
# much in it. Shorter, and the piece would be over before the rest of the
# sentence is written, which sounds like a stumble.
CLAUSE_MIN_WORDS = 4
CLAUSE_MIN_CHARS = 18


class ClauseFirstAggregator(SimpleTextAggregator):
    """Whole sentences, except that an answer may start speaking at a comma.

    The speech engine gets text one piece at a time and needs the piece
    complete to give it a melody. Waiting for the first full stop costs up to
    a second of silence at the start of every answer. A comma, a semicolon or
    a colon is where a speaker pauses anyway, so the FIRST piece of an answer
    may end there. Everything after it is cut at sentence ends as before:
    more cuts would make the voice sound chopped.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._first = True

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        if self._aggregation_type == AggregationType.TOKEN:
            async for piece in super().aggregate(text):
                yield piece
            return
        for char in text:
            self._text += char
            piece = await self._check_sentence_with_lookahead(char)
            if piece is None and self._first:
                piece = self._clause()
            if piece is not None:
                self._first = False
                yield piece

    def _clause(self) -> Aggregation | None:
        # "Sure, " but not "1,000" (no space) and not "Hello, " (too short).
        if len(self._text) < 2 or self._text[-1] != " " or self._text[-2] not in ",;:":
            return None
        head = self._text.strip(" ")
        if len(head) < CLAUSE_MIN_CHARS or len(head.split()) < CLAUSE_MIN_WORDS:
            return None
        self._text = ""
        return Aggregation(text=head, type=AggregationType.SENTENCE)

    async def flush(self) -> Aggregation | None:
        rest = await super().flush()
        self._first = True
        return rest

    async def handle_interruption(self):
        await super().handle_interruption()
        self._first = True

    async def reset(self):
        await super().reset()
        self._first = True


# Whisper reads 16 kHz mono.
WHISPER_SAMPLE_RATE = 16000

# The private fields of SegmentedSTTService the lead-in below works on. A
# test fails if a Pipecat upgrade renames them.
SEGMENT_BUFFER_FIELD = "_audio_buffer"
SEGMENT_SPEAKING_FIELD = "_user_speaking"

# How much audio from before the moment speech was detected can still become
# part of the utterance, and how much of it always does. Pipecat keeps one
# second, which is enough for a voice at normal level in a quiet room. A voice
# that is quiet is detected late: the echo cancellation of the webview turns
# the microphone down while the assistant is talking, and the first words of
# somebody who speaks into an answer arrive well before detection is sure.
# Measured on 06.10.2026 with the real pipeline and a sentence at a
# thirtieth of its level: detection 1.5 s after the first word, "Hold on,"
# missing from the transcript.
LEAD_IN_SECS = 3.0
LEAD_IN_ALWAYS_SECS = 1.0
# The lead-in starts this long before the first sound of the utterance, and
# a silence of this length before a sound means the utterance starts there.
LEAD_IN_MARGIN_SECS = 0.2
LEAD_IN_GAP_SECS = 0.6
LEAD_IN_FRAME_SECS = 0.02


def speech_onset(pcm: bytes, rate: int) -> int:
    """Where the utterance at the end of `pcm` begins, as a byte offset.

    `pcm` is 16-bit mono audio that ends at the moment speech was detected.
    The last second is always kept. Before that, the audio is followed
    backwards for as long as it is sound: the utterance begins after the last
    silence that is long enough to be a pause between sentences. What counts
    as sound is measured against the audio itself, so a quiet voice over a
    quiet background is found the same way as a loud one.
    """
    samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype=np.int16).astype(np.float32)
    frame = max(1, int(rate * LEAD_IN_FRAME_SECS))
    always = int(rate * LEAD_IN_ALWAYS_SECS)
    if len(samples) <= always:
        return 0
    count = len(samples) // frame
    # Frames are counted from the end, so the last one ends where the audio ends.
    tail = samples[len(samples) - count * frame:].reshape(count, frame)
    level = np.sqrt(np.mean(tail * tail, axis=1))
    kept = always // frame
    loudest = float(level[count - kept:].max())
    # Sound: not far below the voice that was just detected, and above the
    # quietest stretches of the lead-in when those are clearly quieter.
    floor = float(np.percentile(level, 10))
    threshold = max(1.0, loudest * 0.1, min(floor * 2.0, loudest * 0.5))
    gap_frames = int(LEAD_IN_GAP_SECS / LEAD_IN_FRAME_SECS)
    first = count - kept
    quiet = 0
    for index in range(count - kept - 1, -1, -1):
        if level[index] >= threshold:
            first = index
            quiet = 0
        else:
            quiet += 1
            if quiet >= gap_frames:
                break
    if first == count - kept:
        # Nothing before the last second belongs to the utterance.
        return (len(samples) - always) * 2
    start = len(samples) - (count - first) * frame - int(rate * LEAD_IN_MARGIN_SECS)
    return max(0, start) * 2


class SharedWhisperSTTService(SegmentedSTTService):
    """Whisper on CPU through faster-whisper, using a preloaded model.

    Not derived from Pipecat's WhisperSTTService: that module needs
    mlx-whisper on Apple Silicon just to be imported.
    """

    Settings = STTSettings
    _settings: Settings

    def __init__(self, *, whisper_model: Any, **kwargs):
        super().__init__(
            sample_rate=WHISPER_SAMPLE_RATE,
            # Upper bound the turn logic waits for a transcript after speech
            # ends. Generous for slow CPUs; a faster transcript ends the wait.
            ttfs_p99_latency=1.5,
            settings=self.Settings(model="base.en", language=Language.EN),
            **kwargs,
        )
        self._shared_model = whisper_model

    async def setup(self, setup):
        await super().setup(setup)
        self._lead_in_bytes = int(self.sample_rate * LEAD_IN_SECS) * 2

    async def process_audio_frame(self, frame: InputAudioRawFrame, direction: FrameDirection):
        """Buffer the microphone, with a longer lead-in than Pipecat keeps."""
        self._user_id = getattr(frame, "user_id", "")
        buffer: bytearray = getattr(self, SEGMENT_BUFFER_FIELD)
        buffer += frame.audio
        if not getattr(self, SEGMENT_SPEAKING_FIELD) and len(buffer) > self._lead_in_bytes:
            del buffer[: len(buffer) - self._lead_in_bytes]

    async def _handle_user_started_speaking(self, frame):
        # Speech was detected: of the lead-in, keep what belongs to it.
        buffer: bytearray = getattr(self, SEGMENT_BUFFER_FIELD)
        if not getattr(self, SEGMENT_SPEAKING_FIELD):
            del buffer[: speech_onset(bytes(buffer), self.sample_rate)]
        await super()._handle_user_started_speaking(frame)
    @property
    def wants_wav_segments(self) -> bool:
        """Receive segments as raw 16-bit PCM, which the model reads directly."""
        return False

    def can_generate_metrics(self) -> bool:
        return True

    def language_to_service_language(self, language: Language) -> str | None:
        return "en"

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        await self.start_processing_metrics()
        audio_float = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0

        def transcribe() -> str:
            # Greedy decoding without timestamps: one short utterance per call,
            # and the answer should start as early as possible.
            segments, _ = self._shared_model.transcribe(
                audio_float, language="en", beam_size=1, without_timestamps=True,
                condition_on_previous_text=False,
            )
            return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.4).strip()

        try:
            text = await asyncio.to_thread(transcribe)
        except Exception as e:
            await self.stop_processing_metrics()
            logger.error("Speech recognition failed (%s)." % safe_error_text(e))
            yield ErrorFrame(error="Speech recognition failed (%s)." % type(e).__name__)
            return
        await self.stop_processing_metrics()
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)


# How long a sentence may bring no sound before Pipecat takes it for finished.
# Its own three seconds are meant for a provider that answers over the network.
# This model runs on the user's processor, next to the chat model: when every
# core is busy the first sound can take longer than that, Pipecat then reports
# "completed with no audio", and the app ends the session on that error.
SOUND_PATIENCE_SECS = 30.0


# The upstream hook the speech service overrides to drop text without words.
# A test fails if a Pipecat upgrade renames it, because such text would then
# reach the speech model again.
SPEAK_HOOK = "_push_tts_frames"


def speakable(text: str) -> bool:
    """There is at least one letter or digit to say."""
    return any(ch.isalnum() for ch in text)


class SharedPocketTTSService(TTSService):
    """Kyutai Pocket TTS on CPU, streaming, using a preloaded model and voice."""

    Settings = PocketTTSSettings
    _settings: Settings

    def __init__(self, *, tts_model: Any, voice_state: Any, voice: str, **kwargs):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            stop_frame_timeout_s=SOUND_PATIENCE_SECS,
            settings=self.Settings(model=None, voice=voice, language=Language.EN),
            **kwargs,
        )
        self._model = tts_model
        # TTSService takes no aggregator of the caller's, so its own is swapped.
        stock = getattr(self, AGGREGATOR_FIELD)
        setattr(self, AGGREGATOR_FIELD, ClauseFirstAggregator(aggregation_type=AggregationType.SENTENCE, language=stock.language))
        # generate_audio_stream(copy_state=True) never mutates this state.
        self._voice_state = voice_state

    def can_generate_metrics(self) -> bool:
        return True

    async def _push_tts_frames(self, src_frame, *args, **kwargs):
        # Blanks, a lone dash, a row of asterisks: the speech model raises on
        # text it finds no words in, and Pipecat reports a sentence that
        # brought no sound as an error. Both would reach the app for
        # something nobody was meant to hear. Pipecat itself drops only text
        # that is all whitespace, so the rest is dropped here, at the same place.
        if not speakable(src_frame.text):
            return
        await super()._push_tts_frames(src_frame, *args, **kwargs)

    def language_to_service_language(self, language: Language) -> str:
        return "english"

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        import torch


        def next_chunk(stream):
            try:
                return next(stream)
            except StopIteration:
                return None

        async def pcm_chunks() -> AsyncIterator[bytes]:
            stream = self._model.generate_audio_stream(self._voice_state, text, copy_state=True)
            while True:
                chunk = await asyncio.to_thread(next_chunk, stream)
                if chunk is None:
                    return
                # A 1-D float32 tensor in [-1, 1] at the model sample rate.
                yield (chunk.clamp(-1.0, 1.0) * 32767).to(torch.int16).numpy().tobytes()

        try:
            await self.start_tts_usage_metrics(text)
            async for frame in self._stream_audio_frames_from_iterator(
                pcm_chunks(), in_sample_rate=self._model.sample_rate, context_id=context_id,
            ):
                await self.stop_ttfb_metrics()
                yield frame
        except Exception as e:
            logger.error("Speech synthesis failed (%s)." % safe_error_text(e))
            yield ErrorFrame(error="Speech synthesis failed (%s)." % type(e).__name__)
        finally:
            await self.stop_ttfb_metrics()


# ── Speech through an HTTP service (N1, Liquid LFM3 Audio) ──────────────────
#
# The app can point a session at an OpenAI-compatible speech service instead
# of the models in this process: Ollama 0.40.13+ with lfm3-audio or lfm3-omni,
# or the LU Engine (llama-server b11960) with one of them loaded. Both take a
# WAV at /v1/audio/transcriptions; Ollama speaks at /v1/audio/speech and
# llama-server at /tts, both with the same JSON body and a WAV answer.

# The longest a single request may take. A speech model next to the chat
# model on the same machine can be slow, but an answer that hangs must end.
HTTP_SPEECH_TIMEOUT_SECS = 120.0


def pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    """16-bit mono PCM as a WAV file, the one format every such service takes."""
    import io
    import wave

    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def wav_pcm(data: bytes) -> tuple[bytes, int]:
    """The 16-bit mono samples and the rate of a WAV answer.

    Read by hand, not with the wave module: Ollama streams its WAV and writes
    the header before it knows the length, so the size fields hold the maximum
    value. Everything after the data chunk header is taken as samples.
    """
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("the speech service did not answer with a WAV file")
    rate = None
    at = 12
    while at + 8 <= len(data):
        kind, size = data[at:at + 4], int.from_bytes(data[at + 4:at + 8], "little")
        if kind == b"fmt ":
            channels = int.from_bytes(data[at + 10:at + 12], "little")
            rate = int.from_bytes(data[at + 12:at + 16], "little")
            bits = int.from_bytes(data[at + 22:at + 24], "little")
            if channels != 1 or bits != 16:
                raise ValueError("the speech service answered %d channels at %d bits, expected mono 16-bit" % (channels, bits))
        elif kind == b"data":
            if rate is None:
                raise ValueError("the WAV answer has no format chunk")
            pcm = data[at + 8:]
            return pcm[: len(pcm) - len(pcm) % 2], rate
        at += 8 + size + (size % 2)
    raise ValueError("the WAV answer has no data chunk")


def tts_body(text: str, model: str, voice: str | None) -> dict[str, Any]:
    """The request body, the same the app sends for read-aloud (tts.rs)."""
    body: dict[str, Any] = {"model": model, "input": text, "response_format": "wav"}
    if voice:
        body["voice"] = voice
    return body


def _auth(api_key: Any) -> dict[str, str]:
    key = api_key.get_secret_value() if api_key is not None else None
    return {"Authorization": "Bearer %s" % key} if key else {}


class HttpSTTService(SharedWhisperSTTService):
    """The same turn handling and lead-in as Whisper, the words from a service."""

    def __init__(self, *, url: str, model: str, api_key: Any = None, **kwargs):
        super().__init__(whisper_model=None, **kwargs)
        self._url = url
        self._model_name = model
        self._api_key = api_key

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        import httpx

        await self.start_processing_metrics()
        try:
            async with httpx.AsyncClient(timeout=HTTP_SPEECH_TIMEOUT_SECS) as client:
                answer = await client.post(
                    self._url,
                    headers=_auth(self._api_key),
                    files={"file": ("take.wav", pcm_to_wav(audio, WHISPER_SAMPLE_RATE), "audio/wav")},
                    data={"model": self._model_name, "response_format": "json"},
                )
            if answer.status_code >= 400:
                raise RuntimeError("HTTP %d: %s" % (answer.status_code, answer.text[:200]))
            text = str(answer.json().get("text") or "").strip()
        except Exception as e:
            await self.stop_processing_metrics()
            logger.error("Speech recognition failed (%s)." % safe_error_text(e))
            yield ErrorFrame(error="Speech recognition through %s failed (%s)." % (self._model_name, safe_error_text(e)))
            return
        await self.stop_processing_metrics()
        if text:
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)


class HttpTTSService(SharedPocketTTSService):
    """The same sentence cutting as Pocket TTS, the sound from a service."""

    def __init__(self, *, url: str, model: str, voice: str | None = None, api_key: Any = None, **kwargs):
        super().__init__(tts_model=None, voice_state=None, voice=voice or "default", **kwargs)
        self._url = url
        self._model_name = model
        self._voice_name = voice
        self._api_key = api_key

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        import httpx

        async def pcm_chunks(pcm: bytes) -> AsyncIterator[bytes]:
            step = 9600
            for at in range(0, len(pcm), step):
                yield pcm[at:at + step]

        try:
            await self.start_tts_usage_metrics(text)
            async with httpx.AsyncClient(timeout=HTTP_SPEECH_TIMEOUT_SECS) as client:
                answer = await client.post(self._url, headers=_auth(self._api_key), json=tts_body(text, self._model_name, self._voice_name))
            if answer.status_code >= 400:
                raise RuntimeError("HTTP %d: %s" % (answer.status_code, answer.text[:200]))
            pcm, rate = wav_pcm(answer.content)
            async for frame in self._stream_audio_frames_from_iterator(pcm_chunks(pcm), in_sample_rate=rate, context_id=context_id):
                await self.stop_ttfb_metrics()
                yield frame
        except Exception as e:
            logger.error("Speech synthesis failed (%s)." % safe_error_text(e))
            yield ErrorFrame(error="Speech synthesis through %s failed (%s)." % (self._model_name, safe_error_text(e)))
        finally:
            await self.stop_ttfb_metrics()
