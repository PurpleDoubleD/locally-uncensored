<!--
The head of every release page (funnel 3.1.0, Nr. 7). Paste it above the
notes of a release that is created by hand. A release that the release
workflow creates gets the same text from `releaseBody` in
.github/workflows/release.yml; src/lib/__tests__/mac-release-lane.test.ts
keeps the two the same. Drop the macOS paragraph when the release has no
.dmg, and the Android one when it has no .apk.
-->
## Which file do I need?

**Windows 10 and 11:** the file ending in `_x64-setup.exe`. The `.msi` is the same app for a system wide install.

**Linux:** the `.AppImage` runs on most distributions: make it executable (`chmod +x`) and start it. The `.deb` is for Ubuntu and Debian, the `.rpm` for Fedora.

**macOS (Apple Silicon only, macOS 14 or newer):** the `.dmg`. Open it and drag LU to Applications. The app is signed with an Apple Developer ID and notarized by Apple. Intel Macs are not supported.

**Android 7.0 or newer (arm64):** the file ending in `-Android.apk`. Allow installs from your browser or file app when Android asks.

The other files (`.sig`, `.zip`, `.tar.gz`, `.cdx.json`, `latest.json`) are for the automatic update and for checks. You do not need them.

**Windows shows "Windows protected your PC"?** The installer has no code signing certificate yet, so SmartScreen does not know it. Click **More info**, then **Run anyway**. It is built by GitHub Actions from the public source: [how to check it](https://github.com/PurpleDoubleD/locally-uncensored/blob/master/SECURITY.md#antivirus--browser-false-positives).

**No GPU, or a model too big for yours?** Run it in LU Cloud from the same app: a credit pack for €15 with no subscription, or Hosted for €19 a month. [Plans and packs](https://lu-labs.ai/pricing?src=github&utm_source=github&utm_medium=release)

> All versions are portable-friendly, no admin rights required. LU by LU Labs.
