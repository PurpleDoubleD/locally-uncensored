/**
 * What zustand's persist `version` / `migrate` pair actually does, and why most
 * of this app's stores deliberately declare neither.
 *
 * The 2.6.8 audit asked for `version: 1` plus a no-op `migrate` on the 17 stores
 * that have none, on the argument that a store which never declared a version
 * writes no version into its blob — so the day someone adds one, zustand finds
 * `undefined`, skips migrate, and hands the old shape through as if it were
 * already current. Measured against zustand 5.0.12 that is not what happens:
 *
 *   let options = { storage: ..., partialize: ..., version: 0, ... }
 *   const setItem = () => storage.setItem(options.name, { state, version: options.version })
 *                                        — zustand/esm/middleware.mjs, persistImpl
 *
 * `version: 0` is persistImpl's OWN default, and it is written into every blob.
 * So an "unversioned" store is really a version-0 store, and a future
 * `version: 1` + migrate reaches every existing user with `version === 0`.
 * persist-version.test.ts runs all three facts against the real library.
 *
 * Stamping a number anyway is not free. An older build that declares no version
 * uses the same default 0, sees a blob at 1, has no migrate to call, logs
 * "couldn't be migrated" and hydrates with `migratedState === undefined` — it
 * throws the user's whole persisted state away. That is the R1
 * DOWNGRADE-KONTRAKT codexStore spells out: 2.6.x builds share one WebView
 * profile, so a downgrade is a real path, and a version bump that buys nothing
 * must not cost a reset on it.
 *
 * What IS worth enforcing is the pair. A `version` WITHOUT a `migrate` is the
 * one combination that loses data on any mismatch, in both directions.
 * persist-version.test.ts asserts that no store declares one without the other.
 */

/**
 * The identity migration, for a store that declares a version but has nothing
 * to migrate yet — its job is to exist, so the mismatch branch has something to
 * call instead of discarding the state.
 *
 * Generic so each store's own persisted shape is what comes back out: zustand
 * types `migrate` as `(persistedState: unknown, version: number) => S`, and the
 * cast is the whole point — nothing about the value changes, only what the
 * caller is allowed to assume about it.
 */
export function keepPersistedState<S>(persisted: unknown): S {
  return persisted as S
}
