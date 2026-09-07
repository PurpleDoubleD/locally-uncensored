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
auseinanderlaufen. Der richtige Weg ist, den Fall vorher zu erkennen und den
Updater erst gar nicht laufen zu lassen.

## 6. Was der Fix macht

`src-tauri/src/commands/install_method.rs` beantwortet die Frage, die das Plugin
nie stellt: wem gehoert die laufende Datei? Reine Funktion `detect(&Probes)`,
daneben `collect_probes()` mit den echten Aufrufen (`pacman -Qo`, `dpkg -S`,
`rpm -qf`, jeweils mit Deckel und ohne Panik, wenn das Programm fehlt).

Regeln, in dieser Reihenfolge:

| Lage | kind |
| --- | --- |
| `APPIMAGE` gesetzt | `appimage` |
| pacman besitzt die Datei | `pacman` |
| dpkg besitzt die Datei | `deb` |
| rpm besitzt die Datei | `rpm` |
| Datei unter `/usr`, kein Paketmanager meldet sich | `unknown` |
| sonst | `unknown` |

Der Store fragt vor dem Download. Bei `pacman` wird nichts geladen und nichts
installiert, stattdessen steht da, dass das AUR-Paket den Weg vorgibt. Bei `deb`
und `rpm` laeuft alles wie bisher, aber vor dem Klick steht, dass gleich das
System nach dem Passwort fragt und dass das nicht LU ist, das nach einem Login
fragt. Bei `appimage` ohne Schreibrecht am Ordner und bei `unknown` unter Linux
wird nicht installiert, sondern auf die Release-Seite verwiesen.

## Beweis

Nicht nur Unit-Tests. Die Erkennung lief in echten Containern gegen das echte
Binary aus dem echten 2.6.8-Deb, und zwar mit der Datei, die auch ausgeliefert
wird: `src-tauri/src/commands/install_method.rs`, md5
`afd6182b26fd77edf241f6e3ef724b34`, in jedem Container mit `md5sum` gegen den
Baum geprueft. Sie kompiliert mit blossem `rustc`, ohne cargo, ohne tauri, ohne
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
