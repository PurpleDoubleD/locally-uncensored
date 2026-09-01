/**
 * Der Cache fertig gebauter Provider-Clients, plus sein Schlüssel.
 *
 * Ein Client wird pro (Slot, baseUrl, Schlüsselanfang) einmal gebaut; ändert
 * sich die Konfiguration, ändert sich der Schlüssel und der alte Eintrag ist
 * tot. Der providerStore leert den Cache zusätzlich bei jeder Schreiboperation,
 * damit ein neu gesetzter API-Key sofort und nicht erst beim nächsten
 * Slot-Wechsel greift.
 *
 * Audit W-T2: Cache und Fabrik saßen zusammen in registry.ts. Der Store wollte
 * nur `clearProviderCache()` und importierte damit die Fabrik — die ihrerseits
 * OpenAIProvider zieht, das über builtin-ensure.ts wieder im Store landet:
 * providerStore → registry → lu-cloud-provider → openai-provider →
 * builtin-ensure → providerStore.
 *
 * Der Cache braucht die Fabrik nicht, nur die Formen. Er liegt deshalb hier,
 * in einem Modul ohne Laufzeit-Import, und beide Seiten greifen darauf zu:
 * registry.ts legt Clients hinein, der Store wirft sie weg. Kante weg,
 * Zyklus weg.
 */

import type { ProviderClient, ProviderConfig } from './types'

const clientCache: Map<string, ProviderClient> = new Map()

/**
 * Create a unique cache key for a provider config.
 * Invalidates when URL or API key changes.
 */
function cacheKey(config: ProviderConfig): string {
  return `${config.id}:${config.baseUrl}:${config.apiKey?.slice(0, 8) || ''}`
}

/**
 * Den Client zu dieser Konfiguration liefern — gebaut wird nur, was noch nicht
 * im Cache liegt.
 */
export function cachedClient(config: ProviderConfig, create: () => ProviderClient): ProviderClient {
  const key = cacheKey(config)
  let client = clientCache.get(key)
  if (!client) {
    client = create()
    clientCache.set(key, client)
  }
  return client
}

/**
 * Clear the client cache (e.g. when provider config changes).
 */
export function clearProviderCache(): void {
  clientCache.clear()
}
