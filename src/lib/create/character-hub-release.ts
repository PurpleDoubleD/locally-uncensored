import { create } from 'zustand'

/**
 * Is the new Character area of LU Cloud released for THIS account?
 *
 * The server decides (CHARACTER_HUB and CHARACTER_HUB_ALLOWLIST, web
 * lib/character-hub.ts) and says so as `features.characterHub: true`, both in
 * /api/me and in /api/jobs/catalog. Without the switch the field is missing
 * and the server refuses the new parts with 403 (preview_feature_off).
 *
 * What hangs on it here: Swap Character (two steps, Kling), every sound
 * choice except the original sound, and the lip sync step after a video.
 * The Character area itself is always there; without the switch the Swap
 * action says "Coming soon to your LU Cloud" and Motion sends no sound.
 *
 * Same shape as Create in chat (chat-release.ts): the app only holds the
 * answer, nothing in the build or the settings can switch it on. `null` means
 * not answered yet and reads as "not released".
 */
interface ReleaseState {
  fromMe: boolean | null
  fromCatalog: boolean | null
}

export const useCharacterHubReleaseStore = create<ReleaseState>(() => ({ fromMe: null, fromCatalog: null }))

function flagOf(body: unknown): boolean {
  return (body as { features?: { characterHub?: unknown } } | null)?.features?.characterHub === true
}

/** The answer of /api/me. A body without the field is a no. */
export function noteCharacterHubFromMe(me: unknown): void {
  useCharacterHubReleaseStore.setState({ fromMe: flagOf(me) })
}

/** The answer of /api/jobs/catalog. A catalog without the field is a no. */
export function noteCharacterHubFromCatalog(catalog: unknown): void {
  useCharacterHubReleaseStore.setState({ fromCatalog: flagOf(catalog) })
}

/** Signed out, or the probe was refused: nothing is released. */
export function clearCharacterHubRelease(): void {
  useCharacterHubReleaseStore.setState({ fromMe: null, fromCatalog: null })
}

function released(s: ReleaseState): boolean {
  return s.fromMe === true || s.fromCatalog === true
}

/** For code outside React (the submit). */
export function characterHubReleasedHere(): boolean {
  return released(useCharacterHubReleaseStore.getState())
}

/** For components. Kept current by the account probe and the catalog. */
export function useCharacterHubReleased(): boolean {
  return useCharacterHubReleaseStore(released)
}
