# Remote LU Engine recovery

Remote Access can recover an unexpectedly exited, app-managed LU Engine while the desktop app remains open. Start a model successfully before dispatching a session; the recovery recipe exists only for the current desktop app run.

Recovery preserves the model path, latest successful requested tuning, and serving port. It waits for an existing desktop reload, then probes the tracked child. Concurrent phone requests share the engine start gate. A living but unready engine returns a temporary error rather than being killed. A desktop model change requires a fresh Remote dispatch.

Explicit engine stops remain authoritative. Recovery does not clear the stop flag. External OpenAI-compatible providers and additional provider entries remain outside native recovery.

Dispatch and restart refresh the managed engine port from native status. Each inference attempt resolves it again, including after recovery chooses a fallback port. The engine authentication key stays in the native bridge.

Only a buffered inference completion may be retried once after a transport failure or HTTP 502/503/504. Remote tool execution is not replayed. Deterministic upstream errors and invalid successful JSON responses are returned directly.

## 256K context configuration

For the Qwen3.8-27B GGUF with `qwen35` architecture and a declared 262144-token context, configure Settings → AI Backends → LU Engine:

```json
{
  "ctx": 262144,
  "flashAttn": "on",
  "cacheTypeK": "q8_0",
  "cacheTypeV": "q4_0",
  "gpuLayers": -1
}
```

Apply and restart the engine before dispatching Remote Access.

This model has 16 full-attention layers. At 256K, mixed q8/q4 K/V uses approximately 6.5 GiB; q8/q8 uses 8.5 GiB. Weights, projector, recurrent state, compute buffers, and other applications consume additional memory. The automatic GPU setting (`-1`) delegates placement to the bundled engine's tensor-aware fitter, preserving the requested context and cache types. An explicit layer count overrides that placement decision.

The phone receives the active context together with its model identity. Its coding agent reserves room for output and tool definitions before budgeting history; a different selected model uses the conservative fallback until its own capacity is known. Stop cancels only that paired device's inference request and does not restart the model server.

Allocation success does not establish long-context answer quality or prompt speed. Quantized V can reduce quality; verify representative prompts and retain headroom for other GPU workloads.

## Local deployment verification

On 2026-10-20, the recovery build loaded this context and cache configuration with explicit full offload (`gpuLayers: 999`) on an RTX 5090 with 32 GiB VRAM. A browser Code request completed a read-only `file_list` tool round trip. After forcibly terminating only the chat `llama-server` process, the next Code request restarted the same model with that tuning and completed another `file_list` round trip. The desktop app, Remote listener, and paired browser session stayed running. This predates the automatic-fitting default above.

This verifies model allocation and recovery with short prompts. Full-window retrieval quality and 256K prompt throughput have not been benchmarked. The installed executable is a local build; a future application update can replace it, so retain the source changes and deployment backup.
