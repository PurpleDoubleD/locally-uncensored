// T1 Nacht-Durchtest 3.0.9 (Mac, Code, Bypass, Ollama, Qwen2.5-Coder 1.5B unter
// eigenem Namen -> Prompt-Transport): das Modell schrieb seine zwei Aufrufe als
// ```json-Block in den Text. Der native und der Streaming-Zweig holen solche
// Aufrufe heraus, der Hermes-Zweig nicht: der Lauf endete mit "break-no-toolcalls"
// und rohem JSON in der Blase, app.py wurde nie geschrieben.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recoverKnownToolCallsFromContent } from '../tool-call-recovery'

const SEEN = '```json\n{\n  "name": "file_write",\n  "arguments": {\n    "path": "app.py",\n    "content": "print(\'hello from t1\')\\n"\n  }\n}\n{\n  "name": "shell_execute",\n  "arguments": {\n    "command": "python3 app.py",\n    "timeout": 120000,\n    "shell": "bash"\n  }\n}\n```'
const known = (names: string[]) => (name: string) => names.includes(name)

describe('a tool call written as a json block, on the prompt transport', () => {
  it('becomes two calls and leaves no raw JSON behind', () => {
    const r = recoverKnownToolCallsFromContent([], SEEN, known(['file_write', 'shell_execute']))
    expect(r.toolCalls.map((c) => c.function.name)).toEqual(['file_write', 'shell_execute'])
    expect(r.content).not.toContain('"name"')
  })

  it('is not run when one name is not a tool of this agent', () => {
    const r = recoverKnownToolCallsFromContent([], SEEN, known(['file_write']))
    expect(r.toolCalls).toEqual([])
    expect(r.content).toBe(SEEN)
  })

  it('the Hermes branch of useCodex asks for it when there are no <tool_call> tags', () => {
    const src = readFileSync(resolve(__dirname, '../../useCodex.ts'), 'utf8')
    const from = src.indexOf('const raw = hermesTurn.content')
    const hermes = src.slice(from, src.indexOf('overflowRetries = 0', from))
    expect(from).toBeGreaterThan(0)
    expect(hermes).toContain('recoverKnownToolCallsFromContent(')
  })
})
