/**
 * Ambient declarations for globals the app reads off `window`.
 *
 * The Tauri runtime injects these itself — there is no import that brings
 * them into the type system — so without this file every read had to go
 * through an `as any` cast (or, in App.tsx, simply failed to compile).
 * `unknown` is deliberate: these are only ever used as presence checks
 * ("are we running inside the Tauri WebView?"), never called through.
 */
declare global {
  interface Window {
    /** Tauri v2 runtime bridge. Present only inside the Tauri WebView. */
    __TAURI_INTERNALS__?: unknown
    /** Tauri v1 runtime bridge / v2 `withGlobalTauri` alias. */
    __TAURI__?: unknown
  }
}

export {}
