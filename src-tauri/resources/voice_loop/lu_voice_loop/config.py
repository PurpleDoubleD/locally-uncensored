"""Session configuration sent by the app in POST /session.

The app decides everything about a session: which OpenAI-compatible endpoint
is the brain, the system prompt and the tools on offer. Validation is strict
so that a malformed request fails here with a clear message and never halfway
into a conversation.
"""

import re
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

# Same shape the app's tool bridge accepts for a function name.
TOOL_NAME = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
# A voice is named like its entry in models.json, "tts-voice-<name>".
VOICE_PATTERN = re.compile(r"^[a-z0-9_]{1,40}$")

MAX_TOOLS = 128
MAX_PROMPT_CHARS = 200_000
MAX_TOOL_SCHEMA_CHARS = 32_768

# The app's bridge gives a tool 120 s by default. The loop waits a little
# longer so the app's own timeout result arrives before this one fires.
DEFAULT_TOOL_TIMEOUT_SECS = 130.0


def _no_reserved_fields(value: dict[str, Any], field_name: str) -> dict[str, Any]:
    reserved = {"model", "messages", "tools", "tool_choice", "stream", "stream_options"}
    clash = sorted(reserved.intersection(value))
    if clash:
        raise ValueError("%s must not set %s" % (field_name, ", ".join(clash)))
    return value


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LlmConfig(_Strict):
    base_url: str = Field(max_length=2048)
    model: str = Field(min_length=1, max_length=512)
    api_key: SecretStr | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=32_768)
    # Passed through to the chat completions request, for example
    # {"reasoning_effort": "none"} or {"extra_body": {...}}.
    extra: dict[str, Any] = Field(default_factory=dict)
    # Set by the app for a model that Ollama serves: the context window the
    # chat sends for this model. With it the session talks to Ollama's own
    # chat API, which is the only one that takes a window, so Ollama does not
    # load the model again between a chat and a voice session
    # (ollama_native.py). `base_url` stays the OpenAI compatible address.
    ollama_num_ctx: int | None = Field(default=None, ge=256, le=4_194_304)

    @field_validator("base_url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("base_url must be an http or https URL")
        if parts.username or parts.password:
            raise ValueError("base_url must not contain credentials, use api_key")
        return value.rstrip("/")

    @field_validator("extra")
    @classmethod
    def _extra_cannot_override(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _no_reserved_fields(value, "extra")


class LlmExtra(_Strict):
    """Request fields the app sets while a session runs, checked like the ones at its start."""

    extra: dict[str, Any] = Field(default_factory=dict)

    @field_validator("extra")
    @classmethod
    def _extra_cannot_override(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _no_reserved_fields(value, "extra")


class SpeechEndpoint(_Strict):
    """An OpenAI-compatible speech service the session hears or speaks through.

    Set by the app when the user picked "External HTTP" or "LU Engine" for
    dictation or read-aloud (N1, Liquid LFM3 Audio): Ollama and llama-server
    both take a WAV at /v1/audio/transcriptions, and speak at
    /v1/audio/speech (Ollama) or /tts (llama-server). Without it the session
    keeps its own Whisper and Pocket TTS.
    """

    url: str = Field(max_length=2048)
    model: str = Field(min_length=1, max_length=512)
    # None lets the service speak in the model's own voice.
    voice: str | None = Field(default=None, max_length=100)
    api_key: SecretStr | None = None

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("url must be an http or https URL")
        if parts.username or parts.password:
            raise ValueError("url must not contain credentials, use api_key")
        return value


class ThinkingConfig(_Strict):
    """How a session deals with a model that reasons before it answers."""

    # The user switched thinking on. Off, a model that thinks anyway is cut
    # short early, and the session stops asking it the way that made it think.
    wanted: bool = False
    # How much the model may think before the turn is asked again without
    # thinking. None sets no limit.
    budget_tokens: int | None = Field(default=None, ge=64, le=32_768)
    # Request fields for the second try, the ones that switch thinking off on
    # this endpoint. The app knows which ones the endpoint accepts.
    direct_extra: dict[str, Any] = Field(default_factory=dict)

    @field_validator("direct_extra")
    @classmethod
    def _extra_cannot_override(cls, value: dict[str, Any]) -> dict[str, Any]:
        return _no_reserved_fields(value, "direct_extra")


class ToolFunction(_Strict):
    name: str
    description: str = Field(default="", max_length=8192)
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    strict: bool | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not TOOL_NAME.match(value):
            raise ValueError("tool name must match %s" % TOOL_NAME.pattern)
        return value

    @field_validator("parameters")
    @classmethod
    def _object_schema(cls, value: dict[str, Any]) -> dict[str, Any]:
        if value.get("type", "object") != "object":
            raise ValueError("tool parameters must be a JSON schema of type object")
        if not isinstance(value.get("properties", {}), dict):
            raise ValueError("tool parameters.properties must be an object")
        if not isinstance(value.get("required", []), list):
            raise ValueError("tool parameters.required must be a list")
        if len(repr(value)) > MAX_TOOL_SCHEMA_CHARS:
            raise ValueError("tool parameters schema is too large")
        return value


class ToolSpec(_Strict):
    """One tool in the OpenAI chat completions format."""

    type: Literal["function"] = "function"
    function: ToolFunction


class SessionConfig(_Strict):
    llm: LlmConfig
    system_prompt: str = Field(default="", max_length=MAX_PROMPT_CHARS)
    tools: list[ToolSpec] = Field(default_factory=list, max_length=MAX_TOOLS)
    # Tools that may run for a long time. The conversation continues while
    # they run, the result is injected when it arrives, and the model gets a
    # way to cancel them. Every other tool holds the answer until it returns
    # and is cancelled when the user interrupts.
    long_running_tools: list[str] = Field(default_factory=list)
    tool_timeout_secs: float = Field(default=DEFAULT_TOOL_TIMEOUT_SECS, ge=1.0, le=620.0)
    voice: str = Field(default="alba", pattern=VOICE_PATTERN.pattern)
    # Send the fixed start of every request (system prompt and tools) to the
    # model once while the session starts, so a local server has it evaluated
    # before the first question. The app asks for it for local models only.
    prewarm: bool = False
    # How many tokens of conversation may pile up before older turns are
    # folded into a summary. None keeps everything, which overflows a small
    # context window in a long session.
    context_limit_tokens: int | None = Field(default=None, ge=500, le=200_000)
    # The tools the model is shown at the start. The app can change the
    # selection while the session runs, within the tools above. None shows all.
    active_tools: list[str] | None = None
    # Thoughts are never spoken, with or without this. It adds the limit and
    # the fields of the second try.
    thinking: ThinkingConfig = Field(default_factory=ThinkingConfig)
    # Hear through this service instead of the built-in Whisper.
    stt: SpeechEndpoint | None = None
    # Speak through this service instead of the built-in Pocket TTS.
    tts: SpeechEndpoint | None = None

    @model_validator(mode="after")
    def _tools_consistent(self) -> "SessionConfig":
        names = [t.function.name for t in self.tools]
        if len(set(names)) != len(names):
            raise ValueError("tool names must be unique")
        # Pipecat adds a cancel_<name> tool for each long running tool.
        reserved = {"cancel_" + n for n in self.long_running_tools}
        clash = sorted(reserved.intersection(names))
        if clash:
            raise ValueError("tool name is reserved for cancelling a long running tool: %s" % ", ".join(clash))
        unknown = sorted(set(self.long_running_tools) - set(names))
        if unknown:
            raise ValueError("long_running_tools names a tool that is not offered: %s" % ", ".join(unknown))
        unknown = sorted(set(self.active_tools or []) - set(names))
        if unknown:
            raise ValueError("active_tools names a tool that is not offered: %s" % ", ".join(unknown))
        return self

    def tool_names(self) -> list[str]:
        return [t.function.name for t in self.tools]


def describe_validation_error(error: Exception) -> str:
    """A pydantic error as text without echoing any submitted value.

    The request holds the prompt and possibly a bearer key, so only the field
    path and the rule that failed are reported.
    """
    errors = getattr(error, "errors", None)
    if not callable(errors):
        return "Invalid session configuration."
    parts = []
    for item in errors(include_input=False, include_url=False)[:8]:
        where = ".".join(str(p) for p in item.get("loc", ())) or "body"
        parts.append("%s: %s" % (where, item.get("msg", "invalid")))
    return "Invalid session configuration. " + "; ".join(parts)
