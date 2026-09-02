/**
 * GH #118 (nayffy, 2026-08-27, fresh Windows 11 install, v2.6.6): "Uncensored
 * chat models download and state installed... If i close and reopen LU, it
 * changed from 'Installed' to 'Get', but the 'Get' button doesn't do anything
 * as the files are still downloaded." In the same report the built-in engine
 * answered ERR_CONNECTION_REFUSED on 127.0.0.1:8127.
 *
 * The rule these tests hold down: the badge is a question about the DISK. An
 * engine that is not answering is a reason to start it, never a reason to tell
 * a user that their multi-gigabyte file is gone.
 *
 * Run: npx vitest run src/lib/__tests__/discover-installed.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  findInstalledForDiscoverModel,
  isDiscoverModelInstalled,
  type DownloadStatuses,
} from '../discover-installed'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../lmstudio-match'

const CYDONIA = {
  filename: 'Cydonia-24B-v4.1-Q4_K_M.gguf',
  downloadUrl:
    'https://huggingface.co/TheDrummer/Cydonia-24B-v4.1-GGUF/resolve/main/Cydonia-24B-v4.1-Q4_K_M.gguf',
}

/** What `list_bundled_models` produced for that file, mapped by
 *  `bundledToAIModels`. A Rust directory scan, no engine involved. */
const ON_DISK: InstalledModelLike[] = [
  {
    provider: 'openai',
    providerName: 'Built-in Engine',
    name: 'openai::Cydonia-24B-v4.1-Q4_K_M',
    model: 'Cydonia-24B-v4.1-Q4_K_M',
  },
]

const NO_DOWNLOADS: DownloadStatuses = {}

describe('the restart from #118', () => {
  it('stays Installed with the engine down, because the file is on the disk', () => {
    // This list is exactly what the app has after a restart: the disk scan, and
    // nothing else. No session downloads, no engine, no /v1/models.
    expect(isDiscoverModelInstalled(CYDONIA, NO_DOWNLOADS, ON_DISK)).toBe(true)
  })

  it('hands back the picker id, so the tile has something to do', () => {
    // The second half of the ticket: the badge was right and the button was
    // still dead. A row that knows WHICH model it is can load it.
    expect(findInstalledForDiscoverModel(CYDONIA, NO_DOWNLOADS, ON_DISK)?.name).toBe(
      'openai::Cydonia-24B-v4.1-Q4_K_M',
    )
  })

  // Negative control: without disk evidence the badge must NOT light, or every
  // row in the catalogue would claim to be installed.
  it('says Get when nothing on the disk matches', () => {
    expect(isDiscoverModelInstalled(CYDONIA, NO_DOWNLOADS, [])).toBe(false)
    expect(findInstalledForDiscoverModel(CYDONIA, NO_DOWNLOADS, [])).toBeNull()
  })

  // Negative control on the matcher's precision: a different quant of the same
  // model is a different file, and claiming it is installed would send the user
  // to a chat that cannot load it.
  it('does not accept a sibling quant as this row', () => {
    const otherQuant: InstalledModelLike[] = [
      {
        provider: 'openai',
        providerName: 'Built-in Engine',
        name: 'openai::Cydonia-24B-v4.1-Q8_0',
        model: 'Cydonia-24B-v4.1-Q8_0',
      },
    ]
    expect(isDiscoverModelInstalled(CYDONIA, NO_DOWNLOADS, otherQuant)).toBe(false)
  })
})

describe('the other disk sources keep working', () => {
  it('an Ollama tag on disk counts, in both the bare and the :latest form', () => {
    const ollama: InstalledModelLike[] = [{ provider: 'ollama', model: 'llama3.2:latest' }]
    expect(isDiscoverModelInstalled({ ollamaModel: 'llama3.2' }, NO_DOWNLOADS, ollama)).toBe(true)
    expect(
      findInstalledForDiscoverModel({ ollamaModel: 'llama3.2' }, NO_DOWNLOADS, ollama)?.model,
    ).toBe('llama3.2:latest')
    // Negative control: a tag nobody pulled stays Get.
    expect(isDiscoverModelInstalled({ ollamaModel: 'qwen3' }, NO_DOWNLOADS, ollama)).toBe(false)
  })

  it('an LM Studio entry on disk counts', () => {
    const lms: InstalledModelLike[] = [
      { provider: 'openai', providerName: 'LM Studio', model: 'Cydonia-24B-v4.1-Q4_K_M.gguf' },
    ]
    expect(isDiscoverModelInstalled(CYDONIA, NO_DOWNLOADS, lms)).toBe(true)
  })

  it('a download that finished in this session counts before the next refresh', () => {
    const downloads: DownloadStatuses = { [CYDONIA.filename]: { status: 'complete' } }
    expect(isDiscoverModelInstalled(CYDONIA, downloads, [])).toBe(true)
    // ...but it carries no picker id, so the tile keeps the plain badge rather
    // than offering to load a model it cannot name.
    expect(findInstalledForDiscoverModel(CYDONIA, downloads, [])?.name).toBeUndefined()
    // Negative control: a download still running is not an installed model.
    expect(
      isDiscoverModelInstalled(CYDONIA, { [CYDONIA.filename]: { status: 'downloading' } }, []),
    ).toBe(false)
  })
})

describe('who owns an installed row (review B1)', () => {
  it('marks a built-in entry as ours, so the engine repair may run', () => {
    expect(isBuiltinEngineEntry(findInstalledForDiscoverModel(CYDONIA, NO_DOWNLOADS, ON_DISK))).toBe(
      true,
    )
  })

  // The finding: an Ollama or LM Studio row went through the built-in
  // diagnosis, which either booted a stranger's GGUF that the pick swapped
  // straight back out, or, with no built-in GGUF on the box, answered a click
  // on a perfectly installed Ollama model with "no chat model to load yet".
  it('does not claim an Ollama row', () => {
    const ollama = [{ provider: 'ollama', model: 'llama3.2:latest', name: 'llama3.2:latest' }]
    const entry = findInstalledForDiscoverModel({ ollamaModel: 'llama3.2' }, NO_DOWNLOADS, ollama)
    expect(entry?.name).toBe('llama3.2:latest')
    expect(isBuiltinEngineEntry(entry)).toBe(false)
  })

  it('does not claim an LM Studio row', () => {
    const lms = [
      {
        provider: 'openai',
        providerName: 'LM Studio',
        name: 'openai::Cydonia-24B-v4.1-Q4_K_M.gguf',
        model: 'Cydonia-24B-v4.1-Q4_K_M.gguf',
      },
    ]
    const entry = findInstalledForDiscoverModel(CYDONIA, NO_DOWNLOADS, lms)
    expect(entry?.name).toBe('openai::Cydonia-24B-v4.1-Q4_K_M.gguf')
    expect(isBuiltinEngineEntry(entry)).toBe(false)
  })

  it('does not claim a session download, which carries no owner yet', () => {
    const downloads = { [CYDONIA.filename]: { status: 'complete' } }
    expect(
      isBuiltinEngineEntry(findInstalledForDiscoverModel(CYDONIA, downloads, [])),
    ).toBe(false)
  })
})
