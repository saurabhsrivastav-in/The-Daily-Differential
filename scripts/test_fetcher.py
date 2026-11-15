"""
Tiny offline self-checks for the fetcher's text helpers. No internet needed.
Run from the repository root:   python -m unittest scripts/test_fetcher.py -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_news as fn  # noqa: E402


class TextHelpers(unittest.TestCase):
    def test_html_to_text_strips_tags_and_scripts(self):
        raw = "<p>Hello <b>world</b></p><script>alert(1)</script><p>Bye</p>"
        self.assertEqual(fn.html_to_text(raw), "Hello world Bye")

    def test_sanitizer_removes_dangerous_and_noisy_markup(self):
        raw = ('<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> '
               '<a href="https://ok.example/x">good</a></p>'
               '<script>evil()</script><iframe src="//ad"></iframe>'
               '<figure><img src="p.png"><figcaption>cap</figcaption></figure><p>End</p>')
        out = fn.sanitize_html(raw)
        self.assertNotIn("script", out)
        self.assertNotIn("iframe", out)
        self.assertNotIn("onclick", out)
        self.assertNotIn("javascript:", out)
        self.assertNotIn("<img", out)
        self.assertNotIn("cap", out)  # figure dropped entirely
        self.assertIn('<a href="https://ok.example/x">good</a>', out)
        self.assertTrue(out.endswith("<p>End</p>"))

    def test_sanitizer_balances_tags(self):
        out = fn.sanitize_html("<p>one <em>two")
        self.assertEqual(out, "<p>one <em>two</em></p>")

    def test_summary_keeps_whole_sentences_within_budget(self):
        text = "First sentence is here. Second sentence follows it. Third sentence is long enough to overflow."
        s = fn.summarize(text, 9)
        self.assertEqual(s, "First sentence is here. Second sentence follows it.")

    def test_summary_trims_single_huge_sentence(self):
        s = fn.summarize("word " * 100, 10)
        self.assertTrue(s.endswith("…"))
        self.assertEqual(len(s.split()), 10)

    def test_article_id_is_stable(self):
        self.assertEqual(fn.article_id("https://a.b/c"), fn.article_id("https://a.b/c"))
        self.assertNotEqual(fn.article_id("https://a.b/c"), fn.article_id("https://a.b/d"))

    def test_keywords_count_distinct_stories(self):
        arts = [{"title": "Fintech regulation tightens", "summary": "Regulators eye fintech lending."},
                {"title": "New fintech rules announced", "summary": "Banks respond to the rules."},
                {"title": "Weather turns cold", "summary": "Snow expected."}]
        terms = [k["term"] for k in fn.top_keywords(arts)]
        self.assertIn("fintech", terms)

    def test_keyword_filter(self):
        art = {"title": "A talk on the immune system", "summary": ""}
        self.assertTrue(fn._matches_keywords(art, ["immune"]))
        self.assertFalse(fn._matches_keywords(art, ["economy"]))
        self.assertTrue(fn._matches_keywords(art, None))

    def test_medical_word_rotates(self):
        import datetime as dt
        a = fn.medical_word_of_the_day(dt.date(2026, 11, 14))["term"]
        b = fn.medical_word_of_the_day(dt.date(2026, 11, 15))["term"]
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
