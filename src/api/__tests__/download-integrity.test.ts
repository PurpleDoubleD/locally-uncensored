/**
 * Was ein Download beweisen muss, bevor er als fertig gilt
 *
 * Drei Befunde treffen sich hier, weil sie alle in discover.ts entschieden
 * werden:
 *
 *  - Es gab keine Integritaetspruefung. Die Vollstaendigkeit hing an einer
 *    Dateigroesse mit 10 % Toleranz gegen einen gerundeten Katalogwert; mehrere
 *    Gigabyte Modellgewichte wurden so akzeptiert. HuggingFace nennt fuer jede
 *    LFS-Datei den SHA256 — der wird jetzt gelesen und durchgereicht.
 *  - Der Speicherplatz-Guard lief N-mal gegen dieselben freien Bytes, weil
 *    jede Bundle-Datei ihn fuer sich stellte. Die Summe ist die einzige
 *    ehrliche Frage.
 *  - 106 fest verdrahtete HF-Adressen ohne Liveness: bei umbenanntem oder
 *    gated Repo bekam der Nutzer "HTTP 404" und einen Retry-Knopf, der nie
 *    funktionieren kann.
 *
 * Run: npx vitest run src/api/__tests__/download-integrity.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  bundleBytesToFetch, isPermanentDownloadError, lfsSha256, orphanFilename,
  planModelDownload, selectGgufFromTree, getVideoBundles, getImageBundles,
  type ModelBundle, type DiscoverModel,
} from '../discover'

const GIB = 1_073_741_824

function bundle(files: Array<Partial<DiscoverModel>>, totalSizeGB = 0): ModelBundle {
  return {
    name: 'Test bundle',
    description: '',
    tags: [],
    totalSizeGB,
    vramRequired: '8 GB',
    workflow: 'wan',
    files: files.map(f => ({
      name: '', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://huggingface.co/x/y/resolve/main/f.safetensors',
      subfolder: 'diffusion_models',
      ...f,
    })) as DiscoverModel[],
  }
}

describe('the bundle asks for space once, for the sum', () => {
  it('adds up every file that still has to be fetched', () => {
    const b = bundle([
      { filename: 'model.gguf', sizeGB: 16 },
      { filename: 'vae.safetensors', sizeGB: 0.3, subfolder: 'vae' },
      { filename: 'text_encoder.safetensors', sizeGB: 6.7, subfolder: 'text_encoders' },
      { filename: 'clip.safetensors', sizeGB: 1 },
    ])

    const need = bundleBytesToFetch(b, new Set())
    expect(need.files).toBe(4)
    expect(need.bytes).toBe(Math.round(24 * GIB))
    // Die alte Vorabpruefung stellte dieselbe Frage viermal mit 16, 0.3, 6.7
    // und 1 GB und liess sie alle durch — auf einer Platte mit 17 GB frei.
    expect(need.bytes).toBeGreaterThan(17 * GIB)
  })

  it('leaves out what is already on disk · sonst wird ein passender Install abgelehnt', () => {
    const b = bundle([
      { filename: 'model.gguf', sizeGB: 16 },
      { filename: 'vae.safetensors', sizeGB: 0.3, subfolder: 'vae' },
    ])
    const need = bundleBytesToFetch(b, new Set(['model.gguf']))
    expect(need.files).toBe(1)
    expect(need.bytes).toBe(Math.round(0.3 * GIB))
    expect(need.subfolder).toBe('vae')
  })

  it('falls back to the bundle total when no file states a size', () => {
    const b = bundle([{ filename: 'model.gguf' }], 9.2)
    expect(bundleBytesToFetch(b, new Set()).bytes).toBe(Math.round(9.2 * GIB))
  })

  it('asks for nothing when everything is already installed', () => {
    const b = bundle([{ filename: 'model.gguf', sizeGB: 16 }], 16)
    expect(bundleBytesToFetch(b, new Set(['model.gguf']))).toEqual({ bytes: 0, files: 0 })
  })

  it('every shipped bundle can be summed · sonst greift die Pruefung nie', () => {
    for (const b of [...getVideoBundles(), ...getImageBundles()]) {
      const need = bundleBytesToFetch(b, new Set())
      expect(need.bytes, `${b.name} hat keine plausible Gesamtgroesse`).toBeGreaterThan(0)
      expect(need.subfolder, `${b.name} hat kein Zielverzeichnis`).toBeTruthy()
    }
  })
})

describe('a dead address is not a retry', () => {
  it('recognises the statuses that can never come back', () => {
    // Genau die Form, die http_error_message in download.rs erzeugt.
    expect(isPermanentDownloadError('x.safetensors is not at this address any more (HTTP 404).')).toBe(true)
    expect(isPermanentDownloadError('needs a HuggingFace login (HTTP 403).')).toBe(true)
    expect(isPermanentDownloadError('needs a HuggingFace login (HTTP 401).')).toBe(true)
    expect(isPermanentDownloadError('gone (HTTP 410).')).toBe(true)
  })

  it('leaves everything temporary retryable', () => {
    expect(isPermanentDownloadError('The host is rate limiting this download (HTTP 429).')).toBe(false)
    expect(isPermanentDownloadError('The host could not serve it right now (HTTP 503).')).toBe(false)
    expect(isPermanentDownloadError('Download ended early: 3 of 6 bytes received.')).toBe(false)
    expect(isPermanentDownloadError('Request failed: connection reset')).toBe(false)
    expect(isPermanentDownloadError('Not enough free space for m.gguf.')).toBe(false)
    expect(isPermanentDownloadError(undefined)).toBe(false)
    expect(isPermanentDownloadError('')).toBe(false)
    // Eine 404 in einer URL ist kein Status.
    expect(isPermanentDownloadError('https://host/404/model.gguf failed')).toBe(false)
  })
})

describe('the digest HuggingFace already publishes', () => {
  it('reads the sha256 out of the LFS pointer', () => {
    const oid = 'b'.repeat(64)
    const files = selectGgufFromTree(
      [{ type: 'file', path: 'model-Q4_K_M.gguf', size: 4_000_000_000, lfs: { oid, size: 4_000_000_000 } }],
      'unsloth/whatever',
    )
    expect(files?.files[0].sha256).toBe(oid)
  })

  it('refuses a git blob hash · 40 Hexzeichen sind kein Inhalts-Digest', () => {
    expect(lfsSha256({ type: 'file', path: 'x.gguf', lfs: { oid: 'c'.repeat(40) } })).toBeUndefined()
    expect(lfsSha256({ type: 'file', path: 'x.gguf' })).toBeUndefined()
    expect(lfsSha256({ type: 'file', path: 'x.gguf', lfs: { oid: 'not hex at all' } })).toBeUndefined()
    // Grossschreibung normalisiert, statt die Pruefung wegzuwerfen.
    expect(lfsSha256({ type: 'file', path: 'x.gguf', lfs: { oid: 'D'.repeat(64) } })).toBe('d'.repeat(64))
  })

  it('carries the digest into the download plan', () => {
    const sha = 'e'.repeat(64)
    const model: DiscoverModel = {
      name: 'M', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://huggingface.co/x/y/resolve/main/m.gguf', filename: 'm.gguf', sha256: sha,
    }
    const plan = planModelDownload(model, model.downloadUrl!, 'm.gguf', 100)
    expect(plan[0].sha256).toBe(sha)
  })

  it('drops the catalog digest when the HF tree corrected the URL', () => {
    // Sonst wuerde der Hash einer anderen Datei gegen diese geprueft und JEDER
    // Download dieses Modells als korrupt geloescht.
    const model: DiscoverModel = {
      name: 'M', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://huggingface.co/x/y/resolve/main/guessed.gguf', filename: 'guessed.gguf',
      sha256: 'f'.repeat(64),
    }
    const plan = planModelDownload(model, 'https://huggingface.co/x/y/resolve/main/Q4_K_M/real.gguf', 'real.gguf', 100)
    expect(plan[0].sha256).toBeUndefined()
    // Der aufgeloeste Hash gewinnt, wenn es einen gibt.
    const resolved = planModelDownload(model, 'https://other/real.gguf', 'real.gguf', 100, 'a'.repeat(64))
    expect(resolved[0].sha256).toBe('a'.repeat(64))
  })

  it('never hands the model digest to its vision projector', () => {
    const model: DiscoverModel = {
      name: 'M', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: 'https://huggingface.co/x/y/resolve/main/m.gguf', filename: 'm.gguf',
      sha256: 'a'.repeat(64), mmprojUrl: 'https://huggingface.co/x/y/resolve/main/mmproj.gguf', mmprojSizeGB: 1,
    }
    const plan = planModelDownload(model, model.downloadUrl!, 'm.gguf', 100)
    expect(plan).toHaveLength(2)
    expect(plan[1].sha256).toBeUndefined()
  })
})

describe('recovering the name of an orphaned partial', () => {
  it('matches the stem back to the real filename', () => {
    // with_extension ERSETZT die Endung: aus wan_2.1_vae.safetensors wird
    // wan_2.1_vae.download, der Rest steht nirgends mehr auf der Platte.
    const known = ['wan_2.1_vae.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']
    expect(orphanFilename('wan_2.1_vae', known)).toBe('wan_2.1_vae.safetensors')
    expect(orphanFilename('umt5_xxl_fp8_e4m3fn_scaled', known)).toBe('umt5_xxl_fp8_e4m3fn_scaled.safetensors')
    expect(orphanFilename('something_else', known)).toBeNull()
  })

  it('takes an exact hit too · nicht jeder Name hat eine Endung', () => {
    expect(orphanFilename('model', ['model'])).toBe('model')
  })
})
