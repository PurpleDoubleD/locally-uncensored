//! A process that does nothing but stay alive — the stand-in the sweep tests
//! need, and nothing else.
//!
//! ── Why this exists as a real binary ──
//!
//! `remote::kill_orphaned_tunnels` identifies a leftover tunnel by
//! `Process::name()` plus its argv, so the test that proves the scan is wired
//! to real data needs a live process that is genuinely NAMED `cloudflared`.
//! On macOS `name()` comes from the executed file, so the stand-in has to BE a
//! file with that name — a symlink reports the resolved target and a shebang
//! script reports its interpreter (`bash`).
//!
//! The obvious shortcut, a copy of `/bin/sh` renamed to `cloudflared`, is what
//! the test used until 01.09.2026, and it is a trap: `/bin/sh` is a SIP
//! platform binary, and macOS SIGKILLs a copy of one shortly after exec.
//! Measured over 15 spawns: it lived 95–486 ms and was then killed, every
//! single time — `sleep 30` was never reached. The test only ever passed
//! because it looked inside that window, and under load it did not, which is
//! the flake that cost a day to find.
//!
//! A binary the toolchain compiles here is ad-hoc/linker-signed rather than
//! platform-signed, so none of that applies: measured over 15 spawns, a copy
//! of this crate's own test binary ran past a second and exited normally every
//! time, with no SIGKILL at all. So the stand-in is compiled rather than
//! borrowed.
//!
//! ── Why stdin and not a sleep ──
//!
//! Blocking on stdin makes the lifetime the test's to decide: the process
//! lives exactly as long as the pipe is open, ends the moment the test drops
//! it, and there is no timer that could outlive a failing test or leave an
//! orphan behind. `read_line` returns `Ok(0)` on EOF, which is the normal way
//! this exits.
//!
//! ── Why an example and not a bin ──
//!
//! `cargo test` builds examples, so it is there whenever the tests are, but it
//! is NOT part of the application: `cargo build --release` does not build it,
//! and the Tauri bundler copies the app binary and the resources named in
//! `tauri.conf.json`, never `target/release/examples/`. Both checked.
//!
//! It takes arguments and ignores them. That is deliberate — the test passes
//! `--url http://127.0.0.1:<port>` so the process carries the argv a real
//! quick tunnel carries, which is the half of the matcher this stand-in is
//! for.

fn main() {
    let mut sink = String::new();
    // EOF (the test closing the pipe) or any read error ends the process.
    let _ = std::io::stdin().read_line(&mut sink);
}
