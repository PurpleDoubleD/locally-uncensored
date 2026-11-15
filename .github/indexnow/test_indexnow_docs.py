"""python3 -m unittest discover -s .github/indexnow -p 'test_indexnow_docs.py'"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import indexnow_docs as ix  # noqa: E402


class UrlFor(unittest.TestCase):
    def test_pages(self):
        self.assertEqual(ix.url_for("docs/index.html"), "https://locallyuncensored.com/")
        self.assertEqual(ix.url_for("docs/guide/index.html"), "https://locallyuncensored.com/guide/")
        self.assertEqual(ix.url_for("docs/guide/install/index.html"), "https://locallyuncensored.com/guide/install/")
        self.assertEqual(ix.url_for("docs/blog/x.html"), "https://locallyuncensored.com/blog/x.html")

    def test_not_pages(self):
        for p in ["docs/404.html", "docs/sitemap.xml", "docs/assets/a.css", "src/index.html", "docs/llms.txt"]:
            self.assertIsNone(ix.url_for(p), p)


class NameStatus(unittest.TestCase):
    def test_add_modify_delete_rename(self):
        present, gone = ix.parse_name_status(
            "A\tdocs/blog/new.html\nM\tdocs/index.html\nD\tdocs/blog/old.html\nR087\tdocs/a.html\tdocs/b.html\n"
        )
        self.assertEqual(present, ["docs/blog/new.html", "docs/index.html", "docs/b.html"])
        self.assertEqual(gone, ["docs/blog/old.html", "docs/a.html"])


class Collect(unittest.TestCase):
    def test_noindex_pages_stay_out_and_gone_pages_go_in(self):
        files = {
            "docs/blog/new.html": "<html><head><title>x</title></head></html>",
            "docs/hidden.html": '<html><head><meta name="robots" content="noindex"></head></html>',
            "docs/sitemap.xml": "<urlset/>",
        }
        urls = ix.collect(
            ["docs/blog/new.html", "docs/hidden.html", "docs/sitemap.xml"],
            ["docs/blog/old.html", "docs/blog/new.html"],
            files.__getitem__,
        )
        self.assertEqual(
            urls,
            ["https://locallyuncensored.com/blog/new.html", "https://locallyuncensored.com/blog/old.html"],
        )

    def test_body_names_the_served_key(self):
        b = ix.body(["https://locallyuncensored.com/"])
        self.assertEqual(b["host"], "locallyuncensored.com")
        self.assertEqual(b["keyLocation"], f"https://locallyuncensored.com/{ix.KEY}.txt")
        root = os.path.join(os.path.dirname(__file__), "..", "..", "docs", f"{ix.KEY}.txt")
        with open(root) as f:
            self.assertEqual(f.read().strip(), ix.KEY)


if __name__ == "__main__":
    unittest.main()
