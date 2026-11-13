# data-testid in der Mobile-Shell: Vorgabe fuer die UI-Bauer

Der Abnahmerahmen findet Elemente ueber `data-testid`. Ohne sie haengen die Flows an Texten und Klassen und brechen bei jeder Umformulierung.

## Die Regel

`data-testid="m-<screen>-<element>"`

- Kleinbuchstaben, Ziffern und Bindestriche. Englisch.
- `m` steht fuer Mobile und trennt die Shell vom Desktop.
- `<screen>` ist ein Wort ohne Bindestrich: `onboarding`, `chat`, `models`, `create`, `remote`, `settings`, `account`, `nav`, `app`.
- `<element>` sagt, was es ist oder tut, nicht wie es aussieht: `send`, nicht `blue-button`.
- Varianten haengen hinten an: `m-chat-model-local`, `m-models-item-toolarge`.
- Eine testid ist auf einem Screen eindeutig. Ausnahme sind Listen, siehe unten.

## Pflicht

1. Jeder Screen hat ein Wurzelelement mit `data-testid="m-<screen>-screen"`. Daran erkennen Inventar und Sweep, wo sie sind.
2. Jedes bedienbare Element hat eine testid: Knoepfe, Links, Felder, Schalter, Tabs, Menuepunkte.
3. Jede Meldung, auf die ein Mensch reagieren soll, hat eine testid, und ihr Aktionsknopf auch: `m-chat-error` und `m-chat-error-action`.
4. Zustand steht in `data-state`, nicht in der testid: `data-state="idle|loading|streaming|done|error"`.
5. Listen: Jedes Element traegt dieselbe testid plus `data-m-id="<stabile id>"`. Chatnachrichten zusaetzlich `data-m-role="user|assistant"`.
6. Risiko: Was Geld kostet, bekommt `data-m-risk="paid"`. Was etwas unwiderruflich loescht oder abmeldet oder etwas an Menschen abschickt, das sich nicht zurueckholen laesst (`m-report-send`), bekommt `data-m-risk="destructive"`. Die Bestaetigung einer Rueckfrage (`m-dialog-confirm`) traegt die Marke der Aktion, die gefragt hat: rot ist `destructive`, Cloud-violett ist `paid`. Der Sweep tippt solche Elemente nie an. Das Mikrofon im Chat (`m-chat-mic`) traegt `paid` immer: Mit LU Cloud kostet die Aufnahme Guthaben, ohne oeffnet der Tipp das Mikrofon des Handys oder den Weg zum Konto. In Create tragen die Wahl der vier Werkzeuge `animate`, `eraser`, `extend` und `removebg` (`m-create-tools-<id>` im Blatt, `m-create-tool-<id>` in der Leiste) `paid`, obwohl erst der Lauf etwas bucht: Ihre Namen sperrt der Sweep ohnehin, die Marke sagt am Element dasselbe (Nachabnahme Android, N9). Was die App verlaesst (Link im Browser, Mail-App, Einstellungen des Systems, Teilen-Blatt), bekommt `data-m-risk="leaves-app"`. Was Kamera oder Mediathek oeffnet, bekommt `data-m-risk="sensor"`. Eine Marke je Element, die schwerere gewinnt: `m-chat-mic` bleibt `paid`. Der Sweep tippt auch diese Elemente nie an und fuehrt sie im Bericht unter ihrer eigenen Marke.
7. Bedienbar heisst auch zugaenglich: echtes `button`, `a`, `input` oder eine `role`. Ein `div` mit Klick-Handler meldet das Inventar als "ohne Rolle".
8. Jedes Touch-Ziel ist mindestens 44 mal 44 CSS-px gross.

## Was das Geruest der Shell dazu vorgibt

Die Shell (`src/mobile/STRAENGE.md`, Abschnitt 7) hat die Regel um Bausteine erweitert, die es hier noch nicht gab. Der Rahmen kennt sie (`lib/shell.mjs`):

- Seite: `.m-page[data-route="<route>"]`, darin `m-<screen>-screen`. Die Seite darunter bleibt eingehaengt (`data-m-hidden`, `inert`).
- Blatt: `[role="dialog"]` mit `m-sheet-<id>`, darin `m-sheet-close` und bei Unterseiten `m-sheet-back`. Seit Runde 2 sitzt `m-sheet-<id>` immer am Blatt selbst, auch waehrend es laedt. Eine eigene Kennung eines Strangs (`m-options`, `m-account-credits-empty`, `m-account-session-expired`) sitzt am Rahmen darum. Wer die Groesse des Blatts misst, nimmt `m-sheet-<id>`.
- Einfahrt eines Blatts: solange das Blatt hereinfaehrt, traegt es `data-m-settling`, und sein Inhalt nimmt noch keine Tipps an. Ein Treiber wartet, bis das Attribut weg ist. Schliessen und der Hintergrund gehen sofort.
- Blaetter und Seiten unter dem obersten: `m-page-back-under`, `m-page-back-leaving`, `m-sheet-close-under-<n>`, `m-sheet-back-under-<n>`, `m-sheet-scrim-under-<n>`. Sie sind nicht bedienbar und gehoeren in kein Inventar.
- Griff des Blatts: `aria-hidden` und `data-m-decor`. Das Inventar laesst Elemente mit `data-m-decor` aus.
- Markdown: `m-md-code`, `m-md-code-copy`, `m-md-code-preview`, `m-md-link`.
- Attribute: `data-m-risk` (`paid`, `destructive`, `leaves-app` oder `sensor`, am bedienbaren Element selbst, geschrieben vom UI-Kit aus der Eigenschaft `risk`), `data-m-id` (feste Kennung eines Listeneintrags), `data-stacked` (ein `Segmented`, das seine Wahlen untereinander stellt), `data-place` am Toast (`top` auf Seiten mit Composer oder Fuss). Seit Runde 5: `data-m-field-group` (eine Seite fasst ein Feld und den Knopf darunter zusammen, beides bleibt bei offener Tastatur in Sicht) und `data-m-capped` (ein mehrzeiliges Feld, das gerade hoeher waere als sein Raum ueber der Tastatur: seine Hoehe ist begrenzt, der Text rollt im Feld. Wer die Hoehe eines Felds misst, liest das Attribut mit).
- Rueckfrage: `[role="alertdialog"]` mit `m-dialog-<name>`, darin `m-dialog-confirm` und `m-dialog-cancel`.
- Toast: `m-toast-<name>`.
- Reiter: `m-nav-chat`, `m-nav-create`, `m-nav-models`, `m-nav-settings` in `m-nav`.

Wo die Shell von der Regel oben abweicht, steht in `ABWEICHUNGEN.md`.

## Reservierte Woerter

Die Sperrliste (`lib/sperre.mjs`) erkennt diese Woerter als ganzen Abschnitt einer Kennung, auch ohne `data-m-risk`:

- kostenpflichtig: `generate`, `render`, `buy`, `send`, `download`, `transcribe`, `speak`, `speaking`, `train`, `enhance`, `improve`, `animate`, `extend`, `removebg`, `eraser`, `install`, `regenerate`, `mic`, `pay`, `invoice`, `plan`, `plans`, `run`, `test`, `preview`
- zerstoerend: `delete`, `signout`, `clear`, `reset`, `remove`, `forget`, `disconnect`, `wipe`, `withdraw`
- immer gesperrt: `m-dialog-confirm`, `m-fatal-reset*`, `m-account-signin`, `m-account-google`, `m-account-github`, `m-account-apple`

Ein Abschnitt wie `-cancel`, `-keep`, `-close`, `-error` oder `-screen` am Ende hebt die Sperre auf (der Ausweg aus einer Rueckfrage ist harmlos). Die Liste ist mit Absicht weit: Ein harmloser Knopf zu viel landet im Sweep unter "einzeln testen", ein Kauf zu wenig waere teuer.

## Welche Kennungen es gibt

Nicht mehr hier, sondern erzeugt:

- `TABELLE.md`: jede Route, jedes Blatt, jeder Tippweg und alle Kennungen je Strang, aus den Quellen der Shell gelesen (`npm run tabelle`).
- `flows/selektoren.mjs`: was die Fluesse davon benutzen. `npm run trocken` prueft jede Kennung dort gegen die Tabelle und gegen die Schnappschuesse der Vorschau.
- `ABWEICHUNGEN.md`: wo die Shell von der Regel abweicht.

Wer in der Shell eine Kennung umbenennt, laesst danach `npm run tabelle` und `npm run trocken` laufen. Der Trockenlauf nennt jede Stelle in den Fluessen, die dann ins Leere greift.

## Testhaken

Was sich von aussen nicht herstellen laesst, stellt die App im Abnahmebau selbst her: `window.__LU_TEST__`. Der Vertrag steht in der Shell, `src/mobile/dev/test-hook.ts` (Version 2, 08.10.2026). Es gibt das Objekt nur in einem Bau mit `VITE_LU_ABNAHME=1`, im Store-Paket fehlen Objekt und Datei. Der Rahmen spricht es ueber `lib/haken.mjs` an.

| Haken | Wirkung | Der Rahmen nutzt es fuer |
|---|---|---|
| `where()` | Flow, Reiter, Route, Parameter, offenes Blatt, `storePreset` (`open`, `play`, `appstore`), `account` (Zustand des Kontos als Wort, zum Beispiel `signed-in`, `signed-out`), alle Routen und Blaetter | Lage lesen, Preset und Anmeldung ohne Umweg ueber die Kontoseite |
| `go(pfad, params?)` | oeffnet eine Seite als Ausgangslage | Sweep, Aufnahme der Schnappschuesse |
| `openSheet(id, props?)`, `closeSheet()` | oeffnet oder schliesst ein Blatt | Sweep, Aufnahme |
| `setSettings(patch)`, `onboardingDone(bool)` | Einstellungen setzen, Onboarding als erledigt oder offen | Ausgangslage |
| `storePreset(preset, {reload})` | zeigt ein Store-Preset, bleibt ueber ein Neuladen | Altersabfrage je Preset |
| `geraet({ramBytes, freeBytes})`, `geraet(null)` | taeuscht ein Geraet vor: der Arbeitsspeicher erreicht die Passrechnung auf jedem Weg, offene Seiten fragen neu (Ereignis `lu-test-device`). `null` nimmt es zurueck | "Modell zu gross" auf einem grossen Testgeraet |
| `speicherVoll(bool)` | Die Geraeteauskunft meldet 0 Byte frei. Wirkt auf das, was die WebView fragt, NICHT auf die native Pruefung vor einem Download (die Antwort des Hakens nennt das in `nichtAuf`) | Fehlerfall 2 |
| `guthabenLeer(bool)` | Zaehler auf 0, die App bekommt das Ereignis "bezahlter Aufruf abgelehnt". Braucht eine Anmeldung | Fehlerfall 6 |
| `sitzungAblaufen()` | schreibt, was die Logik schreibt, wenn der Server das Token ablehnt. Braucht eine Anmeldung | Fehlerfall 7 |
| `speicherWarnung()` | meldet der App wenig Arbeitsspeicher (App-Ereignis, nicht die Warnung des Systems) | `lowMemory` auf iOS |

Jede Funktion antwortet mit `{ok: true, ...}` oder `{ok: false, reason}`. Ein Nein macht den Schritt "nicht pruefbar" mit dem Grund der App. Fehlt der Haken oder eine Funktion, ist der Schritt "offen" und kein Fehler.

Regel: Der Haken stellt Ausgangslagen her und liest Zustand. Was der Kunde tut, laeuft im Kundenfluss immer ueber echte Touches.

Seit Runde 16: `testData()` legt einmal je einen Eintrag ab, den eine Detailseite zeigt (Chat mit Antwort, Memory-Eintrag "Test memory entry", Workflow "Test workflow" mit zwei Schritten, Gruppe im Chat "Test group chat", Ergebnis `test-create-item` in der Galerie von Create als Bild in der Seite, ohne Cloud-Aufruf) und antwortet mit den Kennwerten. Der Rahmen oeffnet damit die Seite selbst statt der Ersatzseite (`tabelle/wege.mjs`, `DATEN_PARAMS` und `BLATT_DATEN`). Die Eintraege bleiben nach dem Lauf auf dem Geraet.

Was Version 2 nicht kann und der Rahmen braucht (Wunsch an die Shell):

- `netz(bool)`: nur iOS, schaltet die Rust-Seite und Hintergrund-Downloads offline. Der Treiber kann im Simulator nur die Anfragen der WebView sperren.
- `speicherVoll` vor einem Download: Der Download fragt die native Seite direkt (`checkDownloadSpace` in `src/api/discover.ts`, Aufruf in `screens/models/parts/start-download.ts`), und kein Skript der WebView kann diese Antwort faelschen. Ein voller Speicher vor einem Download ist nur mit einem vollen Speicher pruefbar. `flows/fehlerfaelle.mjs` meldet das als Fehler des Schritts und verwirft den Download.

Erledigt mit Version 2: `geraet(...)`, und `where()` nennt Store-Preset und Kontozustand.

## Umbenannt in Runde 2

- `m-settings-language` heisst `m-settings-voice` (Zeile E1.6 der Einstellungen, oeffnet `/settings/voice`). `flows/selektoren.mjs`, `flows/freigaben.mjs` und `tabelle/wege.mjs` sind nachgezogen.

## Neu in Runde 5

Die ganze Liste steht in `TABELLE.md` (neu erzeugt aus `mobile/r5-rest`). Hier, was die Fluesse und die Abnahme davon wissen muessen, nach den Notizen unter `mobile-docs/r5/`.

Modelle (`models.md`):

- `m-models-item-tools`, `m-models-detail-tools`: Marke "Tools" an Karte und Detailseite, auch an jeder anderen Packung eines Katalogmodells.
- `m-models-item-queued`: Zeile "Loads after <Name>" an der Karte, deren "Use in chat" vorgemerkt ist. `m-models-use` ist erst dann gesperrt.
- `m-models-item-waiting`: Zeile "Loading <Name>" an den anderen Karten, solange ein Modell laedt.
- Toasts: `m-toast-chat-model` (das Modell, bei dem der Nutzer landet), `m-toast-load-failed`.
- `m-models-detail-thinking` ist eine Marke, kein Schalter. Geschaltet wird in den Chat-Optionen (`m-options-thinking`).

Chat und Agent (`chat.md`, `models.md`):

- `m-chat-no-tool`: Zeile unter einer Agent-Antwort, die Suchergebnisse nennt, ohne dass ein Werkzeug lief.
- `m-chat-waits-for-document`: Hinweis in der Antwort, solange die Frage auf ein Dokument wartet. `m-chat-slot-turn`, `m-documents-slot-turn`: die Zeile dazu unter dem Kopf und auf der Dokumentseite.
- `m-documents-failed` mit `m-documents-retry` und `m-documents-failed-remove` (traegt `destructive`): ein Dokument, das nicht gelesen werden konnte. `m-documents-working-name`: Name der Datei in der Fortschrittszeile.
- Toasts: `m-toast-send-failed`, `m-toast-choose-model`, `m-toast-agent-turned-off`, `m-toast-document-duplicate`, `m-toast-document-failed`.
- Der Hinweis nach einem Abschuss (`m-app-resume`) nennt seinen Chat, wenn ein anderer Chat offen ist ("It belongs to another chat: <Titel>.").

Einstellungen und Remote:

- `m-toast-remote-still-offline`: Antwort auf "Try again" (`m-settings-remote-retry`), wenn der Desktop weiter schweigt.
- `m-remote-attach-camera`, `m-remote-attach-library`: ohne Chat gesperrt, mit Grund. Der Sweep fuehrt sie dann unter "uebersprungen".
- Mit `data-m-risk` seit Runde 5: `m-account-delete-website`, `m-account-reset-send`, `m-account-reset-again` (alle `destructive`), `m-cloud-open-account` (`paid`), `m-chat-mic` (`paid`), die vier Werkzeuge oben.

Neu in Runde 6 (`mobile-docs/r6/agent.md`):

- `m-chat-remembered`: Zeile unter einer Antwort auf eine Bitte, sich etwas zu merken. `data-state` ist `saved` ("Saved to Memory.") oder `nothing` (die Bitte nannte nichts). Keine Schaltflaeche.

Entwicklerseite (nur Vorschau, in keinem Inventar): `m-dev-ui-notes`, `m-dev-ui-long-notes` (Feld mit zwoelf Zeilen fuer die Pruefung der Hoehenbegrenzung).

Rahmen:

- `checks/persistenz.mjs` stellt als Einstellung den Schalter `m-settings-privacy-counter` um und danach zurueck (`config.mjs`, `persistenz.naht`).
- `flows/fehlerfaelle.mjs` bestaetigt beim Aufraeumen die Rueckfrage `m-dialog-download-cancel`.

## Neu in Runde 10 (`mobile-docs/r10/rest.md`)

Altersfrage (vor der Shell, Wort `age`, Android und iOS gleich):

- `m-age-no` speichert nichts mehr, sondern oeffnet die zweite Frage `m-age-confirm` ("You said you are under 18 ..."). `data-age` am Tor `m-age-gate` ist dann `confirm`.
- `m-age-confirm-back` ("Go back"): zurueck zur ersten Frage, nichts ist gespeichert.
- `m-age-confirm-minor` ("Yes, I am under 18"): erst diese Antwort speichert. Traegt `data-m-risk="destructive"`, weil sie sich auf dem Geraet nicht zuruecknehmen laesst; ein Fluss tippt sie nur ueber `tapBewusst` (`flows/alter.mjs`).
- Die Sperrseite `m-age-blocked` hat weiter keinen Knopf.

## Neu in 3.1.0: 3D in Create (Handy, nur LU Cloud)

Das Werkzeug `3d` steht als letztes in der Leiste (`m-create-tool-3d`, im Blatt `m-create-tools-3d`). Es erscheint nur, wenn der Katalog ein 3D-Modell fuehrt. Auf "My computer" gibt es 3D in v1 nicht.

- `m-create-3d-way` (Segmented) mit `m-create-3d-way-text`, `m-create-3d-way-image`, `m-create-3d-way-video`: der Weg. Die Zeile darum heisst `m-create-3d-way-row`.
- Weg Image: die Quelle wie bei jedem Werkzeug (`m-create-source`, `m-create-source-add`). Nimmt das Modell mehrere Seiten: `m-create-3d-sides` (`data-state` ist die Zahl der weiteren Seiten), `m-create-3d-side-add` (traegt `sensor`), `m-create-3d-side-remove`.
- Weg Video: `m-create-3d-video` mit `data-state` `empty`, `reading` oder `ready`; `m-create-3d-video-add` (traegt `sensor`), `m-create-3d-video-remove`, `m-create-3d-video-error`. Die Standbilder: `m-create-3d-frames` mit je `m-create-3d-frame` (`data-m-id` ist die Nummer des Moments, `aria-pressed` sagt, ob er gewaehlt ist). `data-m-picked` am Kasten nennt die gewaehlten Nummern. Das Video wird nie hochgeladen.
- Im Blatt "Add source" (`m-sheet-source`) beim Werkzeug 3D zusaetzlich `m-create-source-video` (traegt `sensor`).
- Detailstufe, wo das Modell eine hat: `m-create-3d-detail-card`, `m-create-3d-detail` (Segmented) mit `m-create-3d-detail-draft`, `m-create-3d-detail-standard`, `m-create-3d-detail-fine`.
- Sperrgrund ohne Video: `m-create-blocked` mit `data-m-reason="no-3d-video"`.
- Ergebnis auf der Buehne: `m-create-result` mit `data-m-kind="3d"`, darin `m-create-result-3d` mit dem 3D-Betrachter (`model-viewer`, `data-phase` `loading`, `ready`, `heavy`, `error` oder `no-webgl`; Leiste `model-viewer-bar` mit `mv-turn`, `mv-look-color`, `mv-look-clay`, `mv-look-wireframe`, `mv-backdrop`, `mv-reset`, `mv-fullscreen`, `mv-download`, Faktenzeile `model-viewer-facts`). Die Kennungen des Betrachters kommen aus `src/components/three` und folgen nicht dem Schema `m-*`.
- Grosser Blick (`/create/item/:id`): `m-create-item-3d` im `m-create-item-stage`. Speichern und Teilen gehen als `.glb` nach Files.
- Galerie: die Kachel `m-create-gallery-tile` mit `data-m-kind="3d"` zeigt `thumb-3d` (Standbild oder Wuerfel). Der Filter `m-create-gallery-filter-3d` erscheint nur, wenn die Galerie ein 3D-Modell hat.
