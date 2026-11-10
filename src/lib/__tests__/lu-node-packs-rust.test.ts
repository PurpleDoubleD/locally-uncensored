// The chat may only install node packs from LU's own list, and Rust enforces
// that with its own copy of the list (install/lu_node_packs.rs, C60-S5). This
// test keeps the copy equal to CUSTOM_NODE_REGISTRY: key, repo, folder name
// and pinned commit.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CUSTOM_NODE_REGISTRY } from '../../api/model-bundles'

const rust = readFileSync(resolve(__dirname, '../../../src-tauri/src/commands/install/lu_node_packs.rs'), 'utf8')

function rustList(): { key: string; repo: string; name: string; commit: string | null }[] {
  const out: { key: string; repo: string; name: string; commit: string | null }[] = []
  const re = /LuNodePack \{ key: "([^"]+)", repo: "([^"]+)", name: "([^"]+)", commit: (None|Some\("([0-9a-f]+)"\)) \}/g
  for (const m of rust.matchAll(re)) out.push({ key: m[1], repo: m[2], name: m[3], commit: m[5] ?? null })
  return out
}

describe('LU node pack list, TypeScript and Rust', () => {
  it('the same packs with the same repo, folder and commit', () => {
    const ts = Object.entries(CUSTOM_NODE_REGISTRY).map(([key, e]) => ({ key, repo: e.repo, name: e.name, commit: e.commit ?? null }))
    expect(rustList()).toEqual(ts)
  })
})
