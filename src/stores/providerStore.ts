/**
 * Provider Store — manages provider configurations.
 *
 * Stores endpoint URLs, API keys (encrypted), and enabled state.
 * Ollama is always enabled by default.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ProviderId, ProviderConfig } from '../api/providers/types'
import { clearProviderCache } from '../api/providers/registry'

// ── API Key Encryption ─────────────────────────────────────────
// Simple base64 obfuscation. Not true encryption, but prevents
// plaintext keys in localStorage and casual inspection.
// Full WebCrypto would be better but requires async init.

function obfuscate(key: string): string {
  if (!key) return ''
  try {
    return btoa(key.split('').reverse().join(''))
  } catch {
    return key
  }
}

function deobfuscate(encoded: string): string {
  if (!encoded) return ''
  try {
    return atob(encoded).split('').reverse().join('')
  } catch {
    return encoded
  }
}

// ── Default provider configs ───────────────────────────────────

const DEFAULT_PROVIDERS: Record<ProviderId, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    enabled: true,
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    isLocal: true,
  },
  openai: {
    id: 'openai',
    name: 'LM Studio',
    enabled: true,
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    isLocal: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: false,
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    isLocal: false,
  },
}

// ── Store Interface ────────────────────────────────────────────

interface ProviderState {
  providers: Record<ProviderId, ProviderConfig>

  setProviderConfig: (id: ProviderId, updates: Partial<ProviderConfig>) => void
  setProviderApiKey: (id: ProviderId, key: string) => void
  getProviderApiKey: (id: ProviderId) => string
  getEnabledProviders: () => ProviderConfig[]
  resetProvider: (id: ProviderId) => void
}

// ── Zustand Store ──────────────────────────────────────────────

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      providers: DEFAULT_PROVIDERS,

      setProviderConfig: (id, updates) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], ...updates },
          },
        }))
        clearProviderCache() // invalidate cached clients
      },

      setProviderApiKey: (id, key) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: { ...state.providers[id], apiKey: obfuscate(key) },
          },
        }))
        clearProviderCache()
      },

      getProviderApiKey: (id) => {
        return deobfuscate(get().providers[id]?.apiKey || '')
      },

      getEnabledProviders: () => {
        const providers = get().providers
        return Object.values(providers)
          .filter((p) => p.enabled)
          .map((p) => ({
            ...p,
            apiKey: deobfuscate(p.apiKey), // deobfuscate for use
          }))
      },

      resetProvider: (id) => {
        set((state) => ({
          providers: {
            ...state.providers,
            [id]: DEFAULT_PROVIDERS[id],
          },
        }))
        clearProviderCache()
      },
    }),
    {
      name: 'lu-providers',
      version: 1,
      // Don't persist transient state, only configs
      partialize: (state) => ({ providers: state.providers }),
    }
  )
)
