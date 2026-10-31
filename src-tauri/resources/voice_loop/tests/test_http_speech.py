"""N1, 30.10.2026: a voice session that hears and speaks through LFM3 Audio.

The app can point a session at Ollama (lfm3-audio, lfm3-omni) or at the LU
Engine (llama-server b11960 with one of them loaded) instead of the Whisper
and Pocket TTS models in this process. Before, the session always used its
own two models and the speech settings of the app did not reach it.
"""

import json

import httpx
import pytest
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame, TTSAudioRawFrame, TTSSpeakFrame
from pipecat.tests.utils import SleepFrame, run_test
from pydantic import ValidationError

from lu_voice_loop.config import SessionConfig
from lu_voice_loop.pipeline import speech_services
from lu_voice_loop.speech import (
    HttpSTTService,
    HttpTTSService,
    SharedPocketTTSService,
    SharedWhisperSTTService,
    pcm_to_wav,
    tts_body,
    wav_pcm,
)

OLLAMA = "http://127.0.0.1:11434"


def session(**speech) -> SessionConfig:
    return SessionConfig.model_validate({"llm": {"base_url": "http://127.0.0.1:8127/v1", "model": "m"}, **speech})


class Hollow:
    tts = object()
    whisper = object()

    def voice_state(self, name):
        return object()


def fake_service(monkeypatch, handler):
    """Every httpx.AsyncClient the services open answers through `handler`."""
    seen = []
    real = httpx.AsyncClient

    def wrapped(request):
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(wrapped), **kw))
    return seen


def test_without_a_speech_service_the_session_keeps_its_own_models():
    stt, tts = speech_services(session(), Hollow())
    assert type(stt) is SharedWhisperSTTService
    assert type(tts) is SharedPocketTTSService


def test_with_one_it_hears_and_speaks_through_it():
    stt, tts = speech_services(session(
        stt={"url": OLLAMA + "/v1/audio/transcriptions", "model": "lfm3-audio:2b"},
        tts={"url": OLLAMA + "/v1/audio/speech", "model": "lfm3-audio:2b"},
    ), Hollow())
    assert isinstance(stt, HttpSTTService)
    assert isinstance(tts, HttpTTSService)


def test_only_http_services_without_credentials_in_the_address():
    with pytest.raises(ValidationError):
        session(stt={"url": "file:///etc/passwd", "model": "m"})
    with pytest.raises(ValidationError):
        session(tts={"url": "http://user:pw@127.0.0.1:8127/tts", "model": "m"})


def test_the_key_of_the_lu_engine_stays_hidden():
    parsed = session(stt={"url": "http://127.0.0.1:8127/v1/audio/transcriptions", "model": "x", "api_key": "k" * 64})
    assert "k" * 64 not in repr(parsed)


def test_without_a_voice_the_model_speaks_in_its_own():
    assert tts_body("Hi.", "lfm3-audio:2b", None) == {"model": "lfm3-audio:2b", "input": "Hi.", "response_format": "wav"}
    assert tts_body("Hi.", "m", "female")["voice"] == "female"


def test_a_wav_answer_is_read_also_with_the_streamed_header_of_ollama():
    pcm = bytes(range(200)) * 10
    wav = pcm_to_wav(pcm, 24000)
    assert wav_pcm(wav) == (pcm, 24000)
    # Ollama writes the header before it knows the length: sizes at maximum.
    streamed = wav[:4] + b"\xff\xff\xff\xff" + wav[8:40] + b"\xff\xff\xff\xff" + wav[44:]
    assert wav_pcm(streamed) == (pcm, 24000)
    with pytest.raises(ValueError):
        wav_pcm(b"{\"error\":\"model not found\"}")


async def test_an_utterance_goes_to_the_service_as_wav_and_comes_back_as_words(monkeypatch):
    seen = fake_service(monkeypatch, lambda r: httpx.Response(200, json={"text": " Hello from LFM3. "}))
    stt = HttpSTTService(url=OLLAMA + "/v1/audio/transcriptions", model="lfm3-audio:2b")
    frames = [f async for f in stt.run_stt(b"\x00\x01" * 16000)]
    assert [f.text for f in frames if isinstance(f, TranscriptionFrame)] == ["Hello from LFM3."]
    body = seen[0].read()
    assert b'name="model"' in body and b"lfm3-audio:2b" in body
    assert b"RIFF" in body and b"WAVE" in body
    assert "authorization" not in seen[0].headers


async def test_the_lu_engine_gets_its_key(monkeypatch):
    seen = fake_service(monkeypatch, lambda r: httpx.Response(200, json={"text": "ok"}))
    stt = HttpSTTService(url="http://127.0.0.1:8127/v1/audio/transcriptions", model="engine", api_key=session(
        stt={"url": "http://127.0.0.1:8127/v1/audio/transcriptions", "model": "e", "api_key": "secret"}).stt.api_key)
    [f async for f in stt.run_stt(b"\x00\x01" * 1600)]
    assert seen[0].headers["authorization"] == "Bearer secret"


async def test_a_refusal_of_the_service_is_said_not_swallowed(monkeypatch):
    fake_service(monkeypatch, lambda r: httpx.Response(404, json={"error": "model \"lfm3-audio:2b\" not found"}))
    stt = HttpSTTService(url=OLLAMA + "/v1/audio/transcriptions", model="lfm3-audio:2b")
    frames = [f async for f in stt.run_stt(b"\x00\x01" * 1600)]
    errors = [f.error for f in frames if isinstance(f, ErrorFrame)]
    assert errors and "lfm3-audio:2b" in errors[0] and "404" in errors[0]


async def test_a_sentence_is_spoken_from_the_wav_the_service_answers(monkeypatch):
    seen = fake_service(monkeypatch, lambda r: httpx.Response(200, content=pcm_to_wav(b"\x00\x00" * 24000, 24000), headers={"content-type": "audio/wav"}))
    tts = HttpTTSService(url=OLLAMA + "/v1/audio/speech", model="lfm3-audio:2b")
    down, up = await run_test(tts, frames_to_send=[TTSSpeakFrame("Hello there."), SleepFrame(0.5)])
    assert [f for f in down if isinstance(f, TTSAudioRawFrame)], "the sentence was never spoken"
    assert not [f for f in [*down, *up] if isinstance(f, ErrorFrame)]
    assert json.loads(seen[0].read()) == {"model": "lfm3-audio:2b", "input": "Hello there.", "response_format": "wav"}
