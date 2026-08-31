/**
 * The app ships under AGPL-3.0-only. That is a promise about what a user may
 * do with the binary, and it only holds if nothing in the production tree
 * carries terms that contradict it — a GPL-2.0-only dependency cannot be
 * relicensed forward into v3, and a source-available licence (SSPL, Commons
 * Clause, "UNLICENSED") is not free software at all.
 *
 * A dependency bump is exactly how such a licence arrives: nobody reads the
 * new transitive tree. This reads package-lock.json, which records a licence
 * per resolved package, so the check is offline and exact about the versions
 * that actually install.
 *
 * Run: npx vitest run src/api/__tests__/prod-licenses.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type LockEntry = { version?: string; dev?: boolean; optional?: boolean; license?: string }

const lock = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package-lock.json'), 'utf8'),
) as { packages: Record<string, LockEntry> }

/** Everything that can reach a user's machine: the root and devDependencies
 *  are out, optional platform builds stay in — one of them ships per OS. */
const production = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev)

/**
 * Terms that cannot travel inside an AGPL-3.0-only release.
 * GPL-2.0-**or-later** is fine (it upgrades into v3), GPL-3.0 and AGPL-3.0 are
 * fine (that is what we are), so only the version-locked v2 forms and the
 * non-free licences are listed.
 */
const INCOMPATIBLE = [
  /^GPL-2\.0(-only)?$/i,
  /^LGPL-2\.[01](-only)?$/i,
  /\bSSPL\b/i,
  /Commons\s*Clause/i,
  /^UNLICENSED$/,
  /\bCC-BY-NC/i,
  /^BUSL/i,
  /Elastic-2\.0/i,
]

describe('production dependency licences stay compatible with AGPL-3.0-only', () => {
  it('has a production tree to check at all', () => {
    // A refactor that renames the lock format would otherwise turn every
    // assertion below into a green no-op.
    expect(production.length).toBeGreaterThan(100)
  })

  it('carries no licence that an AGPL-3.0-only release cannot contain', () => {
    const bad = production
      .filter(([, e]) => e.license && INCOMPATIBLE.some((re) => re.test(e.license!)))
      .map(([p, e]) => `${p} -> ${e.license}`)
    expect(bad).toEqual([])
  })

  it('names every package that declares no licence at all', () => {
    // Both of these carry an MIT LICENSE file and an MIT header in the source;
    // only the package.json metadata is missing (format@0.2.2 uses the retired
    // `licenses` array, webgl-constants@1.1.1 has no field). Checked by hand —
    // a third name appearing here has NOT been checked and must be.
    const undeclared = production.filter(([, e]) => !e.license).map(([p]) => p)
    expect(undeclared.sort()).toEqual(['node_modules/format', 'node_modules/webgl-constants'])
  })

  it('has exactly one unspecific licence string, and it is duck', () => {
    // npm reports duck@0.1.12 as "BSD*" because the package only says "BSD".
    // Its LICENSE file is the two-clause form — copyright notice, binary
    // notice, disclaimer, and no endorsement clause — which is BSD-2-Clause,
    // the same licence its sibling `lop` (same author) declares outright.
    // Permissive, so it travels into an AGPL release without a condition.
    const unspecific = production
      .filter(([, e]) => /^(BSD|MIT\*|Apache|GPL)$/i.test(e.license ?? ''))
      .map(([p, e]) => `${p} -> ${e.license}`)
    expect(unspecific).toEqual(['node_modules/duck -> BSD'])
  })
})
