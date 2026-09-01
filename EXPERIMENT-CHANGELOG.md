# LU Experiment — Changelog gegen beide Audits

Basis: `10bfa0d7` (v2.6.7, origin/master). Design-Audit: LU-Design-Audit.md (24 eigene Screens).
Technik-Audit: LUTechnikAudit2.6.6.html, gemessen auf `b123e89` (2.6.6) — jeder Befund wurde vor dem Fix
am v2.6.7-Stand re-verifiziert.

## Baseline (E0, gemessen an 10bfa0d7 + Sandkasten-Commit 44a76aad)

| Metrik | Wert | Audit-Referenz (2.6.6) |
|---|---|---|
| tsc --noEmit | 0 Fehler | 0 |
| vitest | 6.231 ✓ / 3 skipped (430 Dateien) | 5.405 ✓ |
| App-Chunk | 2,5 MB (App-pYVMkInc.js) | 2.590,68 kB |
| dist gesamt | 6,9 MB | 6,6 MB |
| cargo test | Lauf folgt (Sidecar + dist mussten erst her — siehe Notizen) | 438 geschrieben, 0 in CI |

## Sandkasten-Notizen (Verifikationsgrenzen)

- Sidecar `bin/lu-llama-server-aarch64-apple-darwin`: echtes llama.cpp-Binary (049326a, Juli-Build)
  aus dem Hauptrepo übernommen — nicht der gepinnte Tag b9949 aus scripts/build-llama.sh.
  Funktional identisch für den Showcase; für einen Release müsste das Script neu bauen.
- CI-/Release-Workflows: nur statisch verifiziert, nie ausgeführt (kein Remote, nichts öffentlich).
- Windows-/Linux-only-Befunde: Fix + Test, Repro auf dieser macOS-Maschine nicht möglich.

## Befunde

| Audit-ID | Fundstelle (v2.6.7) | Ist → Soll | Commit | Verifikation | Entscheidungen/Notizen |
|---|---|---|---|---|---|
| BRD-1 (kritisch) | vite.config.ts:2461, :403 | allowedHosts:true + Host-Header-Allowlist → feste Hostliste, Allowlist nur Konstanten | aad90b1c | Live-Smoke gegen echten Dev-Server: evil-Host 403, evil.localhost 403, Ollama-Proxy 200 | cors:true + GET-Carve-out (proxy-image/-download) als Folge-Befunde notiert |
| CS-1 (kritisch) | openai-provider.ts:426ff | Base64-Bilder als Text gezählt → Bild-Parts ersetzt, 1500-Token-Pauschale/Bild | 21e67a15 | 288 Provider-Tests, Text-Clamping per Gegenprobe unverändert | lu-cloud-provider erbt den Fix; Anthropic/Ollama schätzen nicht |
| CDX-1 (kritisch) | side-effect-key.ts:43 | file_edit ohne Key → teilt file_write:<pfad>-Key | 44ca4739 | 17/17 Modultests + 39 Consumer-Tests | Nebenfund gh_pr_create → exec-Queue; todo_write etc. begründet keyless |
| CDX-2 (kritisch) | shell-command-classify.ts:52 | CHAINING ohne \n > <( ; git branch als Präfix → Zeichen ergänzt, --output geblockt, git-branch-Flag-Allowlist | 3a9ac2e8 | Alle 4 bewiesenen Bypässe als Tests, 19 grün | Quoted > wird mit-abgelehnt (bewusst konservativ, im Code begründet) |
| AGT-1 (kritisch) | sub-agent.ts, tool-executor.ts, budget.ts | Sub-Agent ohne Gate/Audit/Abort → awaitApproval PFLICHT (APPROVE_ALL-Opt-out), Gates aus Eltern-Run, fail-closed | 4a228035 | Full-Suite 6.280 + Anti-Cheat-Gegenprobe (9 Tests gaten wirklich) | budget bleibt per-Delegation (SUB_AGENT_MAX_PARALLEL bremst), Kommentar korrigiert |
| IPC-1 (kritisch) | agent.rs:50 (sanitize_chat_slug) | Chat-ID '..' hob Jail auf $HOME → '.' aus Slug-Allowlist raus | d15f5cea | cargo test 19 grün + Falsifikations-Gegenprobe | keine Migration (IDs schon dot-frei); Folgefund: 2 Sanitizer-Kopien + Symlink-canonicalize → Chip |
| M6 (kritisch/hoch) | release.yml, ci.yml, release-rules.mjs, discord-announce.yml | Kein Gate, falscher Ref, No-Op-Prerelease, Asset-Zählung → Gate via workflow_call, ref:tag, verifiziert-Prüfung, Run-Identität | 6a472f16 | STATISCH (kein Actions-Lauf); release-rules 28 Tests, cargo test 539 | Clippy deny-Error secret.rs:108 → Chip; Reusable-Workflow lädt Gate-Def von master (Actions-inhärent) |
| Design-W1 (5 Punkte) | index.css:72, index.html, ChatView/ChatInput/MessageList/MessageBubble/Goal-Plan-LoopBar/WorkingAnchor/Header | 157px Versatz, Fonts nie geshippt, kein Landing-Composer, Action-Bar unter streamendem Text, 6 Header-Rezepte → eine Measure-Spalte, Fonts an Bord, ein Composer, isStreaming-Gate, ein Nav-Rezept | bcec642b | Live im Browser: beide Spalten 760px deckungsgleich, Draft überlebt (gleiche DOM-Node), Fonts laden, Header-Slots überlappungsfrei | PlanBar hat 2.6.6 den Composer verlassen → Intent statt Literal (panel-Variante bleibt breit); ChatInput bleibt QUELLTEXTLICH nach MessageList (Test the-prompt-window pinnt das) |
| #01 / Zeitbombe 1 (kritisch) | main.rs init_tracing, os_paths.rs, commands/logging.rs (neu), logger.ts, LogFileSettings.tsx | Kein Logfile → Rolling-File (täglich, 7 Dateien) in data_dir()/logs, log_write/log_file_path/log_reveal, Settings-Anzeige | 8d13931f | cargo test 560 (+18), vitest 6.290, echter Appender in Tempdir getestet | data_dir statt app_log_dir (AppHandle existiert beim Start noch nicht — genau dort liegen die Fehler); Bug beim Testen gefunden: zwei Zeilen im selben Tick verloren → Promise memoisiert |

## Etappenbilanz E1 (Commit 8d13931f)

| Gate | Baseline (E0) | Nach E1 |
|---|---|---|
| tsc --noEmit | 0 | 0 |
| vitest | 6.231 ✓ | **6.290 ✓** / 3 skipped |
| cargo test | 539 ✓ | **560 ✓** / 3 ignored |
| cargo check | 0 | 0 |
| npm run build | exit 0, App-Chunk 2,5 MB | exit 0, App-Chunk 2,5 MB (Splitting ist E2) |
| e2e chat-Specs | 3 ✓ / 1 ✗ | 3 ✓ / 1 ✗ (**derselbe** vorbestehende Fehler) |

**Der eine e2e-Fehler, selbst nachgeprüft:** `chat-streaming-persist.spec.ts:53` scheitert in
`e2e/support/ui.ts:23` am *New-Chat-Klick*, nicht an einer Composer- oder Streaming-Assertion.
Der Fehler-Snapshot zeigt das „What is new 2.6.7"-Modal mit Got-it-Button offen über der Sidebar —
`shouldShowReleaseNotes` wird wahr, sobald der Onboarding-Walk `onboardingDone` setzt, und der
Harness entlässt es nie. Vorbestehend, nicht durch Design-W1 verursacht. Kein Test wurde entschärft.

**Testanpassungen in E1: genau eine.** `plan-done-vs-applied.test.ts` hing am Literal
`'w-full px-2 pt-1'` der PlanBar. Klassifikation: *Test hing an altem Wert*. Die dokumentierte
Invariante (panel darf keinen schmalen Composer-Wrapper erben) wurde beibehalten und verschärft.


## Windows-Strang (echte Maschine, kein Cross-Compile-Ersatz)

Der Windows-Rechner `lu-box` ist über Tailscale erreichbar und wird ab E2 als
zweite echte Zielplattform mitgeprüft. Damit fällt die ursprüngliche Verifikationsgrenze
„Windows nur per Review" weg — die 224 Windows-only-Zweige im Rust-Code werden dort
wirklich kompiliert und getestet.

| | |
|---|---|
| Host | `lu-box` (Tailscale 100.105.153.30), Windows 10 Home |
| Toolchain | VS Build Tools 2022, WebView2-Runtime 151.0.4129.107, MSVC-Target x86_64, Node 24.13.1, npm 11.8.0, Rust/Cargo 1.92.0, Git 2.41 |
| Platz | 78 GB frei auf C: |
| Sandkasten dort | `C:\Users\ddrob\lu-experiment`, per Git-Bündel aus dem Mac-Sandkasten geklont, **ohne Remote** (Push auch dort unmöglich). Bestehende Verzeichnisse des Nutzers werden nicht angefasst. |
| Sidecar | echter `lu-llama-server-x86_64-pc-windows-msvc.exe` aus `Desktop\lu-263-win` übernommen — **2.6.3-Build, nicht der in `scripts/build-llama.sh` gepinnte Tag b9949**. Funktional für Test und Showcase; ein Release müsste ihn neu bauen. |
| Modelle vor Ort | LM-Studio-Bestand, u. a. Qwen2.5-0.5B-Instruct Q4 (0,37 GB) und gemma-3-4b-it-abliterated Q4 (2,32 GB) — echte Antwort-Tests ohne Download möglich. Ollama ist dort **nicht** installiert. |

**Windows-Gates (fortlaufend ergänzt):**

| Gate | Ergebnis |
|---|---|
| `npm ci` | exit 0, 449 Pakete |
| `npx tsc --noEmit` | **0 Fehler** |
| `npm run build` | exit 0 |
| `cargo check --all-targets` | **exit 0** — die 224 Windows-only-Zweige kompilieren erstmals wirklich, inkl. aller E1-Fixes (sanitize_chat_slug, Remote-Permissions, tracing-appender) |
| `npx vitest run` | 6.282 ✓ / **8 ✗** — alle acht durch CRLF-Checkout, Ursache gefixt (siehe unten) |

**Windows-Befund, den nur die echte Maschine zeigt: kein `.gitattributes`.**
`core.autocrlf` steht auf Windows per Default auf `true`, das Repo hatte keine
Gegenregel. Folgen: (1) `setup.sh` und `scripts/build-llama.sh` kommen mit
`#!/usr/bin/env bash\r` an und sterben unter WSL/Git Bash mit „bad interpreter" —
das ist der dokumentierte From-Source-Weg auf Windows; (2) die fünf Tests, die
Quelltext byteweise festnageln (`build-llama-script`, `prompt-tool-roster`,
`codex-mode-wiring`, `chat-budget-wiring`, `displaced-engine-frees-its-memory`),
sind auf jedem frischen Windows-Clone rot — der erste `npm test` eines Windows-
Mitwirkenden war 8× rot. Fix: `.gitattributes` mit `* text=auto eol=lf`,
CRLF nur für `.bat/.cmd/.ps1`, Binärlisten explizit. Commit `44d3de14`.


## Etappe E2 — Fundament (Technik-Welle 2 + Muster M1/M3/M5/M7)

| Audit-ID | Kern | Commit | Verifikation |
|---|---|---|---|
| M3 (SSRF, hoch ×2 + Cancel-EOF) | Gate prüft die aufgelöste **Adresse** statt den Hostnamen und pinnt die Verbindung daran (Rebinding-Fenster zu); Redirects pro Hop geprüft, max 3 statt 10 blind; EOF-Marker hinter jedem Rückkehrpfad; Idle-Wächter; 3× JSON-Injection auf serde_json | `86e9dd17` | 41 Proxy-Tests, keiner berührt das Netz; Agent hat in isolierter Kopie bewiesen, dass 2 rote Tests fremd waren |
| M7 (RP-1 kritisch + 6) | Boot-Chunk **2,61 → 2,11 MB** (−19,3 %, gzip −23,5 %); **301 → 1** Re-Render pro 300 Streaming-Token; content-visibility ab 200 Nachrichten, pro Konversation eingerastet; MLX-Blob-URLs bekommen einen Besitzer | `402ec7e3`, `705102c7` | Am echten Store gemessen, nicht behauptet; Blob-Tests mutationsgeprüft; **0 Testanpassungen** |
| M5 (OI-1/OI-2 kritisch + 6) | Linux-ComfyUI galt immer als kaputt (toter Unix-Zweig); „installed successfully" für nie befüllte Verzeichnisse; Repair deinstallierte still Voice; `ollama serve` starb am ersten Log-Write; Install/Repair/Update teilten einen Statusslot | `c0cc5639` | 620 Rust-Tests, 38 neu; Windows-/Linux-Zweige auf `lu-box` echt kompiliert |
| Streaming (Zeitbombe 4 + 6) | Ein Idle-Wächter für alle Pfade (60 s zwischen Chunks, **300 s bis zum ersten** — sonst stirbt der legitime Kaltstart); Ollama endet terminal statt mit leerer Blase; **Anthropic Extended Thinking hat nie funktioniert** (konnte nur 400 erzeugen, verbrannte pro Turn einen Zusatz-Request) | `9c7243a1` | 6.469 grün; CRLF-Kern in sse.ts byte-identisch und mit 4 Tests eingezäunt; 3 Anpassungen, alle „hing an altem Wert" |
| DD-1 (kritisch) + Zeitbombe 3 | „Wiederholen" löschte die Teildatei, ab der es fortsetzen wollte — bei 40 GB Totalverlust durch die von der UI empfohlene Aktion; 90-%-Schwelle → byte-genau; SHA256 streamend, beim Resume aus der Teildatei geseedet; Zustand überlebt Neustart; Waisen werden adoptiert | `a9b64245` | 32 Rust- + 110 TS-Tests; exakte Größe vom Server, nie aus dem gerundeten Katalog |
| M1 (5) + M2 (3) | **Ein** Abbruchsignal pro Run bis in den Tool-Aufruf; Stop-Zustand pro Conversation statt pro Hook-Instanz (ein `/loop` nach Tab-Wechsel war vorher unstoppbar); ComfyUI-Stop auf **einer** promptId statt Queue leeren; Freigabedialog zeigt `stdin`; Allow-Liste an der Ausführungsstelle; MCP kann keinen Builtin kapern | `6aa99201` | 6.506 grün, 9 neue Testdateien; 6 Anpassungen, davon **2 echte Regressionen**: zwei Negativkontrollen zementierten den M1-Befund als Soll |

**Windows-Gates nach E1+CRLF-Fix (auf `lu-box` gemessen):**

| Gate | Ergebnis |
|---|---|
| `cargo check --all-targets` | **exit 0** — 224 Windows-Zweige kompilieren |
| `cargo test` | 553 ✓ / 3 ✗ (die 3 sind CRLF-Quelltextvergleiche, Fix greift erst nach Re-Sync) |
| `npx vitest run` | 6.394 ✓ / **8 → 4 ✗** nach `.gitattributes` |
| verbleibende 4 | alle in `build-llama-script.test.ts`: `execFileSync('bash')` trifft auf Windows den **WSL-Startstub** `WindowsApps\bash.exe` statt des vorhandenen Git-Bash. Offen, Fix nach dem Deps-Paket (das dieselbe Datei anfasst). |

## Der schwerwiegendste Fund: das Typecheck-Gate hat nie geprüft

Gefunden nicht vom Audit, sondern von einem **Gegenprüfer** in der orchestrierten Welle E4.

`tsconfig.json` im Repo-Root ist ein Solution-File — `"files": []` plus zwei `references`.
`npx tsc --noEmit` prüft damit **null Dateien** und liefert immer Exit 0. Genau dieser Befehl
steht in `.github/workflows/ci.yml:56`, und genau dieser Befehl galt im Technik-Audit als Beleg
(„npx tsc --noEmit → Exit 0. Sauber unter `strict: true`"). Gegenprobe: ein absichtlich
eingebauter Typfehler in `src/` passiert das alte Gate unbemerkt.

Zweite Ursache: `tsconfig.app.json` führt nur `vite/client` in `types`, schließt aber ganz `src`
ein — inklusive aller `__tests__`. `describe`/`it`/`expect` sind damit unbekannt: **260 der
ursprünglich 378 Fehler** waren reine Konfigurationslücke, nicht Code.

| Messung | Wert |
|---|---|
| Fehler mit `tsc -b`, Stand v2.6.7 (`10bfa0d7`) | **74** — schon vor dieser Session vorhanden |
| Fehler nach den 12 Paketen dieser Session | **118** — also **44 selbst eingebaut**, unsichtbar |
| davon in `CodeBlock.tsx` | 39, alle TS7016 |
| nach dem ersten Reparaturpaket | 44 |

**Fix:** `"vitest/globals"` in die Typen, `npm run typecheck` = `tsc -b --force`
(**Exit 1 bei Fehlern verifiziert**), CI ruft das Script; dazu `npm test` als Einstiegspunkt für
Vitest, den es nie gab. Commit `3b2c520a`.

**Konsequenz für dieses Dokument:** Jede „tsc 0"-Meldung in den Etappen E0 bis E2 war wertlos.
Die Vitest-, Cargo-, Build- und e2e-Zahlen sind davon unberührt — nur der Typecheck.

**Nebenbefund** (`fix(types)`, Commit folgt): `@types/react-syntax-highlighter` ist installiert,
wird aber vom `types`-Pin nie geladen. Der Pin ist für `@types/node` beabsichtigt (sonst wären
`process`/`Buffer` im Browser-Code sichtbar) — die Lösung ist deshalb eine präzise eigene
Deklaration, die dieselbe Bindung re-exportiert wie das ausgelieferte JS, statt DefinitelyTypes
`const language: any` (das hätte 39 Fehler gegen 37 ungeprüfte Werte getauscht).

## Gegenprüfung E4 — was sie eingebracht hat

Fünf Umsetzer, fünf Angreifer mit dem umgekehrten Auftrag. Ergebnis: **kein Paket blockierend,
15 belegte Lücken**, die sonst als „fertig" durchgegangen wären. Die härtesten drei:

- **Remote-Disconnect:** die vom Umsetzer gemeldete Mutationsprobe **hielt nicht** — der
  Gegenprüfer setzte den Handler auf den verwundbaren Rumpf zurück, und kein Test wurde rot.
- **Backup-Kern:** die zentrale Behauptung („der 5-s-Tick liest die Blobs nie wieder aus
  IndexedDB") war **unbelegt** — `emitWrite` aus beiden Zweigen entfernt, alle Tests blieben grün.
- **Cloud-Timeout:** bewacht alles *nach* dem Token, aber `getAccessToken()` läuft **davor** —
  ein hängender Tokenabruf verkeilt weiterhin.

## Was das reparierte Typecheck-Gate freigelegt hat (Commit 44a0692a)

Nachdem `npm run typecheck` (`tsc -b --force`) das erste Mal wirklich Dateien
prüft, sank die repo-weite Fehlerzahl von **118 auf 2**. Entscheidend ist nicht
die Zahl, sondern was in ihr steckte: die Meldungen waren **keine Typkosmetik,
sondern echtes Fehlverhalten**, das seit Monaten unbemerkt lief.

| # | Fundstelle | Ist (kaputt) | Soll |
|---|---|---|---|
| 1 | `src/hooks/useABCompare.ts:40` | liest `persona?.prompt` — Feld existiert nicht | A/B-Vergleich lief mit **leerem System-Prompt** |
| 2 | `src/hooks/useKeyboardShortcuts.ts:35` | dasselbe tote Feld | Ctrl+N öffnete jeden Chat **ohne Persona** |
| 3 | `src/api/ollama.ts:107,132` | `AbortSignal` entgegengenommen, nie an `localFetchStream` gereicht | **Stop brach die HTTP-Anfrage nicht ab**; Ollama generierte weiter (Audit-Muster M1) |
| 4 | `src/components/ParticleField.tsx` | liest `PARTICLE_COUNTS` + `settings.particleDensity` — beide nicht vorhanden | **TypeError beim ersten Render** |
| 5 | `src/stores/memoryStore.ts:765` | `maxChars` wurde vollständig ignoriert | Grenze greift |
| 6 | `vite.config.ts:876` | `provider` verworfen | im Dev-Modus bekam **jedes Backend das Verzeichnis von LM Studio**; rekursive Listings kamen still einstufig zurück |
| 7 | `src/stores/__tests__/stores.test.ts:233` | setzte tote Keys zurück | modelStore-Pull-State wurde zwischen Tests **nie** zurückgesetzt |

Befund 3 ist der wichtigste: das Technik-Audit beschreibt unter M1 ein
„Stop-Konzept, das nur die UI anhält". Hier ist der Beweis dafür im Code — die
Funktion nahm das Signal an und warf es weg. Der Fix ist zweizeilig; gefunden
hat ihn erst der reparierte Compiler, kein Test und kein Review.

**Sauberkeitsnachweis des Pakets:** 0 neue `any`, 0 `as any`, 0 `@ts-ignore`,
netto **ein `any` weniger**. Kein Testfall gelöscht — jede berührte Testdatei
hält ihre Fallzahl oder gewinnt welche (netto **+17**). Verifikation: 21
betroffene Testdateien, **726 Tests grün**.

**Lehre für dieses Repo:** ein grünes Gate ist erst dann ein Gate, wenn belegt
ist, dass es überhaupt etwas anschaut. Der Beweis lief hier über eine
Sonde (`export const kaputt: number = "string"`), die `tsc --noEmit` mit Exit 0
passierte. Solche Sonden gehören vor jedes neue Gate, nicht dahinter.

## Zwischenfall: der Experiment-Build hat in die echten Daten geschrieben

**Das ist ein Fehler in meiner Sandkasten-Einrichtung, nicht im Produkt.** Er
gehört hierher, weil er die zentrale Zusage des Plans verletzt hat („die echten
Chats/Settings des Nutzers werden nie berührt").

Beim ersten echten `npm run tauri dev` schrieb der Experiment-Build in
`~/Library/Application Support/lu-labs/` — das Datenverzeichnis der echten App
(erkennbar an `session.json` vom 1.7., `state.json` vom 4.7., `images/`,
`videos/`, `mlx/`). Belegt per `lsof` auf den laufenden Prozess und per
`find -newermt`. Betroffen: `store_backup.json`, `store_backup.1.json`,
`rag_chunks_backup.json`, `logs/lu.2026-08-31.log`.

**Ursache.** Ich hatte angenommen, die geänderte Tauri-`identifier` genüge. Sie
trennt WebView-Speicher und Keychain — der Single-Instance-Socket heißt
nachweislich `com_purpledoubled_locally_uncensored_experiment_si.sock`. Aber
`src-tauri/src/os_paths.rs:15,21` hartkodiert `"lu-labs"` und leitet den Pfad
gar nicht aus der Identität ab. Dieselbe Hartkodierung steht in `mlx.rs:807`
und in den Pfaden von `video.rs` (`~/.cache/lu-labs`, `~/.config/lu-labs`).

**Schaden und Reparatur.** In der Backup-Datei wurde `lu-providers`
überschrieben und dabei `lu-cloud` von `enabled: true` auf `enabled: false`
gekippt; `lu-update-checker-v2` bekam einen neuen Zeitstempel. Ich habe
`lu-providers` aus der Vorgängerfassung zurückgeholt (Sicherungskopie:
`/tmp/store_backup.before-repair.json`) und nachgemessen: 18 Schlüssel,
`chat-conversations` weiterhin 6.741.552 Zeichen.

**Warum die Chats überlebt haben — ehrlich:** nicht wegen der Isolation, sondern
weil `backup_stores` in `system.rs` über `keys_lost`/`merged_backup` verlorene
Schlüssel aus der Datei auf der Platte hinüberrettet. Das ist ein
Sicherheitsnetz, keine Trennung. Ohne es wären sie weg gewesen. Bemerkenswert:
genau die Merge-Logik, deren Beschreibung in dieser Session als falsch entlarvt
und korrigiert wurde, hat hier die Daten gerettet.

**Zweite Lücke, gemessen:** `~/Library/WebKit/com.purpledoubled.locally-uncensored`
(die installierte App) ist seit dem 6.7. unangetastet — der Lauf schrieb
stattdessen nach `~/Library/WebKit/locally-uncensored/`, dem gemeinsamen Topf
für Dev-Läufe. Der Experiment-Build teilt sich localStorage also vermutlich mit
`npm run tauri dev` aus dem Hauptrepo; von dort dürfte das `lu-providers` mit
abgeschaltetem Cloud stammen.

**Lehre.** Isolation, die nicht durch einen Test festgenagelt ist, ist eine
Annahme. Sie wurde hier beim ersten echten Start widerlegt — und zwar erst, als
zum ersten Mal wirklich gestartet wurde. Ein Review hätte das nie gefunden.

## Etappenstand nach Muster M7, React 19 und dem Windows-Strang

| Messgröße | Basis | jetzt |
|---|---|---|
| Boot-Chunk | 2016 kB | **711 kB** (Audit-Ziel < 800) |
| `INEFFECTIVE_DYNAMIC_IMPORT` | 11 | **0** |
| `react-hooks/*`-Verstöße | 47 | **10** (Rest in laufenden Paketen) |
| eslint gesamt | 1040 | 1003 |
| Typfehler | 118 | **0**, Gate per Sonde als scharf belegt |
| vitest (Mac) | 5405 | **6684 grün, 0 rot** |
| cargo test | 438 | **708 grün, 0 rot** |
| vitest (Windows, echte Maschine) | 8 rot | **15/15** in der letzten roten Datei |

Zusätzlich selbst nachgeholt statt übersprungen: die 51 Katalog-Downloads gegen
ihre echten Dateigrößen per HEAD geprüft — **0 untertrieben**. Der im Kommentar
dokumentierte Vorfall (13 GB angekündigt, 16,3 GB echt, Platte auf 0 Byte)
wiederholt sich derzeit nicht.

## Etappenstand — beide Maschinen, am committeten Stand geprüft

Alle Zahlen unten stammen aus einem **frischen Arbeitsbaum auf `HEAD`**, nicht
aus meinem Arbeitsverzeichnis. Das ist der Unterschied, der in dieser Session
zweimal etwas gefunden hat: neue Dateien, die von committetem Code importiert
werden, aber untracked liegen blieben, sind lokal unsichtbar und kippen den
Build erst woanders um (einmal auf der Windows-Maschine bemerkt, einmal von mir
vor dem Verlassen des Rechners).

| Messgröße | Basis | jetzt | Ziel |
|---|---|---|---|
| Typfehler | 118 | **0** | 0 |
| Importzyklen | 11 (Audit: 9) | **0** | 0 |
| Boot-Chunk | 2016 kB | **731,8 kB** | < 800 |
| `INEFFECTIVE_DYNAMIC_IMPORT` | 11 | **0** | 0 |
| `react-hooks/*` | 47 | **0** | 0 |
| eslint gesamt | 1040 | **188** | — |
| `no-explicit-any` | 827 | **57** ✓ | < 100 |
| vitest Mac | 5405 | **7061 / 0 rot / 3 übersprungen** | — |
| vitest Windows | 8 rot | (Stand `ba9557df`: 6755 / 0 rot) | — |
| cargo test Mac | 438 | **729 / 0 rot / 3 ignoriert** | — |
| cargo test Windows | 15 rot, 11 ignoriert | **715 / 0 rot / 3 ignoriert** | — |

Die drei ignorierten Rust-Tests sind auf beiden Maschinen **dieselben** und
plattformunabhängig opt-in (Cloud-Inferenz, Installer, Proxy) — es gibt keine
Windows-Ausnahme mehr.

Drei Gates sind neu und **durch eine Sonde als scharf belegt**, nicht nur
eingehängt: `typecheck` (Sonde: absichtlicher Typfehler → Exit 2), `cycles`
(Sonde: zwei einander importierende Module → Exit 1, nach Entfernen Exit 0),
und die Isolation (Sonde: Branch-Suffix leeren → 3 Tests rot mit Pfad im
Klartext). Diese Sonden sind Pflicht geworden, seit sich herausstellte, dass
der Typecheck monatelang gar nichts geprüft hat.

### Ehrlich offen

- **`no-explicit-any`**: Audit-Ziel < 100 ist erreicht. Diese Zeile stand
  zwischenzeitlich auf „564" und widersprach damit der Tabelle weiter oben,
  die „57" nannte — ein Stand, der nach dem Typisieren nie nachgezogen wurde.
  Nachgemessen am HEAD: **42** (`npx eslint src e2e`). Beide alten Zahlen waren
  falsch; die Zeile wird ab jetzt mitgemessen statt fortgeschrieben.
- **16 e2e-Tests sind flaky** — sie bestehen nur im Retry. **Nicht von uns:**
  am unveränderten Ausgangsstand `10bfa0d7` fallen dieselben Tests mit
  identischer Meldung um (in einem separaten Arbeitsbaum gegengeprüft). Der
  Lauf endet mit Exit 0, weil Playwright Retries zulässt; ohne `--retries=0`
  sieht man es nicht.
- **Design-Welle 2**: 2 von 7 Posten erledigt (Modal-Bedienbarkeit,
  Motion/reduced-motion). Welle 3 unberührt.

## tech(M1) — die Hintergrund-Shell ignorierte den Shell-Namen

`shell_task_start_impl` verzweigte auf die **Plattform** und baute auf Windows
immer PowerShells `-NoProfile -NonInteractive -Command`, gleich welche Shell der
Aufrufer benannt hatte. Der Vordergrund-Zwilling in `shell.rs` leitete die Form
seit jeher aus dem Shell-*Namen* ab. Dieselbe Verzweigung stand zweimal im Code;
einer wurde repariert, der andere nicht.

Beide rufen jetzt `shell::shell_argv(windows, shell, command)`. `windows` ist ein
**Parameter** statt eines `cfg!` im Rumpf — nur so ist die Windows-Form vom Mac
aus prüfbar, und genau die war für jeden Nicht-Windows-Lauf unsichtbar.

**Auf Windows als echter Bug bewiesen** (Mutationssonde, 2026-09-01): mit dem
alten Zweig wieder eingesetzt wird `cmd` mit `-NoProfile -NonInteractive
-Command echo …` gestartet, cmd.exe ignoriert die Flags vollständig und fällt in
die **interaktive Eingabeaufforderung** — es druckt seinen Banner und wartet. Das
Kommando lief nie. Der Paritätstest fängt das mit genau dieser Ausgabe im
Fehlertext. Auf dem Mac fällt bei derselben Sonde nur der Strukturteil um (dort
sind alter und neuer Pfad für `sh` identisch) — der Verhaltensteil ist der
Windows-Beweis, und er ist gefahren.

## tech(M-any) — Provider-Schicht typisiert, 7 Fehler fielen dabei heraus

Die Grenze zu den drei fremden HTTP-APIs lag hinter `Record<string, any>` und
handgeschriebenen Interfaces, die auf `JSON.parse` nur **behauptet** wurden. Neu
ist `src/api/providers/wire.ts`: ein abhängigkeitsfreies Blattmodul mit Prüfern
für alles, was hereinkommt. Was wir *senden*, bekam dagegen echte Interfaces und
keine Guards — `sendChat`/`applyThinking` löschen Felder dieser Bodies
namentlich, unter `any` hätte ein Tippfehler darin kompiliert und die Anfrage
wäre still mit dem gerade abgelehnten Parameter rausgegangen.

Mitgefundene echte Fehler: `const p: string = toolArgs.path` war eine Behauptung
über Modell-Ausgabe (`{"path": 42}` warf einen TypeError aus der Tool-Schleife);
`safeParseArgs` prüfte nur im Reparatur-, nicht im Erfolgszweig; dieselbe Klasse
in Anthropics `flushToolUseBlocks`; zwei Non-null-Assertions auf selbst als
optional deklarierte Felder; fünf Fixtures bauten `id: 'builtin'` als
`ProviderConfig`, obwohl das eine Preset- und keine Provider-ID ist.

**Verifikationsgrenze, ehrlich:** diese sieben Funde sind gefixt, aber **nicht
einzeln durch einen Regressionstest festgenagelt** — die bestehenden Tests
bleiben grün, wenn man den Fix zurücknimmt. Das ist als eigener Auftrag
nachgezogen.

## Was das Typisieren wirklich eingebracht hat

Fünf Pakete haben `no-explicit-any` von 827 auf 57 gebracht — der Audit-Zielwert
(< 100) ist erreicht. Die Zahl ist aber nicht der Ertrag. Der Ertrag sind **21
echte Fehler**, die dabei herausfielen, weil ein `any` genau dort steht, wo
jemand aufgehört hat nachzudenken. Die schwersten:

- **Eine unlesbare Zeile im Memory-Blob löschte alle Erinnerungen, dauerhaft.**
  zustand fängt einen werfenden `migrate` im `.catch` von `persist`, bricht die
  Hydration ab und ruft `set()` nie — der Store bleibt auf `entries: []`, und der
  nächste gewöhnliche Schreibvorgang persistiert diese Leere über den Blob.
  `migrateV2toV3` ist die Migration, die jeder 2.5.x-Nutzer beim Upgrade fährt.
- **`rag.ts` legte `undefined` in ein `number[][]` — und persistierte es.** Die
  Wache in `cosineSimilarity` ist laut eigenem Kommentar für den *leeren* Vektor
  geschrieben, nicht für `undefined`. Antwortet der Embeddings-Server mit weniger
  Zeilen als Eingaben, bekommt der Schwanz `embedding: undefined`, das wird
  gespeichert, und jede spätere Frage an das Dokument wirft — bis der Nutzer die
  Datei entfernt und neu ablegt.
- **Ein `tool_calls`-Eintrag ohne `function` riss den ganzen Agentenzug ab.** Der
  `TypeError` flog innerhalb der NDJSON-Schleife, aber außerhalb des `try`, das
  nur `JSON.parse` abdeckt.
- **Ein einzelner kaputter CivitAI-Eintrag** riss per `item.name.toLowerCase()`
  in den äußeren catch — alle 20 Treffer verschwanden.

Das wiederkehrende Muster über das ganze Projekt: **zwei Pfade, die dasselbe tun
sollen, und nur einer wurde gepflegt.** Vordergrund/Hintergrund bei der Shell,
Streaming/nicht-Streaming bei Ollama, Erfolgs-/Reparaturzweig bei
`safeParseArgs`. Gefunden wird das zuverlässig nur, wenn man die beiden Pfade
*gegeneinander* testet statt jeden für sich.

## Der Dev-Server war die größte offene Tür

`vite.config.ts` ist keine Konfigurationsdatei, sondern ein Server mit 2.471
Zeilen und — bis `25408c8a` — null Tests. Und er ist nicht bloß Werkzeug:
`setup.sh:155` und `start.bat:10` starten `npm run dev` als Laufzeit des
Nutzers. Bedient wird er nicht von Menschen, sondern **vom Modell**:
`backendCall` schickt dieselben Argumente im Tauri-Build an Rust und im
Dev-Modus an `/local-api/…`.

Sieben Befunde, darunter: ein einziger POST mit kaputtem JSON tötete den Prozess
(live nachgewiesen, `GET /` danach `000`); Pfad-Traversal in vier schreibenden
Endpunkten (`path.join` normalisiert `..` klaglos weg — es ist keine Grenze);
Shell-Injektion über `execSync(\`git clone "${repo_url}"\`)`; und ein
SSRF-Wächter, der auf die *Schreibweise* prüfte statt auf die Adresse —
`0:0:0:0:0:ffff:127.0.0.1` ist gültiges IPv6, erreicht nachweislich localhost,
und keine der beiden Regexen traf.

## Die eine harte Shell-Sperre war dreifach umgehbar

Das Tool-Schema verspricht, `git commit --no-verify` werde abgelehnt. Tatsächlich
ließ sich die Sperre auf drei Wegen abstreifen: mit `background: true` (der
Rückgabepunkt lag vier Zeilen vor der Prüfung), über den zurückgezogenen Namen
`shell_execute_background` (der lief per `runRetiredTool` direkt am Prüfer
vorbei), und durch **irgendein Kommando davor** (`rejectShellCommand` fragte
`commandKind`, und das meldet die Art dessen, was zuerst kommt).

Beim Schließen kam ein vierter Weg dazu, den niemand vorgegeben hatte: die
**Zeilenfortsetzung**. `git commit -m x \` + Umbruch + `--no-verify` ist für die
Shell ein Kommando; ohne Backslash-Behandlung wird der Umbruch zum Trenner und
das Flag landet in einem eigenen Segment.

Die Segmentierung ist jetzt anführungszeichen-bewusst, und die Sicherheitsregel
steht als Kommentar an der Funktion: *Zusammenfassen ist harmlos, Auftrennen ist
die Umgehung* — bei unbalancierten Anführungszeichen wird deshalb auf die
Ganzzeilen-Prüfung zurückgefallen. Bewusst offen und als `toBeNull()` im
Testfile festgehalten: ein Wort vor `git` (`sudo`, `GIT_DIR=x`).

## Windows: startklar, und wie ich das gegen meine eigene Messmethode belegt habe

Am Commit `c77682a2` auf der echten Maschine (`lu-box`), nicht kreuzkompiliert:

| Stufe | Ergebnis |
|---|---|
| `cargo test` | 715 grün, 0 rot, 3 ignoriert |
| `npm run tauri build` | **Exit 0** — MSI 28.475.360 B, NSIS-Setup 15.912.155 B |
| Updater-Artefakte | 0 |
| App-Start | Session 1, WebView2-Familie 1 Kind + 5 Enkel, Log ohne Fehler |
| Echte Nutzerdaten | 661 Dateien, kein Byte geändert |

Drei Fehlschlüsse lagen auf dem Weg, und alle drei kamen von der Messung, nicht
vom Produkt.

**Zwei Updater-Zips im Bundle-Ordner.** Meine Kontrollfrage („müssen 0 sein")
schlug an. Die Zeitstempel klärten es: MSI 13:56:46, EXE 13:57:29, beide Zips
`12:57:42` — dieselbe Sekunde, eine Stunde früher. Reste aus einem Build vor dem
Entfernen von `createUpdaterArtifacts`. Ein Build, der Updater-Artefakte
erzeugt, schreibt sie unmittelbar nach ihrer Quelle, nicht 43 Sekunden davor.

**„Die App startet nicht."** Das Log sagte zweimal
`failed to create webview: HRESULT(0x80070578) Ungültiges Fensterhandle`. Der
Grund war meine SSH-Sitzung: sie läuft in **Session 0**, die keinen
interaktiven Desktop hat. Gegenprobe: die nachweislich funktionierende echte App
in Session 1 meldet von dort aus ebenfalls `MainWindowTitle=''` und
`MainWindowHandle=0` — das Fensterhandle ist als Beweismittel aus Session 0
heraus wertlos. Über eine einmalige geplante Aufgabe in Session 1 gestartet,
liefert derselbe Build die vollständige WebView2-Prozessfamilie und ein Log ohne
Fehlerzeile. Es ist derselbe Fallentyp wie `osascript` auf dem Mac: erst die
Methode verdächtigen, dann das Produkt.

**„Der Experiment-Build fasst die echten Daten an."** Nach dem Start hatten sich
vier Dateien der echten Installation bewegt. Kontrolllauf ohne das Experiment:
drei davon bewegen sich von allein. Die vierte,
`EBWebView\Default\Preferences`, lag elf Stunden still und schrieb dann zweimal
in Folge wenige Sekunden nach dem Experiment-Start — reproduzierbar, zwei von
zwei. Der Inhaltsvergleich entschied es: **11.031 Byte vorher, 11.031 Byte
nachher, `-eq` True.** Chromium schreibt `Preferences` atomar über Temp+Rename,
das setzt den Zeitstempel neu, ohne ein Byte zu ändern; ausgelöst davon, dass
ein neues Fenster den Fokus nimmt. Keine Datei kam hinzu, keine verschwand,
keine änderte ihre Größe.

Was das belegt und was nicht: **kein Byte der echten Nutzerdaten hat sich
geändert.** Welcher Prozess den Rename ausgeführt hat, ließe sich nur mit einem
Dateisystem-Tracer zeigen — die Wirkung ist nachweislich null. Nebenbei ist die
echte App über den gesamten Zeitraum durchgelaufen, seit dem 31.08. 12:29:35,
ohne Neustart.

Der Pfadbau selbst ist zentral abgesichert: `os_paths.rs` greift ausschließlich
auf `APP_CONFIG_DIR` und `APP_DISPLAY_DIR` zu, beide `concat!(…,
branch_dir_suffix!())`. Auf der Platte sind es drei getrennte Orte —
`Roaming\Locally Uncensored-experiment`,
`Local\com.purpledoubled.locally-uncensored.experiment` (WebView2) und
`Local\lu-labs-experiment` (Logs). Auch `tauri-plugin-single-instance` trennt
sauber: Mutex-, Klassen- und Fenstername entstehen ungekürzt als `{identifier}-sim`
/ `-sic` / `-siw`.

Auf der Windows-Maschine ist nichts zurückgeblieben: die einmalige Aufgabe ist
gelöscht, die Hilfsdateien entfernt, kein Experiment-Prozess läuft.

## Ein Test, der sich still abschaltet, ist schlimmer als ein roter

Beim Nachprüfen des Fokusring-Pakets fiel eine Differenz auf: im Hauptbaum 7240
grüne Tests, im sauberen Prüfbaum 7236 — bei identischer Gesamtzahl. Die
Ursache ist `describe.skipIf(builtCss === null)` in
`src/components/__tests__/fokusring-und-press.test.ts:248`. Der Block prüft die
stärkere Hälfte des Beweises am **gebauten** CSS: dass beide Fokusregeln
ungeschichtet landen und damit jede Tailwind-Utility aus `@layer utilities`
schlagen. Wo kein `dist/` liegt, verschwindet er lautlos.

Dazu kam, dass das `dist/` im Hauptbaum von 04:36 stammte, der Commit von
04:41. Die grüne Meldung stützte sich also auf ein Artefakt, das älter war als
der Commit, den es belegen sollte.

Konsequenz für das Verfahren, nicht für den Code: im Prüfbaum wird ab jetzt
**erst gebaut, dann getestet**. Danach laufen in dieser Datei 30 statt 26 Tests.

Denselben Mechanismus gibt es ein zweites Mal, in Rust:
`gguf.rs:264 real_bundled_gguf_if_present` liest bei Vorhandensein ein
Modell aus dem Verzeichnis der **echten** App und tut sonst nichts — lesend,
also keine Isolationsverletzung, aber dieselbe stille Selbstabschaltung. Steht
als offener Posten.

---

## Sieben Pakete, ein wiederkehrender Satz: „zwei Wege, einer gepflegt"

Der Abschnitt fasst `c5773322` bis `4c7bf748` zusammen. Ich habe jedes Paket
in einem eigenen Worktree geprüft — nur die Dateien dieses Pakets auf den
aktuellen HEAD kopiert, dann `tsc`, voller `vitest`, `madge`, und **eine
eigene Mutationssonde**, die ich aus dem Befund abgeleitet habe und nicht aus
den Tests des Agenten.

### Der Sweep, der aussah, als griffe er

`kill_orphaned_tunnels` läuft beim Start und soll verwaiste `cloudflared`-
Prozesse abräumen — sonst republiziert ein alter Tunnel still die neue
Sitzung. Der Matcher verlangt `targets_loopback_port(&cmd.join(" "), port)`.

`sysinfo` 0.33 liefert `process.cmd()` **leer**, wenn man die Kommandozeilen
nicht ausdrücklich anfordert — und die Kette, die das Projekt benutzt,
enthält kein `.with_cmd()`. Also war `cmd` immer leer, der Matcher immer
`false`, und der Sweep konnte **nie etwas töten**. Er lief, er meldete
nichts, und in der Deckungsmatrix stand er auf „umgesetzt".

An fünf Stellen wurde über Prozesse geurteilt, nur eine holte sich die
Kommandozeilen. Jetzt baut `process_util::process_table_with_cmdlines()` die
Tabelle für alle. Meine Sonde: die eine Zeile 67 entschärft — **drei Tests
rot, in beiden Aufrufern und im Helfer selbst.** Genau die Eigenschaft, die
ich verlangt hatte: eine Mutation erreicht jeden, der die Frage stellt.

### Der Timer, der nie aufhörte

Der Built-in-Engine-Installpfad wartete mit `setInterval(…, 500)` auf die
heruntergeladene Datei und rief `clearInterval` in **zwei von fünf** möglichen
Ausgängen. Pausiert der Nutzer, steht der Eintrag auf `paused`; bricht er ab,
verschwindet die Zeile; verlässt er die Ansicht, hört niemand mehr zu. In
allen drei Fällen lief der Timer mit 2 Hz weiter und das `await`ete Promise
settelte nie — pro Versuch ein Timer, und die Installation darunter stand für
immer.

Der Fix ist kein sechster Ausgang, sondern der Verzicht auf den Timer: der
Store wird ohnehin im Sekundentakt aus Rust gefüllt, also wird auf die
Nachricht gewartet, die es schon gibt.

### 34 von 58 Deklarationen waren vier Kopien einer Maschine

Das Audit verlangt für `Onboarding.tsx` (59 `useState`) eine Zerlegung *pro
Schritt*. Das wäre falsch gewesen: 34 der Deklarationen sind vier Kopien
**einer** Maschine — Ollama, LM Studio, ComfyUI, Python, jeweils
„herunterladen, Fortschritt zeigen, fertig oder fehlgeschlagen", vier davon
mit eigenem `setInterval` für dieselbe Rechnung `jetzt − startedAt`. Eine
Zerlegung pro Schritt hätte vier Kopien auf vier Dateien verteilt.

Ein `installerReducer`, viermal benutzt: 58 → 29. Und dabei fielen **zwei
echte Fehler** heraus, die vorher viermal einzeln hätten auffallen müssen:
ein Poll-Tick nach dem Ende konnte eine fertige Installation zurück auf
„läuft" ziehen, und ein zweiter Anlauf begann mit dem Fortschrittsbalken des
ersten.

### Der Befund stimmte, die Begründung war daneben

Das Design-Audit sagt zum Hellmodus: „keine Ebenen". Nachgemessen war der
Stufenabstand in beiden Modi fast gleich (dunkel 1,105:1, hell 1,100:1).
Gefehlt hat die **Kante**: hell 1,008:1 gegen dunkel 1,271:1 —
vierunddreißigmal schwächer. Eine Pane ohne spürbare Stufe *und* ohne Kante
liegt nicht auf der Leinwand, sie **ist** die Leinwand.

Beim Nachmessen fiel nebenbei auf, dass die aktive Navigationspille im
Hellmodus `bg-gray-100` auf einer `bg-gray-100`-Leiste trug: **1,000:1**. Das
Amateur-Signal „aktiv als Fläche" galt im Hellmodus nie.

### Der Audit-Zeiger traf die eine geschlossene Tür

T-76 („Create-Dateislots geben ihre Blob-URLs nie frei") zeigt auf
`SpecialIntentControls.tsx:55`. Diese Stelle ist seit längerem in Ordnung.
Das Leck sitzt beim **dritten Slot derselben Familie**, den das Audit nicht
nennt, gemintet in einer wörtlichen Inline-Kopie in `Stage.tsx:596`. Alle
drei Wege, auf denen der Store dort Refs wegwarf, warfen sie ohne Freigabe
weg — einer davon nach jedem abgeschickten Trainingslauf. Gemessen: **60
gemintet, 60 lebendig, 0 nachher.**

Das ist die Lehre aus mehreren Paketen: die Befunde stimmen fast immer im
Muster und oft nicht in der Zeilennummer. Wer die Zeile fixt statt das
Muster, schließt die Tür, die schon zu war.

### Und einmal war ich selbst der Fall

Meine eigene Deckungsmatrix erzeugt ausgeliefertes CSS. Tailwind 4 scannt das
Projektverzeichnis als Text, `.md` eingeschlossen — eine Erwähnung von
`active:scale-[0.97]` in `AUDIT-COVERAGE.md` erzeugte die Utility im Bundle,
obwohl keine Komponente sie benutzt. Bewiesen mit zwei echten Builds: die
Erwähnung ersetzt, die Utility weg, der Dateihash ändert sich;
Kontrollprobe mit denselben Erwähnungen aus `index.css` entfernt, Build
byte-identisch.

Der Schaden ist doppelt. Totes CSS im Produkt — und `fokusring-und-press.
test.ts` suchte mit `indexOf(':active{scale:.97}')` nach der Hausregel, fand
aber diese Utility, weil sie im Bundle früher steht. Der Test maß vier
Monate lang die falsche Regel.

Dass das überhaupt aufgefallen ist, liegt an einer Protokolländerung: der
Test liest aus `dist/assets` und trägt `describe.skipIf(builtCss === null)`
— wo kein `dist/` steht, schaltet er sich **still** ab. Seit ich vor jedem
Lauf baue, läuft er. Und einmal bin ich dabei selbst hereingefallen: ein Lauf
war grün gegen ein `dist/`, das aus einer früheren Sonde stammte und nicht
mehr zum Quelltext passte. Seitdem gilt `rm -rf dist && npx vite build`.

### Windows-Zwischenprüfung

Am Stand `63294828` auf der echten Maschine: `cargo test` **740 grün, 0 rot,
3 ignoriert**. Die Differenz zu 758 auf dem Mac sind die `#[cfg(unix)]`-
Tests. Das Rust-Paket mit seinen Plattformzweigen kompiliert und läuft dort.

### Was in keinem Audit steht und trotzdem offen ist

`AppState::shutdown_subprocesses` (`state.rs:462`) ist 115 Zeilen lang und
erwähnt `remote`, `RemoteServer`, `tunnel` oder `cloudflared` kein einziges
Mal. Ollama, ComfyUI, llama-server, der Embeddings-Server, der Trainer und
der MLX-Sidecar stehen dort. Der Tunnel hängt allein an `Drop for
RemoteServer` — und der Kommentar über der Funktion begründet selbst, warum
das nicht reicht: Tauri v2 führt `Drop` nicht zuverlässig aus, genau deshalb
existiert der explizite Pfad.

---

## Eine Lücke in meinem eigenen Prüfverfahren

Ich habe jedes Paket isoliert geprüft: nur seine Dateien auf den aktuellen
HEAD kopiert, dann `tsc`, voller `vitest`, `madge`, plus eine eigene
Mutationssonde, die ich aus dem Befund abgeleitet habe statt aus den Tests
des Agenten. Das hat viel gefangen — zweimal eine Reihenfolge, die begründet
und kommentiert, aber von nichts erzwungen war.

**Was ich nicht gefahren habe, ist e2e.** Und `ci.yml` fährt
`npm run test:e2e` als scharfes Gate, ohne `continue-on-error`.

Gefunden hat es ein Agent im Vorbeigehen, nicht ich. `builtin-ctx.spec.ts:55`
sucht

    getByRole('button', { name: /ctx 8K/ })

Genau diese Beschriftung hat D-S06 ersetzt: der Füllstand des Kontextfensters
*ist* jetzt das Label des Wählers — der Messwert sitzt auf dem Regler, der
ihn bewegt. Das war die Absicht des Bullets, und der Test nagelt den alten
Entwurf fest.

Zwei Dinge folgen daraus, und das zweite ist mir das wichtigere:

1. **Mein Gate war unvollständig.** Ein Design-Paket, das sichtbare
   Beschriftungen ändert, muss gegen die Specs laufen, die diese
   Beschriftungen anklicken. `tsc` und `vitest` sehen davon nichts — die
   Unit-Tests dieses Projekts lesen Quelltext, keine gerenderte Oberfläche.
   Ab hier gehört `npm run test:e2e` in die Paketprüfung jedes Pakets, das
   `src/components/**` anfasst.

2. **„Test rot, also Test anpassen" ist genau die Bewegung, vor der dieses
   ganze Dokument warnt.** Die Reparatur muss für jeden roten Spec
   entscheiden, ob er eine *Eigenschaft* festhält, die noch gilt (dann ist
   nur der Selektor veraltet), oder einen *Entwurf*, der absichtlich weg ist
   (dann muss der Test die entsprechende Eigenschaft des neuen Entwurfs
   prüfen, nicht verschwinden). Das ist eine Entscheidung pro Fall, keine
   Sammelumbenennung.

Es ist übrigens dasselbe Muster wie überall sonst hier, nur eine Ebene höher:
zwei Beschreibungen derselben Oberfläche — die Komponente und der Spec — von
denen nur eine gepflegt wurde.

## Ein verschwundenes `node_modules`, und was es über Messungen sagt

Mitten in dieser Runde war `node_modules` im Hauptrepo vollständig weg. Kein
`npm install` lief, nichts hatte es angekündigt. Sichtbar wurde es als
`resource path ../dist doesn't exist` in `cargo test` — Tauri braucht das
gebaute Frontend als Ressource, und `vite build` konnte es nicht liefern,
weil ihm `vite` selbst fehlte.

Wiederhergestellt habe ich es **ohne Netz**: der npm-Cache lag mit 4,4 GB
vollständig da, `npm ci --offline` brachte 422 Pakete zurück, der Build war
danach in 394 ms wieder grün. Das ist der eigentliche Grund, warum es hier
steht — die Reparatur war billig, der Schaden an den *Messungen* nicht.

Denn in dem Zeitfenster liefen vier Agenten. Jeder `tsc`, jeder `vitest`,
jeder Playwright-Lauf daraus ist rot geworden, aus einem Grund, der mit dem
geprüften Code nichts zu tun hat. Ein Agent, der so ein Rot für sein eigenes
hält, repariert ein Phantom — und schlimmstenfalls „repariert" er dabei
etwas, das richtig war. Ich habe deshalb beiden noch laufenden Agenten
geschrieben, sie sollen die Ergebnisse aus diesem Fenster wegwerfen und
wiederholen, und dem e2e-Agenten ausdrücklich, dass auch mein eigener
Verdacht gegen seinen dritten roten Spec dadurch wertlos sein könnte.

Die vermutete Ursache ist ein `rm -rf …/node_modules/` **mit Schrägstrich am
Ende** auf einen Symlink: unter macOS zeigt das auf das Ziel, nicht auf den
Link, und löscht dessen Inhalt. Ich habe selbst so einen Link angelegt, für
den isolierten Worktree der Paketprüfung. Wer es war, weiß ich nicht — ich
habe beide Agenten gefragt und werde es nachtragen, wenn eine Antwort kommt.
Die Lehre gilt unabhängig davon: **eine geteilte Abhängigkeit gehört nicht
in eine Arbeitskopie verlinkt.** Kopieren ist teurer und kann das hier nicht.

Und eine zweite, unangenehmere: mein eigener Messfehler in derselben Minute.
Ich hatte `cargo test 2>&1 | tail -25 > log; echo "exit=$?"` geschrieben und
damit den Status von `tail` protokolliert, nicht den von `cargo`. Das Log
sagte `exit=0`, während der Build in Wahrheit gescheitert war. Ein grünes
Ergebnis, das gar nichts gemessen hat — genau die Form von Fehler, die ich
in dieser Sitzung bei anderen dreimal gesucht habe.

## Dieselbe Tür, dreimal — und zwei Gates, die schwiegen

Diese Runde hat vier Dinge gezeigt, die alle dieselbe Form haben: eine Regel
existiert, sie ist an einer Stelle angewandt, und niemand hat nachgesehen, wo
sie sonst noch hingehört.

**Die Tür.** Eine `fs-write`-Anfrage ohne brauchbare Pfadangabe machte aus der
Käfigwurzel eine Datei. Im Dev-Server gefunden, dort geschlossen. Beim
Nachsehen stand dieselbe Tür im Rust-Code noch offen — also im ausgelieferten
Build, nicht nur in der Entwicklungsumgebung. Und beim Nachsehen dort fand
sich eine **dritte**: `agent.rs file_write`, die Tür, die das *Modell*
aufruft. Dazu eine vierte, halbe: `remote.rs` prüft `path.is_empty()`, fängt
damit `""`, aber nicht `"."` und nicht `"unterordner/.."`.

Die Prüfung, die gefehlt hat, war die ganze Zeit da — `is_workspace_root_path`
steht seit jeher in derselben Datei und wird von `fs_list` benutzt. Sie taugt
allerdings nicht als Wächter, und das in **beide** Richtungen: sie verfehlt
`"unterordner/.."`, und sie erfindet Treffer bei `"  "` und `".\"`, die auf
gewöhnliche Dateien im Käfig auflösen. Wer sie ohne Messung genommen hätte,
hätte das Loch offengelassen und zwei gültige Schreibvorgänge abgewiesen.

Drei Ebenen, an denen dieselbe missgebildete Anfrage hätte auffallen können —
beim Modellaufruf, im Dev-Server, im Rust-Weg — und sie fiel an keiner auf.

**Die Gates.** Ich hatte in meiner Aufstellung *ein* stummes Gate geführt:
Lint. Es waren zwei. Clippy stand ebenfalls auf `continue-on-error`, und
dahinter lagen 78 Warnstellen und ein Fehler. Der Kommentar darüber nannte
sogar die Zeile — nur die falsche (`secret.rs:108` statt `:173`). Beide sind
jetzt bezahlt; Clippy ist scharf, Lint wartet auf die letzten Fehler in
`src/components`.

Unter den 78 waren zwei Klassen, die keine Stilfragen sind. Bei einer davon
lag ich falsch: `MutexGuard` über `await` gehalten klingt nach Deadlock, steht
hier aber in `#[cfg(test)]`-Code mit einer Current-Thread-Runtime. Es kostete
einen geparkten Thread je wartendem Test, nicht mehr. Der Agent hat das
gemessen statt meine Einordnung zu übernehmen.

**Die Plattform.** Derselbe Quelltext: Mac 7929 grün, Windows 8 rot. Alles
Pfadtrennzeichen — und überwiegend in den Wachen, die *ich* in dieser Sitzung
als Beweismittel eingezogen habe. Ein Beweismittel, das nur auf einer
Plattform funktioniert, ist ein halbes. Die Ursache war fünfmal dieselbe
handkopierte Dateisuche mit einem `?? ''`-Rückfall: ein leerer String ist
keine Fehlermeldung, sondern eine leere Datei, und ob daraus rot oder still
grün wurde, entschied allein die Zusicherung dahinter.

Dazu ein Lint-Unterschied, den ich zuerst falsch gedeutet habe. Mac 60,
Windows 206 — ich schrieb „Plattformunterschied". Falsch: der Auslöser ist,
**ob jemand vorher gebaut hat**. `eslint.config.js` schloss `src-tauri/target`
nie aus, und dort liegt nach einem Release-Bau generiertes JavaScript. Das ist
schlimmer als ein Plattformunterschied, weil es sich auf derselben Maschine
ändert.

**Die Grenze.** Beim Zerlegen von `useCodex.ts` kam heraus, was der Teststil
dieses Projekts kostet: 35 Testdateien lesen die Datei als Quelltext und
heften **174 ihrer 2643 Zeilen** fest. Jede Zerlegung, die eine davon bewegt,
braucht Änderungen an 35 fremden Dateien. Der schärfste Fall baut die Regel im
Test nach — „Mirrors the workDir-prepend block" — und heftet dann die Quelle
an, wodurch genau die Auslagerung verboten ist, die den Nachbau überflüssig
machen würde.

Das ist kein Fehler, den man wegräumt. Es ist der Preis dafür, dass diese
Wachen Zusicherungen festhalten, die kein Laufzeittest erreicht. Man muss ihn
nur kennen, bevor man den Rest von W-T3 plant.

### Und was ich selbst falsch gemacht habe

Vier Dinge, weil sie zum Bild gehören.

Ich habe behauptet, Space Grotesk deklariere einen fetten Schnitt, den es
nicht besitzt, und `font-bold` sei still wirkungslos. Der Agent hat es mit
genau der Gegenprobe widerlegt, die ich selbst verlangt hatte: eine Regel
„eine Datei je Deklaration" hätte nicht drei, sondern alle 39 Blöcke
angeschwärzt, weil Inter und JetBrains Mono dasselbe tun. Es sind Variable
Fonts; im Fenster gemessen springt die Deckung um 17 %.

Ich habe `cargo test | tail > log; echo $?` geschrieben und damit den Status
von `tail` protokolliert. Das Log sagte grün, der Bau war rot.

Ich habe `python3 -c` in doppelte Anführungszeichen gesetzt, worauf die Shell
die Backticks im Text als Kommandos ausführte und durch Leerstrings ersetzte.
Übrig blieb ein Satz „hat und nennt nicht".

Und ich habe eine Mutationssonde gefahren, die eine mehrzeilige Aufrufstelle
mittendurch geschnitten hat. Der Bau brach, `cargo test` gab keine
Ergebniszeile aus, und die Sonde maß nichts. Aufgefallen ist es nur, weil ich
auf die Zeile *nach* dem Ergebnis geschaut habe.

## Das Gate ist scharf, und Windows misst dasselbe wie der Mac

Zwei Sätze, die dieses Projekt lange nicht sagen konnte, stimmen seit dieser
Runde. Beide waren teurer, als sie klingen — und beide sind an einer Stelle
gescheitert, an der ich selbst falsch gemessen hatte.

**„Lint ist ein Gate."** Der Audit-Befund AS-10 hieß nie „es gibt
Lint-Fehler". Er hieß: der Schritt trägt `continue-on-error: true`, und ein
Schritt, der nicht scheitern kann, misst nichts. Beides ist jetzt weg. `eslint
.` läuft über 1080 Dateien und meldet 0 Fehler, 0 Warnungen — ohne ein einziges
neues `eslint-disable`; im letzten Paket sind sogar vier `as any` *gefallen*
und stehen jetzt als Begründung im Kommentar, welche Prüfung sie verdeckt
hatten. In keinem der vier Workflows steht noch eine Ausnahmeklausel.

Dass das Gate beißt, ist nachgemessen und nicht behauptet: eine Datei mit
`let z: any = 1` im Baum → exit 1, Datei weg → exit 0.

**Die Voraussetzung dafür war ein Befund, den ich zuerst falsch gedeutet
habe.** eslint las das gebaute Rust-Target mit — Tauris gehashte Codegen-
Assets, die kein Quelltext sind. Meine erste Deutung: ein Plattformunterschied
(Mac 60 Meldungen, Windows 206). Falsch. Der Auslöser ist, **ob ein
Release-Build existiert**. Nachdem ich auf beiden Maschinen ein Paket gebaut
hatte, meldete auch der Mac über 100 Fehler aus demselben Ort. Das ist
schlimmer als ein Plattformunterschied, weil es sich auf *derselben* Maschine
ändert: grün auf einem frischen Klon, rot nach dem ersten Bau, ohne dass eine
Quelldatei sich unterscheidet. Ein Gate, das man unter dieser Bedingung scharf
schaltet, wird zur Zufallsmünze. Gegengeprüft unter genau der auslösenden
Bedingung — 87 Codegen-Assets im Baum —: weiterhin 0.

**„Auf Windows startklar."** Acht Tests waren dort rot, plus neun weitere, die
ich beim Nachsehen fand. Es waren zwei Gruppen mit zwei verschiedenen Ursachen,
und beide sind lehrreicher als der Fix.

Die erste Gruppe verglich Pfade und bekam unter Windows `\` statt `/`. Fünf
hand-kopierte Dateiwanderer sind durch **einen** geteilten ersetzt. Der neue
**wirft**, wenn er eine Datei nicht findet, statt `?? ''` zurückzugeben — denn
ein Test, der einen leeren String liest und dann `expect(...).not.toMatch(...)`
sagt, ist grün, ohne irgendetwas geprüft zu haben.

Die zweite Gruppe war grün — **aus dem falschen Grund**. `os.tmpdir()` liegt
unter Windows in `$HOME\AppData\Local\Temp`, und `AppData` steht in der
Sperrliste des Datei-Käfigs. Das *erste* Tor lehnte also die Wurzel mit 403 ab,
lange bevor irgendein Pfad geprüft war. Fünf Fälle, die einen 403 erwarteten,
bekamen ihren 403 — nur nicht den, über den ihre Überschrift redet. Kein
Produktbefund: derselbe Request mit einem Heim, das die Kulisse nicht enthält,
antwortet auf derselben Maschine mit 200 und dem Dateiinhalt.

Die Reparatur zieht nicht die Kulisse an einen anderen Ort, sondern das
**Heimatverzeichnis** mit: `HOME` und `USERPROFILE` zeigen für die Dauer *einer*
Anfrage auf ein Wegwerf-Heim. Damit liegt der Arbeitsordner per Konstruktion im
Normalfall, für den der Käfig geschrieben ist — keine Plattform-Fallunter-
scheidung, kein `skipIf`, auf beiden Maschinen dieselbe Aussage. Und das Heim
ist **Pflichtargument und steht vorne**: in der Vorgängerfassung war es das
dritte, optionale, drei Aufrufstellen ließen es weg, und genau diese drei waren
rot. Ein Pflichtargument lässt sich nicht vergessen; der Compiler zählt mit.

Ergebnis, auf der echten Maschine gemessen, am selben Commit: **Windows 544
Testdateien, 8006 bestanden, 5 übersprungen** — Ziffer für Ziffer dasselbe wie
auf dem Mac. Dazu `tsc` 0, `eslint` 0, `madge` 0 Zyklen, `cargo test` 768
bestanden bei 0 Fehlschlägen (die Differenz zu den 790 des Macs sind
plattformbedingte Tests, die es dort nicht gibt).

## Die größte Datei des Projekts, und wie man beweist, dass man nichts kaputt gemacht hat

`install.rs` hatte 5918 Zeilen. Das Audit verlangt unter seiner dritten Welle,
die großen Dateien zu zerlegen; bei vier anderen war das geschehen, hier war
die Datei stattdessen um 1331 Zeilen **gewachsen** — die Fehlerbehebungen der
letzten Wochen hatten Code hinzugefügt, und danach hatte niemand aufgeräumt.

Geschnitten wurde nach **geteiltem Zustand**, nicht nach Themen. Drei Gruppen
fielen dabei heraus: das Werkzeug, das alle Installationswege teilen; ComfyUI,
dessen drei Aufträge sich *ein* Verzeichnis teilen; und je ein Modul pro
fremdem Produkt mit eigenem Zustandsobjekt. Größte Einzeldatei danach: 821
Zeilen.

Interessant ist nicht der Schnitt, sondern der **Beweis**. Bei einer reinen
Verschiebung ist die einzige Frage: hat sich unterwegs Verhalten geändert? Ein
Diff beantwortet das nicht — er zeigt tausende bewegte Zeilen. Ein
Multimengen-Vergleich aller Codezeilen (Kommentare und Leerzeilen heraus)
beantwortet es: von **4187 Codezeilen weichen genau 12 ab**. Es sind der alte
Sammel-Import, eine Konstante, die in die Fassade wandert, neun
Sichtbarkeitsaufweitungen auf `pub(super)`, wo eine Naht einen Helfer von
seinem Nutzer trennt, und ein `include_str!`-Pfad. Die 230 hinzugekommenen
Zeilen sind ausnahmslos `use`-Anweisungen, `cfg`-Attribute, `mod tests {` und
schließende Klammern. Kein Rumpf, keine Zeichenkette, kein Bezeichner sonst.

Dazu die Mengenvergleiche in beide Richtungen: `#[tauri::command]` 23 → 23,
`#[test]` 121 → 121, `#[ignore]` 2 → 2, `#[allow(...)]` 7 → 7. Und eine Sonde,
dass die Fassade wirklich trägt: den Re-Export auskommentiert → 2
Übersetzungsfehler, wieder eingesetzt → 0.

## Ein Tastaturnutzer konnte löschen, aber nicht öffnen

Die Chatzeile war ein `<div>` mit `onClick`, ohne Rolle, ohne `tabIndex`. Die
Knöpfe *in* der Zeile — Umbenennen, Löschen — waren erreichbar, die Zeile
selbst nicht. Gemessene Tab-Reihenfolge ab dem Suchfeld: `Rename, Delete,
Rename, Delete, New Chat`. Wer mit der Tastatur arbeitet, konnte also die
zerstörerischen Aktionen ausführen und die harmlose nicht.

Die Reparatur hatte eine Falle, vor der der Befund ausdrücklich gewarnt hatte:
ein neues `role="button"` an der Zeile hätte die e2e-Locator mehrdeutig
gemacht. Und zwar nicht theoretisch — `chatStore.ts:189` nennt einen frischen
Chat wörtlich `New Chat`, also hätte `getByRole('button', { name: /New Chat/i })`
zwei Treffer gehabt, auch der in `e2e/support/ui.ts`, über den *jeder* Spec
seine Chats anlegt. Die Zeile ist fachlich ohnehin keine Schaltfläche, sondern
eine Auswahl aus einer Liste; sie ist jetzt `role="option"` in einem
`role="listbox"`. Die Aktionsknöpfe bleiben Geschwister, weil ein `<button>`
in einem `<button>` ungültiges HTML wäre.

Der neue Wächter **misst** die Reihenfolge über `document.activeElement`,
statt sie zu behaupten. Sonde: `role="option"` entfernt → 3 von 18 Fällen rot;
wieder da → 18 grün.

## Eine veraltete Matrix ist teurer als eine unvollständige

Drei Zeilen der Befundmatrix standen auf „OFFEN", obwohl der beschriebene
Zustand seit Commits nicht mehr existierte: der Display-Slot war besetzt, die
Befehlspalette gebaut, die Kontextmenüs da. Zweimal hätte ich beinahe Arbeit
vergeben, die längst getan war; einmal habe ich es getan und einen Agenten
losgeschickt, der nach eigener Messung zurückkam und meldete, es sei nichts zu
tun.

Bei D-T03 war der Fehler ganz meiner. Ich hatte `grep grotesk` auf
`public/fonts/` laufen lassen und aus dem leeren Ergebnis geschlossen, die
Display-Schrift fehle. Sie liegt dort unter `woff2/` mit Hash-Namen — sechs
Blöcke, Gewicht 500 und 700, je latin, latin-ext und vietnamesisch. Ein leerer
`grep` ist kein Beweis; er ist erst einmal nur ein leerer `grep`.

Das ist dasselbe Muster wie überall in diesem Projekt, eine Ebene höher: zwei
Beschreibungen desselben Sachverhalts, von denen nur eine gepflegt wurde. Die
Matrix führt seitdem eine Spalte „gemessen wie" nicht als Zierde.

## Der Installer-Digest ist angeheftet — gemessen, nicht geraten

`LMSTUDIO_INSTALLER_SHA256` stand auf `None`, mit der ehrlichen Begründung, dass
die Datei auf keiner erreichbaren Maschine lag. Der Eigentümer hat den Download
freigegeben; damit ist die letzte halbe Position des Technik-Audits geschlossen.
Gemessen auf der echten Windows-Maschine, von der versionsfesten URL: 221 768 208
Bytes — **Delta zur angehefteten Größe: 0** —, der SHA-256, und eine gültige
Signatur auf `CN=Element Labs Inc.`. Danach wurde die Datei gelöscht.

Interessanter als die Zahl ist, was jetzt am Code über sie steht. Der Hersteller
veröffentlicht **keine** Prüfsumme zum Vergleichen: `.sha256`, `.sha256sum`,
`.SHA256`, `.checksum` und der Verzeichnisindex antworten alle 404. Der Digest
stammt also aus der Datei selbst, durch denselben unauthentifizierten Kanal, durch
den die App lädt — trust-on-first-use. Er sichert gegen eine *spätere* Ersetzung an
dieser URL, nicht gegen einen bereits manipulierten Erstdownload.

Was diese Lücke schließt, ist die Authenticode-Prüfung, und die beiden sind
ausdrücklich nicht redundant: die Signatur hängt an einem EV-Zertifikat einer CA
und läuft damit **nicht** durch den Download-Kanal. Digest und Signatur beantworten
zwei verschiedene Fragen — „sind das die Bytes, die wir gesehen haben" und „hat der
Hersteller sie signiert". Keine der beiden allein ist die Antwort. Die
Größenübereinstimmung ist Bestätigung, keine dritte Prüfung: sie stammt aus dem
`content-length` desselben Kanals, und eine längengleiche Fälschung käme durch.

Die Wache sagt deshalb die schärfere Sache, nicht die naheliegende: der Pin muss
**bleiben**. Ein Rückfall auf `None` würde einen ausgeführten Installer still auf
Größe-plus-Signatur herabstufen — und weil dieser Pfad Windows-only ist, fiele das
auf dem Mac niemandem auf. Sonde: Pin auf `None` → ein Fehlschlag mit dem Satz „the
digest pin was removed"; Pin zurück → grün.

## Die Argumente werden geprüft, wo die Anfrage entsteht

`executeFileWrite` reichte `args.path` des Modells ungeprüft an `fs_write` weiter.
Fehlte das Feld, fiel es bei `JSON.stringify` aus dem Körper — und genau diese
Anfrage hat einmal live eine 0-Byte-**Datei** an der Stelle erzeugt, an der eine
Käfigwurzel gemeint war. Der Dev-Server fing sie inzwischen ab, der gepackte Build
auch; die dritte Ebene, an der sie *entsteht*, prüfte nichts. Damit sind alle drei
zu.

Beim Lesen fielen sechs weitere Werkzeuge mit demselben Problem auf. Der neue
Helfer folgt dem vorhandenen Muster der Datei: ein zurückgegebener **Text**, kein
`throw`, weil das Werkzeugergebnis der einzige Rückkanal zum Modell ist. Zwei
Unterscheidungen sind bewusst gesetzt: bei `content` und `new_string` heißt `''`
etwas anderes als bei `path` — eine absichtlich leere Datei ist ein gültiger
Auftrag, ein fehlendes Feld nicht. Vorher zog `String(args.content ?? '')` beides
zusammen; genau diese Verwechslung wurde zur 0-Byte-Datei.

Die Wache misst nicht den Wortlaut der Ablehnung, sondern **dass nichts
hinausgeht** — pro Fall wird der Bridge-Befehl gezählt. Dazu ein
Vollständigkeitstest gegen `inputSchema.required` des Katalogs: ein neues Werkzeug
mit ungeprüftem Pflichtargument fliegt automatisch auf, statt auf die nächste
Handzählung zu warten.

Im selben Paket fiel eine Entscheidung, die seit Wochen als „Verhaltensfrage"
offen stand. Die Prüfung, ob der Denkmodus herabgestuft werden muss, stand dreimal
da, und nur die Hermes-Kopie trug die Bedingung `thinking !== undefined`. Das
Urteil lautet jetzt: **Fehler in den anderen beiden, keine Hermes-Besonderheit.**
Der Abstieg *besteht* darin, `thinking` fallenzulassen; war es schon `undefined`,
ist die Wiederholung byte-identisch mit der gescheiterten Anfrage — zweite Absage,
zweite Abrechnung, kann per Konstruktion nicht helfen. Also nicht weggeräumt,
sondern eingezogen: eine Funktion, drei Aufrufstellen, jede reicht ihre eigene
Options-Variable hinein. Ollama und OpenAI bekommen die Bedingung damit erstmals.

## Kein Raster mehr als Hauszeichen

Es waren zwölf Einbindungen, nicht zehn. Die elfte stand in keiner Audit-Liste und
fiel durch die alte Wache: `create/experimental/Stage.tsx` hing an
`/LU-monogram-white.png` — einer **byteidentischen Kopie** des `-bw`-PNG, gleicher
MD5, 3219 Bytes, 512×512. Die alte Wache suchte einen *Namen*. Die neue sucht ein
*Muster*: jede Zeichenkette `*(monogram|logo|brand|wordmark)*.(png|jpg|webp|…)` in
`src/**` und `index.html`, Kommentare gestrippt. Null Treffer. Die Plattform-Icons
unter `src-tauri/icons/` werden dabei **positiv** als Raster festgehalten, damit
niemand den Test als Auftrag missversteht, sie zu vektorisieren.

Die Lesbarkeit ist gemessen, nicht behauptet — Alphakanal ausgezählt. Der Gewinn
des SVG wächst mit der Größe und ist bei 18 px im Rauschen. Bei 10 und 12 px hat
**keine** der beiden Fassungen ein voll deckendes Pixel: das Zeichen ist dort unter
seiner Lesbarkeitsgrenze und nur tragbar, weil das Wort daneben steht. Das steht
jetzt in `brand.ts`, statt als stille Annahme im Kopf des nächsten Lesers.

Beim Titlebar-Monogramm gibt es bewusst **kein** pauschales Urteil, weil die zwei
Zweige nicht dasselbe Ding sind. Auf mac zeichnet das System kein App-Symbol in den
Balken; das Zeichen saß dort rechts als erfundene Marke, 32 px über der zweiten im
Header — und seit dem Header-Umbau mit 18 und 20 px fast gleich groß, die Redundanz
war also *stärker* geworden. Gestrichen; der Streifen bleibt für die nativen
Lichter. Unter Windows und Linux **ersetzt** die App den Systembalken, und was dort
links steht, ist keine Marke, sondern das Fenstersymbol. Bleibt. Beides im Code
begründet, beides im Test festgenagelt.

Nebenbei ist die Pfad-Doppelung aufgelöst, die der vorige Monogramm-Commit selbst
gemeldet hatte. Die zugehörige Wache wurde dafür **umgedreht statt entschärft**:
sie verlangt jetzt den Import *und* die Abwesenheit jedes eigenen Pfadliterals,
8 → 12 Prüfungen. Sonden: `Stage.tsx` zurück aufs PNG → 3 rot, während die alte
Wache grün blieb — das war das Loch; mac-Zeichen wieder eingesetzt → 3 rot; zweite
Füllfarbe im SVG → rot.

## Der scharfe Reset war unter AA, und zwar genau dann, wenn er gefährlich wurde

Der Befund in der Matrix war veraltet, und darunter lag ein echter. Behauptet war,
ein Reset-Link stehe im Dunkelmodus auf 3,37:1. Live gemessen — Farben aus
`getComputedStyle`, `oklch` über Canvas aufgelöst — steht er in Ruhe dunkel bei
**6,57:1** und hell bei **10,31:1**. Die 3,37 gab es nie auf dem Schirm. Sie waren
aus Klassennamen gerechnet, mit zwei falschen Annahmen: der Grund ist `#1e1e1e`,
nicht `#202020`, und `text-gray-500` erreicht den Browser gar nicht, weil der
Rescue-Layer in `index.css` es anhebt.

Offen war stattdessen der **scharfe** Zustand desselben Knopfs: `text-red-400` ohne
hellen Gegenpart, und `red-400` heißt in Tailwind 4 `#ff6467` — hell scharf
**2,89:1**. Der Knopf war also ausgerechnet dann unter AA, wenn er gefährlich
geworden war. Jetzt `text-red-600 dark:text-red-400`, das Rotpaar des Gefahrknopfs
daneben: hell 4,77:1, dunkel 5,77:1. Eine fremde Wache pinnte beide Zweige wörtlich
und ist bewusst mitgezogen, mit der alten Zeile als Zitat davor.

Die Settings-Spalte stand seit dem Rail-Umbau nicht mittig, sondern links mit einer
großen Leere rechts. Ein `justify-center` auf der Zeile, die Rail und Inhalt
enthält, Breiten unangetastet. Gemessen in drei Fensterbreiten, links/rechts:
1280 → 134,0/134,0 · 1440 → 214,0/214,0 · 1920 → 454,0/454,0. Zentriert wird das
**Paar**, nicht der Inhalt allein — der allein mittig wäre wieder die
freischwebende Spalte, also genau der Befund, den derselbe Umbau geschlossen hat.

Und die Frage, ob vor dem ersten Inhalt zwei Bänder eines zu viel sind, ist
beantwortet: **zwei ist die richtige Zahl.** Fensterrahmen und Header tragen
dieselbe Fläche — Kontrast 1,00:1 in beiden Modi, keine Kante, kein Schatten —, und
außerhalb von Tauri rendert die Titlebar `null`. Es liegen also nicht zwei Streifen
übereinander, sondern ein Grund, auf dem die Pane liegt. Der Schritt auf eins wäre
ein DOM-Schritt ohne Bildschirmwirkung, sein Preis (Drag-Region, Ampeln,
Fensterknöpfe in die Kopfzeile) real. Die neue Wache pinnt deshalb nicht das
Ergebnis, sondern die **Voraussetzung** der Entscheidung: Gleichheit der
Flächenklassen, keine Kante dazwischen. Kippt die, ist die Begründung hinfällig.

## Das Token-System hat einen Aufrufer je Stufe — und zwanzig Sperrklinken

Der Audit nannte sieben Token-Zeilen. Es ist **ein** Befund in sieben
Ausprägungen: es gibt ein System, und die App geht daran vorbei. Die Zahlen, jede
mit dem Zähler ihrer eigenen Wache, vorher → nachher: `text-[…]` 1008 Fundstellen
über 25 Werte → **826 über 23**, `.t-*`-Nutzungen 152 → **333**, Akzent-Hex im Code
23/11/5 → **0**, dunkle Graustufen als Literal 15 → **11**, Schwebeblätter mit
eigener Klassenkette 10 → **0**, `.lu-elevated`-Call-Sites 6 → **15**,
`transition-all` 49 → **33**, `MOTION_S`-Aufrufe 0 → **23**, verschiedene
`size={n}` 19 → **15**.

Der Hebel lag jedes Mal in der Sprache, nicht in der Fundstellenzahl. `text-[…]`
sank um 182 Stellen, weil **eine** Klasse das 4-px-Band unter dem Fließtext
übernahm — nicht weil jemand 182 Call-Sites einzeln angefasst hätte. `shadow-sm`
ist im Dunkelmodus durch **eine** Hausregel neutralisiert statt an achtzehn Stellen
entfernt, und das ist Arithmetik, keine Bequemlichkeit: selbst 100 % Schwarz schafft
auf `#141414` nur 1,140:1, der Schatten ist dort schlicht unsichtbar. Zehn
Schwebeblätter trugen sechs Flächen, drei Schatten und zwei Kanten; das
Kontextmenü stand in der Farbe der Leinwand darunter. Alle zehn tragen jetzt ein
Rezept.

Ein Fund verdient eigene Erwähnung, weil er die Klasse von Fehler ist, die man nur
beim Hinsehen findet: `--color-lu-raised: #2d2d2d` war **tot**, und tot heißt hier
schlimmer als ungenutzt. Tailwind gibt ein Farbtoken ohne Aufrufer gar nicht erst
aus — wer `bg-lu-raised` schrieb, bekam im Fenster eine leere Variable, also
**keine Farbe und keinen Fehler**. Eine Stufe, die beim ersten Gebrauch still
danebengreift, gehört nicht beschriftet, sondern gelöscht. Die vorige Fassung hatte
nur geprüft, dass „0 Call-Sites" danebensteht; das war die halbe Antwort.

Umgekehrt bleibt `--shadow-2xl` bewusst stehen, obwohl es keinen `var()`-Aufrufer
hat: die Zeile zu löschen entfernt den Schatten nicht, sie fällt auf Tailwinds
Werkswert zurück. Genau der stille Halbbesitz, um den es geht — ein sichtbarer
toter Token ist ehrlicher als ein unsichtbarer Werkswert.

`rounded-[5px]` ist entschieden statt aufgezählt: **keine Sprosse.** Zwischen 4 und
6 läge sie bei `--ui-scale` 1,15 einen Gerätepixel von beiden Nachbarn — dieselbe
Auflösung, in der vierzehn Schriftgrößen als Rauschen verworfen wurden. Die zwanzig
gehören auf `rounded-md`. Alle zwanzig liegen in einer Datei, die im selben
Durchgang einem anderen Agenten gehörte, also: gedeckelt, nicht gezogen.

Zwanzig Sperrklinken stehen jeweils auf dem **erreichten** Wert, nicht auf einem
Wunschwert, und jede ist mit einer Sonde rot→grün belegt. Zwei vorhandene Wachen
mussten verschärft werden, weil sie ohne den Fix grün geblieben wären — eine las
die Klasse, über die sie urteilte, aus einem Kommentar.

## Testflocken ohne Uhr, eine Antwort für `fs-list`, und vier Versprechen weniger

Die roten Rust-Tests unter Last waren nie ein Produktfehler, aber sie waren auch
nicht „einfach flaky". Gemessen mit einer Apparatur — N Kopien des Testbinaries
gleichzeitig, zehn Runden: bei drei Kopien 14 Fehlschläge in 12 roten Läufen, bei
sechs Kopien **87 Fehlschläge in 57 roten Läufen**. Danach: 0 und 0.

Der ursprünglich benannte Haupttest war schon zu. Rot waren die Nachbarn, und jeder
aus einem eigenen, lehrreichen Grund. `the_call_does_not_block_for_the_grace_period`
maß mit `took < 400ms` gar nicht den Gnadenzeitraum, sondern wie schnell die
Prozesstabelle durchgegangen wird — die Stoppuhr ist raus, an ihre Stelle tritt eine
**Ordnungsfrage ohne Uhr**: direkt nach dem Kill ist das Kind noch unser ungeernteter
Zombie, also kann der Aufruf nicht gewartet haben. `every_screenshot_gets_its_own_
temp_file` zählte alle `lu-screenshot-*` im geteilten Temp und stellte damit eine
Frage über die *Maschine*; jetzt steht die PID im Namen.
`lists_only_directory_names_sorted` hatte den Rumpf der Produktionsfunktion
**kopiert** und die Kopie geprüft; die Regel steht jetzt an einer Stelle, von
Kommando und Test gerufen.

`fs-list` auf die Wurzel beantworteten Rust und der Dev-Server unterschiedlich —
der Grundfehler dieses Projekts in Reinform. Aufgelöst zugunsten des Dev-Servers,
und die Begründung ist eine Regel, kein Münzwurf: **eine Auflistung ist ein
Lesevorgang und darf nichts anlegen.** `fs_list` war die einzige der sechs Türen,
die die Platte veränderte, und diese Datei hat für „eine Anfrage ohne Datei löst
einen Schreibvorgang aus" schon zweimal bezahlt. Greifbar war es auch: der
Explorer ruft `fs_list` direkt, das alte Verhalten legte für jeden bloß
angeschauten Chat einen Ordner an. Wachen stehen jetzt auf beiden Seiten; die
Rust-Seite liest die TypeScript-Datei per `include_str!` und prüft, dass deren
`fs-list`-Block kein `mkdirSync` trägt.

Und vier Funktionen ohne Aufrufer sind weg — `mlx_stop`, `lmstudio_installed`,
`ollama_installed`, `comfyui_search_roots`, alle vier mit einem
`#[allow(dead_code)]` und einem „entscheide später" daran. Ein repo-weiter `git
grep` über `src/`, `dev-server/`, `e2e/` und `mobile-client/` fand für jede genau
**einen** Treffer: ihre eigene Definition. Mit ihnen fiel die Kaskade der vier
Helfer, die nur sie am Leben hielten. Die Frage, die sie beantworten sollten, wird
längst woanders beantwortet — genau die zweite Tür, um die es hier durchgehend
geht.

## Der letzte gewachsene Riese, und ein Knopf, der nie hing

`Onboarding.tsx` hatte 1909 Zeilen und war die letzte der drei Dateien, die unter
den Audit-Fixes *gewachsen* statt zerlegt worden waren. Jetzt 343. Geschnitten nach
geteiltem Zustand, nicht nach Schritten — und das ist der ganze Punkt: ein Schnitt
pro Schritt hätte die vier Installer wieder auf vier Dateien verteilt und damit
vier Uhren gemacht, also genau die Regression, die das Onboarding-Paket vorher
mühsam beseitigt hatte. Ein Schritt, der den Zustand von vier anderen hält, ist
kein Schritt.

Die Treue ist nachgemessen, nicht behauptet: von 1457 Codezeilen stehen **1441
wörtlich** im neuen Satz. Die 16 Abweichungen sind Import-Teilungen, zwei `export`,
vier Zeilen aus einem Design-Befund im selben Paket — und zwei erzwungene, beide im
Code begründet: ein `set-state-in-effect`, das der React-Compiler in der
1909-Zeilen-Funktion nie gelesen hatte (klein genug, meldet er es), und zwei
Dependency-Arrays um stabile Identitäten. `useState` 25 → 25: verteilt, nicht
vermehrt. Das DOM ist byte-gleich.

42 angeheftete Zusicherungen in sechs Testdateien mussten mitgehen; 25 wurden
bewegt, 17 blieben, weil der Schnitt danach gelegt wurde. Eine fremde Wache las
bisher nur eine Datei und deckt jetzt zwei — sonst hätte sie nach dem Schnitt nur
noch zwei der vier Installer gesehen. Und eine neue Prüfung hält fest, dass die
Dateiliste den Ordner **abdeckt**: ohne sie wäre die Zerlegung selbst das
Schlupfloch für die `useState`-Sperrklinke gewesen. Diese Prüfung hat sich schon
bewährt — sie schlägt zuverlässig an, sobald jemand eine neue Datei in den Ordner
legt.

Der Nebenertrag ist die Auflösung eines Fehlerbilds, das monatelang wie ein
Produktfehler aussah: zwei Schaltflächen **„Continue"** auf demselben Schritt, die
zweite in einer Klappe. Playwright wiederholt eine strict-mode-Verletzung bis zum
Timeout — deshalb las sich das als 60-Sekunden-Hänger an einem Knopf, der weder
deaktiviert noch animiert war. Die zweite heißt jetzt „Use this engine": kein
„Continue" im Namen, denn `getByRole` trifft auf Teilstrings, und ein „Continue
with…" hätte die Verletzung nur schöner formuliert. Ein Screenreader hört seitdem
zwei Namen statt zweimal denselben.

Im selben Paket fielen die letzten Sonderbehandlungen unter den Onboarding-Knöpfen.
„Cancel" war das eigentliche Einzelstück — 8,8 px Schrift, rote Kante, 11 px
Trefferfläche — und trägt jetzt dasselbe Rezept wie Stop: **Abbrechen ist der
normale Ausgang, nicht der Defekt.** 6,42:1 / 7,23:1. Keiner der vier musste anders
bleiben.

## Der 422 gehört allen

Nach dem Einziehen des Denk-Abstiegs hatte eine Datei genau eine Stelle. Draußen
standen weitere **vier** Kopien derselben Fehlerform, drei in `useAgentChat.ts`,
eine in `useChat.ts` — und die letzte trug eine 422-Bedingung, die den anderen
fehlte. Die Wache war grün geblieben, während das passierte, weil sie nur in einer
Datei zählte. Sie zählt jetzt repo-weit, mit Landkarte und einem Selbsttest gegen
einen verrutschten Wurzelpfad.

Der 422 ist keine Transport-Eigenart, sondern eine Lücke in den anderen. DeepInfra
antwortet 422 auf einen schlechten Parameter, der Cloud-Proxy reicht ihn absichtlich
durch, und die Provider-Schicht behandelt 400 und 422 selbst als **eine** Klasse.
Er erreicht alle Pfade über denselben Aufruf — nur hatte `useChat` ihn, und die
Agentenpfade beendeten beim selben Anbieter den ganzen Lauf. Der Preis eines
Fehlalarms ist genau eine zusätzliche Anfrage, derselbe Preis, den 400 seit jeher
hat, und die Zusatzbedingung deckelt ihn. Ein Test hält ausdrücklich dagegen, dass
daraus „irgendein 4xx" wird.

## Eine Wache verglich Pfade mit dem Trennzeichen des Betriebssystems

Auf der Windows-Maschine, am selben Commit: 548 Testdateien grün, **eine** rot, zwei
Zusicherungen. Die Monogramm-Wache nimmt ihre eigene Quelldatei per
`rel !== 'src/components/layout/brand.ts'` aus der Suche — und unter Windows heißt
dieselbe Datei `src\components\layout\brand.ts`. Für die Wache war `brand.ts` also
eine zweite Kopie ihrer selbst.

Das ist Zeile für Zeile derselbe Fehler, den eine Woche zuvor an fünf Stellen
weggeräumt wurde: ein handkopierter Verzeichnis-Wälzer, der Pfade mit dem
Trennzeichen des Systems zusammensetzt. Diese Wache ist **jünger** als der geteilte
Wälzer und hat trotzdem ihren eigenen bekommen. Der relative Pfad wird jetzt beim
Einsammeln an genau einer Stelle normalisiert, mit dem Grund daneben. Der eigene
Wälzer bleibt vorerst — das ist ein zweiter, benannter Rest, kein Versehen, und er
steht seitdem als eigene Zeile in der Matrix.

## Der tote Zweig, den ein Test am Leben hielt

Im Mobile-Client war der Doppel-Dekodier-Zweig unter dem ersten `JSON.parse`
**unerreichbar**: ein doppelt kodiertes Argument *ist* gültiges JSON — eine
JSON-Zeichenkette —, das erste Parse gelingt, `typeof` sagt `'string'`, Rückgabe
`{}`. Genau der Fehler, den der Kommentar daneben zu beheben behauptete.

Er stand so lange, weil ein Pin ihn hielt: eine Paritätswache verlangte das `{}`
wörtlich, mit dem Vermerk „deliberately NOT fixed here" aus dem Umbau, der den
Client aus einem Rust-Rohstring geholt hat. Damals war das richtig — dort ging es
um Byte-Gleichheit, nicht um Verhalten. Jetzt ist der Pin nachgezogen und der Zweig
durch eine Schleife ersetzt: parsen, solange das Ergebnis eine Zeichenkette ist, auf
vier Lagen gedeckelt. Elf neue Fälle, auch über den Weg, auf dem der Client die
Argumente wirklich bekommt.

Gemessen und ausdrücklich **nicht** hier gefixt: der Desktop hat denselben Fehler.
Für dieselbe Eingabe gibt `src/lib/tool-call-repair.ts` `{}` zurück. Mobile ist an
dieser Stelle jetzt besser als Desktop — die Umkehrung des Normalfalls in diesem
Projekt, wo sonst der Nachbau der schlechtere ist. Steht als offener Rest in der
Matrix.

Die zweite lose Sperrklinke aus derselben Familie ist ebenfalls nachgezogen:
`toBeGreaterThanOrEqual(9)` bei zehn Werkzeugen wurde nicht auf 10 gesetzt, sondern
**aus dem Katalog abgeleitet**. Sonde: ein Werkzeug entfernt → rot; die alte Klinke
wäre im selben Zustand grün geblieben.

Und die Marke: der Remote-Server liefert keine Datei aus dem Client-Verzeichnis
aus, er baut **eine** Seite und kennt genau eine Bildroute. Ein
`<img src="/LU-monogram.svg">` wäre dort ein 404 gewesen. Deshalb steht die Marke
jetzt als `<symbol>` im Dokument, Pfaddaten Zeichen für Zeichen aus der SVG-Quelle,
vier `<use>`-Stellen, mit einer Driftwache zwischen Sprite und Quelle. Visuell bei
375×812 nachgemessen: 64/22/18/82 px, Marke exakt mittig. Danach hat das alte PNG
keinen Aufrufer mehr; die Route dorthin bleibt als benannter Rest stehen, weil
`src-tauri` nicht zum Paket gehörte.

## Ein Absatz, der das Falsche sagte

Der Abschnitt „Was außerhalb der Reichweite liegt" in der Monogramm-Wache
begründete, warum das Mobile-Verzeichnis nicht mitgeprüft wird: dort stehe die
Marke als PNG. Seit dem Sprite-Umbau stimmt das nicht mehr, also ist der Grund weg
und mit ihm der Ausschluss. Der Wälzer nimmt das Verzeichnis dazu.

Das ist ein kleiner Commit und steht hier trotzdem, weil er den Fehler behandelt,
um den es in diesem ganzen Protokoll geht: eine Begründung, die ihren Gegenstand
überlebt hat. Eine Wache mit einem veralteten Absatz ist nicht falsch — sie ist
schlimmer, sie ist plausibel.

## Clippy war auf Windows rot, in Code, den der Mac nie kompiliert

Die CI fährt `cargo clippy --all-targets -- -D warnings` über die ganze
Plattform-Matrix. Auf der Windows-Maschine brach es am selben Commit, an dem der
Mac grün ist, mit **acht** Fehlern ab. Keiner davon ist auf dem Mac sichtbar: vier
stehen in Funktionen hinter `#[cfg(target_os = "windows")]`, vier sind Funktionen,
deren einziger Aufrufer hinter einem cfg-Tor liegt, das auf Windows zu ist — dort
sind sie tot, hier nicht.

Die windows-only Hälfte ist mechanisch: ein zusammengeklapptes `else { if let }`,
zweimal `sort_by` auf `sort_by_key(Reverse)`, ein `map_or(false, …)` auf
`is_some_and`. Die andere Hälfte ist die interessante, und sie ist **nicht** mit
`#[allow(dead_code)]` erledigt worden — das hätte die Frage nur zugeklebt. Jede der
vier Funktionen trägt jetzt exakt das cfg ihres Aufrufers: der
Port-Killer das von `state.rs` beim Beenden, der LM-Studio-CLI-Sucher das seines
Nicht-Windows-Zweigs, der Test-Portleaser und ein Testmodul-Import je `unix`. Das
Attribut sagt damit, **wo die Funktion lebt**, statt zu behaupten, sie dürfe
unbenutzt sein.

Auf Windows nachgemessen: clippy 0, `cargo test` unverändert grün. Auf dem Mac
konnte in diesem Moment kein `cargo check` laufen — der Fenster-Agent hatte
`main.rs` mitten im Umbau; die Gegenprobe wird mit dessen Paket zusammen gemessen
und steht bis dahin ausdrücklich aus.

Damit ist derselbe Befund zum vierten Mal in derselben Form wiedergekommen: acht
rote Tests aus Pfadtrennzeichen, neun aus dem Ort der Testkulisse, eine Wache, die
sich für ihre eigene Kopie hielt, und jetzt acht Clippy-Befunde. **Eine Zone, die
eine Maschine nie ansieht, ist ungedeckt — auch wenn dort grün steht.**

## Was diese Runde über die Matrix selbst herausgefunden hat

Diese Fassung der Befundmatrix hat mehr Zeilen geändert als jede vorige, und der
Grund ist unangenehm: die Datei nannte **zwei** verschiedene Mess-Commits, einen in
der Kopfzeile und einen achtzehn Zeilen tiefer, vierzig Commits auseinander.
Solange beide dastanden, war für keine einzige Zeile entscheidbar, gegen welchen
Stand sie gilt — und genau deshalb konnte sie veralten, ohne dass es auffiel.

Was dabei herauskam, ist wörtlich der Befund, den dieselbe Matrix dem Code an
zwölf Stellen vorhält: zwei Beschreibungen desselben Sachverhalts, eine gepflegt.
Acht Token-Zeilen standen auf „OFFEN", obwohl zwei Pakete sie geschlossen hatten.
Zwei Nachtragszeilen standen auf „offen", obwohl die Commits, die sie schlossen,
in derselben Datei zitiert wurden. Zwei Wellen-Posten standen auf „OFFEN", obwohl
die Kommandopalette und die Kontextmenüs seit Wochen im Baum lagen — einmal wurde
deshalb ein Agent losgeschickt, der nach eigener Messung zurückkam und meldete, es
sei nichts zu tun.

Die Gegenmaßnahme ist keine Sorgfaltsermahnung, sondern dieselbe, die dieses
Projekt überall anwendet: **die Summen werden jetzt aus der Datei gezählt, nicht
aus dem Kopf**, und der `grep`, der das tut, steht als Kommentar unter jeder
Tabelle. Er hat beim ersten Lauf sofort etwas gefunden — die Signale-Spalte stand
auf 12 und ergab damit 74 statt der 73, die zwei Zeilen darüber im selben Abschnitt
stehen. Eine Zahl, die niemand nachrechnen kann, ist keine Zahl, sondern eine
Behauptung.

Vierzehn neue Zeilen sind dazugekommen, und zwölf davon sind **Selbstmeldungen**
aus den Paketen dieser Runde: „gemessen und nicht hier gefixt", „bleibt als
benannter Rest", „gehört einem anderen Agenten". Das ist der eigentliche Ertrag.
Ein Rest, den ein Commit ehrlich benennt und den kein Register aufnimmt, ist genau
so verloren wie einer, den niemand gesehen hat — nur teurer, weil ihn schon einmal
jemand bezahlt hat.

## Das Onboarding bekommt ein eigenes Fenster — und der Marker entscheidet, wer es ist

Ein Wunsch des Eigentümers, kein Audit-Befund: der Assistent soll ein kleines,
vom Betriebssystem mittig gesetztes Fenster sein, die App bleibt das große.
Der Entwurf steht in einem Satz: Rust entscheidet beim Start aus der Markerdatei
— mit dem Store-Backup als zweiter Quelle —, welches Fenster zuerst sichtbar
wird, und die Fenster **folgen** dem Marker. Damit ist `set_onboarding_done`
nicht nur eine Notiz, sondern der Auslöser für beides: Übergabe bei `true`,
Zurücksetzen bei `false`.

`show_window` zeigt deshalb nicht mehr blind das Hauptfenster, sondern das
rufende nach einer Regel. Solange der Assistent im eigenen Fenster läuft, bleibt
das Hauptfenster unsichtbar; ist der Marker da, wird **erst** das Hauptfenster
gezeigt und **danach** das kleine geschlossen. Erst zeigen, dann schließen — nie
ein Moment ohne Fenster. Die Reihenfolge steht nicht im Kommentar, sondern in
einem Rust-Test, der den Rumpf der Funktion liest.

Die Maße sind gerechnet, nicht gewählt: der längste Schritt misst 531 px, plus
Streifen 37 und Rand 18 sind 586, und 640 lässt 54 px Luft. Dass dieselbe 640
zugleich Tailwinds `sm`-Schwelle ist, ist der zweite Grund und steht als
Untergrenze in einem Test. Das Fenster ist nicht größenveränderbar, hat kein
Maximieren und wird per `.center()` vom System gesetzt. Die Dekoration folgt dem
Hauptfenster der jeweiligen Plattform statt einer eigenen Erfindung: auf mac die
Overlay-Titelleiste mit nativen Ampeln, auf Windows rahmenlos, transparent, ohne
Schatten. Schließen vor dem Ende beendet die App, Subprozesse zuerst.

Die Naht, an der es leicht schiefgegangen wäre, liegt nicht im Fenster, sondern
im `localStorage`. Das Hauptfenster wartet jetzt **vor dem ersten Store-Import**
auf die Übergabe, und zwar auf das Ereignis *und* eine Marker-Nachfrage, gegen
das Rennen zwischen beiden. Ohne das hätten seine Stores mit altem Stand
überschrieben, was der Assistent nebenan gerade geschrieben hatte. Das
Fensterlabel liest genau eine Stelle, und eine Wache verbietet jedes andere
Vorkommen — dieselbe Hausregel wie überall hier, diesmal von Anfang an statt
nach dem dritten Schaden.

Der schönste Fund kam aus dem Lauf und wäre durch kein Lesen gekommen:
`open_devtools()` im Startpfad auf dem *unsichtbaren* Hauptfenster **macht es
sichtbar**. WebKit dockt den Inspector an und holt das Fenster nach vorn —
gemessen, beide Fenster nebeneinander auf dem Schirm. DevTools laufen jetzt erst
beim Aufdecken, und nur für das Hauptfenster.

Belegt ist das Verhalten mit CoreGraphics-Messungen am echten Debug-Bundle. Ohne
Marker steht bei t+3, t+8 und t+15 Sekunden genau **ein** Fenster, 640×640 an
(544,192), Mitte (864,512) — die Bildschirmmitte; kein Hauptfenster, auch nach
dem 10-Sekunden-Notweg nicht, und ein zweiter Start ergibt einen Prozess und
dasselbe Fenster. Sagt das Backup „fertig", schreibt Rust den Marker nach und bei
t+2 s steht **nur** das Hauptfenster, 1280×800, nie ein kleines. Mit Marker, aber
ohne Store, greift der Notweg: nur das Hauptfenster, Assistent inline.

Zwei Reste sind ausdrücklich benannt und stehen als solche in der Matrix. Der
**Klick durch den Assistenten bis zur Übergabe wurde nicht ausgeführt** — keine
Bildschirmsteuerung freigegeben; gedeckt ist die Übergabe durch Rust-Tests und
Quelltext-Wachen, nicht durch Ausführung, und die Handprüfung steht aus. Und vier
**Windows-Punkte** sind dort nachzusehen: ob die Fläche das transparente Fenster
voll deckt, ob `.center()` auf dem Cursor-Monitor zentriert, ob ein Doppelklick
auf die Ziehfläche nicht doch maximiert, und ob beide Webviews wirklich dasselbe
`localStorage` sehen — letzteres ist die Annahme, auf der die ganze Übergabe
ruht.

Gates: tsc 0, eslint 0/0, vitest 553/8203, madge 0, `cargo test` 812 (+21 im
neuen Modul), clippy 0, Playwright 39/3. Kein `eslint-disable`, kein `any`, kein
neues `allow`, kein `skip`.

## Ein Mess-Commit statt zwei

Die Befundmatrix ist auf den Stand gebracht, und der Anlass war nicht, dass
einzelne Zeilen veraltet waren, sondern **warum** sie es konnten: die Datei
nannte zwei verschiedene Mess-Commits, einen in der Kopfzeile und einen achtzehn
Zeilen tiefer, vierzig Commits auseinander. Solange beide dastanden, war für
keine Zeile entscheidbar, gegen welchen Stand sie gilt.

Was dabei zutage kam, ist wörtlich der Befund, den dieselbe Matrix dem Code an
zwölf Stellen vorhält. Acht Token-Zeilen standen auf „OFFEN", obwohl zwei Pakete
sie geschlossen hatten. Zwei Nachtragszeilen standen auf „offen", obwohl die
Commits, die sie schlossen, in derselben Datei zitiert wurden. Zwei
Wellen-Posten standen auf „OFFEN", obwohl Kommandopalette und Kontextmenüs seit
Wochen im Baum lagen. Nach dem Nachziehen steht der Technik-Audit bei 83 von 85
umgesetzt und keiner offenen Position, der Design-Audit bei 66 von 73 und einer
halben Zeile.

Die Gegenmaßnahme ist keine Sorgfaltsermahnung, sondern dieselbe wie überall
hier: **die Summen werden aus der Datei gezählt, nicht aus dem Kopf**, und der
`grep`, der das tut, steht als Kommentar unter jeder Tabelle. Er hat beim ersten
Lauf sofort etwas gefunden — die Signale-Spalte stand auf 12 und ergab damit 74
statt der 73, die zwei Zeilen darüber im selben Abschnitt stehen. Und er hat eine
zweite Lehre erzwungen: über den Fließtext einer Zeile zu zählen ist untauglich,
weil „die größte offene Tür" und „offengelegt" mitzählen. Gezählt wird die
Statusspalte.

Vierzehn neue Zeilen sind dazugekommen, zwölf davon **Selbstmeldungen** aus den
Paketen dieser Runde: „gemessen und nicht hier gefixt", „bleibt als benannter
Rest", „gehört einem anderen Agenten". Ein Rest, den ein Commit ehrlich benennt
und den kein Register aufnimmt, ist genau so verloren wie einer, den niemand
gesehen hat — nur teurer, weil ihn schon einmal jemand bezahlt hat.

Zwei Formfehler sind nebenbei gefallen: zwei Zeilen Werkzeug-Auswurf, die ein
früherer Lauf mitten in einen Abschnitt geschrieben hatte, und eine
Tabellenkopfzeile mit fünf Spalten über Zeilen mit sieben. Dazu vier Zellen, in
denen ein unmaskiertes `|` die Tabelle zerriss — sichtbar erst, als jede Zeile
maschinell auf ihre Spaltenzahl geprüft wurde.
