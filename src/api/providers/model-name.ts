/**
 * Der Modellname als Zeichenkette: wie ein Slot-Präfix drangeschrieben,
 * ausgelesen und wieder abgeschnitten wird.
 *
 *   "ollama::llama3.1:8b"  →  Slot ollama, Modell llama3.1:8b
 *   "llama3.1:8b"          →  Slot ollama (kein Präfix = Ollama, Altbestand)
 *
 * Audit W-T2: Diese drei Funktionen standen in registry.ts, zwischen der
 * Client-Fabrik und dem Zugriff auf den providerStore. Wer nur wissen wollte,
 * zu welchem Slot ein Name gehört — api/engine.ts, stores/modelStore.ts und ein
 * Dutzend Komponenten —, zog damit die vier Provider-Klassen und den Store mit
 * herein. Über engine.ts und modelStore.ts schloss sich daraus ein Kreis:
 * providers/index → openai-provider → builtin-ensure → providerStore →
 * modelStore/engine → providers/index.
 *
 * Sie brauchen nichts davon. Es sind reine Zeichenketten-Funktionen, sie
 * kennen nur den Typ eines Slot-Bezeichners. Also liegen sie hier, in einem
 * Modul ohne Laufzeit-Import. registry.ts und providers/index.ts exportieren
 * sie unverändert weiter.
 */

import type { ProviderId } from './types'

/**
 * Extract the provider ID from a prefixed model name.
 * Returns 'ollama' if no prefix.
 */
export function getProviderIdFromModel(modelName: string): ProviderId {
  if (!modelName) return 'ollama'
  const parts = modelName.split('::')
  return parts.length === 2 ? parts[0] as ProviderId : 'ollama'
}

/**
 * Create a prefixed model name for storage.
 */
export function prefixModelName(provider: ProviderId, modelId: string): string {
  if (provider === 'ollama') return modelId // backward compat: Ollama models have no prefix
  return `${provider}::${modelId}`
}

/**
 * Get the display name for a model (strip provider prefix).
 */
export function displayModelName(modelName: string): string {
  const parts = modelName.split('::')
  return parts.length === 2 ? parts[1] : modelName
}
