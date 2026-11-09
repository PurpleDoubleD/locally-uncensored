/**
 * Where the Hugging Face token is saved.
 *
 * Windows and macOS: the OS keychain. Linux has no keychain in LU
 * (secret.rs answers "keychain unsupported"), so there the token goes to
 * localStorage, obfuscated the same way as the provider keys.
 */
import { secretGet, secretSet } from '../api/backend'
import { HF_TOKEN_ACCOUNT } from '../api/mlx-image'
import { isKeychainMissing } from './parked-key'
import { obfuscate, deobfuscate } from '../stores/providerStore'

const FALLBACK_KEY = 'lu-hf-token'

export async function saveHfToken(token: string): Promise<void> {
  try {
    await secretSet(HF_TOKEN_ACCOUNT, token)
    try { localStorage.removeItem(FALLBACK_KEY) } catch { /* no storage */ }
    return
  } catch (err) {
    if (!isKeychainMissing(err)) throw err
  }
  if (token) localStorage.setItem(FALLBACK_KEY, obfuscate(token))
  else localStorage.removeItem(FALLBACK_KEY)
}

export async function loadHfToken(): Promise<string | null> {
  try {
    return await secretGet(HF_TOKEN_ACCOUNT)
  } catch (err) {
    if (!isKeychainMissing(err)) return null
  }
  try {
    const stored = localStorage.getItem(FALLBACK_KEY)
    return stored ? deobfuscate(stored) : null
  } catch {
    return null
  }
}
