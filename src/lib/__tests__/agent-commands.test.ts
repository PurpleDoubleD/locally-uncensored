import { describe, it, expect } from 'vitest'
import {
  AGENT_COMMANDS,
  getAgentCommand,
  parseAgentCommand,
  matchAgentCommands,
  parseLoopSpec,
  buildLoopRecheck,
  formatDuration,
  DEFAULT_LOOP_INTERVAL_MS,
  MAX_LOOP_INTERVAL_MS,
  LOOP_DONE_MARKER,
  LOOP_CONTINUE_MARKER,
  loopPassSaysDone,
  commandInScope,
} from '../agent-commands'
import { MUTATING_TOOLS } from '../mutating-tools'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Die drei Hooks, die einen lokal behandelten Befehl ausfuehren muessen. */
const HOOKS = join(__dirname, '..', '..', 'hooks')

// The 2.5.9 set. Kept as an explicit list rather than a count so a rename or an
// accidental drop fails loudly instead of quietly changing a number.
const EXPECTED = [
  // steer
  'goal', 'loop',
  // understand
  // context
  'compact',
  'plan', 'explain', 'find', 'diff', 'log', 'todo',
  // change
  'fix', 'types', 'test', 'refactor', 'clean', 'optimize',
  // check
  'review', 'security', 'deps',
  // ship
  'commit', 'pr', 'undo', 'docs', 'init',
]

describe('AGENT_COMMANDS registry', () => {
  it('ships the expected command set', () => {
    expect(AGENT_COMMANDS.map((c) => c.name).sort()).toEqual([...EXPECTED].sort())
  })

  it('every command has a summary and a non-empty expansion', () => {
    for (const c of AGENT_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(5)
      // A locally-handled command's build() is a short marker the hook reads,
      // not a prompt, so it is exempt from the length floor.
      const floor = c.handledLocally ? 4 : 40
      expect(c.build('').length, c.name).toBeGreaterThan(floor)
      expect(c.build('src/app.ts').length, c.name).toBeGreaterThan(floor)
    }
  })

  it('command names are unique', () => {
    const names = AGENT_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('every command that reaches a model tells it to act via tools', () => {
    for (const c of AGENT_COMMANDS) {
      if (c.handledLocally) continue
      expect(c.build(''), c.name).toContain('Use your tools')
    }
  })

  // Diese Sperre stand als "nur /goal ist lokal behandelt" da, mit der
  // Begruendung: ein zweiter solcher Befehl braeuchte einen eigenen Zweig in
  // drei Hooks und wuerde still nichts tun, wenn er keinen bekommt.
  //
  // Der zweite ist jetzt da (/compact, 2.6.8). Die Namensliste zu erweitern
  // haette die Sperre entwertet — sie haette dann nur noch gezaehlt. Also
  // prueft sie ab hier das, wovor ihr eigener Kommentar gewarnt hat: dass
  // JEDER lokal behandelte Befehl in allen drei Hooks tatsaechlich einen
  // Zweig hat. Das ist die Zusicherung, die "still nichts tun" verhindert.
  it('jeder lokal behandelte Befehl hat einen Zweig in JEDEM Hook, der Befehle liest', () => {
    // Die Hook-Liste wird ABGELEITET, nicht aufgezaehlt. Der erste Entwurf
    // dieser Sperre nannte drei Dateien fest und verlangte damit einen Zweig
    // in useAgentChat.ts — das liest aber gar keine Befehle, es bekommt vom
    // useChat bereits Aufbereitetes. Ein Zweig dort waere Code ohne Aufrufer
    // gewesen, also genau der Defekt, den dieses Projekt an anderer Stelle
    // schon einmal aufgeraeumt hat. Wer spaeter parseAgentCommand in einen
    // weiteren Hook holt, wird von dieser Fassung automatisch miterfasst.
    const alle = readdirSync(HOOKS).filter((f) => f.endsWith('.ts'))
    const leser = alle
      .map((f) => ({ f, src: readFileSync(join(HOOKS, f), 'utf8') }))
      .filter(({ src }) => /\bparseAgentCommand\s*\(/.test(src))
    expect(leser.map((h) => h.f).sort()).toEqual(['useChat.ts', 'useCodex.ts'])

    const lokal = AGENT_COMMANDS.filter((c) => c.handledLocally)
    expect(lokal.length).toBeGreaterThan(1)
    for (const c of lokal) {
      for (const { f, src } of leser) {
        expect(src.includes(`'${c.name}'`), `${f} hat keinen Zweig fuer /${c.name}`).toBe(true)
      }
    }
  })

  // Die Reichweite: genau ein Befehl darf im normalen Chat erscheinen, und es
  // ist der eine, der ohne Werkzeuge auskommt. Jeder andere wuerde dort eine
  // Arbeit versprechen, die die Oberflaeche nicht ausfuehren kann.
  it('nur /compact reicht bis in den normalen Chat', () => {
    const imChat = AGENT_COMMANDS.filter((c) => commandInScope(c, 'chat')).map((c) => c.name)
    expect(imChat).toEqual(['compact'])
    expect(AGENT_COMMANDS.every((c) => commandInScope(c, 'agent'))).toBe(true)
  })

  it('das Menue und der Parser folgen derselben Reichweite', () => {
    expect(matchAgentCommands('/', 'chat').map((c) => c.name)).toEqual(['compact'])
    expect(matchAgentCommands('/', 'agent').length).toBe(AGENT_COMMANDS.length)
    // Ein Agentenbefehl im normalen Chat ist kein Befehl, sondern Text.
    expect(parseAgentCommand('/fix den login', 'chat')).toBeNull()
    expect(parseAgentCommand('/fix den login', 'agent')).not.toBeNull()
    expect(parseAgentCommand('/compact die datenbank', 'chat')?.args).toBe('die datenbank')
  })

  it('an argument the user typed always reaches the expansion', () => {
    // A template that silently drops its args looks like it worked and does the
    // wrong thing, which is worse than refusing.
    const arg = 'src/hooks/useChat.ts'
    for (const c of AGENT_COMMANDS) {
      // /init takes no argument by design.
      if (c.name === 'init') continue
      expect(c.build(arg), `${c.name} dropped its argument`).toContain(arg)
    }
  })

  it('read-only commands never name a mutating tool in their template', () => {
    // The runner strips these tools for the turn, so a template that asks for
    // one would be instructing the model to reach for something that is gone.
    for (const c of AGENT_COMMANDS.filter((c) => c.readOnly)) {
      const text = c.build('x')
      for (const tool of MUTATING_TOOLS) {
        expect(text, `${c.name} names ${tool}`).not.toContain(tool)
      }
    }
  })

  it('read-only commands say up front that they cannot write or run', () => {
    for (const c of AGENT_COMMANDS.filter((c) => c.readOnly)) {
      expect(c.build('x')).toContain('no write or shell tools')
    }
  })

  it('marks exactly the inspection commands read-only', () => {
    expect(AGENT_COMMANDS.filter((c) => c.readOnly).map((c) => c.name).sort()).toEqual(
      ['diff', 'explain', 'find', 'plan', 'review', 'security', 'todo'].sort(),
    )
  })

  it('getAgentCommand looks up by name, case-insensitively', () => {
    expect(getAgentCommand('review')?.name).toBe('review')
    expect(getAgentCommand('REVIEW')?.name).toBe('review')
    expect(getAgentCommand('nope')).toBeUndefined()
  })
})

describe('parseAgentCommand', () => {
  it('parses a bare command', () => {
    const r = parseAgentCommand('/init')
    expect(r?.command.name).toBe('init')
    expect(r?.args).toBe('')
    expect(r?.expanded).toContain('AGENTS.md')
  })

  it('parses a command with args and threads them into the expansion', () => {
    const r = parseAgentCommand('/explain src/hooks/useChat.ts')
    expect(r?.command.name).toBe('explain')
    expect(r?.args).toBe('src/hooks/useChat.ts')
    expect(r?.expanded).toContain('src/hooks/useChat.ts')
  })

  it('is case-insensitive on the command name', () => {
    expect(parseAgentCommand('/REVIEW changes')?.command.name).toBe('review')
  })

  it('handles multi-line / quoted args', () => {
    const r = parseAgentCommand('/fix TypeError: cannot read "x" of undefined\nat foo.ts:10')
    expect(r?.command.name).toBe('fix')
    expect(r?.expanded).toContain('TypeError')
  })

  it('tolerates leading whitespace', () => {
    expect(parseAgentCommand('  /review')?.command.name).toBe('review')
  })

  it('returns null for unknown commands so they fall through to chat', () => {
    expect(parseAgentCommand('/notacommand do thing')).toBeNull()
    expect(parseAgentCommand('/')).toBeNull()
  })

  it('returns null for normal text and for a slash mid-sentence', () => {
    expect(parseAgentCommand('hello there')).toBeNull()
    expect(parseAgentCommand('what is 1/2 of 8')).toBeNull()
    expect(parseAgentCommand('please run the /review later')).toBeNull()
  })

  it('commit template forbids pushing', () => {
    expect(parseAgentCommand('/commit')?.expanded.toLowerCase()).toContain('do not push')
  })

  it('undo shows what would be lost before destroying it', () => {
    const t = parseAgentCommand('/undo')!.expanded
    expect(t).toContain('show the user exactly what would be lost')
    expect(t.toLowerCase()).toContain('never rewrite published history')
  })

  it('pr does not silently sweep in uncommitted work', () => {
    expect(parseAgentCommand('/pr')?.expanded).toContain('ask before including them')
  })

  it('deps reports without upgrading', () => {
    expect(parseAgentCommand('/deps')?.expanded).toContain('Do NOT upgrade anything yet')
  })

  it('types refuses to silence errors quietly', () => {
    const t = parseAgentCommand('/types')!.expanded
    expect(t).toContain('never silence one with')
  })

  it('clean proves a symbol is unused before deleting it', () => {
    expect(parseAgentCommand('/clean')?.expanded).toContain('Prove each one is unused')
  })

  it('plan stops at the plan', () => {
    expect(parseAgentCommand('/plan add caching')?.expanded).toContain('Do not start implementing')
  })
})

describe('matchAgentCommands (autocomplete)', () => {
  it('returns every command for a lone slash', () => {
    expect(matchAgentCommands('/').length).toBe(AGENT_COMMANDS.length)
  })

  it('prefix-filters by name', () => {
    expect(matchAgentCommands('/re').map((c) => c.name).sort()).toEqual(['refactor', 'review'])
    expect(matchAgentCommands('/sec').map((c) => c.name)).toEqual(['security'])
    expect(matchAgentCommands('/d').map((c) => c.name).sort()).toEqual(['deps', 'diff', 'docs'])
  })

  it('opens the menu even when the line starts with whitespace', () => {
    // parseAgentCommand trimmed and matchAgentCommands did not, so hitting
    // space first killed the menu while sending still expanded the command.
    expect(matchAgentCommands('  /re').map((c) => c.name).sort()).toEqual(['refactor', 'review'])
  })

  it('closes once the user has typed a space (now typing args, not picking)', () => {
    expect(matchAgentCommands('/review ')).toEqual([])
    expect(matchAgentCommands('/review changes')).toEqual([])
  })

  it('returns [] for a non-slash input', () => {
    expect(matchAgentCommands('review')).toEqual([])
    expect(matchAgentCommands('')).toEqual([])
  })

  it('returns [] for an unmatched prefix', () => {
    expect(matchAgentCommands('/zzz')).toEqual([])
  })
})

describe('/loop interval', () => {
  // The interval is the PAUSE BETWEEN PASSES, not a deadline. An earlier build
  // treated it as a time limit and Qwen3-32B then tried to cram the whole task
  // into 30 seconds (David, 2026-07-25).
  it('reads the compact forms', () => {
    expect(parseLoopSpec('30s fix the tests').intervalMs).toBe(30_000)
    expect(parseLoopSpec('20m fix the tests').intervalMs).toBe(20 * 60_000)
    // Capped: an interval longer than half an hour is not a loop cadence.
    expect(parseLoopSpec('1h30m big job').intervalMs).toBe(MAX_LOOP_INTERVAL_MS)
    // Bare number = minutes, also subject to the cap.
    expect(parseLoopSpec('10 something').intervalMs).toBe(10 * 60_000)
  })

  it('strips the interval out of the task text', () => {
    expect(parseLoopSpec('30s fix the tests').rest).toBe('fix the tests')
    expect(parseLoopSpec('2h: refactor the parser').rest).toBe('refactor the parser')
  })

  it('falls back to a short default when none is given', () => {
    const r = parseLoopSpec('make the build green')
    expect(r.intervalMs).toBe(DEFAULT_LOOP_INTERVAL_MS)
    expect(r.rest).toBe('make the build green')
  })

  it('caps a silly interval', () => {
    expect(parseLoopSpec('99h forever').intervalMs).toBe(MAX_LOOP_INTERVAL_MS)
  })

  it('does not mistake a task that mentions a duration for an interval', () => {
    expect(parseLoopSpec('fix 20m of flakiness').intervalMs).toBe(DEFAULT_LOOP_INTERVAL_MS)
    expect(parseLoopSpec('fix 20m of flakiness').rest).toBe('fix 20m of flakiness')
  })

  it('tells the model it will be brought BACK, not that it has a deadline', () => {
    const t = getAgentCommand('loop')!.build('30s make the tests pass')
    expect(t).toContain('pass 1 of a LOOP')
    expect(t).toContain('bring you back roughly every 30s')
    // No pass ceiling is promised, because there is none by default.
    expect(t).toContain('for as long as it takes')
    expect(t).not.toMatch(/up to \d+ passes/)
    // The exact wording that caused the misread must not come back.
    expect(t).not.toContain('You have 30s')
    expect(t).not.toMatch(/time is up|budget/i)
  })

  it('makes the model declare done or continue explicitly', () => {
    const t = getAgentCommand('loop')!.build('make the tests pass')
    expect(t).toContain(LOOP_CONTINUE_MARKER)
    expect(t).toContain(LOOP_DONE_MARKER)
  })

  it('still refuses to fake a green result', () => {
    const t = getAgentCommand('loop')!.build('make the tests pass')
    expect(t).toContain('Never loosen a check to make it pass')
    expect(t).toContain('never delete or skip a test to go green')
  })
})

describe('buildLoopRecheck — the actual point of a loop', () => {
  it('makes the model audit its own last pass instead of trusting it', () => {
    const t = buildLoopRecheck('make the tests pass', 3)
    expect(t).toContain('pass 3')
    expect(t).toContain('make the tests pass')
    expect(t).toContain('Do not assume the previous pass was right')
    expect(t).toContain('claimed as done that you have not PROVEN')
  })

  it('prices the two markers honestly, so DONE is not the cheap option', () => {
    const t = buildLoopRecheck('x', 2)
    expect(t).toContain(`an honest ${LOOP_CONTINUE_MARKER} costs one more pass`)
    expect(t).toContain(`a wrong ${LOOP_DONE_MARKER} ships a broken result`)
  })
})

describe('formatDuration', () => {
  it('reads naturally at every scale', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(20 * 60_000)).toBe('20m')
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
  })
})

describe('loopPassSaysDone', () => {
  // Caught live on the ship exe, 2026-07-25: Qwen3-32B ended with
  // "LOOP_DONE (verified by code_execute test)" and an end-anchored match
  // missed it, so the loop kept re-running an already-finished task. The
  // template ASKS for that reason, so the detector has to tolerate it.
  it('accepts the marker with the reason the template asks for', () => {
    expect(loopPassSaysDone('All good.\nLOOP_DONE (verified by code_execute test)')).toBe(true)
    expect(loopPassSaysDone('LOOP_DONE, tests pass')).toBe(true)
    expect(loopPassSaysDone('done.\nLOOP_DONE')).toBe(true)
  })

  it('does not finish on a continue', () => {
    expect(loopPassSaysDone('still work left\nLOOP_CONTINUE')).toBe(false)
  })

  it('treats a pass that says both as NOT done', () => {
    // Safer to spend one more pass than to ship on an ambiguous claim.
    expect(loopPassSaysDone('LOOP_DONE for the helper, LOOP_CONTINUE for the tests')).toBe(false)
  })

  it('does not finish on silence', () => {
    expect(loopPassSaysDone('I added the function.')).toBe(false)
    expect(loopPassSaysDone('')).toBe(false)
  })
})
