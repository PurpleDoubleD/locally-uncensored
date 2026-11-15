# Abweichungen von der Konvention m-<screen>-<element>

Die Konvention steht in `TESTIDS.md`. Diese Liste sagt, wo die Shell davon abweicht. Der Rahmen kommt mit jeder Abweichung hier zurecht (er liest die echten Kennungen aus den Quellen, siehe `TABELLE.md`). Im App-Code ist nichts geaendert. Was davon angeglichen wird, die Shell oder die Konvention, entscheidet David.

Der obere Teil ist von Hand geschrieben und am 08.10.2026 gegen die Quellen geprueft. Der untere Teil (ab "Gemessen") wird von `npm run tabelle` neu geschrieben.

## A. Was TESTIDS.md erwartet hat und es so nicht gibt

| erwartet | in der Shell | Folge fuer den Rahmen |
|---|---|---|
| `m-nav-agent`, `m-nav-remote` | gibt es nicht. Vier Reiter: `m-nav-chat`, `m-nav-create`, `m-nav-models`, `m-nav-settings` | Agent: Chat-Optionen (`m-options-agent`) und Einstellungen (`m-settings-agent`). Remote: Segment der Chatliste (`m-chats-segment-remote`) |
| `m-chat-agent-toggle` | `m-options-agent` im Blatt `m-options` | Selektor umgestellt |
| `m-chat-toolcall` | `m-chat-tool` | Selektor umgestellt |
| `m-remote-host`, `m-remote-connect`, `m-remote-status` | `m-remote-connect-address`, `m-remote-connect-submit`, `m-remote-connect-status` auf der Seite `/remote/connect` | Selektor umgestellt |
| `m-models-storage-full` | Rueckfrage `m-dialog-storage-full` aus dem Geruest (gilt fuer alle Downloads, nicht nur auf der Modellseite) | Selektor umgestellt |
| `m-app-restored` | `m-app-resume` | Selektor umgestellt |

Alle anderen erwarteten Kennungen aus der Tabelle in TESTIDS.md gibt es wortgleich.

## B. Kennung und Inhalt passen nicht zusammen

- Erledigt in Runde 2: `m-settings-language` heisst jetzt `m-settings-voice` (Einstellungen, Zeile E1.6, oeffnet `/settings/voice`).
- `m-settings-theme` oeffnet die Seite Aussehen (`/settings/appearance`), auf der das Farbschema eine von mehreren Einstellungen ist. Vertretbar, aber nicht mehr genau.

## C. Pflichten aus TESTIDS.md, die nicht ueberall erfuellt sind

- **Pflicht 6, `data-m-risk`:** Der Strang Settings, Konto, Cloud setzt die Markierung nirgends. Betroffen sind unter anderem `m-account-signout`, `m-account-delete`, `m-account-buy`, `m-account-pay-invoice`, `m-settings-data-all-delete` und die Hoerproben der Cloud-Stimmen. Der Strang Models und Onboarding setzt sie ebenfalls nicht (Downloads kosten Datenvolumen, Loeschen entfernt Modelle). `m-chat-send` und `m-create-generate` tragen sie nicht, obwohl sie im Cloud-Modus Geld kosten. Der Sweep sperrt diese Elemente ueber ihre Kennung (`lib/sperre.mjs`), die Zahlen stehen unten in Abschnitt 5.
- **Pflicht 7, Rolle:** Der Griff oben an jedem Blatt (`div.m-sheet-grab` in `ui/Sheet.tsx`) reagiert auf Ziehen und hat keine Rolle. Seit Runde 4 traegt er `data-m-decor`, Inventar und Sweep ueberspringen ihn. Wer das Blatt nicht ziehen kann, schliesst es ueber `m-sheet-close`.
- **Pflicht 2, jede bedienbare Stelle hat eine Kennung:** Was das Inventar in der Vorschau ohne Kennung findet, steht je Seite im Sweep-Ergebnis (`sweep/<route>.json`, Feld `ohneTestid`).

## D. Was der Sweep in der Vorschau gesehen hat und am Geraet nachgesehen werden muss

Das sind keine Namensabweichungen, sondern Knoepfe ohne messbare Wirkung im Browser (Trockenlauf vom 08.10.2026, 89 Seiten und Blaetter, 663 Elemente). Im Browser fehlt die native Seite und fremde Adressen sind gesperrt, deshalb ist das noch kein Befund ueber die App. Am Geraet muss bei jedem etwas passieren.

- **Oeffnen eine Webseite** (gesperrt): `m-settings-about-website`, `-source`, `-contact`, `-privacy`, `-terms`, `m-settings-privacy-policy`, `m-settings-licenses-full`, `m-account-forgot`.
- **Oeffnen die Dateiauswahl oder die Kamera des Systems:** `m-chat-attach-file`, `m-create-source-take`, `m-create-source-library`, `m-create-source-file`, `m-settings-appearance-picture-choose`, `m-settings-data-import-choose`, `m-settings-data-restore`, `m-memory-import`.
- **`m-chat-attach-file` auf iOS (Gegenpruefung grosses iPhone, N13):** Der Tipp oeffnet zuerst ein Menue des Systems mit "Photo Library" und "Choose Files" (so im Bericht gesehen), erst "Choose Files" oeffnet die Dateiauswahl. Das ist das Verhalten von iOS fuer ein Dateifeld ohne Einschraenkung, und der Chat nimmt jede Datei an (auch Binaerdateien, `src/lib/chat-files.ts`), deshalb gibt es keine Liste von Dateitypen, die das Menue abschaltet. Ein dort gewaehltes Foto kommt als Datei in den Chat, nicht als Bild fuer das Modell. Der Kundenfluss waehlt "Choose Files" selbst (`waehleDatei`). Die Zeile traegt keine Risikomarke, weil der Kundenfluss sie tippt. Erwartung am Geraet: Menue, dann Dateiauswahl, "Preparing" steht so lange in der Zeile.
- **Lesen die Zwischenablage:** die Knoepfe "Paste into ..." an vier Feldern (Adresse des Desktops, Brave, Tavily, Hugging Face). Seit Runde 4 enden sie immer mit Text im Feld oder mit einem Satz (`m-toast-paste-empty`, `m-toast-paste-blocked`).
- **Brauchen Daten oder eine Anmeldung:** `m-create-model-refresh`, `m-create-batch-add`, `m-create-char-add`, `m-create-gallery-filter-all` (schon gewaehlt), `m-memory-outside`, `m-settings-troubleshooting-run`, `m-settings-troubleshooting-refresh`.
- **Der Griff jedes Blatts:** entfaellt seit Runde 4, siehe C, Pflicht 7.

## Gemessen

<!-- GEMESSEN:ANFANG (tabelle/bauen.mjs schreibt diesen Abschnitt) -->

Stand: mobile-310-d0418d@effcb892a, 110 Schnappschuesse.

### 1. Screen-Wort ausserhalb der Liste

TESTIDS.md erlaubt als `<screen>`: `onboarding`, `chat`, `models`, `create`, `remote`, `settings`, `account`, `nav`, `app`. In den Quellen stehen 820 Kennungen mit einem anderen Wort an dieser Stelle.

| Wort | Kennungen | Strang | Beispiel | Einordnung |
|---|---|---|---|---|
| `toast` | 231 | shell, settings, agent, models, chat, remote, create | `m-toast` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `dialog` | 85 | shell, settings, models, agent, create, chat, remote | `m-dialog` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `options` | 69 | agent | `m-options` | eigenes Wort des Strangs |
| `memory` | 66 | agent | `m-memory-add` | eigenes Wort des Strangs |
| `sheet` | 47 | agent, shell, chat, create, settings, remote | `m-sheet-agent-add-step` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `cloud` | 34 | settings | `m-cloud-add-credits` | eigenes Wort des Strangs |
| `documents` | 31 | agent | `m-documents-add` | eigenes Wort des Strangs |
| `chats` | 25 | chat | `m-chats-empty` | eigenes Wort des Strangs |
| `step` | 21 | agent | `m-step-cond` | eigenes Wort des Strangs |
| `iap` | 16 | settings | `m-iap-close` | eigenes Wort des Strangs |
| `search` | 16 | agent | `m-search-free-only` | eigenes Wort des Strangs |
| `tasks` | 13 | agent | `m-tasks-empty` | eigenes Wort des Strangs |
| `workflow` | 13 | agent | `m-workflow-add-step` | eigenes Wort des Strangs |
| `compare` | 11 | agent | `m-compare` | eigenes Wort des Strangs |
| `group` | 11 | agent | `m-group-add` | eigenes Wort des Strangs |
| `preview` | 11 | agent | `m-preview-close` | eigenes Wort des Strangs |
| `agent` | 10 | agent | `m-agent-groups` | eigenes Wort des Strangs |
| `fatal` | 10 | remote | `m-fatal-copy` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `age` | 9 | shell | `m-age-actions` | eigenes Wort des Strangs |
| `approval` | 9 | agent | `m-approval-allow` | eigenes Wort des Strangs |
| `price` | 8 | settings | `m-price-change-model` | eigenes Wort des Strangs |
| `persona` | 7 | agent | `m-persona-builtin` | eigenes Wort des Strangs |
| `credits` | 6 | settings | `m-credits-add` | eigenes Wort des Strangs |
| `dev` | 5 | shell | `m-dev-composer-screen` | eigenes Wort des Strangs |
| `link` | 5 | settings | `m-link-offer-continue` | eigenes Wort des Strangs |
| `page` | 5 | shell | `m-page-back` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `report` | 5 | shell | `m-report-include-text` | eigenes Wort des Strangs |
| `whats` | 5 | settings | `m-whats-new-empty` | eigenes Wort des Strangs |
| `consent` | 4 | shell | `m-consent-agree` | eigenes Wort des Strangs |
| `md` | 4 | chat | `m-md-code` | eigenes Wort des Strangs |
| `personas` | 4 | agent | `m-personas-add` | eigenes Wort des Strangs |
| `workflows` | 4 | agent | `m-workflows-add` | eigenes Wort des Strangs |
| `placeholder` | 3 | shell | `m-placeholder` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `unavailable` | 3 | shell, settings | `m-unavailable` | eigenes Wort des Strangs |
| `add` | 2 | agent | `m-add-step-gone` | eigenes Wort des Strangs |
| `engine` | 2 | shell, models | `m-engine-notice-failed` | eigenes Wort des Strangs |
| `session` | 2 | settings | `m-session-on-device` | eigenes Wort des Strangs |
| `beta` | 1 | shell | `m-beta` | eigenes Wort des Strangs |
| `compact` | 1 | settings | `m-compact-label` | eigenes Wort des Strangs |
| `direct` | 1 | shell | `m-direct-mark` | eigenes Wort des Strangs |
| `foot` | 1 | shell | `m-foot-jump` | eigenes Wort des Strangs |
| `kb` | 1 | shell | `m-kb-open` | eigenes Wort des Strangs |
| `overlays` | 1 | shell | `m-overlays` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `stack` | 1 | shell | `m-stack` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |
| `viewer` | 1 | chat, shell | `m-viewer-close` | Vorgabe des Geruests (STRAENGE.md), fehlt in TESTIDS.md |

### 2. Blaetter, die nicht `m-sheet-<id>` heissen

| Blatt | erwartet | im DOM |
|---|---|---|
| keine | | |

Solange ein Blatt noch laedt, traegt der Platzhalter des Geruests `m-sheet-<id>`. Erst das fertige Blatt hat die eigene Kennung. Wer auf `m-sheet-<id>` wartet, findet in diesen drei Faellen nur den Ladezustand.

### 3. Seiten mit zusammengesetztem Screen-Wort

TESTIDS.md: "`<screen>` ist ein Wort ohne Bindestrich". 56 von 64 Seiten haengen den Namen der Unterseite an: `m-onboarding-model-screen`, `m-onboarding-documents-screen`, `m-onboarding-done-screen`, `m-chat-file-screen`, `m-chat-message-edit-screen`, `m-chat-message-text-screen`, `m-chat-documents-screen`, `m-chat-compare-screen` und so weiter. Die ganze Liste steht in TABELLE.md.

### 4. Andere Zeichen als Kleinbuchstaben, Ziffern und Bindestrich

26 Kennungen im DOM: `m-settings-engine-advanced-cachek-q8_0`, `m-settings-engine-advanced-cachev-q8_0`, `m-settings-voice-pick-Wise_Woman`, `m-settings-voice-preview-Wise_Woman`, `m-settings-voice-pick-Calm_Woman`, `m-settings-voice-preview-Calm_Woman` und so weiter. Der veraenderliche Teil ist die Kennung der Stimme, wie der Dienst sie liefert.

### 5. Risiko-Markierung `data-m-risk`

Im DOM der Vorschau tragen 66 bedienbare Elemente `data-m-risk`: `m-memory-export-md` (leaves-app), `m-memory-export-json` (leaves-app), `m-consent-privacy` (leaves-app), `m-chat-attach-photo` (sensor), `m-chat-attach-library` (sensor), `m-chat-link-open` (leaves-app), `m-credits-plans` (paid), `m-remote-attach-camera` (sensor), `m-remote-attach-library` (sensor), `m-report-send` (destructive), `m-cloud-sheet-plan-hosted` (paid), `m-cloud-sheet-plan-hosted-pro` (paid), `m-cloud-sheet-plan-hosted-max` (paid), `m-account-delete-go-delete` (destructive), `m-account-reset-send` (destructive), `m-settings-licenses-full` (leaves-app), `m-create-source-take` (sensor), `m-create-source-library` (sensor), `m-create-tools-removebg` (paid), `m-create-tools-eraser` (paid), `m-create-tools-animate` (paid), `m-create-tools-extend` (paid), `m-chat-mic` (paid), `m-cloud-plan-hosted` (paid), `m-cloud-plan-hosted-pro` (paid), `m-cloud-plan-hosted-max` (paid), `m-create-batch-add` (sensor), `m-create-char-add` (sensor), `m-create-train` (paid), `m-create-showcase-plans` (paid), `m-remote-connect-scan` (sensor), `m-settings-about-website` (leaves-app), `m-settings-about-source` (leaves-app), `m-settings-about-contact` (leaves-app), `m-settings-about-privacy` (leaves-app), `m-settings-about-terms` (leaves-app), `m-account-delete-website` (destructive), `m-agent-reset` (destructive), `m-settings-appearance-picture-choose` (sensor), `m-settings-chat-reset` (destructive), `m-settings-data-backup` (leaves-app), `m-settings-data-all-delete` (destructive), `m-settings-engine-reset` (destructive), `m-memory-delete-all` (destructive), `m-personas-reset` (destructive), `m-settings-privacy-policy` (leaves-app), `m-settings-storage-partials-clear` (destructive), `m-settings-storage-cache-clear` (destructive), `m-settings-troubleshooting-share-log` (leaves-app), `m-settings-troubleshooting-setup` (destructive), `m-settings-troubleshooting-reset` (destructive), `m-settings-troubleshooting-share-report` (leaves-app), `m-settings-voice-preview-Wise_Woman` (paid), `m-settings-voice-preview-Calm_Woman` (paid), `m-settings-voice-preview-Lively_Girl` (paid), `m-settings-voice-preview-Lovely_Girl` (paid), `m-settings-voice-preview-Sweet_Girl_2` (paid), `m-settings-voice-preview-Friendly_Person` (paid), `m-settings-voice-preview-Deep_Voice_Man` (paid), `m-settings-voice-preview-Casual_Guy` (paid), `m-settings-voice-preview-Patient_Man` (paid), `m-settings-voice-preview-Determined_Man` (paid), `m-settings-voice-preview-Elegant_Man` (paid), `m-settings-voice-preview-Young_Knight` (paid), `m-settings-voice-test` (paid), `m-age-confirm-minor` (destructive). In den Quellen sind es 108 Kennungen, alle in den Straengen remote, settings, shell, agent, chat, create, models.

19 bedienbare Elemente im DOM der Vorschau haben KEIN `data-m-risk`, obwohl ihre Kennung nach der Sperrliste (`lib/sperre.mjs`) Geld kostet oder etwas loescht. Der Sweep sperrt sie ueber die Kennung, die Markierung fehlt:

- **shell** (1): `m-consent-agree` destructive
- **create** (1): `m-create-improve` paid
- **settings** (11): `m-account-reset-email` destructive, `m-settings-troubleshooting-run` paid, `m-settings-troubleshooting-self-test` paid, `m-settings-voice-phone-preview-default` paid, `m-settings-voice-phone-preview-0` paid, `m-settings-voice-phone-preview-1` paid, `m-settings-voice-phone-preview-2` paid, `m-settings-voice-phone-preview-3` paid, `m-settings-voice-phone-preview-4` paid, `m-settings-voice-phone-preview-5` paid, `m-settings-voice-test-system` paid
- **models** (4): `m-compare-send` paid, `m-models-download` paid, `m-onboarding-documents-install` paid, `m-onboarding-download` paid
- **chat** (1): `m-chat-install-model` paid
- **agent** (1): `m-search-test` paid

Die Sperrliste ist mit Absicht weit gefasst. Nicht jede Kennung hier braucht die Markierung (ein Link zur Preisseite kostet noch nichts), aber jede sollte einmal angesehen werden.

Die Vorschau zeigt nur, was ohne Anmeldung, ohne Modell und ohne Daten zu sehen ist. Knoepfe wie `m-account-signout`, `m-account-delete`, `m-chat-send`, `m-create-generate` oder `m-chat-menu-delete` erscheinen dort nicht. Was die Quellen dazu sagen, steht in TABELLE.md (`!paid`, `!destructive`, `!leaves-app`, `!sensor`).

<!-- GEMESSEN:ENDE -->
