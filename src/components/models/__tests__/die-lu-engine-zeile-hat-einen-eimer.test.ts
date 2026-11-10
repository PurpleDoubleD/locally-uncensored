/**
 * .dan_48 (help chat, 2026-09-05, LU 2.6.7, GTX 1660 Ti with 6 GB): "I see
 * nowhere to delete models on the app", with a screenshot of two LU Engine
 * rows that had Bench and Details and no bin, and Details asked Ollama about
 * a file Ollama has never seen. The row is a file; the file is what the two
 * buttons act on now.
 *
 * Run: npx vitest run src/components/models/__tests__/die-lu-engine-zeile-hat-einen-eimer.test.ts
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const MANAGER = fs.readFileSync(path.join(__dirname, '..', 'ModelManager.tsx'), 'utf8')
const ENGINE_API = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'api', 'engine.ts'), 'utf8')
const RUST = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'commands', 'engine.rs'), 'utf8')
const MAIN = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`anchor missing: ${from} .. ${to}`)
  return src.slice(a, b)
}

describe('an LU Engine row can be deleted', () => {
  it('the bin shows on an LU Engine row, next to Ollama and ComfyUI rows', () => {
    const canDelete = slice(MANAGER, 'canDelete={', '}\n')
    expect(canDelete).toContain('|| luEngineFile(model)')
  })

  // C17 (3.1.0): the bin opens the uninstall dialog, which reads the files
  // of the model from the backend and deletes them there.
  const DIALOG = fs.readFileSync(path.join(__dirname, '..', 'UninstallDialog.tsx'), 'utf8')

  it('the row asks the uninstall dialog about its file, and whether it is loaded', () => {
    const req = slice(MANAGER, 'const uninstallRequestFor', 'const handleDelete')
    expect(req).toContain("if (luEngineFile(model)) return { kind: 'engine', name: displayModelName(model.name), path: model.path, active: model.name === activeModel }")
  })

  it('the loaded model is stopped before its file goes, and the list is re-read after', () => {
    const branch = slice(DIALOG, "if (plan.kind === 'engine'", "} else if (plan.kind === 'ollama'")
    const stop = branch.indexOf('if (request.active) await stopBundledEngine()')
    const del = branch.indexOf('await deleteBundledModel(request.path, { trash: toTrash })')
    expect(stop).toBeGreaterThan(0)
    expect(del).toBeGreaterThan(stop)
    const after = slice(DIALOG, "if (plan.kind === 'engine'", "setPhase({ at: 'done'")
    expect(after).toContain('await Promise.resolve(onDone())')
    expect(MANAGER).toContain('onDone={async () => { await fetchModels() }}')
  })

  it('the dialog names every file that goes, from the same plan the delete acts on', () => {
    expect(DIALOG).toContain('const { files } = await bundledModelDeletePlan(request.path)')
    expect(DIALOG).toContain('data-testid="uninstall-file-delete"')
    expect(DIALOG).toContain('{f.path && <span')
    const plan = slice(RUST, 'pub async fn bundled_model_delete_plan', 'pub async fn delete_bundled_model')
    expect(plan).toContain('gguf_delete_plan(Path::new(&path), &roots)?')
  })

  it('Details on an LU Engine row is the file, not a question to Ollama', () => {
    const info = slice(MANAGER, 'const handleInfo = async', 'const info = await showModel(name)')
    expect(info).toContain('file: model.path')
    expect(info).toContain('size: model.size')
  })

  it('the delete goes through the backend with the Storage folders, like the listing', () => {
    const api = slice(ENGINE_API, 'export async function deleteBundledModel', 'export function stopBundledEngine')
    expect(api).toContain("backendCall<{ deleted?: number; bytes?: number }>('delete_bundled_model'")
    expect(api).toContain('extraDirs: customModelDirs()')
    expect(MAIN).toContain('commands::engine::delete_bundled_model,')
  })

  it('the backend refuses the loaded model and judges the path after canonicalize', () => {
    const cmd = slice(RUST, 'pub async fn delete_bundled_model', 'fn list_bundled_models_blocking')
    // C17: the plan command reads, it deletes nothing.
    const readOnly = slice(RUST, 'pub async fn bundled_model_delete_plan', 'pub async fn delete_bundled_model')
    expect(readOnly).not.toContain('remove_file')
    expect(cmd).toContain('This model is loaded in the LU Engine right now.')
    expect(cmd).toContain('gguf_delete_plan(Path::new(&path), &roots)?')
    const plan = slice(RUST, 'pub(crate) fn gguf_delete_plan', 'pub async fn delete_bundled_model')
    expect(plan).toContain('std::fs::canonicalize(path)')
    expect(plan).toContain('file.starts_with(&r)')
    expect(plan).toContain('split_shard_stem(stem)')
  })
})
