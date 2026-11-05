"""One voice session: WebSocket in, Pipecat pipeline, WebSocket out.

    client mic -> VAD + Smart Turn -> Whisper -> LLM (tools via the app) -> Pocket TTS -> client speaker

Audio arrives from and returns to the webview, which owns the devices and the
echo cancellation. Barge-in is Pipecat's default: speech detected while the
bot talks interrupts the LLM and the TTS and stops the outgoing audio. A
voice that the echo cancellation turned down still counts as speech
(VAD_MIN_VOLUME), and its first words are kept (the lead-in in speech.py).

Around that line sits what a long session needs: the fixed start of every
request is sent to the model once before the first question (prewarm), older
turns are folded into a summary before the context window overflows, and
the app can have a sentence spoken, open a question that is answered by
voice, and replace the model's bearer key before it expires.
"""

import asyncio
import time
from typing import Any

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from openai import APIStatusError, AsyncOpenAI, DefaultAsyncHttpxClient
from pipecat.frames.frames import Frame, InterruptionFrame, LLMContextFrame, LLMTextFrame, TTSSpeakFrame
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import NOT_GIVEN, LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregatorParams,
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import RTVIObserverParams
from pipecat.processors.frameworks.rtvi.observer import RTVIFunctionCallReportLevel
from pipecat.serializers.protobuf import ProtobufFrameSerializer
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)
from pipecat.workers.runner import WorkerRunner

from .commands import EmptyTurnUnlessCommand, VoiceCommandGate
from .config import MAX_PROMPT_CHARS, LlmExtra, SessionConfig, ThinkingConfig
from .engines import Engines
from .latency import LatencyReport
from .log import pipeline_error_line, safe_error_text
from .ollama_native import OllamaNativeTransport
from .speech import HttpSTTService, HttpTTSService, SharedPocketTTSService, SharedWhisperSTTService
from .thinking import (
    CHARS_PER_TOKEN,
    DIRECT_INSTRUCTION,
    NO_ANSWER_SENTENCE,
    SAY,
    ThinkingOverBudget,
    ThinkingTurn,
    UNWANTED_THOUGHT_TOKENS,
    without_thoughts,
)
from .tools import OwedAnswer, RelayRTVIProcessor, ToolRelay, register_tools, tools_schema

# How loud a voice has to be to count as speech, on Pipecat's scale (0.5 is
# -60 LUFS, its own default of 0.6 is -50 LUFS). While the assistant talks,
# the echo cancellation of the webview turns the microphone down, and a user
# who speaks into the answer arrives much quieter than in a silent room. With
# the default a sentence at a thirtieth of its level was detected 1.5 s late
# and one at a hundredth not at all (measured 06.10.2026, real pipeline).
VAD_MIN_VOLUME = 0.5

# What the JS client records and plays (WebSocketTransport defaults).
AUDIO_IN_RATE = 16000
AUDIO_OUT_RATE = 24000


class ClientFrameSerializer(ProtobufFrameSerializer):
    """Protobuf frames as @pipecat-ai/websocket-transport understands them.

    The JS client's frame schema has no interruption kind and logs an error
    for every one it receives. It learns about an interruption from the RTVI
    messages, so the frame itself is not sent.
    """

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, InterruptionFrame):
            return None
        return await super().serialize(frame)


def fold_announcements(messages: list) -> list | None:
    """Join "I'll write the file." with the tool call it announced.

    The model says one sentence and calls the tool in the same answer. Pipecat
    stores that as two assistant messages: the sentence, then the call with no
    text. Read back, the first one is a complete assistant turn that announces
    and does nothing, and the model copies it: from the second request of a
    session on it announces and stops, and the user waits for a tool that was
    never called. Measured on 07.10.2026 with Qwen3.5-9B on the LU Engine and
    the real session prompt: a tool call in 2 of 6 and 0 of 6 answers with the
    two messages, in 6 of 6 with one message that carries both.

    Returns the new list, or None when nothing had to change.
    """
    folded: list = []
    changed = False
    for message in messages:
        before = folded[-1] if folded else None
        if (
            isinstance(message, dict)
            and isinstance(before, dict)
            and message.get("role") == "assistant"
            and message.get("tool_calls")
            and not message.get("content")
            and before.get("role") == "assistant"
            and not before.get("tool_calls")
            and isinstance(before.get("content"), str)
            and before["content"].strip()
        ):
            folded[-1] = {**message, "content": before["content"]}
            changed = True
        else:
            folded.append(message)
    return folded if changed else None


# The request fields that are about thinking. A change of the Thinking switch
# replaces these and leaves every other field of the session alone.
THINKING_FIELDS = ("reasoning_effort", "extra_body")

# Said once when the user talks while the model cannot answer (see set_hold).
HOLD_SENTENCE = "One moment, I am still working on the screen."


# What an error frame for a request limit (HTTP 429) starts with. The app
# reads the rest as the server's sentence (src/lib/voice/loop-errors.ts).
REQUEST_LIMIT_PREFIX = "Request limit: "


def request_limit_sentence(e: APIStatusError) -> str:
    """The sentence the server sent with a 429, or nothing.

    The client library hands over the `error` field of the answer: a string
    from LU Cloud, an object with a `message` from most other servers.
    """
    body = getattr(e, "body", None)
    said = body.get("message") if isinstance(body, dict) else body
    return " ".join(said.split()) if isinstance(said, str) else ""


class ChatModelService(OpenAILLMService):
    """The chat model behind an OpenAI compatible endpoint that is not OpenAI.

    Pipecat reports a tool that finished after the conversation moved on, and
    every interim report of a running tool, in a message with the role
    "developer". Only OpenAI's own API knows that role. Ollama and llama.cpp
    hand it to the model's chat template as a system message, and the Qwen
    template refuses one that is not at the beginning: the request fails with
    HTTP 500 and the session ends (seen on 06.10.2026 with Qwen3.5-9B). The
    brain of a session is always a local server or LU Cloud, so such messages
    are sent as user messages, which every template takes.
    """

    supports_developer_role = False

    def __init__(self, *, thinking: ThinkingConfig | None = None, ollama_num_ctx: int | None = None, **kwargs):
        # Read by create_client, which the base class calls while it is built.
        self._ollama_num_ctx = ollama_num_ctx
        super().__init__(**kwargs)
        self._on_hold = False
        self._hold_told = False
        self._turn = ThinkingTurn()
        self._tell_app = None
        self.set_thinking(thinking or ThinkingConfig())

    def create_client(self, api_key=None, base_url=None, organization=None, project=None, default_headers=None, **kwargs):
        if self._ollama_num_ctx is None:
            return super().create_client(api_key=api_key, base_url=base_url, organization=organization, project=project, default_headers=default_headers, **kwargs)
        # A model on Ollama: the same client, on a road that can name the
        # context window (ollama_native.py).
        return AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            organization=organization,
            project=project,
            http_client=DefaultAsyncHttpxClient(transport=OllamaNativeTransport(self._ollama_num_ctx)),
            default_headers=default_headers,
        )

    def set_thinking(self, thinking: ThinkingConfig, extra: dict | None = None) -> None:
        """What the session does about thinking, at the start or after the user moved the switch."""
        budget = thinking.budget_tokens
        if not thinking.wanted:
            budget = UNWANTED_THOUGHT_TOKENS if budget is None else min(budget, UNWANTED_THOUGHT_TOKENS)
        self._budget_chars = None if budget is None else budget * CHARS_PER_TOKEN
        self._wanted = thinking.wanted
        self._direct_extra = dict(thinking.direct_extra)
        # A model that thinks although it was asked not to is asked the
        # second way from then on, so only one turn pays for finding out.
        self._always_direct = False
        if extra is not None:
            kept = {k: v for k, v in self._settings.extra.items() if k not in THINKING_FIELDS}
            self._settings.extra = {**kept, **extra}

    def set_instructions(self, prompt: str) -> None:
        """Replace what the model is told, for example after its tools changed."""
        self._base_system_instruction = prompt or None
        self._compose_system_instruction()

    def set_thought_listener(self, tell_app) -> None:
        """Where the thoughts of the model go: to the app, as text to show."""
        self._tell_app = tell_app

    def set_hold(self, on: bool) -> None:
        """The app says the model cannot answer right now, or can again.

        On a computer with one graphics card the app's own engine holds one
        model at a time. While a screen task runs with another local model,
        the engine serves that one: a request for the chat model would be
        answered by the wrong model, or refused while the engine changes
        models, and the refusal ends the session (seen on 06.10.2026, RTX
        3060, Qwen3.5-9B as the brain and Holo 3.1 as the screen model, when
        the user said one more word during the task).
        """
        self._on_hold = on
        if not on:
            self._hold_told = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if self._on_hold and isinstance(frame, LLMContextFrame):
            # No request. What the user said is in the context already; the
            # model reads it with the result of the task, which is its next
            # request. The user is told once that it takes a moment.
            await FrameProcessor.process_frame(self, frame, direction)
            if not self._hold_told:
                self._hold_told = True
                await self.push_frame(TTSSpeakFrame(HOLD_SENTENCE, append_to_context=False))
            return
        if isinstance(frame, LLMContextFrame):
            folded = fold_announcements(frame.context.get_messages())
            if folded is not None:
                frame.context.set_messages(folded)
        await super().process_frame(frame, direction)

    # What follows keeps the thoughts of a reasoning model away from the
    # speech engine and makes sure every turn ends in something the user can
    # hear. The rule for a voice session: a question is always answered aloud.
    #
    #   - Thoughts come in a field of their own or inside tags in the answer
    #     (thinking.py). Both go to the app as text and never to the speech
    #     engine or into the context.
    #   - A thought that grows past the length the user set ends the request.
    #     The turn is asked again with thinking switched off.
    #   - A request that ends without a word and without a tool call (the
    #     thought used up the output limit of the server, or the server
    #     refused the thinking fields) is asked again the same way.
    #   - When the second try says nothing either, one fixed sentence is
    #     spoken, so the turn never ends in silence.

    async def _tell(self, message: dict) -> None:
        if self._tell_app is None:
            return
        try:
            await self._tell_app({"type": "thought", **message})
        except Exception as e:
            logger.warning("A thought was not passed on (%s)." % safe_error_text(e))

    async def _thought_text(self, text: str) -> None:
        turn = self._turn
        if not text.strip() and not turn.thought_open:
            # An empty thought block is how a model says it did not think.
            return
        turn.thought(text)
        if not turn.thought_open:
            turn.thought_open = True
            await self._tell({"phase": "start"})
        await self._tell({"phase": "text", "text": text})
        if turn.over_budget():
            raise ThinkingOverBudget()

    async def _thought_over(self, cut: bool = False) -> None:
        turn = self._turn
        if turn.thought_open:
            turn.thought_open = False
            await self._tell({"phase": "end", "secs": turn.thought_secs(), "cut": cut})

    async def get_chat_completions(self, context):
        stream = await super().get_chat_completions(context)
        turn = self._turn
        service = self

        async def chunks():
            async for chunk in stream:
                choice = chunk.choices[0] if chunk.choices else None
                delta = choice.delta if choice is not None else None
                if delta is None:
                    yield chunk
                    continue
                reasoning = getattr(delta, "reasoning", None) or getattr(delta, "reasoning_content", None)
                if isinstance(reasoning, str) and reasoning:
                    await service._thought_text(reasoning)
                if delta.tool_calls:
                    turn.tool_called = True
                    await service._thought_over()
                if delta.content:
                    said = ""
                    for kind, piece in turn.splitter.feed(delta.content):
                        if kind == SAY:
                            said += piece
                        else:
                            await service._thought_text(piece)
                    # Line breaks between a thought and the answer are not an answer yet.
                    if said and (turn.said or said.strip()):
                        if not turn.said:
                            said = said.lstrip()
                        turn.said = True
                        await service._thought_over()
                    else:
                        said = ""
                    delta.content = said or None
                yield chunk
            # A piece that looked like the start of a tag and was none.
            for kind, piece in turn.splitter.flush():
                if kind == SAY and piece.strip():
                    turn.said = True
                    await service._thought_over()
                    await service._push_llm_text(piece)
                elif kind != SAY:
                    await service._thought_text(piece)

        class Filtered:
            def __aiter__(self):
                return chunks()

            async def close(self):
                close = getattr(stream, "close", None) or getattr(stream, "aclose", None)
                if close is not None:
                    await close()

        return Filtered()

    def build_chat_completion_params(self, params_from_context) -> dict:
        params = super().build_chat_completion_params(params_from_context)
        if not self._turn.direct:
            return params
        if self._turn.bare:
            for name in list(self._settings.extra) + list(self._direct_extra):
                params.pop(name, None)
        else:
            params.update(self._direct_extra)
        messages = list(params.get("messages") or [])
        if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system" and isinstance(messages[0].get("content"), str):
            messages[0] = {**messages[0], "content": messages[0]["content"] + "\n\n" + DIRECT_INSTRUCTION}
        else:
            messages.insert(0, {"role": "system", "content": DIRECT_INSTRUCTION})
        params["messages"] = messages
        return params

    async def _one_try(self, context, direct: bool, bare: bool = False) -> tuple[ThinkingTurn, bool]:
        """One request. Returns the turn and whether the server refused it."""
        turn = ThinkingTurn(direct=direct, bare=bare, budget_chars=self._budget_chars)
        self._turn = turn
        refused = False
        try:
            await super()._process_context(context)
            await self._thought_over()
        except ThinkingOverBudget:
            await self._thought_over(cut=True)
            logger.info("The model thought past the set length; asking again without thinking.")
        except APIStatusError as e:
            # A server that does not know a thinking field refuses the whole
            # request. The next try sends less.
            if bare or e.status_code not in (400, 422):
                raise
            refused = True
            logger.info("The model server refused the request (HTTP %d); asking again with fewer fields." % e.status_code)
        except BaseException:
            # Interrupted or cancelled: the thought ends where it is.
            await self._thought_over()
            raise
        return turn, refused

    async def _process_context(self, context):
        try:
            refused = False
            if not self._always_direct:
                turn, refused = await self._one_try(context, direct=False)
                if not self._wanted and turn.thought_chars > 0:
                    self._always_direct = True
                if turn.answered:
                    return
            turn, refused_again = await self._one_try(context, direct=True)
            if turn.answered:
                return
            if refused_again:
                turn, _ = await self._one_try(context, direct=True, bare=True)
                if turn.answered:
                    return
            logger.warning("The model gave no answer in %s." % ("three tries" if refused_again else "two tries" if not refused else "its second try"))
            await self._push_llm_text(NO_ANSWER_SENTENCE)
        except APIStatusError as e:
            if e.status_code != 429:
                raise
            # A request limit. The server's sentence says whose limit it is
            # and how long it lasts, so it travels to the app as it is, not
            # inside the client library's "Error code: 429 - {...}".
            logger.warning("The model server refused the request (HTTP 429): a request limit.")
            await self.push_error(error_msg=REQUEST_LIMIT_PREFIX + request_limit_sentence(e), exception=e)
        finally:
            # The prewarm and the summary build their request with the same
            # code and must not inherit the second try's instruction.
            self._turn = ThinkingTurn()

    async def run_inference(self, context, **kwargs):
        # A one shot answer (the summary of a long conversation) is text for
        # the context, so the thought in front of it has to go as well.
        return without_thoughts(await super().run_inference(context, **kwargs))


def build_llm(config: SessionConfig) -> OpenAILLMService:
    llm = config.llm
    settings: dict[str, Any] = {
        "model": llm.model,
        "system_instruction": config.system_prompt or None,
        "extra": dict(llm.extra),
    }
    if llm.temperature is not None:
        settings["temperature"] = llm.temperature
    if llm.max_tokens is not None:
        settings["max_tokens"] = llm.max_tokens
    return ChatModelService(
        # A local server ignores the key, but the client library insists on one.
        api_key=llm.api_key.get_secret_value() if llm.api_key else "not-needed",
        base_url=llm.base_url,
        settings=ChatModelService.Settings(**settings),
        thinking=config.thinking,
        ollama_num_ctx=llm.ollama_num_ctx,
    )


# The longest question the app may have spoken, and the longest key it may set.
MAX_SAY_CHARS = 400
MAX_KEY_CHARS = 8192
# A prewarm that takes longer than this is given up on. The session works
# without it, the first answer is just slow.
PREWARM_TIMEOUT_SECS = 90.0


def summarization_params(config: SessionConfig) -> LLMAssistantAggregatorParams:
    """Fold older turns into a summary before the window overflows."""
    limit = config.context_limit_tokens
    if limit is None:
        return LLMAssistantAggregatorParams()
    return LLMAssistantAggregatorParams(
        enable_auto_context_summarization=True,
        auto_context_summarization_config=LLMAutoContextSummarizationConfig(
            max_context_tokens=limit,
            # Tokens decide. A count would summarize a chat of short turns
            # long before it has to.
            max_unsummarized_messages=None,
            summary_config=LLMContextSummaryConfig(
                target_context_tokens=max(200, min(1200, limit // 4)),
                # The last exchanges stay word for word, so "as I just said"
                # still has something to point at.
                min_messages_after_summary=6,
                summary_message_template="Summary of the conversation so far: {summary}",
            ),
        ),
    )


async def prewarm(llm: OpenAILLMService, schema, notify) -> None:
    """Have the model server evaluate the system prompt and the tools once.

    A local server keeps the evaluated start of a prompt and reuses it for
    the next request that begins the same way. `run_inference` builds its
    request with the same code as a real turn, so the start is the same bytes.
    One token of answer is asked for; the answer is thrown away.
    """
    began = time.monotonic()
    ok = True
    try:
        hello = [{"role": "user", "content": "Hi"}]
        context = LLMContext(messages=hello, tools=schema) if schema else LLMContext(messages=hello)
        await asyncio.wait_for(llm.run_inference(context, max_tokens=1), PREWARM_TIMEOUT_SECS)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        ok = False
        logger.warning("The model was not prewarmed (%s)." % safe_error_text(e))
    await notify({"type": "warm", "ok": ok, "secs": round(time.monotonic() - began, 2)})


class SessionControl:
    """What the app may ask of a running session, beyond audio and tools.

    Every request is a client message on the session's own WebSocket, which
    was let in with a one time ticket. Each handler checks what it is given
    and ignores the rest: a malformed message changes nothing.
    """

    def __init__(self, worker: PipelineWorker, llm: OpenAILLMService, gate: VoiceCommandGate, context: LLMContext | None = None, tools: list | None = None):
        self._worker = worker
        self._llm = llm
        self._gate = gate
        self._context = context
        # Every tool of the session by name. The app picks among them.
        self._tools = {tool.name: tool for tool in (tools or [])}

    async def handle(self, kind: str, data: Any) -> None:
        data = data if isinstance(data, dict) else {}
        if kind == "question":
            question_id = data.get("id")
            if isinstance(question_id, str) and 0 < len(question_id) <= 100:
                self._gate.open_question(question_id, data.get("voice") is True)
                # Spoken, and kept out of the context. As an assistant message
                # the question sits between the model's tool call and its
                # result, and the model repeats it word for word as its answer
                # to the result, or starts the task again after a spoken stop
                # (Qwen3.5-9B, 06.10.2026). The result says what happened.
                await self._say(data.get("text"))
        elif kind == "question-closed":
            question_id = data.get("id")
            self._gate.close_question(question_id if isinstance(question_id, str) else None)
        elif kind == "task":
            self._gate.set_task_active(data.get("active") is True)
        elif kind == "hold":
            hold = getattr(self._llm, "set_hold", None)
            if callable(hold):
                hold(data.get("on") is True)
        elif kind == "thinking":
            # The user moved the Thinking switch, or changed the length.
            try:
                thinking = ThinkingConfig(**{k: data[k] for k in ("wanted", "budget_tokens", "direct_extra") if k in data})
                extra = LlmExtra(extra=data.get("extra") or {}).extra
            except Exception:
                return
            set_thinking = getattr(self._llm, "set_thinking", None)
            if callable(set_thinking):
                set_thinking(thinking, extra)
        elif kind == "session-tools":
            # The user switched the agent on or off, or changed where it may
            # work. Only tools the session started with can be shown.
            names = data.get("names")
            prompt = data.get("system_prompt")
            if self._context is None or not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                return
            if not isinstance(prompt, str) or len(prompt) > MAX_PROMPT_CHARS:
                return
            shown = [self._tools[name] for name in dict.fromkeys(names) if name in self._tools]
            self._context.set_tools(ToolsSchema(standard_tools=shown) if shown else NOT_GIVEN)
            set_instructions = getattr(self._llm, "set_instructions", None)
            if callable(set_instructions):
                set_instructions(prompt)
        elif kind == "llm-key":
            key = data.get("api_key")
            if isinstance(key, str) and 0 < len(key) <= MAX_KEY_CHARS:
                # The client reads the key for each request, so the next
                # turn already goes out with the new one.
                self._llm._client.api_key = key

    async def _say(self, text: Any) -> None:
        if isinstance(text, str) and text.strip():
            await self._worker.queue_frames([TTSSpeakFrame(text.strip()[:MAX_SAY_CHARS], append_to_context=False)])


def user_turn_params(gate: VoiceCommandGate, **kwargs) -> LLMUserAggregatorParams:
    """How the user's turns are read. A turn whose words were a spoken command is not answered."""
    return LLMUserAggregatorParams(empty_user_turn=EmptyTurnUnlessCommand(gate), **kwargs)


def speech_services(config: SessionConfig, engines: Engines) -> tuple[FrameProcessor, FrameProcessor]:
    """The ear and the voice of a session: the app's choice, else the built-in models."""
    if config.stt is not None:
        stt = HttpSTTService(url=config.stt.url, model=config.stt.model, api_key=config.stt.api_key)
    else:
        stt = SharedWhisperSTTService(whisper_model=engines.whisper)
    if config.tts is not None:
        tts = HttpTTSService(url=config.tts.url, model=config.tts.model, voice=config.tts.voice, api_key=config.tts.api_key)
    else:
        tts = SharedPocketTTSService(
            tts_model=engines.tts, voice_state=engines.voice_state(config.voice), voice=config.voice,
        )
    return stt, tts


def build_worker(websocket, config: SessionConfig, engines: Engines) -> tuple[PipelineWorker, ToolRelay]:
    """Assemble the pipeline for one accepted WebSocket."""
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=ClientFrameSerializer(),
            # Origin, Host and ticket were checked before the socket was accepted.
            allowed_origins=[],
        ),
    )

    stt, tts = speech_services(config, engines)
    llm = build_llm(config)

    relay = ToolRelay(frozenset(config.long_running_tools))
    register_tools(llm, relay, config)

    schema = tools_schema(config)
    all_tools = list(schema.standard_tools) if schema else []
    if schema and config.active_tools is not None:
        shown = [tool for tool in all_tools if tool.name in set(config.active_tools)]
        schema = ToolsSchema(standard_tools=shown) if shown else None
    context = LLMContext(tools=schema) if schema else LLMContext()
    rtvi = RelayRTVIProcessor(relay)
    gate = VoiceCommandGate(rtvi.send_server_message)
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=user_turn_params(
            gate,
            # Smart Turn decides when the turn is over, so the VAD only needs
            # a short pause before it asks.
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.2, min_volume=VAD_MIN_VOLUME)),
        ),
        assistant_params=summarization_params(config),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        gate,
        aggregators.user(),
        llm,
        tts,
        transport.output(),
        OwedAnswer(context),
        aggregators.assistant(),
    ])

    latency = UserBotLatencyObserver()

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=AUDIO_IN_RATE,
            audio_out_sample_rate=AUDIO_OUT_RATE,
            enable_metrics=True,
        ),
        rtvi_processor=rtvi,
        # The app needs the name and arguments to run a tool it offered; the
        # result is not echoed back. A call to any other name (the model made
        # it up) is answered inside Pipecat and not announced at all.
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={
                "*": RTVIFunctionCallReportLevel.DISABLED,
                **{name: RTVIFunctionCallReportLevel.ARGUMENTS for name in config.tool_names()},
            },
        ),
        observers=[latency],
        # The app ends the session. A quiet user is not a reason to hang up.
        idle_timeout_secs=None,
    )

    report = LatencyReport()

    @worker.event_handler("on_pipeline_error")
    async def on_pipeline_error(_worker, frame):
        # Pipecat's own record of this is cut down to its location by the
        # redactor, which left a session that ended on an error unexplained.
        logger.error(pipeline_error_line(frame))

    @latency.event_handler("on_latency_measured")
    async def on_latency_measured(_observer, latency_secs):
        report.measured(latency_secs)

    @latency.event_handler("on_latency_breakdown")
    async def on_latency_breakdown(_observer, breakdown):
        # Numbers and stage names only, for the app's latency readout.
        message = report.message(breakdown)
        if message is not None:
            await rtvi.send_server_message(message)

    llm.set_thought_listener(rtvi.send_server_message)
    control = SessionControl(worker, llm, gate, context, all_tools)
    warming: list[asyncio.Task] = []

    @rtvi.event_handler("on_client_message")
    async def on_client_message(_rtvi, message):
        await control.handle(message.type, message.data)

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(_rtvi):
        if config.prewarm and not warming:
            warming.append(asyncio.create_task(prewarm(llm, schema, rtvi.send_server_message)))

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _websocket):
        logger.info("Client disconnected, ending the session.")
        for task in warming:
            task.cancel()
        relay.cancel_all()
        await worker.cancel()

    return worker, relay


async def run_worker(worker: PipelineWorker) -> None:
    # Signals belong to __main__, which shuts the whole process down.
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
    await runner.run(worker)
