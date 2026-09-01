# AUDIT-COVERAGE — Deckungsmatrix beider Audits

Zeile für Zeile: welcher Audit-Befund ist im Branch `experiment/audits-komplett` erledigt, welcher nicht.

- **Gemessen an:** `517c29a6` (HEAD), gegen die Basis `10bfa0d7` (v2.6.7). 74 Commits.
- **Quellen:** `LUTechnikAudit2.6.6.html` (85 Befunde, gemessen auf `b123e89` = v2.6.6) · `LU-Design-Audit.md` (Stand 2026-08-25).
- **Methode:** Beide Commits wurden als unveränderliche Snapshots ausgecheckt (`git archive`) und der Sachverhalt jedes Befundes **am Code** nachgeschlagen — nie an der Zeilennummer, die 119 Commits alt ist. Eine Commit-Nachricht, die einen Befund erwähnt, zählt hier **nicht** als Beleg; wo Nachricht und Code auseinandergehen, gilt der Code, und die Abweichung steht in Abschnitt 5.
- **Warum `base/` mitgeprüft wurde:** Zwischen dem Audit-Commit `b123e89` und der Experiment-Basis `10bfa0d7` liegen 119 Produkt-Commits. Ein Befund, der schon dort weg war, ist `war schon behoben`, nicht `umgesetzt`.

**Status** = genau einer von `umgesetzt` · `war schon behoben` · `gegenstandslos` · `OFFEN` · `unklar`.
**Verifikationsgrad** = genau einer von `im Lauf bewiesen` · `per Test` · `nur Review` · `nicht verifizierbar hier`.

> Zu `im Lauf bewiesen`: Ich habe in dieser Sitzung selbst nichts gebaut und nichts gestartet — fünf andere Agenten arbeiten parallel im selben Arbeitsbaum, ein `npm run build`, `vitest`, `cargo test` oder ein App-Start hätte ihnen dazwischengefunkt. Wo dieser Grad steht, ist der Lauf **anderswo mit gemessener Ausgabe belegt**: die 403/403/200-Sonde gegen den echten Dev-Server (`aad90b1c`), der cmd.exe-Banner auf `lu-box` (`ba9557df`), die Exit-0/Exit-1-Sonden des Build-Gates (`517c29a6`) und der Windows-Strang auf der echten Maschine (`cargo test` 715 grün, `tauri build` Exit 0 mit MSI und NSIS, App-Start mit vollständiger WebView2-Prozessfamilie, keine Nutzerdaten berührt). Die Anmerkung sagt jedes Mal dazu, worauf sie sich stützt.

---

## 1. Bilanz

Gemessen am HEAD `517c29a6`. Die Zählung des Audits („12 kritisch, 34 hoch, 30 mittel, 2 niedrig") meint die **CONFIRMED**-Befunde; die Befundtabelle §4b hat 85 Zeilen, weil 7 als *unbewiesen* markierte dazukommen (1 kritisch, 3 hoch, 3 mittel). Diese Matrix führt alle 85.

### Technik-Audit — 85 Befunde

| Status | kritisch (13) | hoch (37) | mittel (33) | niedrig (2) | **gesamt** |
|---|---|---|---|---|---|
| umgesetzt | 13 | 37 | 21 | 2 | **73** |
| war schon behoben | 0 | 0 | 0 | 0 | **0** |
| gegenstandslos | 0 | 0 | 1 | 0 | **1** |
| **OFFEN** | **0** | **0** | **11** | **0** | **11** |
| unklar | 0 | 0 | 0 | 0 | **0** |

**Kein einziger kritischer und kein einziger hoher Befund ist offen.** Alle elf offenen liegen im Mittelfeld.

Verifikationsgrad, Technik: `im Lauf bewiesen` 2 · `per Test` 64 · `nur Review` 16 · `nicht verifizierbar hier` 3.

**Zusätzlich, außerhalb der 85er-Liste** (§3 Zeitbomben und §4 Amateur-Signale ohne Entsprechung in der Befundtabelle, 9 Positionen): umgesetzt 4 · gegenstandslos 1 · **OFFEN 4**.

### Design-Audit — 73 Befunde

Gezählt sind §3 (10 Amateur-Signale), §4 (49 Screen-Bullets), §5 (13 Token-Zeilen) und die eine Korrektur im Anhang. §7 „Die eine Sache" ist eine Dublette von D-A1 und nicht mitgezählt.

| Status | Signale (10) | Screens (49) | Tokens (13) | Anhang (1) | **gesamt** |
|---|---|---|---|---|---|
| umgesetzt | 6 | 8 | 3 | 1 | **18** |
| war schon behoben | 0 | 2 | 0 | 0 | **2** |
| gegenstandslos | 0 | 0 | 0 | 0 | **0** |
| **OFFEN** | **4** | **39** | **10** | **0** | **53** |
| unklar | 0 | 0 | 0 | 0 | **0** |

Verifikationsgrad, Design: `im Lauf bewiesen` 0 · `per Test` 12 · `nur Review` 56 · `nicht verifizierbar hier` 5.

**Der Politur-Pfad (§6), 23 Posten:** Welle 1 5/5 · Welle 2 5/7 · Welle 3 7/11 — zusammen 17 umgesetzt, 6 offen.

### Das Gesamtbild in einem Satz

Der Technik-Audit ist zu 86 % umgesetzt und in seinen beiden schweren Klassen **vollständig** (50 von 50); der Design-Audit ist zu 25 % umgesetzt. „Ausnahmslos" stimmt für keinen von beiden — es fehlen 11 Technik-, 4 Nachtrags- und 53 Design-Befunde.

> **Stand der Messung.** Alles unten ist am committeten HEAD gemessen. Im Arbeitsbaum liegen zum Zeitpunkt dieser Aufnahme uncommittete Änderungen von fünf parallel arbeitenden Agenten, darunter neue Dateien `src/components/ui/CommandPalette.tsx`, `ContextMenu.tsx`, `command-actions.ts`, `menu-actions.ts` samt Tests — D-W3-9 und D-W3-10 sind also gerade in Arbeit und werden hier trotzdem als `OFFEN` geführt, weil sie nicht committet sind. Ebenso berührt sind `IntentBar.tsx`, `Composer.tsx`, `MessageBubble.tsx`, `Sidebar.tsx`, `Header.tsx`, `index.css` und `useKeyboardShortcuts.ts` — also die Dateien hinter D-A10, D-A3, D-S07/S08, D-S14/S15/S17 und D-T13.

---

## 2. Technik-Audit — die 85 Befunde

Der Audit vergibt IDs **nur für die zwölf kritischen Befunde** (Anhang A: `BRD-1`, `IPC-1`, `AGT-1`, `CDX-1`, `CDX-2`, `CS-1`, `CVX-1`, `DD-1`, `OI-1`, `OI-2`, `RA-1`, `RP-1`) und für die fünf **widerlegten** (`AGT-4`, `DD-5`, `DD-7`, `RA-5`, `BRD-8`, Anhang D). Die übrigen 73 Befunde sind in der Befundliste (§4b) und in Anhang B nur über Subsystem + Fundstelle identifiziert — sie tragen hier die laufende Nummer **T-01 … T-85** in der Reihenfolge der Befundtabelle des Audits. Wo eine Audit-ID existiert, steht sie dazu.

### 2.1 kritisch (13 Zeilen: 12 CONFIRMED + 1 unbewiesen)

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| T-01 / **AGT-1** | `delegate_task` umgeht den Freigabe-Dialog | `sub-agent.ts:187` | umgesetzt | `4a228035` | per Test (`src/api/agents/__tests__/tool-executor-abort.test.ts`, `src/hooks/__tests__/approval-shows-the-payload.test.ts`) | `awaitApproval` ist im `ExecutorRuntime` jetzt Pflichtfeld (`tool-executor.ts:124`, kein `?`); `sub-agent.ts:358-369` reicht `awaitApproval`, `recordAudit` und `{ abortSignal }` durch. Opt-out heißt sichtbar `APPROVE_ALL`. Der falsche Kommentar in `budget.ts` ist korrigiert, das Budget bleibt bewusst per Delegation. |
| T-02 / **BRD-1** | Dev-Server: DNS-Rebinding-RCE über `allowedHosts:true` | `vite.config.ts:2434` | umgesetzt | `aad90b1c` | im Lauf bewiesen (laut Commit: evil-Host 403, evil.localhost 403, Ollama-Proxy 200 — von mir nicht nachgefahren) | `vite.config.ts:2454` = `allowedHosts: ['localhost','127.0.0.1']`; die Origin-Allowlist (`:429`) besteht nur noch aus Konstanten + einem Loopback-Muster, der `host`-Header geht nicht mehr ein. |
| T-03 / **CS-1** | Bild im Chat kappt die Antwort bei 256 Tokens | `openai-provider.ts:369` | umgesetzt | `21e67a15` | per Test (`src/api/providers/__tests__/` Provider-Suite) | `IMAGE_TOKEN_ESTIMATE = 1500`; `applyMaxTokens` zählt Bild-Parts als Pauschale statt als Base64-Zeichen (`:578-580`). |
| T-04 / **CDX-1** | `file_edit` ohne Side-Effect-Key → stiller Editverlust | `side-effect-key.ts:57` | umgesetzt | `44ca4739` | per Test (`side-effect-key.test.ts`) | `case 'file_edit'` fällt bewusst mit `file_write` auf denselben Key `file_write:<pfad>` zusammen. |
| T-05 / **CDX-2** | Read-only ist nicht read-only | `shell-command-classify.ts:28` | umgesetzt | `3a9ac2e8` (+ `89f8f242`, `99d9be0e`, `8b4792df`, `a277b921`) | per Test (`src/api/mcp/__tests__/shell-bg-refusal-parity.test.ts` u. a.) | `CHAINING = /[;&|\`\n\r>]|\$\(|<\(/`; `git branch` aus der Präfixliste heraus und über eine Flag-Allowlist geregelt. Vier weitere Umgehungswege fielen erst beim Schließen auf und haben eigene Commits — siehe Abschnitt 5. |
| T-06 / **CVX-1** | Stop zwischen Workflow-Bau und Absenden schickt trotzdem ab | `vram-handoff.ts:1105` | umgesetzt | `6aa99201` | per Test (`src/api/__tests__/stop-removes-only-our-job.test.ts`) | `cancelledFor(seq)` prüft direkt vor **und** nach `submitWorkflow`; ein durchgerutschter Job wird per `abandonPrompt(promptId)` wieder aus der Queue genommen. |
| T-07 / **DD-1** | „Wiederholen“ löscht die Teildatei, Retry startet bei Byte 0 | `downloadStore.ts:233` | umgesetzt | `a9b64245` | per Test (`src/api/__tests__/download-integrity.test.ts`, `src/stores/__tests__/downloadStore-orphans.test.ts`) | `retry` geht nicht mehr über `cancelDownload`; `resume` reicht `expectedBytes` + `sha256` durch, der Zustand überlebt den Neustart (`persist`). |
| T-08 / **OI-1** | Jede Linux-ComfyUI-Installation gilt als kaputt | `process.rs:362` | umgesetzt | `c0cc5639` | per Test (Rust-Tests in `process.rs`, Interpreterliste injiziert) | `is_comfyui_install_complete_with` schaut zuerst ins eigene `venv`/`.venv`, dann portable Layouts, dann System-Python. Der tote Unix-Zweig ist weg. Ein echter Linux-Lauf war hier nicht möglich. |
| T-09 / **OI-2** | „ComfyUI installed successfully!“ für ein leeres Verzeichnis | `install.rs:880` | umgesetzt | `c0cc5639` | per Test (Rust-Tests) | `already exists` wird jetzt klassifiziert (`.git` + `main.py` vs. Fremdrepo vs. Fremdverzeichnis); am Ende steht ein `main.py`-Gate (`install.rs:1419`), das den Fehlschlag benennt. |
| T-10 / **RA-1** | Berechtigungs-Panel zeigt etwas anderes als der Server tut | `remoteStore.ts:161` | umgesetzt | `c9935453` | nur Review | `normalizeRemotePermissions` ist der eine Abbildungspunkt; `start`, `refreshStatus` und `restart` lesen die Rechte im selben `set()` vom Server zurück. |
| T-11 / **RP-1** | Keine Virtualisierung: N Markdown-Dokumente in einem Commit | `MessageList.tsx:65` | umgesetzt | `402ec7e3` | per Test (`src/components/chat/__tests__/long-transcripts-stay-cheap.test.ts`, `.../streaming-does-not-repaint-the-app.test.ts`) | **Bewusst anders gelöst als vom Audit vorgeschlagen:** kein Windowing/`react-window`, sondern `content-visibility: auto` ab 200 Nachrichten, mit Begründung im Kopf der Datei (eine Scroll-Instanz, ein Slice müsste die Scroll-Ankerung nachbauen). Die Renderzahlen sind laut Changelog am echten Store gemessen. |
| T-12 / **IPC-1** | Chat-ID `..` hebt den Datei-Jail auf `$HOME` | `agent.rs:50` | umgesetzt | `d15f5cea` + `1a8464dc` + `dab30435` | per Test (`src/lib/__tests__/dev-fs-jail-slug.test.ts`, `src/dev/__tests__/fs-request-path.test.ts`, cargo-Tests) | `.` ist aus der Slug-Allowlist heraus. **Der erste Fix war unvollständig:** zwei weitere Kopien desselben Sanitizers standen offen — in `filesystem.rs` (geschlossen mit `dab30435`) und im TypeScript-Port des Dev-Servers (geschlossen erst mit `1a8464dc`, 60 Commits später). Siehe Abschnitt 5. |
| T-13 | `idbStorage.getItem` verwechselt Lesefehler mit „keine Daten“ | `idbStorage.ts:85` · *unbewiesen* | umgesetzt | `9b72e430` + `2d8b9279` | per Test (`src/lib/__tests__/idbStorage-read-failure.test.ts`, `.../store-backup-mirror.test.ts`) | `readFailed`-Latch + `hasFailedRead()`; ein Schreibvorgang, den der Latch ablehnt, feuert kein `emitWrite` und wird nicht zur neuen Wahrheit. |

### 2.2 hoch (37 Zeilen: 34 CONFIRMED + 3 unbewiesen)

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| T-14 | Chat-Tools-Allowlist nur beim Katalogbau durchgesetzt | `useAgentChat.ts:1238` | umgesetzt | `6aa99201` | per Test (`src/hooks/__tests__/chat-tools-allowlist-at-execution.test.ts`) | Prüfung sitzt jetzt an der Ausführungsstelle (`useAgentChat.ts:1726`), nicht mehr nur bei `:485-490`. |
| T-15 | Externer MCP-Server kapert Builtin-Namen | `mcp/tool-registry.ts:63` | umgesetzt | `6aa99201` | per Test (`src/api/mcp/__tests__/tool-registry-builtin-hijack.test.ts`) | `builtinNames`-Set; Kollision wird abgelehnt statt überschrieben (`:134`), und Disconnect kann einen Builtin nicht mehr löschen (`:157`). |
| T-16 | `enforce-prerelease` ist ein garantierter No-Op | `release-rules.mjs:70` | umgesetzt | `6a472f16` | per Test (28 Tests in `scripts/`) | `ctx.publishedByThisRun` wird **vor** der `rel.id === latest.id`-Kurzschlussprüfung ausgewertet (`:87-90`). Die Kurzschlussprüfung steht noch da, ist aber jetzt nur noch die „ein Mensch hat entschieden“-Regel. |
| T-17 | Release baut `master` HEAD statt des Tags, ohne CI | `release.yml:59` | umgesetzt | `6a472f16` + `517c29a6` | nicht verifizierbar hier für den Workflow (kein Remote, kein Actions-Lauf); das Gate-Skript selbst **im Lauf bewiesen** (laut `517c29a6`: HEAD keyless → Exit 0, `10bfa0d7` nachgestellt keyless → Exit 1) | `release.yml:43-48`: Gate-Job über `workflow_call` auf `ci.yml`, `needs: gate`; `ref: ${{ github.event.release.tag_name \|\| github.event.inputs.tag }}` an beiden Checkouts. `517c29a6` zieht `demote-on-arrival` ohne `needs:` vor, damit das Latest-Flag nicht erst nach einem Zwei-Plattform-Build fällt. |
| T-18 | pdf.js 5.6.205 mit offenem RCE-Advisory | `rag.ts:24` · *unbewiesen* | umgesetzt | `a05b11f4` | per Test (`src/api/__tests__/pdfjs-supply-chain.test.ts`, `.../rag-pdf-eval.test.ts`) | `pdfjs-dist ^6.3.289` (außerhalb GHSA-hq66-cqwq-w95j). `enableScripting` bewusst **nicht** gesetzt — ist in 5.x/6.x keine `getDocument`-Option; im Code begründet. |
| T-19 | Webview-Capability erlaubt `args: true` für 12 Interpreter | `capabilities/default.json:32` | umgesetzt | `3218b16c` | nur Review | `node`, `python`, `deno`, `bun`, `docker` u. a. sind raus; `withGlobalTauri: false`. **Rest-Risiko benannt:** `npx`/`npx.cmd`/`uvx` behalten `args: true`, weil externe MCP-Server so gestartet werden — `npx -y <paket>` bleibt damit ein Weg zu fremdem Code. Die Datei sagt das selbst in ihrer `description`. |
| T-20 | Cancel im Verbindungsaufbau sendet keinen EOF-Marker | `proxy.rs:565` | umgesetzt | `86e9dd17` | per Test (`proxy.rs:1761` `every_exit_path_ends_with_the_eof_marker`) | Vier Rückkehrpfade, alle mit EOF; dazu ein Stall-Cut mit Grund. |
| T-21 | Ollama liefert bei abgeschnittenem NDJSON keinen `done`-Chunk | `ollama-provider.ts:150` | umgesetzt | `9c7243a1` | per Test (`src/api/__tests__/provider-ollama-terminal-chunk.test.ts`, `.../ollama-ndjson-boundary.test.ts`) | `terminal('disconnect')` auf beiden Abrisspfaden; ein *vom Nutzer* gedrücktes Stop bekommt bewusst keinen Terminal-Chunk. |
| T-22 | Anthropic Extended Thinking kann nur 400 erzeugen | `anthropic-provider.ts:160` | umgesetzt | `9c7243a1` | per Test (`src/api/providers/__tests__/anthropic-thinking-and-errors.test.ts`) | `budget_tokens < max_tokens` erzwungen (`max_tokens = max(ceiling, budget + MIN_ANSWER_TOKENS)`), `temperature`/`top_p` werden bei aktivem Thinking gelöscht. |
| T-23 | Abmelden verschluckt den Keychain-Fehler | `useCloudAuth.ts:146` | umgesetzt | `93498d03` | per Test (`src/hooks/__tests__/signing-out-must-not-lie.test.ts`, `src/components/auth/__tests__/sign-out-failure-reaches-the-user.test.ts`) | Der `.catch(() => {})` ist weg; der Fehler kommt aus `signOutAccount()` heraus und erreicht die Oberfläche. |
| T-24 | Linux: Supabase-Refresh-Token im Klartext im localStorage | `cloud/supabase.ts:80` · *unbewiesen* | umgesetzt | `93498d03` | nur Review (Linux-Pfad hier nicht ausführbar) | Fallback ist jetzt dieselbe Verschleierung wie bei den Provider-Schlüsseln; ein *permanentes* Keychain-Fehlen latcht, ein transienter Fehler nicht. **Rest:** Linux hat weiterhin keinen OS-Tresor — das steht als benannte Lücke im Modulkopf, ist also nicht gelöst, sondern angeglichen. |
| T-25 | Jeder 429 heißt „Guthaben aufgebraucht“ | `useCloudCreate.ts:383` · *unbewiesen* | umgesetzt | `93498d03` | per Test (`src/hooks/__tests__/a-429-is-not-always-money.test.ts`) | Nur `code === 'credits_exhausted'` bzw. `/credit/i` liefert den Guthaben-Text; alles andere sagt „die Warteschlange drosselt“ und nennt `Retry-After`. |
| T-26 | Stop bricht ein laufendes Werkzeug nicht ab | `tool-executor.ts:334` | umgesetzt | `6aa99201` | per Test (`src/api/agents/__tests__/tool-executor-abort.test.ts`, `src/api/mcp/__tests__/shell-honours-stop.test.ts`) | Das Signal wird in den Tool-Aufruf durchgereicht (`:392-393`), nicht nur vor dem Batch geprüft. |
| T-27 | Freigabedialog zeigt `args.command`, nie `args.stdin` | `useCodex.ts:1999` | umgesetzt | `6aa99201` | per Test (`src/hooks/__tests__/approval-shows-the-payload.test.ts`) | `renderApprovalPreview(req.toolName, a)` rendert die **vollen** Argumente; `args: a` geht zusätzlich mit. |
| T-28 | `userStoppedRef` pro Hook-Instanz → `/loop` unstoppbar | `useCodex.ts:2401` | umgesetzt | `6aa99201` | per Test (`src/lib/__tests__/run-stop.test.ts`) | Stop-Zustand liegt jetzt pro Conversation auf Modulebene, nicht mehr am Hook (`useCodex.ts:239`, `:2606-2614`). |
| T-29 | Chat-Agent kann gestopptes ComfyUI nie kaltstarten | `vram-handoff.ts:682` | umgesetzt | `6aa99201` | nur Review | `ensureComfyRunning()` steht jetzt **vor** der DECIDE-Phase (`:756-765`), mit Kommentar an der Stelle. |
| T-30 | Create-Stop nimmt den Prompt nie aus der Queue | `useCreate.ts:1414` | umgesetzt | `6aa99201` | per Test (`src/api/__tests__/stop-removes-only-our-job.test.ts`) | „Take OUR job out of the queue — do not blanket-/interrupt“ (`useCreate.ts:1490`). |
| T-31 | Chat-Stop leert ComfyUIs ganze Queue | `vram-handoff.ts:576` | umgesetzt | `6aa99201` | per Test (dieselbe Datei) | Abbruch läuft über die eigene `promptId` (`:611`), nicht mehr `/interrupt` + `clear: true`. |
| T-32 | Keine Integritätsprüfung; ohne Content-Length fallen beide Wächter aus | `download.rs:580` | umgesetzt | `a9b64245` | per Test (`src/api/__tests__/download-integrity.test.ts` + 32 Rust-Tests) | SHA256 streamend, beim Resume aus der Teildatei geseedet (`digest_of_prefix`); `normalize_sha256` lehnt einen kaputten Digest ab statt ihn zu ignorieren; fehlendes Content-Length wird über einen 1-Byte-Range-GET (`Content-Range`) aufgelöst. Digest kommt aus HF-LFS-Metadaten (`discover.ts:1348`). |
| T-33 | Bundle-Dateien prüfen den Plattenplatz jeweils einzeln | `discover.ts:374` | umgesetzt | `a9b64245` | per Test (Summenfunktion ist rein und getestet) | „Verdict of the ONE space check a bundle gets before its first transfer“ (`discover.ts:147`); Dateien, die schon auf Platte liegen, gehen nicht in die Summe. |
| T-34 | Download-Zustand nur im Speicher, Waisen unsichtbar | `downloadStore.ts:95` | umgesetzt | `a9b64245` | per Test (`src/stores/__tests__/downloadStore-orphans.test.ts`, `src/lib/__tests__/download-tray.test.ts`) | `persist` auf localStorage, `orphans` + `orphanRows` + `resumeOrphan`; nur auflösbare Waisen bekommen eine Zeile mit Resume. |
| T-35 | `get_python_bin` greift auf nacktes `python3`, ignoriert BUG-008 | `python.rs:114` | umgesetzt | `c0cc5639` | per Test (Rust-Tests) | Läuft über `unix_python_candidates()` + `which::which`, Ergebnis ist immer ein absoluter Pfad — das war die Voraussetzung dafür, dass `process.rs` überhaupt ein Prefix ableiten kann (siehe T-08). |
| T-36 | `repair_comfyui_env` löscht das Voice-venv und stellt es nie wieder her | `install.rs:1118` | umgesetzt | `c0cc5639` | per Test (Rust-Tests) | `VenvPassenger`-Liste (faster-whisper, piper-tts) wird vor dem Repair inventarisiert und danach nachgezogen; ein Fehlschlag dabei wird benannt statt verschluckt. |
| T-37 | `ollama serve` stirbt am ersten Log-Write | `install.rs:1762` | umgesetzt | `c0cc5639` | nur Review (echter Ollama-Installlauf hier nicht gefahren) | Eigene Startfunktion mit dem ausdrücklichen Vertrag „SURVIVES the installer“, das Child wird gehalten. |
| T-38 | Install/Repair/Update teilen einen Statusslot | `install.rs:726` | umgesetzt | `c0cc5639` | per Test (Rust-Tests) | `ComfyJobSlot` + `ComfyJobGuard` (RAII), `comfy_job_busy_message`; ein Repair kann nicht mehr in einen laufenden Clone starten. |
| T-39 | `cloudflared` überlebt die App und republiziert still | `remote.rs:5523` | umgesetzt | `7de75b95` | nur Review | Startseitiger Sweep tötet fremde Tunnel auf dem eigenen Port vor dem Bind — damit ist die **stille Republikation** zu. **Der Kill beim Beenden ist nur Best-effort:** er hängt an `Drop for RemoteServer` (`remote.rs:5275`), und die Datei sagt selbst, dass der explizite Shutdown-Pfad (`AppState::shutdown_subprocesses`, `main.rs:625`) den Tunnel **nicht** erreicht. Siehe Abschnitt 5. |
| T-40 | „Authentifiziert“ ist die einzige Autorisierungsstufe | `remote.rs:4776` | umgesetzt | `7de75b95` | per Test (Rust-Tests, u. a. `the_qr_payload_carries_no_passcode`) | `merge_remote_permissions` ist bewusst ein No-op — der Server behält die Rechte, das Telefon darf nur lesen. `/qr` liefert keinen Passcode mehr. `/disconnect` liest die anfragende Identität aus `CallerDevice` statt aus dem Body. |
| T-41 | Sidebar abonniert den ganzen `chatStore` | `Sidebar.tsx:14` | umgesetzt | `402ec7e3` | per Test (`src/components/layout/__tests__/streaming-does-not-repaint-the-app.test.ts`) | Fünf gezielte Selektoren statt eines Store-Abos; die Zeilenliste läuft über einen eigenen `rows`-Selektor. |
| T-42 | Kein Code-Splitting, Boot-Chunk 2,59 MB | `AppShell.tsx:6` | umgesetzt | `402ec7e3` + `140574bb` | per Test (`src/components/layout/__tests__/lazy-view-boundaries.test.ts`) für die Struktur; **Chunk-Größe: nicht verifizierbar hier** (`dist/` ist nicht committet, ein Build hätte den geteilten Arbeitsbaum angefasst) | `LazyView` + `Suspense` + Skelette für alle fünf Top-Level-Views und Onboarding. Die Zahlen 2016 → 711/731,8 kB stehen im Changelog, ich konnte sie nicht nachmessen. |
| T-43 | MLX-Blob-URLs werden nie freigegeben | `mlx-video.ts:147` | umgesetzt | `402ec7e3` | per Test (`src/api/__tests__/mlx-video-blob-lifetime.test.ts`) | `releaseVideoBlobUrl` / `releaseAllVideoBlobUrls`, und `createObjectURL` widerruft den Vorgänger. |
| T-44 | `CodeBlock` liefert alle 300 Prism-Grammatiken aus | `CodeBlock.tsx:2` | umgesetzt | `402ec7e3` + `705102c6` + `8beff423` | per Test (`CodeBlock`-Tests auf die registrierten Grammatiken erweitert) | `prism-light` statt Barrel, Sprachen einzeln registriert. `8beff423` ersetzte dabei 37 ungeprüfte Werte durch echte Typen statt DefinitelyTyped-`any`. |
| T-45 | `ChatView` abonniert das ganze `conversations`-Array | `ChatView.tsx:38` | umgesetzt | `402ec7e3` | per Test (`streaming-does-not-repaint-the-app.test.ts`) | Gezielte Selektoren; Vollzugriffe laufen über `getState()` außerhalb des Renders. |
| T-46 | SSRF-Gate prüft nur den Hostnamen-Text | `proxy.rs:169` | umgesetzt | `86e9dd17` | per Test (41 Proxy-Tests, keiner berührt das Netz; Resolver ist injizierbar) | `validate_public_url_addrs_with` prüft die **aufgelöste Adresse**, mit 5-s-Deckel und fail-closed; die Verbindung wird an die geprüfte Adresse gepinnt. |
| T-47 | Redirects umgehen den Metadata-Hardblock | `proxy.rs:439` | umgesetzt | `86e9dd17` | per Test (`proxy.rs:1669`) | `ssrf_safe_redirect_policy` validiert jeden Hop, max. 3; ein Pfad nutzt `Policy::none()`. |
| T-48 | Backup schreibt alle 5 s die ganze Historie ohne Dirty-Check | `AppShell.tsx:473` | umgesetzt | `9b72e430` + `2d8b9279` | per Test (`src/lib/__tests__/store-backup-dirty.test.ts`, `.../store-backup-mirror.test.ts`) | `backupStoresIfChanged()`; die Änderung kommt über `onIdbWrite` statt über ein erneutes Lesen der Blobs. Der Gegenprüfer hat hier eine unbelegte Kernbehauptung gekippt — der Test zählt jetzt die IndexedDB-Lesevorgänge. |
| T-49 | Vier Schlüssel fehlen in beiden Backup-Listen | `stagedChangesStore.ts:186` | umgesetzt | `9b72e430` | per Test (`src/lib/__tests__/store-backup-covers-every-store.test.ts`) | `staged-changes`, `locally-uncensored-todos`, `locally-uncensored-ui`, `lu_release_notes` stehen in `STORE_KEYS`/`IDB_STORE_KEYS` (`store-backup.ts:50-59`). |
| T-50 | Konversation löschen lässt fünf Stores verwaist zurück | `chatStore.ts:143` | umgesetzt | `9b72e430` | per Test (`src/stores/__tests__/delete-conversation-cascade.test.ts`) | `dropConversationSideState(id)` vor dem `set()`. |

</content>
</invoke>

### 2.3 mittel (33) und niedrig (2)

Hier liegen **alle elf offenen Technik-Befunde**. Der Audit liefert für diese 35 Zeilen keinen Volltext (Anhang D: die Rohausgabe der 24 Agenten ging verloren) — geprüft wurde daher genau der Sachverhalt, den Titel und Fundstelle benennen.

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| T-51 | `userStoppedRef` wird nie zurückgesetzt, `/loop` läuft nur einen Pass | `useAgentChat.ts:2121` | umgesetzt | `6aa99201` | per Test (`src/lib/__tests__/run-stop.test.ts`) | Stop-Zustand liegt in `src/lib/run-stop.ts` pro Conversation (`beginRun`/`isRunStopped`/`stopRun`), nicht mehr in einem Hook-Ref. |
| T-52 | Aus Prosa geborgene Tool-Calls haben keine `id` | `useAgentChat.ts:1828` | umgesetzt | `6aa99201` | per Test (`src/api/providers/__tests__/tool-arguments-stay-objects.test.ts`) | Synthetische Calls bekommen eine erzeugte `id`; `tool_call_id: undefined` kann nicht mehr rausgehen. |
| T-53 | Tote MCP-Server bleiben in der Registry; nichts trennt beim App-Ende | `mcp/external-client.ts:78` | **OFFEN** | — | nur Review | Die **erste** Hälfte ist zu (`tool-registry.ts` kennt `builtinNames` und den Server-Bezug, siehe T-15). Die im Befund ausdrücklich genannte zweite Hälfte ist unberührt: kein `beforeunload`, kein `onCloseRequested`, kein `disconnectAll` — nichts trennt beim Beenden, verwaiste Kindprozesse bleiben. |
| T-54 | llama-server-Sidecar aus einem beweglichen Tag, Cache-Key ignoriert ihn | `scripts/build-llama.sh:31` | umgesetzt | `87658903` + `8c0c1cf9` | per Test (`src/api/__tests__/bash-interpreter.ts`, `build-llama-script.test.ts`) | Auf einen Commit-SHA gepinnt, Cache-Key nimmt den Pin auf, Digest ohne Backslash-Fehler. **Rest:** eine Prüfsumme des *fertigen Artefakts* gibt es weiterhin nicht — bei einem selbst gebauten Binary aus gepinntem Quellstand hält der Befundkern trotzdem. |
| T-55 | Asset-Zählung ohne Bezug zum aktuellen Lauf | `discord-announce.yml:45` | umgesetzt | `6a472f16` | nicht verifizierbar hier (kein Actions-Lauf) | Assets werden über die REST-API gelesen und gegen einen Zeitschnitt dieses Laufs gefiltert („only ones uploaded after the cutoff below count“), statt Dateinamen zu zählen. |
| T-56 | Anthropic-`error`-Events mitten im 200er-Stream werden verschluckt | `anthropic-provider.ts:210` | umgesetzt | `9c7243a1` | per Test (`src/api/providers/__tests__/anthropic-thinking-and-errors.test.ts`) | `overloaded_error`/`api_error` werden im Event-Switch behandelt statt durchzufallen. |
| T-57 | `AnthropicProvider` nutzt den Rust-Proxy nie | `anthropic-provider.ts:176` | umgesetzt | `2d8b9279` | per Test (`src/api/providers/__tests__/anthropic-proxy-shapes.test.ts`) | Der Relay-/Custom-`baseUrl` läuft jetzt über denselben Proxy-Pfad wie die anderen Provider und stirbt nicht mehr an CSP/CORS. |
| T-58 | `probeContextFromServer` ohne Signal und ohne Timeout auf dem Sendepfad | `openai-provider.ts:718` | umgesetzt | `9c7243a1` + `44a0692a` | per Test (`src/api/providers/__tests__/openai-probe-guards.test.ts`) | Beide Proben tragen Abbruchsignal und Deckel; dazu ein Probe-Cache, weil `applyMaxTokens` `getContextLength` bei **jedem** Turn rief. |
| T-59 | Kein Cloud-Fetch trägt Timeout oder AbortSignal | `cloud/client.ts:35` · *unbewiesen* | umgesetzt | `2d8b9279` | per Test | Der Gegenprüfer fand hier die schärfste Lücke des Pakets: der erste Fix bewachte alles **nach** dem Token, `getAccessToken()` läuft davor — ein hängender Tokenabruf verkeilte weiter. Das ist nachgezogen. |
| T-60 | OAuth-Loopback bedient jede fremde Anfrage mit `code=`/`error=` | `oauth.rs:93` | **OFFEN** | `dab30435` | per Test (`a_scripted_top_level_navigation_…` pinnt genau den Rest) | Zwei der drei im Befund genannten Prüfungen sind da: Pfad (`/callback`) und Origin (jedes `Origin` wird abgelehnt, dazu `Sec-Fetch-Mode`/`-Dest`). Die dritte, der `state`-Nonce, fehlt — und der Code erklärt gerechnet, warum sie hier allein nicht baubar ist: der Nonce müsste an der Redirect-URI hängen, die gegen Supabases `uri_allow_list` mit exakten Einträgen geprüft wird. **Rest-Angriff:** jede offene Seite kann per Top-Level-Navigation eine laufende Anmeldung beenden und den Text im Auth-Panel wählen (anmelden kann sie niemanden — der PKCE-Verifier verlässt die App nie). Schließen lässt es sich nur serverseitig. |
| T-61 | `secret_get`/`secret_set` nehmen einen beliebigen Account-String | `secret.rs:238` · *unbewiesen* | **OFFEN** | `3218b16c` | nur Review | Der Verstärker ist weg (`withGlobalTauri: false`, T-19). Der Befundkern steht: `secret::set(account, value)` nimmt den Account-String unverändert vom Frontend, es gibt keine Allowlist erlaubter Konten. Über `__TAURI_INTERNALS__.invoke` bleibt die Brücke für Seitenskript erreichbar. |
| T-62 | `codexStore.threads[].events` wächst ohne Deckel und wird nie gelesen | `codexStore.ts:176` | umgesetzt | `2d8b9279` | per Test (`src/stores/__tests__/codexStore-event-log.test.ts`) | Gedeckelt; der Kommentar nennt den Downgrade-Kontrakt, der bei einem naiven Löschen gebrochen wäre. |
| T-63 | Stop wendet die Staged Changes des Laufs trotzdem an | `useCodex.ts:2229` | umgesetzt | `6aa99201` | per Test (`src/hooks/__tests__/useCodex-caught-value.test.ts`) | Der Auto-Apply-Block sitzt nicht mehr auf dem normalen Ausstiegspfad der Schleife. |
| T-64 / T-80 | Hintergrund-Shell-Tasks verwaisen auf macOS/Linux beim Quit | `bg_tasks.rs:212` | umgesetzt | `dab30435` | per Test (Rust-Tests in `bg_tasks.rs`) | **Im Audit doppelt gelistet** (einmal unter „Coding-Agent", einmal unter „Rust-/IPC-Grenze") — derselbe Befund, hier einmal geprüft. `bg_tasks.rs:562` hängt an Tauris `RunEvent::Exit` **und** an einem C-`atexit`-Handler, der auf allen Pfaden feuert. |
| T-65 | `free_comfyui_memory`/`offload_ollama_loaded_models` hartkodieren Ports | `process.rs:2507` | **OFFEN** | — | nur Review | `process.rs:2909` unverändert `http://localhost:8188/free`, `:2867` unverändert `http://localhost:11434/api/ps`. Auf einem eigenen Port oder einer anderen Ollama-Basis tut der Make-room-for-VRAM-Schritt weiterhin nichts — und meldet dabei `false`, nicht „nicht zuständig". |
| T-66 | `pollAndExtract` prüft nie, ob ComfyUI noch lebt | `vram-handoff.ts:1361` | umgesetzt | `6aa99201` | nur Review | Eine Lebendprüfung läuft, wenn ein Render zu scheitern droht (`:1453`), plus WS-Aktivitätsfenster (`:1494`) — der Agent parkt nicht mehr das volle 5/10-Minuten-Budget. |
| T-67 | Custom-Node-Installation leert den `/object_info`-Cache nicht | `discover.ts:405` | **OFFEN** | — | nur Review | `refreshComfyModels()` hängt am **Download**-Pfad (`discover.ts:684`). `installCustomNodes` (`:439-455`) ruft `install_custom_node` und kehrt zurück — kein Cache-Bruch, kein Refresh. Der Workflow-Builder rät dem Nutzer weiterhin, zu installieren, was er gerade installiert hat. |
| T-68 | Linux: hart gekilltes LU verwaist sein ComfyUI-Kind, Stop wird zum No-op | `process.rs:1529` | **OFFEN** | — | nur Review | Der Branch hat die Orphan-*Vermeidung* verbessert (`tie_child_to_app_lifetime`, `orphan_safety_tests`) — das ist ein anderer Fall. Für den beschriebenen: kein Adoptionspfad, kein `adopt_`, keine Änderung an `:1529`. |
| T-69 | Unabbrechbares `setInterval` im Built-in-Engine-Installpfad | `DiscoverModels.tsx:586` | **OFFEN** | — | nur Review | `DiscoverModels.tsx:596-600`: `clearInterval` nur bei `complete` und `error`. Pausiert oder bricht der Nutzer ab, bleibt der Status auf `paused`/weg, das Promise settelt nie und der 2-Hz-Timer läuft weiter — exakt der Befund. |
| T-70 | 106 hartkodierte HF-URLs ohne jede Lebendprüfung | `discover.ts:539` | **OFFEN** | `a9b64245` | nur Review | Die Folge ist entschärft: der Retry ist kein Sackgassen-Knopf mehr (T-07/T-34), und die 51 Katalog-Größen wurden laut Changelog per HEAD gegengeprüft. Der Befundkern steht: keine Lebendprüfung im Code, 0 Treffer für eine URL-Probe. Die Zahl selbst ist von **106 auf 28** `resolve/main`-URLs gefallen. |
| T-71 | Installer-Kindprozesse ungetrackt und nicht rekursiv gekillt | `install.rs:506` | umgesetzt | `c0cc5639` + `dab30435` | per Test (Rust-Tests) | An der Audit-Fundstelle (pip/git-Kette) sind die Kinder registriert und werden über `kill_tree` abgeräumt. **Rest:** der `winget`-Pfad läuft weiterhin an dieser Registrierung vorbei. |
| T-72 | `.exe`-Installer werden ohne Hash, Signatur oder Größe ausgeführt | `install.rs:1747` | **OFFEN** | `dab30435` | per Test (Größen- und Signaturprüfung) | Substanziell nachgebessert: Größenprüfung plus `Get-AuthenticodeSignature` mit klassifiziertem Ergebnis (`install.rs:2320-2332`). Die im Befund eigens genannte Klausel bleibt offen — der SHA-256-Pin für die **hartkodierte, unveränderliche** Versions-URL ist nicht gesetzt; der Code sagt selbst „Until then the size and Authenticode checks below are what stands between". |
| T-73 | `SO_REUSEADDR` auf `0.0.0.0:11435` erlaubt Hijacking unter Windows | `remote.rs:4809` | umgesetzt | `7de75b95` | im Lauf bewiesen (Windows `cargo test` 715 grün auf `lu-box`; die Sockettests laufen dort wirklich) | `build_reusable_listener` setzt pro Plattform das Flag, das dort das Richtige tut — unter Windows also **nicht** `SO_REUSEADDR`. Der Kommentar, der vorher das Gegenteil behauptete, ist korrigiert. |
| T-74 | `client_ip` vertraut `X-Forwarded-For`, Geräte werden danach dedupliziert | `remote.rs:181` | umgesetzt | `7de75b95` + `dab30435` | per Test (Rust-Tests) | Deduplizierung und Sitzungsbezug hängen an `ConnectInfo` (`remote.rs:470`), nicht mehr am fälschbaren Header; XFF wird nur noch vom Gate gelesen. |
| T-75 | Der Mobile-Client ist ein 2.988-Zeilen-Rust-Rohstring | `remote.rs:2019` | **OFFEN** | — | nur Review | Unverändert ein Rohstring, für `tsc`, `eslint` und `vitest` unsichtbar; die „Tests" bleiben handkopierte TypeScript-Nachbauten. `remote.rs` ist dabei von **6.304 auf 7.405 Zeilen** gewachsen. Mit 8 h die teuerste offene Position der Liste. |
| T-76 | Create-Dateislots erzeugen pro Datei eine Blob-URL und geben sie nie frei | `SpecialIntentControls.tsx:48` · *unbewiesen* | **OFFEN** | — | nur Review | `SpecialIntentControls.tsx:55` unverändert: `URL.createObjectURL(file)` ohne Gegenstück. Die `revoke`-Paare bei `:886`/`:893` gehören einem anderen Helfer. Der MLX-Galerie-Fix (T-43) erreicht diesen Pfad nicht. |
| T-77 | `AppShell` abonniert den ganzen `uiStore`, der Resize-Griff schreibt pro Pointermove | `AppShell.tsx:50` | umgesetzt | `402ec7e3` | per Test (`src/components/layout/__tests__/streaming-does-not-repaint-the-app.test.ts`) | Gezielte Selektoren; das Ziehen des Trenners rendert nicht mehr den ganzen Baum. |
| T-78 | `fs_read`/`fs_search` blockieren synchron den Main-Thread | `filesystem.rs:403` | umgesetzt | `dab30435` | per Test (`filesystem.rs:1547` prüft das Präambel-Paar) | `pub async fn fs_read` reicht an `tauri::async_runtime::spawn_blocking` weiter (`:510-515`), der synchrone Kern bleibt testbar daneben. |
| T-79 | `kill_tree` signalisiert eine Prozessgruppe, die niemand anlegt; 800 ms auf dem Main-Thread | `process_util.rs:71` | umgesetzt | `dab30435` | per Test (`process_util.rs:271` `a_child_without_a_process_group_still_loses_its_whole_tree`) | `pre_exec` legt die Gruppe jetzt wirklich an (`:45`); die 800-ms-Gnadenfrist liegt nicht mehr auf dem Main-Thread und nicht mehr unter dem Video-Mutex. |
| T-80 | *(Dublette von T-64)* | `bg_tasks.rs:212` | umgesetzt | `dab30435` | per Test | Siehe T-64 — der Audit führt denselben Befund unter zwei Subsystemen. |
| T-81 | `pull_model_stream` baut JSON per String-Formatierung | `proxy.rs:698` | umgesetzt | `86e9dd17` | per Test (Rust-Tests, 3× JSON-Injection) | Body wird über `serde_json` gebaut; ein Modellname mit Anführungszeichen kann den Request nicht mehr aufbrechen. |
| T-82 | `storage-quota.ts` ist an nichts angeschlossen | `storage-quota.ts:123` | umgesetzt | `2d8b9279` | per Test (`src/lib/__tests__/storage-quota-wiring.test.ts`) | `createSafeStorage()` ist über `createJSONStorage` verdrahtet (`:207`) und feuert das Event, auf das `StorageQuotaToast` hört. |
| T-83 | `chatStore` persistiert ohne `version` | `chatStore.ts:397` | gegenstandslos | `9b72e430` | per Test (`src/stores/__tests__/persist-versioning.test.ts`) | Dieselbe Prämisse wie ZB-5 und mit derselben Sonde widerlegt: gegen das vendorte zustand 5.0.12 überspringt ein späteres `version: 1` die Migration **nicht**. `chatStore` schreibt bewusst `version: 0` — persistImpls eigener Default — und begründet das im Code (`:481-483`). |
| T-84 | Kein Idle-/Stall-Timeout irgendwo auf dem Chat-Stream | `proxy.rs:548` · *niedrig* | umgesetzt | `9c7243a1` + `86e9dd17` | per Test (`src/api/__tests__/stream-idle-watchdog.test.ts`, `proxy.rs:1818`) | Ein Wächter für alle Pfade: 60 s zwischen Chunks, 300 s bis zum ersten — sonst stirbt der legitime Kaltstart eines großen Modells. |
| T-85 | `execute_code` schreibt sein Skript world-readable in den gemeinsamen Temp | `agent.rs:301` · *niedrig* | umgesetzt | `dab30435` | per Test (`agent.rs:779` prüft `mode() & 0o777`) | `write_private_script` legt ein `tempfile::TempDir` mit 0o700 an, statt einen vorhersagbaren Pfad im geteilten Temp zu benutzen. |

### 2.4 Nachtrag: Audit-Befunde außerhalb der 85er-Liste

Die Befundtabelle §4b ist nicht das ganze Audit. Sechs der zehn **Amateur-Signale** (§4) und drei der neun **Zeitbomben** (§3) haben in §4b **keine** Entsprechung — sie fallen sonst durchs Raster. Sie stehen deshalb hier.

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| AS-01 / ZB-1 | Kein Logfile — nirgends | `main.rs:52-69`, `lib/logger.ts:32` | umgesetzt | `8d13931f` | per Test (18 neue cargo-Tests, echter Appender in Tempdir) | Rolling-File (täglich, 7 Dateien) in `data_dir()/logs`, `log_write`/`log_file_path`/`log_reveal`, Pfad + Copy in den Settings. Bewusst `data_dir()` statt `app_log_dir()` — beim Start existiert noch kein `AppHandle`, und genau dort liegen die Fehler. |
| AS-04 | 438 Rust-Tests laufen in der CI nie | `ci.yml` ruft nur `cargo check` | umgesetzt | `6a472f16` | im Lauf bewiesen für die Tests selbst (Mac 729 grün, Windows `lu-box` 715 grün, 0 rot); der CI-Job **nicht verifizierbar hier** (kein Actions-Lauf) | `ci.yml` hat jetzt einen `cargo test`-Schritt. **Nicht** erledigt ist der zweite Teil des Audit-Fixes: `cargo clippy` läuft als `Clippy (non-gating — pre-existing debt)`, ist also weiterhin kein Gate. |
| AS-05 | Der Datei-Jail lässt sich seinen Root vom Aufrufer setzen | `filesystem.rs:113-115` | umgesetzt | `dab30435` | per Test (cargo-Tests in `filesystem.rs`) | `workspace_root` gibt den Aufrufer-Pfad weiterhin zurück — das ist bewusst nur eine Pfad-Ableitung. Die Grenze ist `check_workspace_root` (Allowlist der per Dialog gewählten Ordner), und `resolve_path:463-465` ruft sie auf, sobald ein `working_dir` gesetzt ist. Der Kommentar wurde auf die tatsächliche Garantie zurückgenommen — genau das, was der Audit verlangt hat. |
| AS-08 / ZB(Scorecard 2) | „Läuft gerade etwas?“ hat zwei unabhängige Quellen | `generationStore.ts:23`, `types/codex.ts:23`, `run-idle.ts:17` | **OFFEN** | — | nur Review | `types/codex.ts:23` ist unverändert `status: 'idle' \| 'running' \| 'error'` — `awaiting_approval`, `applying` und `cancelling` fehlen weiterhin. `anyRunActive` in `run-idle.ts:17` existiert unverändert, verrechnet also weiter zwei Wahrheiten zu einer. Kein Commit im Branch fasst das an. |
| AS-09 | Onboarding: 59 `useState` in einer Datei | `Onboarding.tsx`, `SettingsPage.tsx` | **OFFEN** | — | nur Review | Nachgezählt: `Onboarding.tsx` 59 → **59** (unverändert), `SettingsPage.tsx` 43 → **46** (gestiegen). Die vom Audit verlangte Zerlegung pro Schritt hat nicht stattgefunden. |
| AS-10 | Lint ist seit April rot und darf es bleiben | `ci.yml` `continue-on-error: true` | **OFFEN** (Schuld stark reduziert) | `af7a40ae`, `fdf81bce`, `9a52f712`, `0e740f60`, `b2447cf1`, `1ea409cd`, `92c5a694` | nur Review | Der **Befund** ist, dass Lint kein Gate ist — und `ci.yml:51` heißt weiterhin `Lint (non-gating — pre-existing debt)`. Die Schuld dahinter wurde massiv abgetragen (`react-hooks/*` 47 → 0 belegt, `any` textuell 516 → 72 im Snapshot), aber der vom Audit verlangte Schritt „alles außer `no-explicit-any` auf error und gating“ ist nicht gegangen. |
| ZB-5 | 17 Stores ohne `version`/`migrate` | `stores/uiStore.ts`, `stores/mcpStore.ts` u. a. | gegenstandslos | `9b72e430` | per Test (`src/stores/__tests__/persist-versioning.test.ts`) | **Die Prämisse des Befundes wurde gemessen und widerlegt**, nicht ignoriert: gegen das vendorte zustand 5.0.12 stimmt „ein unversionierter Store schreibt keine Version, also überspringt ein späteres `version: 1` die Migration“ nicht — die ersten drei Tests der Datei sind der Beweis gegen die echte Bibliothek. Den Rat zu befolgen hätte eine echte Regression gekostet (ein älterer Build verwirft ein Version-1-Blob; 2.6.x-Builds teilen ein WebView-Profil). Stattdessen ist das Paar erzwungen: wer `version` deklariert, muss `migrate` deklarieren. Stores mit `version` 7 → 9. |
| ZB-7 | `vite.config.ts` mit 2.466 Zeilen | `vite.config.ts` | **OFFEN** (Hälfte erledigt) | `25408c8a`, `7a9ad684`, `a8cce006` | per Test (7 Testdateien in `src/dev/__tests__/`) | Die eine Hälfte des Audit-Fixes ist da: die Guards sind nach `src/dev/` gezogen (`ssrf-policy`, `fs-request-path`, `http-body`, `model-paths`, `console-strip`, `web-search-parse`) und mit Vitest abgedeckt — vorher null Tests. Die andere Hälfte nicht: **`vite.config.ts` hat am HEAD 2.486 Zeilen, also 20 mehr als der Audit gemessen hat**, Ziel war < 100. Der Dev-Server steckt weiter in der Build-Konfiguration. |
| ZB-8 | 9 Importzyklen im Kern | `comfyui.ts ↔ discover.ts` u. a. | umgesetzt | `5be70969` | nicht verifizierbar hier (`madge` nicht ausgeführt, würde den geteilten Arbeitsbaum anfassen) | `npm run cycles` = `madge --circular` existiert und hängt als eigener Schritt in `ci.yml:64`. Der Branch dokumentiert eine Sonde („zwei einander importierende Module → Exit 1“). Gezählt hat der Branch 11, nicht 9. |

---

## 3. Design-Audit

Der Design-Audit vergibt keine IDs. Vergeben sind hier: **D-A1…D-A10** (§3, die 10 Amateur-Signale), **D-S01…D-S49** (§4, Screen für Screen, in Dateireihenfolge), **D-T01…D-T13** (§5, Token-Diff), **D-W1-1…D-W3-11** (§6, die drei Wellen), **D-E1** (§7 „Die eine Sache“) und **D-X1** (die eine Korrektur im Anhang).

### 3.1 Die 10 Amateur-Signale (§3)

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| D-A1 | Nachrichtenspalte und Composer sind zwei Formeln | `ChatInput.tsx:246`, `MessageBubble.tsx:187`, `MessageList.tsx:71` | umgesetzt | `bcec642b` | per Test (`src/components/chat/__tests__/long-transcripts-stay-cheap.test.ts`, `.../plan-done-vs-applied.test.ts` pinnen `--lu-measure`); der 0px-Versatz selbst ist **nicht verifizierbar hier** (braucht gerendertes DOM) | `--lu-measure: 760px` in `index.css:107`, benutzt von MessageList, ChatInput, WorkingAnchor, GoalBar, LoopBar, PlanBar. **Rest:** `GroupCostHint.tsx:54` trägt weiter `max-w-[70%]` und wird über `composerAbove` *innerhalb* der Measure-Spalte gerendert. |
| D-A2 | Die Hausschrift wird nie ausgeliefert | `index.css:88` | umgesetzt | `44a76aad` (Dateien), `bcec642b` (Einbindung) | nur Review | `public/fonts/` mit 16 woff2 und 39 `@font-face`, verlinkt in `index.html:20`. In `base/` gab es `public/fonts/` nicht. |
| D-A3 | Vier Maßstäbe gleichzeitig | `index.css:79`, `Sidebar.tsx:236`, `IntentBar.tsx:42`, `Composer.tsx:345` | **OFFEN** | — | nur Review | Alle vier unverändert: `html { font-size: 18.4px }` (`index.css:117`), `zoom: 1.25` (`Sidebar.tsx:320`), `scale(0.763)` (`IntentBar.tsx:43`), `scale(0.7)` (`Composer.tsx:337`). Kein `--ui-scale`. Das ist der W2-Posten, den der Changelog selbst als offen führt. |
| D-A4 | Der Platzhalter ist heller als der eingegebene Text | `index.css:362-363` | **OFFEN** | — | nur Review | `index.css:501-502` sind byte-gleich mit dem Audit-Zitat: `.light ::placeholder { rgb(31 41 55) }` (gray-800), `.dark ::placeholder { rgb(229 231 235) }` (gray-200). Die Grundrelation eines Eingabefelds steht weiter auf dem Kopf. |
| D-A5 | Sieben Controls im Composer, sieben Rezepte | `ChatInput.tsx:383/411/452`, `VoiceButton.tsx:123`, `ChatView.tsx:348`, `PluginsDropdown.tsx:69`, `ModelSelector.tsx:711` | umgesetzt | `8198495f` + `3883eaa8` (VoiceButton) | per Test (`src/components/chat/__tests__/composer-grammar.test.ts`) | Zwei Rezepte: `.lu-control` (+ `--icon`) und `.lu-primary`. Der Commit meldet, dass es tatsächlich **zehn** Formsprachen waren, nicht sieben. |
| D-A6 | Die Hauptnavigation ist Text, kein Ziel | `Header.tsx:157/174/310` | umgesetzt | `bcec642b` | nur Review | Ein `NAV_BASE` (`Header.tsx:147`): `h-7 px-2 rounded-md text-[0.68rem]`, aktiv als Fläche. |
| D-A7 | Streaming ist kein eigener Zustand | `MessageBubble.tsx:442`, `WorkingAnchor.tsx:37` | umgesetzt | `bcec642b` + `3883eaa8` | per Test (`src/components/chat/__tests__/der-caret-ist-reines-css.test.ts`) | Caret als CSS-`::after` mit `@keyframes` (kein Timer, kein neues Prop); Aktionsleiste beim Streamen aus; Anker in der Measure-Spalte. **Zwei bewusste Abweichungen, beide im Code begründet:** Gate auf `!isStreaming` statt auf `(!isLast \|\| !!message.usage)` (ein Backend ohne `usage` verlöre die Leiste sonst dauerhaft), Blink 300/300 ms statt 133/133 (3,76 Hz liegt an der Schwelle von WCAG 2.3.1). |
| D-A8 | Der primäre Button ist auf drei Screens grau | `create/ui/Button.tsx:43`, `auth/AccountPanel.tsx:164`, `ChatInput.tsx:455` | umgesetzt | `f336b91e` | per Test (`src/components/__tests__/primary-recipe.test.ts` rechnet den WCAG-Kontrast aus den echten Tokens) | `.lu-primary` an genau einer Stelle definiert, benutzt von allen drei. **Rest:** `Onboarding.tsx:795` hat sein eigenes `primaryBtn` und erbt das Rezept nicht (siehe D-S36). |
| D-A9 | Die Marke erscheint vier Mal in vier Größen | `Titlebar.tsx:59/71`, `Header.tsx:227`, `CloudSwitch.tsx:52`, `ChatView.tsx:159`, `Onboarding.tsx:790` | **OFFEN** (1 von 3 Teilen) | `c77682a2` | per Test (`src/components/layout/__tests__/titlebar-monogramm.test.ts` — deckt nur die Titlebar) | Erledigt: die Titlebar nimmt `/LU-monogram.svg`. Offen: **neun** weitere Einbindungen laden weiter das 512×512-PNG (`Header.tsx:214` 33px, `ChatView.tsx:185` 46px, `MessageBubble.tsx:209`, `CodexView.tsx:261`, `ChatInput.tsx:491`, `AccountPanel.tsx:209`, `CloudSwitch`), das Titlebar-Monogramm wurde nicht gestrichen, und auf dem Welcome-Screen steht weiterhin kein Zeichen. |
| D-A10 | Elf Icons ohne Label als Hauptnavigation von Create | `intents.ts:33-154`, `IntentBar.tsx:88` | **OFFEN** | — | nur Review | `IntentBar.tsx:87` unverändert: nicht-selektierte Labels auf `max-w-0 opacity-0 px-0`. Die `short`-Labels liegen weiter ungenutzt im Datenmodell. |
| D-E1 | §7 „Die eine Sache“: eine gemeinsame Messgröße | = D-A1 | umgesetzt | `bcec642b` | per Test (siehe D-A1) | Der als stärkstes Signal des Audits benannte Punkt (4 von 6 Prüfern unabhängig) ist der eine Design-Befund, der vollständig gelandet ist. |
| D-X1 | Anhang-Korrektur: `big.dot = 'bg-red-400/80'` | `ModelTiles.tsx:32` | umgesetzt | `3883eaa8` | nur Review | `orange-500/80` und „Runs on CPU, slower“ statt „Too big for your GPU“ — die Leiter bleibt emerald → amber → orange. |

### 3.2 Screen für Screen (§4, 49 Bullets)

| ID | Kurztitel | Fundstelle laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| D-S01 | Kein Composer im leeren Chat | `ChatView.tsx:330` | umgesetzt | `bcec642b` | nur Review | Eine `ChatInput`-Instanz außerhalb der `AnimatePresence` (`ChatView.tsx:366-368`), beide Zweige teilen sie. |
| D-S02 | Empty-State ohne Titel und CTA | `ChatView.tsx:159/162` | **OFFEN** | — | nur Review | `ChatView.tsx:185-189` unverändert: 46px-PNG auf `opacity-20` plus bedingt „Select a model above.“ Kein Titel, keine Subline, kein Primärbutton. |
| D-S03 | „New Chat“ schwächer als die aktive Zeile | `Sidebar.tsx:593` | **OFFEN** | — | nur Review | `Sidebar.tsx:675-682`, Klassenkette byte-identisch zu `base/`. |
| D-S04 | Dritter Modus-Tab ohne Label | `Sidebar.tsx:290` | **OFFEN** | — | nur Review | `Sidebar.tsx:360-373`: Radio-Icon, „Remote“ steht nur in `title`/`aria-label`. |
| D-S05 | 1237×850px tote Fläche | `ChatView` | **OFFEN** | — | nicht verifizierbar hier (Messung am DOM) | Ursache nur halb weg: der Composer ist da (D-S01), die Fläche darüber ist unverändert leer (`ChatView.tsx:176-190`). |
| D-S06 | Zwei Kontextanzeigen in zwei Notationen | `ChatView.tsx:189/192` | **OFFEN** | — | nur Review | `ChatView.tsx:211` (`TokenCounter`, „32/8.2k“) und `:214` (`ContextDropdown`, „ctx 8K“) stehen beide noch. |
| D-S07 | Aktionsleiste nicht hover-gated | `MessageBubble.tsx:442` | **OFFEN** | — | nur Review | `MessageBubble.tsx:474` gatet auf `!isStreaming` — das schließt D-A7, nicht diesen Bullet. Der Kommentar bei `:467` nennt „always visible but subtle“ ausdrücklich als Absicht; drei Icons stehen weiterhin unter **jeder** fertigen Nachricht. |
| D-S08 | Zwei Avatar-Systeme | `MessageBubble.tsx:195-206` | **OFFEN** | — | nur Review | `:196-211` unverändert: Assistent rahmenlos, User als gerahmte Box. |
| D-S09 | Think-Pill trägt die Fokusring-Farbe | `ChatInput.tsx:417`, `index.css:308` | umgesetzt | `8198495f` + `c77682a2` | per Test (`composer-grammar.test.ts`) | Think ist neutral über `aria-pressed`; der Fokusring liegt jetzt auf dem Akzent statt auf Blau — die Doppelbedeutung ist an beiden Enden aufgelöst. |
| D-S10 | DOM-Reihenfolge Text → Aktionen → Status | `MessageList.tsx:102-104` | umgesetzt | `bcec642b` | nur Review | Die Reihenfolge ist unverändert (`MessageList.tsx:169-171`), aber der Konflikt ist weg: die Aktionsleiste rendert während des Streamens nicht mehr, der Status steht also nicht mehr unter Buttons. |
| D-S11 | `WorkingAnchor` ist im Standbild Fließtext | `WorkingAnchor.tsx:38` | **OFFEN** | — | nur Review | `WorkingAnchor.tsx:51-52`: nur das Padding wurde auf `pl-11` gezogen (Spaltenausrichtung, D-A7). Wort, Schriftgröße und Shimmer sind identisch. |
| D-S12 | Stop-Button trägt Rot | `ChatInput.tsx:445` | umgesetzt | `8198495f` | per Test (`composer-grammar.test.ts:262`) | `.lu-control` neutral; Auffindbarkeit läuft über `data-active` statt über die Fehlerfarbe. Die Begründung („Stop ist der Normalabschluss“) steht in `index.css:600`. |
| D-S13 | Paperclip und Mic auf `opacity-20` | `ChatInput.tsx:383` | umgesetzt | `8198495f` | per Test (`composer-grammar.test.ts:335`) | `.lu-control:disabled { opacity: .4 }` (`index.css:759-762`). |
| D-S14 | Doppelte Kürzung des Titels | `Sidebar.tsx:465` | **OFFEN** | — | nur Review | `Sidebar.tsx:557`: `truncate(conv.title, 30)` **und** CSS-`truncate` unverändert. |
| D-S15 | Hover-Icons behalten ihren Layoutplatz | `Sidebar.tsx:486` | **OFFEN** | — | nur Review | `Sidebar.tsx:578`: `opacity-0 group-hover:opacity-100`, kein `absolute`/`hidden`. |
| D-S16 | 698 von 899px Sidebarhöhe leer | `Sidebar.tsx:593` | **OFFEN** | — | nicht verifizierbar hier (Messung) | Struktur und Position der Primäraktion unverändert (`Sidebar.tsx:318`, `:675`). |
| D-S17 | Vier Control-Höhen auf 250px Breite | `Sidebar.tsx`, `index.css:68-70` | **OFFEN** | — | nur Review | Kein `--control-h-*` in der Sidebar (`:514`, `:557`, `:331`, `:678`); die Tokens wurden nur im Composer neu erschlossen. |
| D-S18 | Drei Bänder vor dem ersten Inhalt | `ChatView.tsx:181` | **OFFEN** | — | nur Review | `Titlebar.tsx:94` (h-8), `Header.tsx:193` (h-10), `ChatView.tsx:200` — alle drei stehen. |
| D-S19 | Rechts 9 Elemente, Center-Slot leer | `Header.tsx:231/288-372` | **OFFEN** | — | nur Review | Der Center-Slot wurde mit `bcec642b` in den Flow geholt (`Header.tsx:227`), bleibt aber praktisch leer; rechts unverändert `gap-2.5` (`:265`). |
| D-S20 | Overflow-Breakpoint `lg` oder `xl` je nach View | `Header.tsx:296-299` | **OFFEN** | — | nur Review | `Header.tsx:284-285`, `:310-311` unverändert view-abhängig. |
| D-S21 | Das Overflow-Menü ist kein Menü | `Header.tsx:341-342` | **OFFEN** (teilweise) | `bcec642b` | nur Review | Padding und Hover-Fläche kamen mit dem Nav-Rezept (`navClass`, `Header.tsx:322-345`). `role="menu"`/`role="menuitem"` fehlen weiterhin — 0 `role=`-Treffer in der Datei, während `Sidebar.tsx:615` es korrekt hat. |
| D-S22 | Vier Glyphen im selben Slot ohne Legende | `ModelTiles.tsx:65-84` | **OFFEN** | — | nur Review | `ModelTiles.tsx:88-100`: Flame/Wrench/Eye/Feather, alle 11px, alle gray-500. |
| D-S23 | Quant-Dropdown sieht aus wie der Größen-Chip | `ModelTiles.tsx:213` vs. `:56` | **OFFEN** | — | nur Review | `:232` vs. `:75` — Klassenketten weiterhin deckungsgleich bis auf das Chevron. |
| D-S24 | 53× „Get“ trägt `shadow-sm` | `ModelTiles.tsx:269` | **OFFEN** | — | nur Review | `ModelTiles.tsx:288` und `:406` unverändert; `shadow-sm` app-weit 16× wie in `base/`. |
| D-S25 | Zwei Segmented-Sprachen 47px übereinander | `DiscoverModels.tsx:684` vs. `:719` | **OFFEN** | — | nur Review | `:686-704` (rechteckig) über `:719-733` (Pills). |
| D-S26 | Keine Virtualisierung im Models-Grid | `DiscoverModels.tsx:899/917` | **OFFEN** | — | nur Review | `:910`, `:928` unverändert. `content-visibility` kam nur in `MessageList` (T-11), nicht hier — 300 Modelle sind weiter ≈ 9000 Knoten. |
| D-S27 | Settings-Inhaltsspalte schwebt frei | `SettingsPage.tsx:1297` | **OFFEN** | — | nur Review | `:1309` unverändert `max-w-lg mx-auto`; die vom Audit verlangte 200px-Rail existiert nicht. |
| D-S28 | 12 identische Sektionsköpfe | `SettingsPage.tsx:155` | **OFFEN** | — | nur Review | `:154` unverändert `tracking-[0.15em]` uppercase gray-500. |
| D-S29 | Zwei gleich aussehende Reset-Textlinks | `SettingsPage.tsx` | **OFFEN** | — | nur Review | `:1077-1093`: `9a52f712` hat die Logik angefasst (Arm-Zustand merkt sich seinen Tab), die Optik ist unverändert grau. |
| D-S30 | Aktiver Tab und Aktionsbutton tragen dieselbe Fläche | `SettingsPage.tsx` | **OFFEN** | — | nur Review | `:119` vs. `:1392`/`:1400` — beide `bg-gray-200 dark:bg-white/10`. |
| D-S31 | Banner und Empty-State widersprechen sich | `CreateExperimental.tsx:145`, `Stage.tsx:509` | **OFFEN** | — | nur Review | `CreateExperimental.tsx:207` und `Stage.tsx:505`, beide Texte unverändert. |
| D-S32 | QUALITY/ASPECT zentriert über linksbündigem Prompt | `create/experimental/Composer.tsx` | **OFFEN** | — | nur Review | `Composer.tsx:336-337`: `justify-center` plus `scale(0.7)` unverändert. |
| D-S33 | „Neg“ sieht aus wie ein zweiter Platzhalter | `Composer.tsx:236` | **OFFEN** | — | nur Review | `:224-228` byte-identisch zu `base/`. |
| D-S34 | Rechte 45px-Leiste mit zwei unbeschrifteten Icons | `CreatePanel.tsx:43,53` | **OFFEN** | — | nur Review | Die ganze Datei ist zu `base/` byte-identisch. |
| D-S35 | Sechs Onboarding-Schritte, nicht drei | `Onboarding.tsx:782…1791` | **OFFEN** | — | nur Review | `Onboarding.tsx:809`, `STEP_ORDER` unverändert sechsstufig. |
| D-S36 | Primärbutton-Hover liest als deaktiviert | `Onboarding.tsx:745` | **OFFEN** | — | nur Review | `:795-796` unverändert `hover:bg-gray-200`. Das `.lu-primary`-Rezept aus `f336b91e` erreicht das Onboarding nicht. |
| D-S37 | H1 ist `text-base` = 18,4px | `Onboarding.tsx:790` | **OFFEN** | — | nur Review | `:840` unverändert; Soll waren 28px. |
| D-S38 | 294px Niemandsland unter den Fortschrittspunkten | `Onboarding.tsx` | **OFFEN** | — | nicht verifizierbar hier (Messung) | Ursache unverändert: `fixed top-10` plus zentrierter Inhalt (`:824-827`). |
| D-S39 | Nackter Punkt statt Icon in Schritt 3 | `Onboarding.tsx:1231` | **OFFEN** | — | nur Review | `:1295` unverändert `w-3 h-3 rounded-full bg-purple-400`. |
| D-S40 | Der Send-Glyph verschwindet im Hellmodus | `ChatInput.tsx:455`, `index.css:374` | umgesetzt | `f336b91e` | per Test (`primary-recipe.test.ts:110`, rechnet den Kontrast) | `ChatInput.tsx:535` trägt `.lu-primary`: Akzentfläche mit dunklem Text in beiden Modi. |
| D-S41 | `hover:text-white` ohne `dark:`-Prefix | `ChatInput.tsx:383`, `create/ui/Button.tsx:45` | war schon behoben | vor `10bfa0d7` | nur Review | Der `.light`-Rescue-Layer (`index.css:509-510`, `:524`) steht byte-gleich schon in `base/src/index.css:370-371`, `:385`. Rest: die `ghost`-Variante in `create/ui/Button.tsx` trägt die Klassen weiterhin roh und lebt vom Rescue-Layer. |
| D-S42 | Hellmodus hat keine Ebenen | `AppShell.tsx:804`, `:812` | **OFFEN** | — | nur Review | `AppShell.tsx:927`, `:948` unverändert gegenüber `base/`:827/835. |
| D-S43 | Think-Pill ≈ 2,3:1 auf Weiß | `ChatInput.tsx:417` | umgesetzt | `8198495f` | per Test (`composer-grammar.test.ts:420`) | Aktiv-Zustand hell ist `rgba(0,0,0,.05)` + gray-900 (`index.css:735-742`). |
| D-S44 | Create-Wurzel setzt `text-gray-200` ohne `dark:` | `CreateExperimental.tsx:134` | umgesetzt | `f336b91e` | per Test (`primary-recipe.test.ts:157`) | `:196` jetzt `text-gray-900 dark:text-gray-200` — an der Wurzel korrigiert, nicht im Rescue-Layer nachgefangen. |
| D-S45 | Composer bricht bei 900px in zwei Zeilen | `ChatInput.tsx:378` | war schon behoben | vor `10bfa0d7` | nur Review | `base/src/components/chat/ChatInput.tsx:400` trägt bereits `flex flex-nowrap` samt Kommentar „It used to be flex-wrap“. |
| D-S46 | 407px nutzbare Eingabebreite von 900px | `Sidebar`, `ChatInput.tsx:246` | **OFFEN** (teilweise) | `bcec642b` | nicht verifizierbar hier (Messung) | Der Composer-Anteil ist weg (`--lu-measure` statt `max-w-[70%]`), die Sidebar bleibt fix (200px × `zoom:1.25`, `Sidebar.tsx:318-320`). |
| D-S47 | Kebab-Regel ist nicht erkennbar | `Header.tsx` | **OFFEN** | — | nur Review | `Header.tsx:265-285`: CloudSwitch, DownloadBadge und Theme stehen weiterhin außerhalb der Klappgruppe. |
| D-S48 | Settings skaliert nach oben nicht | `SettingsPage.tsx:1297` | **OFFEN** | — | nicht verifizierbar hier (Messung) | Ursache `max-w-lg mx-auto` unverändert (= D-S27). |
| D-S49 | Kein einziger Schriftgrößen-Breakpoint | app-weit | **OFFEN** | — | nur Review | 0 Treffer für `(sm\|md\|lg\|xl\|2xl):text-` in `base/` wie in `head/`. |

### 3.3 Design-Token-Diff (§5, 13 Zeilen)

| ID | Token | Ist laut Audit | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|---|
| D-T01 | `html font-size` | `18.4px` | **OFFEN** | — | nur Review | `index.css:117` unverändert; kein `--ui-scale`; `zoom:1.25` und beide `scale()` stehen noch (= D-A3). |
| D-T02 | Schrift UI | Inter deklariert, nie geladen | umgesetzt | `44a76aad` + `bcec642b` | nur Review | `public/fonts/lu-fonts.css`, 39 `@font-face`, 16 woff2, verlinkt in `index.html:20`. |
| D-T03 | Schrift Display | fehlt | **OFFEN** | — | nur Review | 0 Treffer für „Grotesk“ in `src/`; auch die ausgelieferte `lu-fonts.css` enthält ausschließlich Inter-Faces. Der Display-Slot ist unbesetzt. |
| D-T04 | Type-Scale | 30 effektive px-Werte | **OFFEN** | — | nur Review | Tokens und `.t-*`-Klassen existieren (`index.css:88-93`, `:558-563`), aber die Umgehung ist **gewachsen**: arbitrary `text-[…]` 1007 → **1017**, `.t-*`-Nutzungen unverändert 143. |
| D-T05 | Akzent | `#a094f8` vs. `#7c3aed` 9× | **OFFEN** | — | nur Review | `index.css:41` weiter `#a094f8`; `#7c3aed` 20 → **22**; das Brand-Kit-Violett `#8b5cf6` kommt in `src/` weiterhin 0× vor. Zwei Violett-Identitäten für eine Marke — unverändert. Das `.lu-primary`-Rezept vereinheitlicht die *Verwendung*, nicht den *Wert*. |
| D-T06 | Surface | 16 Graustufen, `bg-lu-*` 0× | **OFFEN** (teilweise) | `f336b91e`, `8198495f` | nur Review | `bg-lu-*` 0 → 6 echte Call-Sites, aber die Shell malt weiterhin Literale (`AppShell.tsx:927`, `:948`). |
| D-T07 | Control-Höhen | 11–15 distinct pro Screen | **OFFEN** (teilweise) | `8198495f` | nur Review | `.lu-control` nimmt `--control-h-sm` (`index.css:626`, `:671`); Sidebar, Settings und Header-Nav setzen ihre Höhen weiter frei. |
| D-T08 | Radius | 4,6/6/6,9/8/9,2/12px | **OFFEN** | — | nur Review | Beide Systeme unverändert nebeneinander: rem-abgeleitet (`index.css:27-29`) und px (`:110-112`). `rounded-lg ≡ rounded-xl` gilt weiter. |
| D-T09 | Schatten | dominant `shadow-sm` (Light-Rezept) | **OFFEN** | — | nur Review | `shadow-sm` 16 → 16, u. a. weiterhin auf dem „Get“-Button (`ModelTiles.tsx:288`); `--shadow-lg/xl/2xl` bleiben ungenutzt. |
| D-T10 | Fokusring | 1px, Inputs `outline:none` | umgesetzt | `c77682a2` | per Test (`src/components/__tests__/fokusring-und-press.test.ts`, WCAG-Kontrast gerechnet) | 2px Akzent, `outline-offset: 2px`, Inputs eingeschlossen; `.lu-focus-ring` samt neun Call-Sites gelöscht. Die Ausnahme `:not(.lu-primary)` ist gerechnet begründet (Akzent auf Akzent = 1,00:1). |
| D-T11 | Motion | 18 Dauern, 4 Springs, `transition-all` 66× | **OFFEN** (teilweise) | `c5901d0c` | nur Review | Vier Tokens (`--motion-fast/base/slow/ease`, `index.css:72-75`), Modal und ToggleSwitch migriert (`components/ui/motion.ts`). Offen: `Drawer.tsx:59` und `Segmented.tsx:60` tragen weiter eigene Springs (420/40, 500/38) — 2 von 4 ersetzt. `transition-all` 66 → 59. |
| D-T12 | `prefers-reduced-motion` | 0× in `src/` | umgesetzt | `c5901d0c` | per Test (`der-caret-ist-reines-css.test.ts` prüft die Ausnahme) | CSS-Regel (`index.css:928-969`) **plus** `<MotionConfig reducedMotion="user">` (`App.tsx:68`), weil framer-motion an der Kaskade vorbei animiert. `animation-iteration-count: 1`, Spinner und Caret ausgenommen. |
| D-T13 | Platzhalter | `gray-200` dark / `gray-800` light | **OFFEN** | — | nur Review | `index.css:501-502` byte-gleich mit dem Audit-Zitat (= D-A4). |

### 3.4 Der Politur-Pfad (§6, drei Wellen)

Die Wellen sind Fixes, keine eigenen Befunde; sie stehen hier, weil der Auftrag nach ihnen fragt. Wo ein Posten einen Befund oben doppelt, ist das vermerkt.

| ID | Posten | Status | Commit | Verifikationsgrad | Anmerkung |
|---|---|---|---|---|---|
| D-W1-1 | Inter ausliefern | umgesetzt | `44a76aad`+`bcec642b` | nur Review | = D-A2 / D-T02 |
| D-W1-2 | `--lu-measure: 760px` | umgesetzt | `bcec642b` | per Test | = D-A1 / D-E1 |
| D-W1-3 | Aktionsleiste gaten | umgesetzt | `bcec642b` | nur Review | Gate auf `!isStreaming` statt auf die vom Audit genannte Bedingung — Abweichung im Code begründet (= D-A7). Der Hover-Gate-Bullet D-S07 bleibt davon unberührt offen. |
| D-W1-4 | Nav zu echten Zielen | umgesetzt | `bcec642b` | nur Review | = D-A6 |
| D-W1-5 | Composer im leeren Chat | umgesetzt | `bcec642b` | nur Review | = D-S01 |
| D-W2-1 | Root 16px, 6 px-Stufen, `zoom`/`scale()` raus | **OFFEN** | — | nur Review | = D-A3 / D-T01 / D-T04. Der einzige W2-Posten, den nichts angefasst hat — und laut Audit der, der die meisten Ursachen behebt. |
| D-W2-2 | Composer-Grammatik: 2 Klassen statt 7 | umgesetzt | `8198495f`+`3883eaa8` | per Test | = D-A5 |
| D-W2-3 | Escape, Fokus-Falle, `role="dialog"`, `isCtrl` vor dem Input-Guard | umgesetzt | `c5901d0c` | per Test (`src/components/ui/__tests__/dialog-a11y.test.ts`, 32 Fälle; `src/hooks/__tests__/shortcut-owner.test.ts`) | `useKeyboardShortcuts.ts:54-55` prüft `isCtrl` jetzt **vor** dem Eingabefeld-Guard. Anfangsfokus überspringt destruktive Knöpfe. |
| D-W2-4 | Ein Fehlerkanal, die stummen `catch {}` einordnen | umgesetzt | `9a52f712` | nur Review | `catch {}` 18 → **5**. Der Commit meldet 46 stumme Stellen statt der 9 aus dem Audit und begründet, warum 24 davon bleiben — eine Hochstufung aller wäre eine Toast-Lawine gewesen. |
| D-W2-5 | Hellmodus-Lücken | umgesetzt | `f336b91e`+`8198495f` | per Test | = D-S40/S43/S44. **Rest offen:** D-S42 (keine Ebenen im Hellmodus). |
| D-W2-6 | 4 Motion-Tokens, reduced-motion, 4 Springs ersetzen | **OFFEN** (teilweise) | `c5901d0c` | nur Review | Tokens und reduced-motion sind da (D-T12), 2 von 4 Springs ersetzt (D-T11). |
| D-W2-7 | Ein Primär-Rezept | umgesetzt | `f336b91e` | per Test | = D-A8 |
| D-W3-1 | Caret als Herzschlag des Streams | umgesetzt | `3883eaa8` | per Test (`der-caret-ist-reines-css.test.ts`) | Reines CSS auf einem `::after`-Pseudoelement; React kann die Animation pro Token nicht neu starten. |
| D-W3-2 | Skelette für vier Listen-Ladezustände | umgesetzt | `c77682a2` | per Test (`src/components/layout/__tests__/listen-ladezustaende.test.ts`) | Der Commit meldet, dass **drei der vier Audit-Fundstellen nie auf einen Ladezustand zeigten**, auch nicht am Audit-Commit — der eigentliche Fund war die Falschaussage „No models available“ während des ersten Ladens. |
| D-W3-3 | `active:scale-[0.97]` auf allen Icon-Buttons | umgesetzt | `c77682a2` | per Test (`fokusring-und-press.test.ts`) | Eine ungeschichtete Regel (`index.css:451`) statt 489 Call-Sites; die sechs `whileTap` sind entfernt, weil sie sich multipliziert hätten. |
| D-W3-4 | Copy-Feedback in der Sidebar | umgesetzt | `3883eaa8` | per Test (`src/components/layout/__tests__/kopieren-sagt-dass-es-kopiert-hat.test.ts`) | Glyph-Tausch nach dem Muster aus `CodeBlock.tsx`, bewusst ohne Farbe. |
| D-W3-5 | `.lu-hud-num` auf die 10 springenden Readouts | umgesetzt | `3883eaa8` | per Test (`src/components/__tests__/lu-hud-num-auf-den-springenden-readouts.test.ts`) | 30 Fundstellen am HEAD; 11 Readouts bestückt, zwei bewusst nicht (Download-Zähler, Ranglisten-Nummer), im Test begründet. |
| D-W3-6 | Icon-Leiter 12/16/20 | **OFFEN** (teilweise) | `c77682a2` | nur Review | Geliefert ist die optische Korrektur (`LucideProvider absoluteStrokeWidth` an der Wurzel) und `icon-size.ts` mit `ICON_SM/MD/LG`. **Nicht** geliefert ist die Leiter: weiterhin **19 verschiedene `size=`-Werte** (7–36), genauso viele wie in `base/`; häufigste sind 11 (149×), 10 (117×), 12 (115×). Die Datei sagt das selbst. Siehe Abschnitt 5. |
| D-W3-7 | Titlebar-Monogramm streichen, SVG statt 512px-PNG | **OFFEN** (1 von 10) | `c77682a2` | per Test (nur Titlebar) | = D-A9. Siehe Abschnitt 5. |
| D-W3-8 | Fokusring 2px Akzent inkl. Inputs, `.lu-focus-ring` löschen | umgesetzt | `c77682a2` | per Test | = D-T10 |
| D-W3-9 | `Cmd+K`-Palette über die vorhandenen Aktionen | **OFFEN** | — | nur Review | 0 Treffer für `CommandPalette`/`cmdk`/`Cmd+K` in `src/`. Nichts im Branch fasst das an. |
| D-W3-10 | Kontextmenüs auf Nachricht und Modellkarte | **OFFEN** | — | nur Review | `onContextMenu` existiert nur in `Sidebar.tsx:533` und `:695` (Chat-Zeile) — genau das eine Kontextmenü, das der Audit schon vorgefunden hat. Weder `MessageBubble` noch `ModelTiles` haben eines. |
| D-W3-11 | Ton-Pass | umgesetzt | `3883eaa8` | nur Review | = D-X1 |

---

## 4. Die offene Liste — was noch zu vergeben ist

68 Positionen: 11 Technik-Befunde, 4 aus dem Technik-Nachtrag, 53 Design-Befunde. Nichts davon ist `unklar` — jede Zeile ist am Code entschieden.

### 4.1 Technik — 11 offene Befunde (alle „mittel", zusammen ~48 h nach Audit-Schätzung)

| ID | Was offen ist | h |
|---|---|---|
| T-75 | Der Mobile-Client bleibt ein Rust-Rohstring, unsichtbar für `tsc`/`eslint`/`vitest`. `remote.rs` ist dabei von 6.304 auf 7.405 Zeilen gewachsen. | 8 |
| T-70 | 28 (vorher 106) hartkodierte HF-URLs, weiterhin ohne jede Lebendprüfung. | 10 |
| T-60 | OAuth-Loopback: `state`-Nonce fehlt. Jede offene Seite kann per Top-Level-Navigation eine laufende Anmeldung beenden und den Fehlertext wählen. **Nur serverseitig schließbar** (Supabase `uri_allow_list`) — das ist eine Aufgabe außerhalb dieses Repos. | 4 |
| T-72 | SHA-256-Pin für die hartkodierte, unveränderliche Installer-URL fehlt (Größe und Authenticode sind da). | 5 |
| T-68 | Linux: verwaistes ComfyUI-Kind wird read-only adoptiert, Stop bleibt ein No-op. | 3 |
| T-53 | Nichts trennt MCP-Server beim App-Ende; Kindprozesse verwaisen. | 3 |
| T-65 | `free_comfyui_memory`/`offload_ollama_loaded_models` hartkodieren `localhost:8188`/`:11434`. | 1,5 |
| T-61 | `secret_get`/`secret_set` nehmen weiterhin einen beliebigen Account-String ohne Allowlist. | 2 |
| T-69 | Unabbrechbares `setInterval` im Built-in-Engine-Installpfad; Promise settelt bei Pause/Abbruch nie. | 2 |
| T-76 | Create-Dateislots geben ihre Blob-URLs nie frei. | 2 |
| T-67 | Custom-Node-Installation leert den `/object_info`-Cache nicht. | 0,5 |

### 4.2 Technik-Nachtrag — 4 offene Positionen

| ID | Was offen ist |
|---|---|
| ZB-7 | `vite.config.ts` ist **2.486 Zeilen** (Audit maß 2.466, Ziel < 100). Die Guards sind extrahiert und getestet, der Dev-Server steckt weiter in der Build-Konfiguration. |
| AS-10 | Lint ist weiterhin kein Gate (`ci.yml`: `Lint (non-gating — pre-existing debt)`). Die Schuld dahinter ist stark abgetragen, der Befund — „ein dauerhaft rotes Gate ist kein Gate" — steht. Dazu: `cargo clippy` ebenfalls non-gating. |
| AS-08 | „Läuft gerade etwas?" hat weiter zwei Quellen: `codex.status` kennt unverändert nur `idle\|running\|error`, `anyRunActive` verrechnet weiter zwei Wahrheiten. |
| AS-09 | `Onboarding.tsx` unverändert 59 `useState`; `SettingsPage.tsx` von 43 auf **46** gestiegen. |

### 4.3 Design — 53 offene Befunde

**Die vier offenen Amateur-Signale (§3) — hier steckt der Hebel:**

- **D-A3 / D-T01 / D-W2-1 — die vier Maßstäbe.** `html { font-size: 18.4px }`, `zoom: 1.25` in der Sidebar, `scale(0.763)` und `scale(0.7)` in Create: alle vier unverändert, kein `--ui-scale`. Das ist der eine Posten, den der Audit als Ursache für „praktisch kein Radius, keine Hairline und keine Schriftgröße auf einem ganzen Pixel" benennt — und der einzige W2-Posten, den nichts angefasst hat. Er hängt an D-T04 (Type-Scale) und D-T08 (Radius) mit dran.
- **D-A4 / D-T13 — der Platzhalter ist heller als der eingegebene Wert.** `index.css:501-502` ist byte-gleich mit dem Audit-Zitat. Zwei Zeilen CSS, gemessene 3,4:1 unter WCAG AA für den *eingegebenen* Text. Billigster offener Punkt des ganzen Design-Audits.
- **D-A9 / D-W3-7 — die Marke.** Neun von zehn Einbindungen laden weiter das 512×512-PNG, das Titlebar-Monogramm wurde nicht gestrichen, der Welcome-Screen hat weiter kein Zeichen.
- **D-A10 — elf Icon-Rätsel als Hauptnavigation von Create.** `IntentBar.tsx:87` blendet die vorhandenen `short`-Labels weiterhin auf `max-w-0 opacity-0` aus.

**Die zehn offenen Token-Zeilen (§5):** D-T01 (Root-Größe) · D-T03 (Display-Schrift fehlt ganz) · D-T04 (arbitrary `text-[…]` **1007 → 1017**, `.t-*` unverändert 143) · D-T05 (Akzent weiter `#a094f8`, `#7c3aed` **20 → 22**, Brand-Violett `#8b5cf6` weiter 0×) · D-T06 (Surface-Tokens 0 → 6 Call-Sites, Shell malt Literale) · D-T07 (Control-Höhen nur im Composer erschlossen) · D-T08 (zwei Radius-Systeme nebeneinander) · D-T09 (`shadow-sm` 16 → 16, weiter auf dem „Get"-Button) · D-T11 (2 von 4 Springs ersetzt) · D-T13 (= D-A4).

**Die 39 offenen Screen-Bullets (§4)**, nach Screen:

| Screen | offen |
|---|---|
| Chat, leerer Zustand | D-S02 (Empty-State ohne Titel/CTA), D-S03 („New Chat" schwächer als die aktive Zeile), D-S04 (dritter Modus-Tab ohne Label), D-S05 (tote Fläche) |
| Chat mit Antwort | D-S06 (zwei Kontextanzeigen, zwei Notationen), D-S07 (Aktionsleiste nicht hover-gated), D-S08 (zwei Avatar-Systeme) |
| Chat, streamend | D-S11 (`WorkingAnchor` im Standbild von Fließtext ununterscheidbar) |
| Sidebar | D-S14 (doppelte Kürzung), D-S15 (Hover-Icons halten ihren Platz), D-S16 (698 von 899px leer), D-S17 (vier Control-Höhen) |
| Header / Titlebar | D-S18 (drei Bänder), D-S19 (9 Elemente rechts, Center leer), D-S20 (Breakpoint je nach View), D-S21 (Overflow-Menü ohne `role="menu"`) |
| Models | D-S22 (vier Glyphen ohne Legende), D-S23 (Dropdown ≡ Chip), D-S24 (`shadow-sm` auf „Get"), D-S25 (zwei Segmented-Sprachen), D-S26 (keine Virtualisierung — 300 Modelle ≈ 9000 Knoten) |
| Settings | D-S27 (Spalte schwebt frei), D-S28 (12 rangfreie Sektionsköpfe), D-S29 (zwei gleiche Reset-Links, einer löscht mehr), D-S30 (Zustand ≡ Aktion) |
| Create | D-S31 (Banner und Empty-State widersprechen sich), D-S32 (175px Versatz), D-S33 („Neg" liest als Platzhalter), D-S34 (unbeschriftete 45px-Leiste) |
| Onboarding | D-S35 (sechs Schritte, nicht drei), D-S36 (Hover verdunkelt den Primärbutton — `.lu-primary` erreicht das Onboarding nicht), D-S37 (H1 = 18,4px), D-S38 (294px Niemandsland), D-S39 (nackter Punkt statt Icon) |
| Light Mode | D-S42 (keine Ebenen) |
| 900px | D-S46 (nutzbare Eingabebreite), D-S47 (Kebab ohne erkennbare Regel), D-S48 (Settings skaliert nach oben nicht), D-S49 (kein Schriftgrößen-Breakpoint) |

**Die sechs offenen Wellen-Posten (§6):** D-W2-1 (Root 16px) · D-W2-6 (2 von 4 Springs) · D-W3-6 (Icon-Leiter: 19 Größen unverändert) · D-W3-7 (SVG-Monogramm: 1 von 10) · D-W3-9 (`Cmd+K`-Palette) · D-W3-10 (Kontextmenüs auf Nachricht und Modellkarte).

### 4.4 Was daran auffällt

Die Verteilung ist kein Zufall. Der Technik-Audit ist in beiden schweren Klassen vollständig abgearbeitet und bricht erst im Mittelfeld ab; der Design-Audit ist genau dort umgesetzt, wo ein Befund **eine** Stelle betrifft (`--lu-measure`, `.lu-primary`, `.lu-control`, Fokusring, Caret) und genau dort offen, wo er **viele** betrifft (Root-Größe: ~1.000 Call-Sites, Icon-Leiter: 667, Type-Scale: 1.017). Die drei offenen Design-Posten mit dem größten Hebel sind alle vom selben Typ: eine Ursache, tausend Fundstellen. Und der billigste offene Punkt des ganzen Design-Audits sind zwei CSS-Zeilen (D-A4).

---

## 5. Wo Commit-Nachricht und Code auseinandergehen

Ich habe gezielt danach gesucht. Was ich **nicht** gefunden habe: einen Fall, in dem eine Commit-Nachricht einen Befund als behoben meldet, den der Code überhaupt nicht anfasst. Die Nachrichten in diesem Branch sind ungewöhnlich präzise — mehrere benennen von sich aus Abweichungen vom Audit (`3883eaa8`: Blink 300/300 statt 133/133 wegen WCAG 2.3.1), korrigierte Audit-Zahlen (`c77682a2`: 489 statt 462 Buttons, 19 statt 9 Icon-Größen) oder Fundstellen, die schon vorher behoben waren (`f336b91e`: 2 von 6). Was ich gefunden habe, sind **sechs Überschriften, die breiter sind als ihr Rumpf**, und zwei Stellen, an denen die Erzählung hinter dem Code zurückbleibt.

**1. `7de75b95` — „Tunnel überlebt die App nicht mehr“, aber auf macOS/Linux tut er es weiterhin.**
Der Sweep beim Start schließt die eigentliche Gefahr (stille Republikation der neuen Sitzung). Der Kill beim Beenden hängt an `impl Drop for RemoteServer` (`remote.rs:5275`) — und der Doc-Kommentar direkt darüber sagt es selbst: *„Tauri v2 does not reliably drop managed state on `app.exit(0)`, which is why `AppState` has an explicit shutdown path — but that path lives outside this module and does not reach the tunnel.“* `main.rs:625` ruft bei `RunEvent::Exit` nur `state.shutdown_subprocesses()`, und darin kommt der Tunnel nicht vor (Ollama, Engine, Embeddings, ComfyUI — kein `cloudflared`). Auf Windows fängt das Job-Objekt es ab, auf Unix erst der nächste Start. Der Code ist ehrlich, die Überschrift nicht.

**2. `c77682a2` — „Icon-Leiter“ ist die Strichstärken-Korrektur, nicht die Leiter.**
`src/components/ui/icon-size.ts` definiert `ICON_SM/MD/LG = 12/16/20` und schreibt daneben: *„Umgesetzt wird das NICHT hier und nicht an 668 Call-Sites.“* Am HEAD stehen weiterhin **19 verschiedene `size=`-Werte** zwischen 7 und 36 — exakt so viele wie in `base/`; die häufigsten sind 11 (149×), 10 (117×) und 12 (115×). Geliefert ist `<LucideProvider absoluteStrokeWidth strokeWidth={…}>` an der Wurzel, was die *Strichstärke* vereinheitlicht. Das ist wertvoll und war der schwerere Teil — aber der Audit-Befund „9 Icon-Größen auf einem Screen“ ist offen.

**3. `c77682a2` — „SVG-Monogramm“ gilt für eine von zehn Einbindungen.**
`Titlebar.tsx:30` nimmt `/LU-monogram.svg`. `Header.tsx:214` (33px), `ChatView.tsx:185` (46px), `MessageBubble.tsx:209`, `CodexView.tsx:261`, `ChatInput.tsx:491`, `AccountPanel.tsx:209` und `CloudSwitch` laden weiter `LU-monogram-bw.png` mit 512×512. Der Audit-Fix hatte drei Teile (Titlebar streichen, Header auf 20px SVG, 64px-Marke auf den Welcome-Screen); keiner davon ist vollständig gegangen — die Titlebar wurde nicht gestrichen, sondern nur umgestellt. Rumpf und Test beschränken sich korrekt auf die Titlebar.

**4. `bcec642b` — „EINE Spalte“ ist im Chat-Strang nicht ganz durchgezogen.**
Sechs Komponenten nehmen `--lu-measure`. `GroupCostHint.tsx:54` trägt weiterhin `max-w-[70%]` — dieselbe Formel, die der Audit als Ursache benennt — und wird über `composerAbove` (`ChatView.tsx:387`) *innerhalb* des Measure-Wrappers gerendert, sitzt also mit 532px in einer 760px-Spalte.

**5. `d15f5cea` — „Chat-ID '..' kann den Datei-Jail nicht mehr auf `$HOME` heben“ galt zu diesem Zeitpunkt für eine von drei Kopien.**
Der Sanitizer existierte dreifach. `agent.rs` wurde mit `d15f5cea` geschlossen; `filesystem.rs` hielt seine eigene Kopie mit `.` in der Allowlist und fiel erst mit `dab30435`; der TypeScript-Port im Dev-Server fiel erst mit `1a8464dc` — 60 Commits nach dem Commit, der den Befund für erledigt erklärte. Der Branch hat das selbst gefunden und beide Nachträge ehrlich betitelt (`fix(dev-jail): IPC-1 war im TypeScript-Port wieder offen`); am HEAD ist der Befund zu. Es bleibt der klarste Beleg dafür, warum ein Commit-Titel kein Abnahmekriterium ist.

**6. `EXPERIMENT-CHANGELOG.md` widerspricht sich in benachbarten Absätzen.**
Zeile 277 (Tabelle „Etappenstand — beide Maschinen“): `no-explicit-any | 827 | **57** ✓ | < 100`. Zeile 296, achtzehn Zeilen darunter im selben Abschnitt: „**`no-explicit-any` steht bei 564**, Audit-Ziel < 100“. Der Code gibt der niedrigen Zahl recht — im Snapshot zähle ich textuell 72 `any`-Vorkommen gegen 516 an der Basis. Die 564er-Zeile ist ein nicht nachgezogener Zwischenstand, der als aktueller Befund gelesen wird.

**7. Die Erzählung führt `vite.config.ts` als erledigt, der Zeilenzähler nicht.**
Der Abschnitt „Der Dev-Server war die größte offene Tür“ beschreibt sieben geschlossene Löcher und die erste Testabdeckung überhaupt — alles belegt. Die zweite Hälfte des Audit-Fixes (Zeitbombe 7: „Dev-Server nach `scripts/dev-server/` auslösen, Config auf < 100 Zeilen“) kommt nicht vor: **`vite.config.ts` hat am HEAD 2.486 Zeilen, 20 mehr als der Audit gemessen hat.**

**8. `3218b16c` — „die Angriffsfläche der WebView schrumpft“ stimmt, mit einem benannten Rest.**
`withGlobalTauri: false` und elf Interpreter raus ist der Kern des Befundes. `npx`, `npx.cmd` und `uvx` behalten `args: true`, weil externe MCP-Server so starten — `npx -y <paket>` bleibt damit ein Weg zu fremdem Code im Hauptfenster. Die `description` der Capability sagt das selbst; ich führe es hier, weil der Audit-Fix wörtlich „args auf konkrete Argument-Validatoren einschränken statt true“ verlangt hat.

**Und einmal andersherum: der Code liefert mehr, als beide Audits verlangt haben.**
`517c29a6` schließt eine Lücke, die in keinem der 85 Befunde steht: `ci.yml` fuhr `npm run build`, `cargo check` und `cargo test` — drei grüne Gates auf einer Konfiguration, die sich nicht bündeln ließ. `tauri build` kam in keinem Workflow außer `release.yml` vor, und dort mit Signaturschlüssel aus den Secrets, unter dem der Defekt aus `a0030ad2` sauber durchbaut. Das neue Gate baut deshalb **absichtlich ohne Schlüssel** und löscht die beiden Variablen selbst, statt sie nur nicht zu setzen — mit vier gefahrenen Sonden als Beleg, darunter der Nebenbefund, dass der Bundler bei einem zum `pubkey` unpassenden Schlüssel nur warnt und 0 exitet. Der Audit hat M6 als „die Release-Sicherung ist ein No-Op" formuliert; die schärfere Frage — „prüft überhaupt irgendetwas, ob sich das Produkt bauen lässt?" — hat er nicht gestellt.

---

## 6. Was ich nicht entscheiden konnte

- **Alles, was einen Build oder einen Lauf braucht, habe ich nicht selbst gefahren.** Fünf andere Agenten arbeiten parallel im selben Arbeitsbaum; ich habe deshalb `git archive` auf unveränderliche Snapshots gezogen und ausschließlich gelesen. Betroffen: die Boot-Chunk-Zahlen (T-42, `dist/` ist nicht committet), der Zyklen-Zähler (ZB-8) und jede DOM-Messung des Design-Audits (D-S05, D-S16, D-S38, D-S46, D-S48). Die Test- und Build-Zahlen selbst sind inzwischen anderswo real belegt (Mac und `lu-box`), nur eben nicht von mir.
- **Die CI- und Release-Workflows (T-17, AS-04).** Kein Remote, nichts veröffentlicht — `release.yml` und `ci.yml` sind nur statisch gelesen. Ob der Gate-Job wirklich greift, kann erst ein echter Actions-Lauf zeigen. Das ist dieselbe Grenze, die der Changelog selbst benennt.
- **Plattform-gebundene Befunde.** Windows ist inzwischen keine Lücke mehr: `cargo test` 715 grün, `tauri build` Exit 0 mit MSI und NSIS, App-Start mit vollständiger WebView2-Prozessfamilie — auf `lu-box`, an echter Hardware. **Linux dagegen ist in beiden Audits und in diesem Experiment ausschließlich gelesen.** Genau dort liegen T-08 (jede Linux-ComfyUI-Installation galt als kaputt), T-24 (WebKitGTK-localStorage) und der offene T-68 (verwaistes ComfyUI-Kind). Das ist die größte verbleibende Verifikationslücke des Experiments.
- **Die Zuordnung „welcher Commit hat es getan“ ist bei Muster-Fixes nicht immer eindeutig.** Wo mehrere Commits dieselbe Datei anfassen (z. B. `openai-provider.ts`: `21e67a15`, `9c7243a1`, `0e740f60`, `1f7ef5e6`, `44a0692a`), habe ich den Commit eingetragen, der den Sachverhalt tatsächlich ändert — nicht den, der die Datei zuletzt berührt hat. Bei den Typisierungs-Commits (`M-any`) ist diese Trennung an einzelnen Zeilen nicht mehr sauber zu ziehen.
- **Die 30 mittleren und 2 niedrigen Befunde haben im Audit keinen Volltext** (Anhang D: die JSON-Rohausgabe der 24 Agenten ging beim Recyceln der Arbeitsumgebung verloren). Für sie gibt es nur Titel, Subsystem und Fundstelle. Wo der Titel mehrdeutig ist, konnte ich den Befund nur so eng prüfen, wie er formuliert ist.
