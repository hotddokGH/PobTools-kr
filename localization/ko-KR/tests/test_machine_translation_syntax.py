import sys
import unittest
from pathlib import Path


LOCALE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCALE_ROOT))

from runtime_machine_syntax import (  # noqa: E402
    apply_source_glossary,
    apply_source_scoped_replacements,
    format_signature,
    protect_syntax,
    protect_with_numeric_markers,
    restore,
    restore_numeric_markers,
)


class MachineTranslationSyntaxTests(unittest.TestCase):
    def test_korean_term_cleanup_is_scoped_by_english_source(self):
        rules = [
            ("Ailment", "질병", "상태 이상"),
            ("Unique Enemy", "독특한 적", "고유 적"),
        ]

        self.assertEqual(
            apply_source_scoped_replacements("More Ailment Duration", "질병 지속시간 증폭", rules),
            "상태 이상 지속시간 증폭",
        )
        self.assertEqual(
            apply_source_scoped_replacements("Disease Vector", "질병 매개", rules),
            "질병 매개",
        )

    def test_source_glossary_is_enforced_on_translated_output(self):
        translated = "지원되는 Skills Reserve Life instead of Mana and Energy Shield"

        normalized = apply_source_glossary(
            translated,
            {"Skills": "스킬", "Life": "생명력", "Mana": "마나", "Energy Shield": "에너지 보호막"},
        )

        self.assertEqual(normalized, "지원되는 스킬 Reserve 생명력 instead of 마나 and 에너지 보호막")

    def test_format_specifier_placeholder_is_protected_and_validated(self):
        source = "Drenched Enemies apply {:+d}% and {}% to Resistances"

        masked, tokens = protect_syntax(source)

        self.assertIn("{:+d}", tokens)
        self.assertIn("{}", tokens)
        self.assertIn("{:+d}", restore(masked, tokens))
        self.assertEqual(format_signature(source), ["SLOT:{:+d}", "SLOT:{}"])
        self.assertNotEqual(format_signature(source), format_signature(source.replace("{:+d}", "")))

    def test_numeric_markers_round_trip_multiple_placeholders_and_newlines(self):
        source = "Deals {0}% more Damage\nBuff lasts {1:+d} seconds"

        masked, tokens = protect_with_numeric_markers(source)

        self.assertNotIn("{0}", masked)
        self.assertNotIn("\n", masked)
        restored = restore_numeric_markers(masked, tokens)
        self.assertIn("{0}", restored)
        self.assertIn("{1:+d}", restored)
        self.assertEqual(format_signature(restored), format_signature(source))

    def test_numeric_markers_protect_official_glossary_terms(self):
        masked, tokens = protect_with_numeric_markers(
            "Spend Life and Mana before Energy Shield",
            glossary={"Life": "생명력", "Mana": "마나", "Energy Shield": "에너지 보호막"},
        )

        restored = restore_numeric_markers(masked, tokens)
        self.assertNotIn("Life", restored)
        self.assertNotIn("Mana", restored)
        self.assertNotIn("Energy Shield", restored)
        self.assertIn("생명력", restored)
        self.assertIn("마나", restored)
        self.assertIn("에너지 보호막", restored)


if __name__ == "__main__":
    unittest.main()
