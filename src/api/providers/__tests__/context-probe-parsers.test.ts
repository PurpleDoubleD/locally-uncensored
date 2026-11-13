/**
 * Was die Server ueber ihr Kontextfenster sagen, und ob wir es lesen koennen.
 *
 * GH #129: LU kannte zwei Auskunftswege (LM Studio und ein allgemeines
 * /v1/models/<id>) und riet in jedem anderen Fall aus dem Modellnamen. Der
 * Melder betreibt llama.cpp mit einem 256k-Modell, also wurde geraten, und die
 * geratene Zahl landete im Zaehler UND als `max_tokens` auf der Leitung.
 *
 * Die Koerper hier sind gekuerzte, aber echte Formen der dokumentierten
 * Endpunkte. HIER LAEUFT KEIN SERVER: geprueft ist das Lesen der Antwort,
 * nicht das Antworten selbst.
 *
 * Run: npx vitest run src/api/providers/__tests__/context-probe-parsers.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  serverRoot, v1Root, parseLlamaCppProps, parseModelsListContext,
  parseKoboldMaxContext, parseLmStudioModel, parseModelRowContext, parseOllamaShowContext,
} from '../context-probe'

describe('serverRoot: eine Basis-URL mit und ohne /v1 meint denselben Server', () => {
  it('schneidet ein angehaengtes /v1 ab', () => {
    expect(serverRoot('http://localhost:8080/v1')).toBe('http://localhost:8080')
    expect(serverRoot('http://localhost:8080/v1/')).toBe('http://localhost:8080')
  })

  it('laesst eine Basis OHNE /v1 stehen, statt die Abfrage zu verweigern', () => {
    // Genau der Fall des Melders: llama-server startet auf :8080 ohne Pfad.
    expect(serverRoot('http://localhost:8080')).toBe('http://localhost:8080')
    expect(v1Root('http://localhost:8080')).toBe('http://localhost:8080/v1')
    expect(v1Root('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
  })

  it('schneidet kein /v1 mitten im Pfad ab', () => {
    expect(serverRoot('http://gpu.local/llama/v1')).toBe('http://gpu.local/llama')
    expect(serverRoot('http://gpu.local/v1/proxy')).toBe('http://gpu.local/v1/proxy')
  })
})

describe('llama.cpp GET /props', () => {
  // Gekuerzte Form der dokumentierten Antwort von llama-server.
  const props = {
    default_generation_settings: {
      id: 0,
      n_ctx: 262144,
      params: { n_predict: -1, temperature: 0.8 },
    },
    total_slots: 1,
    model_path: '/models/qwen3-30b.gguf',
    chat_template: '{% for message in messages %}',
    build_info: 'b4567',
  }

  it('liest das WIRKLICH geladene Fenster', () => {
    expect(parseLlamaCppProps(props)).toBe(262144)
  })

  it('liest auch die aeltere Schreibweise unter params', () => {
    const alt = { default_generation_settings: { params: { n_ctx: 8192 } } }
    expect(parseLlamaCppProps(alt)).toBe(8192)
  })

  it('gibt null zurueck, wo kein llama.cpp antwortet', () => {
    expect(parseLlamaCppProps(undefined)).toBeNull()
    expect(parseLlamaCppProps({ error: 'not found' })).toBeNull()
    expect(parseLlamaCppProps({ default_generation_settings: { n_ctx: 0 } })).toBeNull()
  })
})

describe('vLLM GET /v1/models', () => {
  const vllm = {
    object: 'list',
    data: [
      {
        id: 'Qwen/Qwen3-30B-A3B',
        object: 'model',
        created: 1757500000,
        owned_by: 'vllm',
        root: 'Qwen/Qwen3-30B-A3B',
        parent: null,
        max_model_len: 262144,
        permission: [],
      },
    ],
  }

  it('liest max_model_len des passenden Eintrags', () => {
    expect(parseModelsListContext(vllm, 'Qwen/Qwen3-30B-A3B').window).toBe(262144)
  })

  it('findet den Eintrag auch ueber root', () => {
    const byRoot = { data: [{ id: 'served-name', root: 'Qwen/Qwen3-30B-A3B', max_model_len: 40960 }] }
    expect(parseModelsListContext(byRoot, 'Qwen/Qwen3-30B-A3B').window).toBe(40960)
  })

  it('nimmt bei genau einem Eintrag diesen, auch wenn die Id anders heisst', () => {
    // Ein Server mit einem Modell nennt es oft anders als der Nutzer im
    // Modellfeld. Eine Liste mit einem Eintrag laesst keine Verwechslung zu.
    const single = { data: [{ id: 'gpt-3.5-turbo', max_model_len: 32768 }] }
    expect(parseModelsListContext(single, 'mein-modell').window).toBe(32768)
  })

  it('raet nicht, wenn mehrere Eintraege da sind und keiner passt', () => {
    const many = { data: [{ id: 'a', max_model_len: 1000 }, { id: 'b', max_model_len: 2000 }] }
    expect(parseModelsListContext(many, 'c').window).toBeNull()
  })
})

describe('llama.cpp GET /v1/models', () => {
  const llamaModels = {
    object: 'list',
    data: [
      {
        id: 'qwen3-30b',
        object: 'model',
        created: 1757500000,
        owned_by: 'llamacpp',
        meta: { n_vocab: 151936, n_ctx_train: 262144, n_embd: 4096, size: 18000000000 },
      },
    ],
  }

  it('liest n_ctx_train als TRAINIERTE Decke, nicht als Fenster', () => {
    const got = parseModelsListContext(llamaModels, 'qwen3-30b')
    expect(got.trained).toBe(262144)
    expect(got.window).toBeNull()
  })

  it('liest meta.n_ctx als das laufende Fenster, neben derselben Decke', () => {
    // Der Fall der Box vom 11.09.2026: EIN Server, ZWEI Zahlen in derselben
    // Karte. Wer nur n_ctx_train liest, zeigt 40960 fuer einen Server, der mit
    // --ctx-size 16384 gestartet wurde.
    const box = {
      object: 'list',
      data: [{
        id: 'Qwen3-4B-Q4_K_M.gguf',
        object: 'model',
        meta: { n_vocab: 151936, n_ctx: 16384, n_ctx_train: 40960, n_embd: 2560 },
      }],
    }
    expect(parseModelsListContext(box, 'Qwen3-4B-Q4_K_M.gguf')).toEqual({
      window: 16384,
      trained: 40960,
    })
  })
})

describe('KoboldCpp GET /api/extra/true_max_context_length', () => {
  it('liest den value', () => {
    expect(parseKoboldMaxContext({ value: 8192 })).toBe(8192)
  })

  it('nimmt auch eine blanke Zahl', () => {
    expect(parseKoboldMaxContext(4096)).toBe(4096)
  })

  it('gibt null bei allem anderen', () => {
    expect(parseKoboldMaxContext({ value: 0 })).toBeNull()
    expect(parseKoboldMaxContext('4096')).toBeNull()
    expect(parseKoboldMaxContext(undefined)).toBeNull()
  })
})

describe('LM Studio und die allgemeinen Schluessel', () => {
  it('trennt geladen von koennen', () => {
    const body = { id: 'qwen2.5-7b', max_context_length: 32768, loaded_context_length: 8192 }
    expect(parseLmStudioModel(body)).toEqual({ loaded: 8192, max: 32768 })
  })

  it('trennt auch beim allgemeinen /v1/models/<id> Fenster und Decke', () => {
    // Dieselbe Modellkarte, derselbe Leser wie in der Liste: ein zweiter
    // Parser fuer dieselbe Form waere ein zweiter Pflegeweg.
    expect(parseModelRowContext({ max_model_len: 40960 }))
      .toEqual({ window: 40960, trained: null })
    expect(parseModelRowContext({ n_ctx_train: 131072 }))
      .toEqual({ window: null, trained: 131072 })
    expect(parseModelRowContext({ context_length: 16384 }))
      .toEqual({ window: 16384, trained: null })
    expect(parseModelRowContext({ id: 'x' })).toEqual({ window: null, trained: null })
  })
})

describe('GH #201: an Ollama emulation that names the length outside model_info', () => {
  it('reads a plain context_length at the top', () => {
    expect(parseOllamaShowContext({ model_info: {}, context_length: 262144 })).toBe(262144)
  })
  it('reads <arch>.context_length at the top, as a pass-through proxy added it', () => {
    expect(parseOllamaShowContext({ model_info: {}, 'gemma4.context_length': 262144 })).toBe(262144)
  })
  it('reads it from details', () => {
    expect(parseOllamaShowContext({ details: { context_length: '131072' } })).toBe(131072)
  })
  it('model_info still wins, as Ollama fills it', () => {
    expect(parseOllamaShowContext({ model_info: { 'llama.context_length': 8192 }, context_length: 4096 })).toBe(8192)
  })
  it('nothing named stays null', () => {
    expect(parseOllamaShowContext({ model_info: {}, details: { family: 'gemma4' } })).toBeNull()
  })
})
