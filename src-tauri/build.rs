//! Build script.
//!
//! Besides Tauri's own codegen this assembles the mobile client page from
//! `mobile-client/` into `OUT_DIR`, where `commands/remote.rs` picks it up
//! with `include_str!`.
//!
//! Two properties matter more than the assembly itself, and both are why the
//! step lives here rather than in an npm script somebody has to remember:
//!
//!   * **It cannot be skipped.** `cargo build` needs the file that this
//!     produces; without the step there is nothing to embed and the compile
//!     fails at the `include_str!`.
//!   * **It cannot go stale.** The output is written into `OUT_DIR`, never
//!     into the repository, so there is no older copy to fall back to, and
//!     cargo re-runs this script whenever `mobile-client/` or any file in it
//!     changes. A broken source aborts the build with the reason; it never
//!     leaves the previous page in place and carries on.

#[path = "src/mobile_page.rs"]
mod mobile_page;

fn main() {
    emit_mobile_client_page();
    tauri_build::build()
}

fn emit_mobile_client_page() {
    let dir = mobile_page::client_dir();

    // The directory is on the watch list next to the individual files so that
    // a NEW source — one that `SOURCES` does not know about yet — still
    // triggers a re-run, and the ledger test in `mobile_page` gets to fail.
    println!("cargo:rerun-if-changed={}", dir.display());
    for name in mobile_page::SOURCES {
        println!("cargo:rerun-if-changed={}", dir.join(name).display());
    }

    let page = match mobile_page::assemble(&dir) {
        Ok(page) => page,
        Err(why) => panic!(
            "the mobile client page could not be assembled from {}:\n\n{why}\n\n\
             That page is what a paired phone receives. Building without it \
             would ship whatever the last successful build produced, so the \
             build stops here instead.",
            dir.display()
        ),
    };

    let out_dir = std::env::var_os("OUT_DIR").expect("cargo did not set OUT_DIR");
    let out = std::path::Path::new(&out_dir).join(mobile_page::EMBED_NAME);
    if let Err(e) = std::fs::write(&out, page) {
        panic!("could not write the mobile client page to {}: {e}", out.display());
    }
}
