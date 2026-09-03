/**
 * The num_ctx an agent turn runs with — resolved in ONE place because every
 * request that touches the SAME Ollama model must send the SAME value.
 *
 * Ollama allocates the KV cache at load time and RELOADS the model whenever
 * num_ctx changes between requests. Captured off the wire on the ship exe
 * (2026-07-25): the chat request went out with `num_ctx: 32768` and the memory
 * extraction that follows EVERY agent turn went out with no options at all, so
 * Ollama threw away the 32k allocation and reloaded the model at its own
 * default. `ollama ps` then reported `context_length: 4096` while LU's own bar
 * still said "ctx 32K", and each turn paid for two model loads instead of one.
 *
 * So: same model, same num_ctx, no reload. Callers that talk to a different
 * model (a dedicated small extraction model, say) are free to resolve their own.
 */

import { getModelContextCached } from '../api/ollama'
import { getProviderForModel } from '../api/providers'
import { AGENT_CONTEXT_CAP, effectiveContextWindow } from './context-window'
import { getModelMaxTokens } from './context-compaction'

/**
 * @param modelId       provider-local model id (already stripped of any prefix)
 * @param providerId    'ollama' | 'openai' | 'lu-cloud' | …
 * @param override      the user's contextWindowOverride (0 = none)
 * @param fullModelName the UNstripped model name ('lu-cloud:Qwen/…') — needed
 *                      to resolve a cloud model's real window from the catalog
 *
 * The override wins outright. Without one, Ollama models get their REAL context
 * capped at AGENT_CONTEXT_CAP, floored at 8192 so feeding a generated image back
 * for vision feedback never overflows a 4096-default model.
 *
 * The agent ceiling, not the chat one: this resolver only ever runs for a turn
 * that carries the tool catalogue, and that catalogue measured 8488 tokens on
 * the installed build, which is 52% of the chat cap before the work starts. A
 * run under the chat cap reached step 18 of 30, compacted, and restarted its
 * own plan (David, 2026-08-06: "Du kannst nicht eine Riesencoding Aufgabe in
 * 'nem sechzehn k Kontext rausschicken"). See context-window.ts for the VRAM
 * measurement that says the larger ceiling offloads rather than OOMs.
 *
 * Cloud models resolve their REAL window from the model catalog. They used to
 * fall through to the flat 8192 — there is no KV-cache/VRAM cost on our side,
 * but the compaction budget derives from this value, so a 262k cloud model was
 * trimmed to ~6.5k every iteration. The model "forgot" the files it had just
 * read, the trim notice told it to re-read them, and the coding agent looped
 * on the same file_read for minutes (Morgan, 2026-07-26).
 */
/**
 * Das Fenster UND die Auskunft, ob es gemessen oder geraten ist.
 *
 * ── WARUM DAS EINE EIGENE AUSKUNFT SEIN MUSS ───────────────────────────────
 *
 * Bei jedem Fehlschlag faellt diese Funktion auf den flachen Boden 8192
 * zurueck. Der Auto-Ausloeser braucht aber die Unterscheidung "gemessen" vs.
 * "geraten", weil er im zweiten Fall eine Sicherheitsmarge abzieht — und er
 * hatte sie sich bis 2026-09-02 aus der ZAHL erschlossen: `window !== 8192`.
 *
 * Das war in beide Richtungen falsch. 8192 ist Ollamas Voreinstellung und ein
 * voellig legitimer Override; ein Modell, das wirklich mit 8192 laeuft, galt
 * damit dauerhaft als unsicher und wurde acht Prozentpunkte zu frueh
 * zusammengefasst. Und `Math.max(real, 8192)` macht aus jedem echten
 * 8192er-Fenster ebenfalls eine 8192 — dieselbe Fehldeutung.
 *
 * Eine Zahl kann nicht sagen, woher sie kommt. Also sagt es die Funktion.
 */
export async function resolveAgentNumCtxWithConfidence(
  modelId: string,
  providerId: string,
  override: number | undefined,
  fullModelName?: string,
): Promise<{ ctx: number; gemessen: boolean }> {
  let ctx: number = override || 8192
  // Hat ueberhaupt jemand geantwortet? Ein Override ist eine Angabe des
  // Nutzers und zaehlt als Antwort; alles andere erst, wenn die Abfrage
  // wirklich eine Zahl geliefert hat.
  let gemessen = !!override
  if (!override) {
    if (providerId === 'ollama') {
      try {
        ctx = Math.max(
          effectiveContextWindow(await getModelContextCached(modelId), 0, AGENT_CONTEXT_CAP),
          8192,
        )
        gemessen = true
      } catch { /* keep the 8192 floor on failure */ }
    } else {
      try {
        const real = await getModelMaxTokens(fullModelName ?? modelId)
        if (typeof real === 'number' && Number.isFinite(real) && real > 0) {
          ctx = Math.max(real, 8192)
          gemessen = true
        }
        // R19 (LM Studio, twice the cause of a run death): the KV cache is
        // allocated at JIT-load time and a prompt beyond it is hard-truncated
        // server-side, tool contract included. When the server says what it
        // actually loaded, that number IS the budget — even below the 8192
        // floor, because the floor cannot grow an allocation we do not
        // control. Ollama is different: there num_ctx sets the allocation.
        if (providerId === 'openai') {
          const { provider, modelId: rawId } = getProviderForModel(fullModelName ?? modelId)
          const loaded = await provider.loadedContextLength?.(rawId)
          if (typeof loaded === 'number' && loaded > 0 && loaded < ctx) {
            ctx = loaded
            gemessen = true
          }
        }
      } catch { /* keep the 8192 floor on failure */ }
    }
  }
  return { ctx, gemessen }
}

/**
 * Dasselbe Fenster, nur als blosse Zahl — der Weg, den fast alle gehen.
 *
 * Die Vertrauensfrage interessiert genau einen Aufrufer: den Auto-Ausloeser,
 * der eine Sicherheitsmarge abzieht, solange der Nenner geraten ist. Alle
 * anderen wollen eine Budgetzahl und sonst nichts.
 */
export async function resolveAgentNumCtx(
  modelId: string,
  providerId: string,
  override: number | undefined,
  fullModelName?: string,
): Promise<number> {
  return (await resolveAgentNumCtxWithConfidence(modelId, providerId, override, fullModelName)).ctx
}
