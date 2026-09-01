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
