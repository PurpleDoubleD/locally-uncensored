# Befund: was der Updater unter Linux wirklich tut

Anlass: ein Kunde auf Zen (Arch Linux, installiert ueber das AUR-Paket
`locally-uncensored-bin`) meldet: "auto update downloads the update, then asks
me for a password, I type my user password, then it fails."

Das AUR-Paket entpackt unser `.deb` nach `/usr`. Es pflegt ein Community-
Maintainer (Umar Alfarouk), es steht auf 2.6.7, und wir koennen es nicht selbst
aktualisieren.

Alle Zeilennummern unten sind aus dem Quelltext, der in diesem Baum wirklich
gebaut wird (`src-tauri/Cargo.lock`: tauri 2.10.3, tauri-utils 2.8.3,
tauri-plugin-updater 2.10.1).

Gelesene Dateien:

* `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-updater-2.10.1/src/updater.rs`
* `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-plugin-updater-2.10.1/src/lib.rs`
* `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-utils-2.8.3/src/platform.rs`
* `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-utils-2.8.3/src/lib.rs`

## 1. Wie der Installer-Typ bestimmt wird

Kurz: gar nicht zur Laufzeit. Der Typ ist eine Konstante, die beim Paketieren in
das Binary hineingeschrieben wird.

`updater.rs:1431` `installer_for_bundle_type(bundle: Option<BundleType>)` bildet
`BundleType` auf `Installer` ab (`Deb`, `Rpm`, `AppImage`, `Msi`, `Nsis`, `App`).
Die Quelle des `BundleType` ist `tauri::utils::platform::bundle_type`, importiert
in `updater.rs:32`.

`tauri-utils-2.8.3/src/platform.rs:349`:

    static mut __TAURI_BUNDLE_TYPE: &str = "__TAURI_BUNDLE_TYPE_VAR_UNK";

und `platform.rs:353` `pub fn bundle_type()` vergleicht genau diesen String
gegen `__TAURI_BUNDLE_TYPE_VAR_DEB`, `_RPM`, `_APP` (das ist AppImage), `_MSI`,
`_NSS`. Der Kommentar darueber sagt es selbst: "This is modified by binary
patching during build". Der Bundler schreibt also pro erzeugtem Artefakt einen
anderen String in dieselbe Stelle derselben Binary.

Damit ist die Antwort auf die Frage, welche Pruefung zwischen deb und rpm
entscheidet: **keine**. Es wird nicht nach `dpkg` gesucht, nicht nach `rpm`,
nicht nach `/etc/os-release`, nicht nach `pacman`. Auf einem System ganz ohne
`dpkg` und ohne `rpm` faellt die Entscheidung genauso aus wie auf Debian, denn
sie faellt gar nicht auf dem System, sondern in unserer Release-Pipeline.

Nur wenn der String unveraendert `..._UNK` ist, liefert `bundle_type()` `None`
(unter macOS ersatzweise `BundleType::App`).

AppImage ist der eine Sonderfall, bei dem zusaetzlich die Umgebung eine Rolle
spielt, aber nicht fuer die Typwahl, sondern fuer den Zielpfad:
`tauri-plugin-updater/src/lib.rs:102` liest `env.appimage` (gefuellt aus der
Variablen `APPIMAGE`, `tauri-utils/src/lib.rs:285`) und setzt damit
`executable_path`. Ohne `APPIMAGE` bleibt es bei `current_exe()`
(`updater.rs:317`). Unter Linux wird dieser Pfad unveraendert zum
`extract_path` (`updater.rs:320`), waehrend die anderen Plattformen noch das
Bundle darum herum suchen.

### Beweis am ausgelieferten Binary

Das echte 2.6.8-Deb, aus dem das AUR-Paket seinen Inhalt zieht:

    curl -sSL -o lu.deb https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v2.6.8/Locally.Uncensored_2.6.8_amd64.deb
    ar x lu.deb && mkdir root && tar -xzf data.tar.gz -C root
    strings -a root/usr/bin/locally-uncensored | grep -o '__TAURI_BUNDLE_TYPE_VAR_[A-Z]*'

Ausgabe:

    __TAURI_BUNDLE_TYPE_VAR_DEB

Das Binary, das das AUR-Paket nach `/usr/bin/locally-uncensored` legt, haelt sich
also auf Arch fuer eine Debian-Installation. Es ist dasselbe Binary, nur an einem
anderen Ort ausgepackt, und der Marker reist mit.

## 2. Welcher Schluessel aus latest.json gewaehlt wird

`updater.rs:568` `get_urls` sucht der Reihe nach:

1. `{os}-{arch}-{installer}` (nur wenn ein Installer bekannt ist,
   `updater.rs:584`)
2. `{os}-{arch}` (`updater.rs:586`)

`{installer}` ist der Name aus `Installer::name` (`updater.rs:59`): `appimage`,
`deb`, `rpm`, `app`, `msi`, `nsis`. Der Installer selbst kommt aus
`updater.rs:535`, also wieder aus dem eingebrannten Marker.

Unser `latest.json` (v2.6.8) bietet an:

    linux-x86_64          -> Locally.Uncensored_2.6.8_amd64.AppImage.tar.gz
    linux-x86_64-appimage -> Locally.Uncensored_2.6.8_amd64.AppImage
    linux-x86_64-deb      -> Locally.Uncensored_2.6.8_amd64.deb
    linux-x86_64-rpm      -> Locally.Uncensored-2.6.8-1.x86_64.rpm

Auf der AUR-Installation gewinnt darum `linux-x86_64-deb`. Der Kunde laedt ein
Debian-Paket auf ein Arch-System herunter. Der Download selbst gelingt, die
Signaturpruefung auch, denn das Paket ist echt und richtig signiert. Das ist
genau die Haelfte der Meldung, die funktioniert.

## 3. Was install() fuer deb und rpm macht, und woher das Passwort kommt

`updater.rs:968` `install_inner` (Linux-Zweig) verzweigt erneut ueber
`installer_for_bundle_type(bundle_type())`:

* `Some(Installer::Deb)` -> `install_deb` (`updater.rs:1049`)
* `Some(Installer::Rpm)` -> `install_rpm` (`updater.rs:1059`)
* alles andere -> `install_appimage` (`updater.rs:976`)

`install_deb` prueft mit `infer::archive::is_deb`, dass die Bytes wirklich ein
Deb sind, und ruft dann `updater.rs:1056`:

    self.try_tmp_locations(bytes, "dpkg", "-i", "deb")

`install_rpm` analog `updater.rs:1064` mit `("rpm", "-U", "rpm")`.

`try_tmp_locations` (`updater.rs:1067`) schreibt das Paket in das erste
Temp-Verzeichnis, das sich beschreiben laesst, und uebergibt an
`try_install_with_privileges` (`updater.rs:1106`). Dort stehen die drei
Passwortquellen, und zwar in dieser Reihenfolge:

1. `updater.rs:1113` `Command::new("pkexec").arg("dpkg").arg("-i").arg(pkg_path)`.
   pkexec ist der grafische polkit-Dialog. **Das ist die Passwortabfrage, die der
   Kunde sieht.** Sie kommt, bevor irgendjemand geprueft hat, ob `dpkg`
   ueberhaupt existiert.
2. `updater.rs:1148` `get_password_graphically`: `zenity --password`
   (`updater.rs:1150`), sonst `kdialog --password` (`updater.rs:1165`), und das
   Ergebnis geht an `install_with_sudo` (`updater.rs:1178`), das `sudo -S dpkg
   -i` das Passwort ueber stdin schiebt. **Das ist eine zweite Passwortabfrage.**
3. `updater.rs:1134` `Command::new("sudo").arg("dpkg")...` ohne Terminal.

Erst wenn alle drei fehlschlagen, kommt `Error::PackageInstallFailed`.

Auf Arch gibt es kein `dpkg`. Also:

* pkexec startet, polkit fragt nach dem Passwort, der Kunde tippt es ein,
  pkexec versucht `dpkg` zu starten und endet mit einem Fehlerstatus, weil das
  Programm nicht existiert. `status.success()` ist falsch, also geht es weiter.
* zenity oder kdialog fragt ein zweites Mal nach dem Passwort, `sudo -S dpkg -i`
  scheitert aus demselben Grund.
* `sudo dpkg -i` ohne tty scheitert auch.
* Der Store bekommt einen Fehler und zeigt "The update could not be installed."

Das deckt sich Wort fuer Wort mit der Meldung: der Download klappt, es wird nach
dem Passwort gefragt, das Passwort ist richtig, und trotzdem schlaegt es fehl.
Das Passwort war nie das Problem. Es fehlt nur das Programm, das danach laufen
sollte, und auf Arch waere es auch das falsche: selbst mit `dpkg` installiert
haette `dpkg -i` an der pacman-Datenbank vorbei in `/usr` geschrieben.

## 4. AppImage in einem Verzeichnis ohne Schreibrecht

`install_appimage` (`updater.rs:976`) arbeitet direkt auf `extract_path`, und das
ist bei einem AppImage der Pfad aus `APPIMAGE`, also die `.AppImage`-Datei
selbst (`lib.rs:102`). Der Ablauf:

1. Es sucht ein Temp-Verzeichnis auf demselben Geraet wie die Datei
   (`st_dev`-Vergleich). Findet es keines, endet es mit
   `Error::TempDirNotOnSameMountPoint` (`updater.rs:1046`).
2. `updater.rs:1003` `std::fs::rename(&self.extract_path, tmp_app_image)`
   schiebt die laufende AppImage als Sicherung weg.
3. Danach wird die neue AppImage an die alte Stelle geschrieben und die alten
   Rechte werden gesetzt.

Liegt die AppImage in einem Verzeichnis, das dem Nutzer nicht gehoert, etwa
`/opt`, scheitert schon Schritt 2 mit `EACCES`, denn `rename` braucht
Schreibrecht am **Verzeichnis**, nicht an der Datei. Der Fehler geht ueber `?`
nach oben und wird zu "The update could not be installed". Kein pkexec, kein
sudo, keine Passwortabfrage: dieser Pfad versucht nie, sich Rechte zu holen.
Deshalb ist "es fragt nach dem Passwort" ein zuverlaessiges Zeichen dafuer, dass
der deb- oder rpm-Zweig gelaufen ist, nicht der AppImage-Zweig.

## 5. Fazit fuer den Zen-Fall

1. AUR entpackt unser Deb nach `/usr`. Das Binary traegt weiter
   `__TAURI_BUNDLE_TYPE_VAR_DEB`.
2. Der Updater haelt sich fuer eine Deb-Installation, waehlt
   `linux-x86_64-deb` und laedt das Deb.
3. `install()` ruft `pkexec dpkg -i`. polkit fragt nach dem Passwort.
4. `dpkg` gibt es auf Arch nicht. Alle drei Rechte-Wege scheitern, zwei davon
   nach einer Passworteingabe.
5. Der Nutzer sieht: Download ok, Passwort ok, Installation kaputt.

Ein Fix im Updater-Plugin ist nicht moeglich, ohne das Plugin zu forken, und er
waere auch falsch: auf einer pacman-Installation darf LU sich gar nicht selbst
ueberschreiben, weil dann die Paketdatenbank und die Dateien auf der Platte
auseinanderlaufen. Der Weg ist, den Fall vorher zu erkennen (Abschnitt 6) und
dann an der Paketdatenbank vorbei eine eigene AppImage ins Heimverzeichnis zu
legen, die niemandem sonst gehoert (Abschnitt 7).

## 6. Was der Fix macht

`src-tauri/src/commands/install_method.rs` beantwortet die Frage, die das
Plugin nie stellt: wem gehoert die laufende Datei? Reine Funktion
`detect(&Probes)`, daneben `collect_probes()` mit den echten Aufrufen
(`pacman -Qo`, `dpkg -S`, `rpm -qf`, jeweils mit Deckel und ohne Panik, wenn
das Programm fehlt).

Regeln, in dieser Reihenfolge:

| Lage | kind |
| --- | --- |
| `APPIMAGE` gesetzt | `appimage` |
| pacman besitzt die Datei | `pacman` |
| dpkg besitzt die Datei | `deb` |
| rpm besitzt die Datei | `rpm` |
| Datei unter `/usr`, kein Paketmanager meldet sich | `unknown` |
| sonst | `unknown` |

## 7. Loesung: LU zieht sich selbst um

Die erste Fassung dieses Fixes hat auf `pacman`, `unknown` und der AppImage
ohne Schreibrecht gar nichts geladen und stattdessen einen Hinweis angezeigt
("update ueber deinen AUR-Helper", "das System fragt gleich nach dem
Passwort"). Der Chef hat das verworfen, und zwar zu Recht: der Kunde soll den
Update-Knopf druecken und fertig sein. Ein Hinweistext ist kein Update.

Ausgeliefert wird darum Selbstheilung. `src-tauri/src/commands/self_migrate.rs`
(reine Logik, kein tauri) und `self_migrate_cmd.rs` (HTTP, Konfiguration,
Fortschrittsereignisse).

### Wer welchen Weg nimmt

`self_migrate::migrates_itself(kind, exe_dir_writable)`:

| Lage | Weg |
| --- | --- |
| `appimage` in beschreibbarem Ordner | Plugin, in place, unveraendert |
| `deb`, `rpm` | Plugin, `pkexec dpkg -i` / `rpm -U`, ohne Zusatztext |
| `msi` | Plugin, Windows-Installer |
| `pacman` | LU installiert sich selbst |
| `unknown` unter Linux | LU installiert sich selbst |
| `appimage` ohne Schreibrecht am Ordner | LU installiert sich selbst |

Die Frontend-Seite (`installsItself` in `src/stores/updateStore.ts`) haengt
noch `isLinux()` davor: ein `.app` unter `/Applications` meldet ebenfalls
`unknown`, und dort funktioniert das Plugin.

### Was der Eigenbau tut

1. `latest.json` von denselben Endpunkten wie das Plugin
   (`tauri.conf.json`, `plugins.updater.endpoints`, Platzhalter werden
   ersetzt), Eintrag `platforms["linux-x86_64-appimage"]`.
2. Download nach `<XDG_DATA_HOME>/locally-uncensored/` in
   `Locally.Uncensored.AppImage.part`, Fortschritt alle 512 KB als Ereignis
   `update-migration`.
3. Signaturpruefung mit `minisign-verify` und dem `pubkey` aus derselben
   `tauri.conf.json`, also genau die Pruefung aus
   `tauri-plugin-updater-2.10.1/src/updater.rs`, `verify_signature`. Faellt sie
   durch, wird die Datei geloescht und der Fehler (englisch) gemeldet.
4. `chmod 755`, dann `rename` auf `Locally.Uncensored.AppImage`. Gleicher
   Ordner, also atomar.
5. `<XDG_DATA_HOME>/applications/Locally Uncensored.desktop` mit `Exec` auf die
   AppImage, Name und Icon wie im Deb. Der Dateiname ist buchstabengleich mit
   dem aus `usr/share/applications`, denn XDG sucht nach Dateinamen und nur ein
   gleicher Name im Heimverzeichnis ueberdeckt den Systemeintrag, statt einen
   zweiten Menueeintrag danebenzustellen. Icons werden aus `$APPDIR`, sonst aus
   `XDG_DATA_DIRS`, sonst aus `/usr/share` in den eigenen hicolor-Baum kopiert,
   danach `update-desktop-database` (Fehler egal).
6. Start der neuen AppImage abgekoppelt, danach beendet die Oberflaeche die
   laufende App ueber `exit_app`.

Punkt 6 hat einen Haken, den man nur einmal uebersieht: LU laeuft mit
`tauri-plugin-single-instance`. Eine zweite Instanz mit derselben Kennung
findet die laufende, holt deren Fenster nach vorn und beendet sich. Die neue
AppImage waere also sofort wieder weg. `self_migrate::relaunch_script` startet
deshalb ueber `setsid sh -c` einen Helfer, der auf das Verschwinden unserer PID
wartet (Deckel 20 Sekunden) und danach die AppImage exect. `APPIMAGE`,
`APPDIR`, `OWD` und `ARGV0` werden aus seiner Umgebung entfernt, sonst erbt die
neue Instanz die Pfade der alten.

Ab dem naechsten Update ist die Lage die gewoehnliche: `APPIMAGE` zeigt in das
Heimverzeichnis, der Ordner ist beschreibbar, `detect()` sagt `appimage` und
`migrates_itself` sagt nein. Das Plugin tauscht die Datei wieder selbst.

### Oberflaeche

Keine eigene. Derselbe Download-Knopf, derselbe Neustart-Knopf, derselbe
Fortschrittsbalken. Die drei kurzen Schritte nach dem Download haben keine
Prozentzahl und schreiben stattdessen ihren Namen in dieselbe Zeile ("Checking
the signature", "Putting the new version in place", "Starting the new
version"). Status `unavailable`, `updateBlockedBecause`, der Passworthinweis
und das Feld `hint` sind samt Oberflaeche geloescht.

## 8. Beweis der Erkennung

Nicht nur Unit-Tests. Die Erkennung lief in echten Containern gegen das echte
Binary aus dem echten 2.6.8-Deb, und zwar mit der Datei, die auch ausgeliefert
wird: `src-tauri/src/commands/install_method.rs`, md5
`afd6182b26fd77edf241f6e3ef724b34`, in jedem Container mit `md5sum` gegen den
Baum geprueft. Diese Fassung hat inzwischen `hint_for` und `is_under_usr`
verloren, weil die Oberflaeche nichts mehr erklaert; die Laeufe in Abschnitt 9
pruefen die aktuelle Datei (md5 `1d5ddd6212bf0b34465cd55ad4d0da79`). Sie kompiliert mit blossem `rustc`, ohne cargo, ohne tauri, ohne
serde. Daneben liegt nur `probe_main.rs`, ein Dutzend Zeilen Ausgabe, das die
Datei per `#[path]` einbindet.

Docker auf dem Mac (29.5.3, colima), Container als `linux/amd64` unter
Emulation.

### Vorbereitung auf dem Mac

    curl -sSL -o lu.deb https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v2.6.8/Locally.Uncensored_2.6.8_amd64.deb
    ar x lu.deb && mkdir root && tar -xzf data.tar.gz -C root
    strings -a root/usr/bin/locally-uncensored | grep -o '__TAURI_BUNDLE_TYPE_VAR_[A-Z]*'
    __TAURI_BUNDLE_TYPE_VAR_DEB

    docker create --platform linux/amd64 --name lu-arch archlinux:latest sleep 7200
    docker cp lu.deb        lu-arch:/root/lu.deb
    docker cp install_method.rs lu-arch:/root/install_method.rs
    docker cp probe_main.rs lu-arch:/root/probe_main.rs
    docker cp PKGBUILD      lu-arch:/root/PKGBUILD
    docker start lu-arch

`pacman` braucht in diesem Container `--disable-sandbox`, sonst bricht es mit
`error restricting syscalls via seccomp: 22` ab. Das ist die Emulation, nicht
pacman.

### a) Arch, Lauf 1: das Deb einfach nach / entpackt

    docker exec lu-arch bash /root/arch.sh

    ### uname: x86_64
    ### os: NAME="Arch Linux"
    ### rustc: rustc 1.98.1 (48a229cea 2026-09-01) (Arch Linux rust 1:1.98.1-1)
    --- what landed in /usr/bin:
    /usr/bin/locally-uncensored
    /usr/bin/lu-llama-server
    -rwxr-xr-x 1 root root 16398304 Sep  6 20:10 /usr/bin/locally-uncensored
    --- the bundle-type marker the tauri bundler patched in:
    __TAURI_BUNDLE_TYPE_VAR_DEB
    --- pacman -Qo says:
    error: No package owns /usr/bin/locally-uncensored
    (pacman -Qo exit 1)
    --- detect():
    exe_path         = /usr/bin/locally-uncensored
    appimage_env     = None
    exe_dir_writable = true
    has_pacman       = true
    has_dpkg         = false
    has_rpm          = false
    pacman_owns_exe  = false
    dpkg_owns_exe    = false
    rpm_owns_exe     = false
    DETECT           = unknown
    HINT             = /usr/bin/locally-uncensored is in the system folders and no package manager claims it. It was installed by a repackaged build or a script.

Die Schritte davor waren `bsdtar -xf lu.deb` und `bsdtar -xzf data.tar.gz -C /`,
also genau das, was `package()` im PKGBUILD tut, nur ohne pacman drumherum. Der
Marker im Binary sagt weiter DEB, obwohl kein dpkg auf der Maschine ist.

### b) Arch, Lauf 2: als echtes pacman-Paket, der Zen-Fall

    docker exec lu-arch bash /root/arch2.sh

Gebaut mit `makepkg --nodeps --skipinteg` als unprivilegierter Nutzer aus dem
PKGBUILD des AUR-Maintainers (2.6.7, laedt sein Deb selbst von GitHub),
installiert mit `pacman -U --overwrite '*'` ueber die Dateien aus Lauf 1.

    ==> Finished making: locally-uncensored-bin 2.6.7-1
    --- makepkg built:
    -rw-r--r-- 1 builder builder 23755608 Sep  7 23:04 /home/builder/build/locally-uncensored-bin-2.6.7-1-x86_64.pkg.tar.zst
    --- pacman -Qo says:
    /usr/bin/locally-uncensored is owned by locally-uncensored-bin 2.6.7-1
    --- the marker is still the deb one:
    __TAURI_BUNDLE_TYPE_VAR_DEB
    --- detect():
    exe_path         = /usr/bin/locally-uncensored
    appimage_env     = None
    exe_dir_writable = true
    has_pacman       = true
    has_dpkg         = false
    has_rpm          = false
    pacman_owns_exe  = true
    dpkg_owns_exe    = false
    rpm_owns_exe     = false
    DETECT           = pacman
    HINT             = Installed with pacman. Update it with your package manager, for example yay -Syu locally-uncensored-bin.

Das ist der Fall des Kunden, und die Datei traegt dabei weiter den DEB-Marker,
den das Plugin liest.

**Nebenbefund am PKGBUILD.** Die Kopie, die uns vorliegt, baut so nicht durch:

    ==> Starting package()...
    mv: cannot stat '/home/builder/build/pkg/locally-uncensored-bin/usr/bin/llama-server': No such file or directory
    ==> ERROR: A failure occurred in package().

Das 2.6.7-Deb legt `usr/bin/lu-llama-server` ab, nicht `usr/bin/llama-server`,
und die Zeile, die den Sidecar aus `/usr/bin` herausschiebt, findet ihre Datei
darum nicht. Fuer den Beweislauf wurde genau diese eine Zeile in ein
`if [ -e ... ]` gefasst, im PKGBUILD als Aenderung markiert; an der
Besitzfrage aendert die Verschiebung nichts. Ob der Maintainer inzwischen eine
andere Fassung veroeffentlicht hat, ist von hier aus nicht zu sehen. Wenn
nicht, baut sein Paket aktuell nicht, und das erklaert auch, warum es auf 2.6.7
steht.

### c) Ubuntu 22.04: unser Deb, mit dpkg installiert

    docker create --platform linux/amd64 --name lu-ubuntu ubuntu:22.04 sleep 7200
    docker cp lu.deb install_method.rs probe_main.rs ubuntu.sh lu-ubuntu:/root/
    docker start lu-ubuntu && docker exec lu-ubuntu bash /root/ubuntu.sh

    ### os: Ubuntu 22.04.5 LTS
    ### rustc: rustc 1.75.0 (82e1608df 2023-12-21) (built from a source tarball)
    Setting up locally-uncensored (2.6.8) ...
    -rwxr-xr-x 1 root root 16398304 Sep  6 20:10 /usr/bin/locally-uncensored
    --- dpkg -S says:
    locally-uncensored: /usr/bin/locally-uncensored
    --- detect():
    exe_path         = /usr/bin/locally-uncensored
    appimage_env     = None
    exe_dir_writable = true
    has_pacman       = false
    has_dpkg         = true
    has_rpm          = false
    pacman_owns_exe  = false
    dpkg_owns_exe    = true
    rpm_owns_exe     = false
    DETECT           = deb
    HINT             = Installed with dpkg. Installing the update runs a package install, and the system asks for your password.

Die Abhaengigkeiten (webkit2gtk, gtk3, libvulkan1) fehlen im nackten Container,
darum lief `dpkg --force-depends -i`. Fuer die Besitzfrage spielt das keine
Rolle: die Datei steht in der dpkg-Datenbank.

### d) AppImage in /opt ohne Schreibrecht

Im selben Ubuntu-Container, als unprivilegierter Nutzer, `chmod 555` auf dem
Ordner:

    su tester -c 'APPIMAGE=/opt/lu-readonly/x.AppImage /tmp/probe'

    dr-xr-xr-x 2 root root 4096 Sep  7 23:02 /opt/lu-readonly
    exe_path         = /opt/lu-readonly/x.AppImage
    appimage_env     = Some("/opt/lu-readonly/x.AppImage")
    exe_dir_writable = false
    has_pacman       = false
    has_dpkg         = true
    has_rpm          = false
    pacman_owns_exe  = false
    dpkg_owns_exe    = false
    rpm_owns_exe     = false
    DETECT           = appimage
    HINT             = The AppImage sits in a folder you cannot write to (/opt/lu-readonly/x.AppImage).

`exe_dir_writable` wird nicht aus Rechte-Bits geraten, sondern durch einen
Schreibversuch beantwortet, der die Probendatei danach wieder wegraeumt. Genau
das braucht der Updater an dieser Stelle: sein erster Schritt ist ein `rename`
IN diesen Ordner (`updater.rs:1003`).

### Was der Beweis nicht zeigt

Es lief kein echtes Update auf einer echten Arch-Maschine mit Desktop, weil hier
weder eine solche Maschine noch ein polkit-Dialog zur Verfuegung steht. Der Weg
von `pkexec` bis zum Fehlschlag ist aus dem Quelltext gelesen (Abschnitt 3) und
mit der Fehlerbeschreibung des Kunden abgeglichen, nicht nachgestellt. Was
gemessen wurde, ist die Frage, an der der Fix haengt: wem gehoert die Datei, und
was antwortet `detect()` darauf.


## 9. Beweis der Selbstheilung

Zweiter Lauf, 08.09.2026, im selben Aufbau: Docker auf dem Mac (colima,
`macOS Virtualization.Framework`, Gast `aarch64`), Container `archlinux:latest`
als `linux/amd64`, also unter `qemu-x86_64`.

Getestet werden die ausgelieferten Dateien, unveraendert. Der Container baut
sie mit cargo (`--offline`, Kisten vorher mit `cargo vendor` mitgegeben), drei
Kisten: serde_json, minisign-verify, base64. Daneben liegt nur ein `main.rs`
mit den Unterbefehlen `detect`, `migrate` und `launch`, das nichts entscheidet.
Am Anfang jedes Laufs steht `md5sum`:

    1d5ddd6212bf0b34465cd55ad4d0da79  src/commands/install_method.rs
    5cce6c52ba71684b754e1c09e8b24aff  src/commands/self_migrate.rs
    92d791fa837357611f55f5076537aea4  src/app_identity.rs
    46cb22874e67cf71def3f5a46b192ec4  src/os_error.rs

### a) Die Signatur, gegen die echte 2.6.8-AppImage

Auf dem Mac, als Test im Baum (`the_real_appimage_is_accepted_and_one_flipped_byte_is_not`,
laeuft nur mit `LU_APPIMAGE_FIXTURE`, sonst uebersprungen):

    accepted 112871928 bytes from ".../Locally.Uncensored_2.6.8_amd64.AppImage"
    refused after flipping byte 56435964: the signature does not match the
      downloaded file: The signature verification failed

Datei und Signatur sind die echten: die AppImage von GitHub, die Signatur aus
`platforms["linux-x86_64-appimage"]` in `latest.json`, der Schluessel aus
`tauri.conf.json`.

### b) Der Zen-Fall, echtes AUR-Paket

`makepkg --nodeps --skipinteg` aus dem PKGBUILD des AUR-Maintainers (2.6.7,
laedt sein Deb selbst von GitHub), installiert mit
`pacman -U --disable-sandbox --nodeps --overwrite '*'`. Die `mv`-Zeile fuer den
Sidecar ist wie in der Nacht in ein `if` gefasst, sonst bricht `package()` ab
(Nebenbefund in Abschnitt 8b); an der Besitzfrage aendert das nichts.

    /usr/bin/locally-uncensored is owned by locally-uncensored-bin 2.6.7-1
    __TAURI_BUNDLE_TYPE_VAR_DEB
    LU starting version="2.6.7"

    exe_path         = /usr/bin/locally-uncensored
    has_pacman       = true
    has_dpkg         = false
    pacman_owns_exe  = true
    DETECT           = pacman
    MIGRATES_ITSELF  = true

Das Binary aus dem Deb startet in diesem Container wirklich (die Zeile
`LU starting version="2.6.7"` kommt aus dem Programm) und bricht danach ab,
weil kein Display da ist.

### c) Die Migration, als gewoehnlicher Nutzer

    --- gate
    DETECT           = pacman
    MIGRATES_ITSELF  = true
    --- manifest
    version          = 2.6.8
    url              = https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v2.6.8/Locally.Uncensored_2.6.8_amd64.AppImage
    --- signature
    bytes            = 112871928
    VERIFY           = accepted
    --- placed
    appimage         = /home/builder/.local/share/locally-uncensored/Locally.Uncensored.AppImage
    staged_gone      = true
    desktop_file     = /home/builder/.local/share/applications/Locally Uncensored.desktop
    icon             = /home/builder/.local/share/icons/hicolor/32x32/apps/locally-uncensored.png
    icon             = /home/builder/.local/share/icons/hicolor/128x128/apps/locally-uncensored.png
    icon             = /home/builder/.local/share/icons/hicolor/256x256@2/apps/locally-uncensored.png
    icon             = /home/builder/.local/share/icons/hicolor/512x512/apps/locally-uncensored.png
    --- after
    DETECT           = appimage
    exe_dir_writable = true
    MIGRATES_ITSELF  = false

    -rwxr-xr-x 1 builder builder 112871928 Locally.Uncensored.AppImage

Die vier Icons stammen aus `/usr/share/icons/hicolor`, also aus dem, was das
AUR-Paket hinterlassen hat. `MIGRATES_ITSELF = false` in der letzten Zeile ist
die Zusage fuer das naechste Update: ab hier macht es wieder das Plugin.

### d) Der Menueeintrag gewinnt gegen den des Pakets

Beide Dateien liegen da, und die XDG-Reihenfolge entscheidet nach Dateinamen:

    WINS:      /home/builder/.local/share/applications/Locally Uncensored.desktop
    absent:    /usr/local/share/applications/Locally Uncensored.desktop
    shadowed:  /usr/share/applications/Locally Uncensored.desktop

    Exec=locally-uncensored                                              (Paket)
    Exec="/home/builder/.local/share/locally-uncensored/Locally.Uncensored.AppImage"  (unserer)

`update-desktop-database` hat daneben die `mimeinfo.cache` geschrieben.

### e) Die neue AppImage ist die echte 2.6.8

`--appimage-extract` laeuft in diesem Container NICHT:

    cannot execute binary file: Exec format error

Der Grund liegt nicht an der Datei, sondern am Aufbau: der Container ist
`linux/amd64` unter `qemu-x86_64` auf einem Apple-Silicon-Mac, und die
AppImage-Laufzeit ist `static-pie` gelinkt, was diese Emulation nicht startet
(`file`: "ELF 64-bit LSB pie executable, x86-64, static-pie linked"). Dynamisch
gelinkte x86-64-Programme laufen sehr wohl, siehe b).

Der Inhalt wurde darum ohne Ausfuehren geholt, mit `unsquashfs` am Versatz aus
dem ELF-Kopf (`e_shoff + e_shentsize * e_shnum`, dasselbe, was
`--appimage-offset` ausrechnet):

    squashfs offset = 944632
    unsquashfs_exit=0
    AppRun  AppRun.wrapped  Locally Uncensored.desktop  locally-uncensored.png  usr
    usr/bin: locally-uncensored  lu-llama-server

    /tmp/x/root/usr/bin/locally-uncensored --version
    LU starting version="2.6.8"

    xvfb-run -a ./AppRun --version
    LU starting version="2.6.8"
    [Python] Resolved: /usr/sbin/python3
    [Ollama] Starting...

Mit Bildschirm startet die entpackte 2.6.8 also durch bis zum Hochfahren ihrer
eigenen Dienste.

### f) Der Neustart wartet auf das Ende der alten Instanz

Ohne dieses Warten wuerde Single-Instance die neue Instanz sofort wieder
beenden. Beweis mit einem Platzhalter fuer die neue Version (ein Skript, das
einen Zeitstempel schreibt) und einem alten Prozess, der 25 Sekunden lebt:

    the old process:              pid 11519
    launched
    11529  1  11529  /usr/bin/qemu-x86_64 /usr/sbin/sh sh -c n=0; while [ $n -lt 200 ] && kill -0 11519 2>/dev/null; do sleep 0.1; n=$((n+1)); done; exec '/home/builder/new-version.sh'
    after 3 s, old process alive: yes, new version started: no
    3 s after it ended:           old process alive: no, new version started: yes

Die Spalten sind pid, ppid, pgid: der Helfer haengt an 1 und hat eine eigene
Prozessgruppe, `setsid` hat also gegriffen. Und er startet die neue Version
genau dann, wenn die alte weg ist, nicht vorher.

### Was dieser Beweis nicht zeigt

* Kein Klick auf einer echten Arch-Maschine mit Desktop. Was hier lief, ist die
  Logik der beiden Befehle, nicht die Oberflaeche darum herum; die haengt an
  den Vitest-Tests (`update-installiert-sich-auf-arch-selbst`,
  `das-update-zeigt-den-schritt-statt-eines-hinweises`).
* Die AppImage-Datei selbst wurde im Container nicht gestartet (Abschnitt e).
  Bewiesen ist ihr Inhalt und dass er unter xvfb hochfaehrt, nicht der Start
  ueber die AppImage-Laufzeit.
* Der Download laeuft im Container nicht ueber `self_migrate_cmd.rs`, weil der
  Teil tauri braucht. Die AppImage wurde auf dem Mac von GitHub geladen und in
  den Container kopiert; die Signaturpruefung im Container hat sie danach als
  echt angenommen.
