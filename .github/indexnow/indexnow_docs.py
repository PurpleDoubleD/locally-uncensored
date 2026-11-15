#!/usr/bin/env python3
"""Tell IndexNow which pages of locallyuncensored.com a push changed.

The site is GitHub Pages from master:/docs. IndexNow is the protocol Bing,
Yandex, Seznam and Naver share for "this URL is new, changed or gone, come
and look". Google does not take it; for Google the sitemap and Search Console
stay the way.

Run by .github/workflows/indexnow.yml on every push to master that touches
docs/. It maps the changed .html files of the push to their public URLs,
waits until GitHub Pages serves the new version of one of them, and submits
the list once. Deleted and renamed-away pages go in too: the engines recrawl,
see the 404 and drop them.

The key is public by design: the protocol proves ownership by serving it at
https://locallyuncensored.com/<key>.txt (docs/). Never rotate it.

Only the standard library, so the workflow needs no install step.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOST = "locallyuncensored.com"
KEY = "64c8084e74dd0e16c6152f82363537ad"
KEY_LOCATION = f"https://{HOST}/{KEY}.txt"
ENDPOINT = "https://api.indexnow.org/indexnow"
MAX_URLS = 10_000
ZERO_SHA = "0" * 40
# Pages that are not meant to be found.
SKIP = {"docs/404.html"}


def url_for(path: str) -> str | None:
    """docs/blog/x.html -> https://host/blog/x.html, docs/guide/index.html -> https://host/guide/"""
    if not path.startswith("docs/") or not path.endswith(".html") or path in SKIP:
        return None
    rel = path[len("docs/"):]
    if rel == "index.html":
        rel = ""
    elif rel.endswith("/index.html"):
        rel = rel[: -len("index.html")]
    return f"https://{HOST}/{rel}"


def parse_name_status(text: str) -> tuple[list[str], list[str]]:
    """git diff --name-status output -> (paths that exist after the push, paths that are gone)."""
    present: list[str] = []
    gone: list[str] = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0]
        if status.startswith("R"):  # rename: old path gone, new path present
            gone.append(parts[1])
            present.append(parts[2])
        elif status.startswith("C"):
            present.append(parts[2])
        elif status == "D":
            gone.append(parts[1])
        else:  # A, M, T
            present.append(parts[1])
    return present, gone


def is_noindex(html: str) -> bool:
    head = html.split("</head>", 1)[0].lower()
    return 'name="robots"' in head and "noindex" in head


def collect(present: list[str], gone: list[str], read) -> list[str]:
    """Public URLs to submit. `read(path)` returns the file at the pushed commit."""
    urls: list[str] = []
    for path in present:
        url = url_for(path)
        if url and not is_noindex(read(path)):
            urls.append(url)
    for path in gone:
        url = url_for(path)
        if url:
            urls.append(url)
    seen: set[str] = set()
    return [u for u in urls if not (u in seen or seen.add(u))][:MAX_URLS]


def body(urls: list[str]) -> dict:
    return {"host": HOST, "key": KEY, "keyLocation": KEY_LOCATION, "urlList": urls}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def changed_paths(before: str, after: str) -> tuple[list[str], list[str]]:
    base = before
    if not base or base == ZERO_SHA or subprocess.run(
        ["git", "cat-file", "-e", f"{base}^{{commit}}"], capture_output=True
    ).returncode != 0:
        base = f"{after}^"
    return parse_name_status(git("diff", "--name-status", "-M", base, after, "--", "docs/"))


def wait_until_live(url: str, expected: bytes, timeout_s: int) -> bool:
    """GitHub Pages builds after the push; submit only once the new file is served."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "lu-indexnow"})
            with urllib.request.urlopen(req, timeout=20) as res:
                if res.read() == expected:
                    return True
        except urllib.error.URLError:
            pass
        time.sleep(15)
    return False


def submit(urls: list[str]) -> int:
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body(urls)).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status
    except urllib.error.HTTPError as err:
        print(f"IndexNow answered HTTP {err.code}: {err.read()[:300]!r}", file=sys.stderr)
        return err.code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", default="")
    ap.add_argument("--after", default="HEAD")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--wait", type=int, default=600, help="seconds to wait for GitHub Pages")
    args = ap.parse_args()

    present, gone = changed_paths(args.before, args.after)
    urls = collect(present, gone, lambda p: git("show", f"{args.after}:{p}"))
    if not urls:
        print("No public page changed, nothing to submit.")
        return 0
    print(f"{len(urls)} URL(s):", *urls, sep="\n  ")
    if args.dry_run:
        print(json.dumps(body(urls), indent=2))
        return 0

    probe = next((p for p in present if url_for(p)), None)
    if probe and args.wait > 0:
        expected = subprocess.run(["git", "show", f"{args.after}:{probe}"], check=True, capture_output=True).stdout
        if wait_until_live(url_for(probe), expected, args.wait):
            print(f"Live: {url_for(probe)}")
        else:
            print(f"::warning::{url_for(probe)} not live after {args.wait}s, submitting anyway")

    status = submit(urls)
    print(f"IndexNow HTTP {status}")
    return 0 if status in (200, 202) else 1


if __name__ == "__main__":
    sys.exit(main())
