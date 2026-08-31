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

