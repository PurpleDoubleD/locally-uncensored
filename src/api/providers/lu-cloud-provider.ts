/**
 * LU Cloud Provider — OpenAI-compatible chat through the lu-labs.ai
 * confidential-inference proxy (`/api/inference/v1`).
 *
 * Thin composition over OpenAIProvider: the only difference is auth — the
 * bearer is the user's short-lived Supabase access token, refreshed per call
 * via getAccessToken(), never a static apiKey from the provider store.
 */

import type {
  ProviderClient, ProviderModel, ProviderConfig, ChatMessage, ChatOptions,
  ChatStreamChunk, ToolCall, ToolDefinition, ChatBilling,
} from './types'
import { ProviderError } from './types'
import { OpenAIProvider } from './openai-provider'
import { getAccessToken } from '../cloud/supabase'
import { CLOUD_BASE } from '../cloud/config'
import { outageAfterFailure } from '../../lib/cloud-outage-watch'

/** `err` as it reaches the chat: while LU Cloud has an outage the server
 *  announced, a failure that may be part of it carries the server's sentence
 *  under the code `outage` (lib/cloud-outage.ts). Anything else unchanged. */
async function asOutage(err: unknown): Promise<unknown> {
  const message = await outageAfterFailure(err)
  return message ? new ProviderError(message, 'lu-cloud', 'outage', 503) : err
}

export class LuCloudProvider implements ProviderClient {
  readonly id = 'lu-cloud' as const
  private config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  // Fresh delegate per call: the token rotates (~1 h), and OpenAIProvider
  // reads apiKey from its config. isLocal:false keeps it off the Rust proxy.
  private async delegate(): Promise<OpenAIProvider> {
    let token: string | null
    try {
      token = await getAccessToken()
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : 'LU Cloud unreachable, check your connection.',
        'lu-cloud',
        'network',
      )
    }
    if (!token) {
      // `signed_out`, not `auth`: there is no session left to refresh, so this
      // is the one 401 on this provider that a retry cannot fix. The retry
      // guard (lib/http-status) keeps every OTHER lu-cloud 401 retryable
      // precisely because the call below re-mints the token.
      throw new ProviderError('Sign in to your LU Cloud account to chat in the cloud.', 'lu-cloud', 'signed_out', 401)
    }
    // Hard-pin the endpoint at call time. The Supabase access token is a live
    // bearer; if we trusted `this.config.baseUrl` a tampered provider store could
    // repoint it at an attacker host and leak the token (security review 2.5.7).
    return new OpenAIProvider({
      ...this.config,
      baseUrl: `${CLOUD_BASE}/api/inference/v1`,
      apiKey: token,
      isLocal: false,
      // Its reasoners continue from their own reasoning between tool calls
      // (lib/agent-core/reasoning-replay.ts).
      replayReasoning: true,
    })
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatStreamChunk> {
    try {
      const inner = await this.delegate()
      yield* inner.chatStream(model, messages, options)
    } catch (err) {
      throw await asOutage(err)
    }
  }

  async chatWithTools(
    model: string,
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<{ content: string; toolCalls: ToolCall[]; promptEvalCount?: number; evalCount?: number; cachedPromptCount?: number; thinking?: string; billing?: ChatBilling }> {
    try {
      const inner = await this.delegate()
      return await inner.chatWithTools(model, messages, tools, options)
    } catch (err) {
      throw await asOutage(err)
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const inner = await this.delegate()
    const models = await inner.listModels()
    // Rebrand: the delegate reports provider 'openai' — these are LU Cloud.
    return models.map((m) => ({ ...m, provider: this.id, providerName: 'LU Cloud' }))
  }

  async checkConnection(): Promise<boolean> {
    try {
      const inner = await this.delegate()
      return await inner.checkConnection()
    } catch {
      return false
    }
  }

  async getContextLength(model: string): Promise<number> {
    const inner = await this.delegate()
    return inner.getContextLength(model)
  }
}
