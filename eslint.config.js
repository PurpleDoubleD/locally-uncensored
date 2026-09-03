import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // ── Was gebaut wurde, ist kein Quelltext ──────────────────────────────────
  //
  // KF-11. Ein gebautes Rust-Target enthaelt GENERIERTES JavaScript, und das
  // hat in einer Quelltextpruefung nichts verloren. Tauris Codegen legt unter
  // `src-tauri/target/**/out/tauri-codegen-assets/` gehashte `.js`/`.mjs` ab —
  // keine Skripte, sondern eingebettete Assets; eslint kommt bis zum ersten
  // Byte und meldet `Parsing error: Unexpected character`. Daneben liegen dort
  // `_up_/dist/assets` und, nach einem Paketbau, eine ganze zweite Kopie des
  // Frontends im App-Bundle.
  //
  // DER AUSLOESER IST NICHT DIE PLATTFORM, SONDERN DER BAUZUSTAND. Der Befund
  // sah zuerst wie ein Windows-Problem aus (Mac 60, Windows 206 auf demselben
  // Commit), war aber keines: auf dem Mac gab es zu dem Zeitpunkt bloss noch
  // keinen Release-Build. Sobald einer da ist, meldet der Mac dieselbe Sorte
  // Fehler in derselben Groessenordnung. Waehrend dieser Sitzung wanderte die
  // Mac-Zahl allein durch einen nebenherlaufenden Rust-Build von 147 auf 132 —
  // ohne dass sich eine Quelldatei geaendert haette.
  //
  // Ein Gate, dessen Zahl davon abhaengt, ob jemand vorher gebaut hat, ist
  // kein Gate. `ci.yml` soll das Lint-Gate scharf schalten; dann waere es
  // unerfuellbar gewesen, und zwar auf JEDER Maschine.
  //
  // AUSGESCHLOSSEN WIRD DER ORT, NICHT DIE ENDUNG. Eine Endungsliste
  // (`**/tauri-codegen-assets/*.js`) traefe genau den heutigen Hashordner und
  // laege beim naechsten Tauri-Update daneben. Es ist EIN Bauverzeichnis, also
  // EIN Eintrag.
  //
  // UND `target` WAR NICHT ALLEIN. Nachgemessen in einem Baum, in dem diese
  // Verzeichnisse WIRKLICH angelegt wurden (nicht an der Konfiguration
  // gelesen): legt man in `playwright-report/`, `coverage/`, `test-results/`,
  // `blob-report/`, `.vite/` und `.llama-build/` je eine `.js` ab, die keine
  // ist — genau die Sorte, die Tauris Codegen produziert —, steigt `eslint .`
  // von 45 auf 51. Ein Parsing-Fehler wird naemlich auch dann gemeldet, wenn
  // fuer die Datei GAR KEIN Regelblock gilt: es reicht, dass eslint sie
  // ueberhaupt aufmacht. Deshalb stehen sie hier alle, und nicht nur die eine,
  // die zufaellig zuerst aufgefallen ist.
  //
  // `coverage` ist der Sonderfall in der Liste: es ist das einzige dieser
  // Verzeichnisse, das `.gitignore` NICHT nennt. Es steht trotzdem hier, weil
  // vitest sein Deckungsprotokoll dorthin schreibt und ein HTML-Bericht voller
  // `.js` genau den Effekt oben ausloest.
  //
  // DASS DIE LISTE VOLLSTAENDIG IST, WIRD GEPRUEFT UND NICHT GEGLAUBT:
  // `src/lib/__tests__/das-gate-bleibt-scharf.test.ts` haelt fest, dass eslint
  // KEINE Datei begeht, die git ignoriert — auf jeder Maschine, mit dem
  // Bauzustand, den sie gerade hat. Taucht hier je ein weiteres generiertes
  // Verzeichnis auf, wird dieser Test rot und nennt es beim Namen, statt dass
  // die Zahl still auseinanderlaeuft.
  globalIgnores([
    'dist',
    'dist-ssr',
    'src-tauri/target',
    'coverage',
    'playwright-report',
    'blob-report',
    'test-results',
    'playwright/.cache',
    '.vite',
    '.llama-build',
    '.preview-mobile',
    '.claude',
  ]),

  // ── Eine tote Unterdrueckung ist eine Luege ueber das, was geprueft wird ──
  //
  // Voreinstellung ist 'warn', und `npm run lint` ist `eslint .` ohne
  // `--max-warnings 0`: eine Warnung faellt also durch jedes Gate hindurch.
  // Gemessen am 01.09.2026 standen 10 solcher Direktiven im Baum, und die
  // Haelfte davon unterdrueckte Regeln, die in KEINER der geerbten Configs
  // eingeschaltet sind — `no-console` (3x), `no-await-in-loop`,
  // `@typescript-eslint/no-use-before-define`, dazu `no-var-requires`, das es
  // in typescript-eslint 8 nicht mehr gibt. Wer die Zeile schrieb, glaubte an
  // ein Gate, das nie existiert hat. Genau das soll auffallen, und ein Fehler
  // faellt auf, eine Warnung nicht.
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // ── `_` heisst in diesem Baum "absichtlich ungenutzt" ──
      //
      // Ohne diese Muster meldete die Regel 43 Stellen. 40 davon trugen einen
      // Unterstrich vor dem Namen — `_args`, `_opts`, `_dropped`, `_tag` —,
      // also die Schreibweise, mit der dieses Projekt seit jeher sagt "steht
      // in der Signatur, wird hier nicht gebraucht". Eine Regel, die genau die
      // Konvention bestraft, mit der man ihr antwortet, erzieht dazu, den Lauf
      // zu ignorieren.
      //
      // Der Beweis, dass das Muster trennscharf ist und nicht bloss den
      // Zaehler senkt: von den 43 Meldungen ueberlebt genau eine ohne
      // Unterstrich — `catch (fallbackErr)` in api/mcp/builtin-tools.ts, wo
      // der Grund des Fallbacks weggeworfen und stattdessen der Fehler des
      // ersten Wegs gemeldet wurde. Das war der einzige echte Fehler im
      // ganzen Haufen, und er ist der einzige, den die Regel nach dieser
      // Einstellung noch faengt (Sonde:
      // src/api/mcp/__tests__/web-fetch-nennt-den-grund-des-fallbacks.test.ts).
      //
      // `ignoreRestSiblings` deckt das Weglass-Idiom `({ a, b, ...rest }) =>
      // rest` ab — dort SIND `a` und `b` benutzt: sie benennen, was
      // wegfaellt (stores/createStore.ts:897 haelt die Medien-Bytes so aus
      // dem localStorage).
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // ── Ein leerer case kann nirgends durchfallen ──
      //
      // Gemessen: `case 'a': case 'b':` meldet die Regel nicht, aber
      // `case 'a': /* warum */ case 'b':` meldet sie — mit
      // `allowEmptyCase: false` (Voreinstellung) kostet der Kommentar den
      // Fehler, nicht der Code. Alle drei Fundstellen im Baum lagen in
      // api/agents/side-effect-key.ts und waren genau das: leere Labels, die
      // erklaeren, warum sie sich einen Rumpf teilen.
      //
      // Die gefaehrliche Form — ein case MIT Anweisungen, der ohne `break` in
      // den naechsten laeuft — bleibt gedeckt, und zwar zweifach: von dieser
      // Regel (allowEmptyCase aendert daran nichts) und von tsc, das
      // `noFallthroughCasesInSwitch: true` in tsconfig.app.json stehen hat.
      // Sonde (laesst diese Config selbst laufen und misst beide Seiten der
      // Grenze): src/lib/__tests__/das-gate-bleibt-scharf.test.ts
      'no-fallthrough': ['error', { allowEmptyCase: true }],

      // ── react-refresh/only-export-components: aus, und hier steht warum ──
      //
      // 29 Meldungen, alle in src/components. Nachgemessen, was sie
      // beanstanden (ueber die Import-Bezeichner, nicht ueber Namenstreffer):
      // 23 der 29 exportierten Namen werden von einer Datei unter __tests__/
      // IMPORTIERT — `groupCostHintText`, `computeFit`,
      // `pickDefaultVariant`, `comfyViewUrlFromResult`, `toolBadgeTitle` und
      // so weiter. Es sind keine Ausrutscher, es ist die Naht, an der dieses
      // Projekt die Logik aus seinen Komponenten herausgezogen hat, um sie
      // ohne DOM testen zu koennen. Von den uebrigen sechs ist `useCreateExp`
      // der klassische Fall Provider + Hook in einer Datei (sieben
      // Produktionsdateien lesen ihn).
      //
      // Was die Regel dafuer verlangt, steht in ihrer eigenen Meldung: "Use a
      // new file". Das waeren rund 29 neue Dateien, deren einziger Zweck es
      // ist, einer Regel zu genuegen. Was sie schuetzt, ist Fast Refresh im
      // Dev-Server; ein Verstoss kostet einen vollen Reload statt eines
      // zustandserhaltenden Updates. Kein ausgeliefertes Verhalten haengt
      // daran — `vite build` kennt die Regel nicht.
      //
      // Bequemlichkeit gegen Testbarkeit, und die Regel steht auf der
      // falschen Seite. `allowExportNames` waere die andere Moeglichkeit
      // gewesen: eine Namensliste, also ein zweiter Pflegeweg neben dem Code.
      // Genau davon hat dieses Projekt genug.
      'react-refresh/only-export-components': 'off',
    },
  },
  // ── mobile-client/: the page a paired phone runs ──
  //
  // Until T-75 this was a 2 964-line Rust string literal, so eslint had never
  // seen a character of it. It is now four real .js files that src-tauri's
  // build script glues into one <script>. They are plain browser ES5 with
  // `var` and function expressions, not React TypeScript, so they get their
  // own block rather than being bent into the one above.
  //
  // The rule that earns this block is `no-undef`, and it covers a gap tsc
  // leaves: the import statements at the top of client.js are the only
  // written-down record of which names the three spliced modules owe it, and
  // client.js is a .js importer, which tsc does not check unless `checkJs` is
  // on (it is not — see tsconfig.app.json for why). Drop a name from that
  // import block and eslint is the only thing that says so.
  //
  // The two relaxations below are this file's idiom, not a waiver: `catch(_){}`
  // is how the client swallows a failed localStorage read, and the only unused
  // bindings it has are catch parameters and unread arguments. Nothing else is
  // turned off. (Der Satz hier lautete: "reports 5 real errors today (one
  // dead variable, four inert regex escapes)". Nachgemessen am 01.09.2026:
  // `npx eslint mobile-client` meldet nichts mehr, die fuenf sind inzwischen
  // bezahlt. Und der Block prueft wirklich — Gegenprobe mit einem
  // eingesetzten undefinierten Bezeichner: 61 Regeln greifen, no-undef und
  // no-unused-vars melden ihn. Das ist nicht selbstverstaendlich; scripts/
  // sah genauso gruen aus und hatte null Regeln.)
  {
    files: ['mobile-client/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // ── scripts/: die Zone, die nur so AUSSAH, als waere sie geprueft ──
  //
  // Gemessen am 01.09.2026: `npx eslint scripts` listete alle zehn .mjs-Dateien
  // auf und meldete null Probleme. Nicht weil sie sauber waren, sondern weil
  // KEINE EINZIGE REGEL auf sie zutraf: der TypeScript-Block oben greift
  // `**/*.{ts,tsx}`, der mobile-client-Block greift `mobile-client/**/*.js`,
  // und `.mjs` faellt zwischen beide. `npx eslint --print-config
  // scripts/release-rules.mjs` sagte: 0 Regeln. Ein gruener Lauf ueber eine
  // Zone, in der nichts geprueft wird, ist schlimmer als ein roter — er
  // behauptet Deckung.
  //
  // Mit Regeln kamen 42 Meldungen zum Vorschein, darunter 11 `no-undef`. Die
  // sind hier die eigentliche Begruendung fuer den Block: in einem Node-Modul
  // ist ein unbekannter Bezeichner keine Stilfrage, sondern ein
  // ReferenceError beim Lauf. (Die 11 gemessenen waren `window`/`document` in
  // page.evaluate-Rueckrufen — die laufen wirklich im Browser, und die Datei
  // sagt das jetzt selbst per `/* global */`-Zeile, statt dass diese Config
  // pauschal Browser-Globals ueber alle Skripte schuettet und damit Tippfehler
  // wie `name` oder `status` durchliesse.)
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // Dieselbe Konvention wie im TypeScript-Block: `_` heisst absichtlich
      // ungenutzt. Betrifft hier ausschliesslich `catch (_)`.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
])
