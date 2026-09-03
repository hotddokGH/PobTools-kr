import sys
import unittest
from pathlib import Path


LOCALE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCALE_ROOT))

from runtime_machine_state import has_unrestored_marker, resume_machine_fallback  # noqa: E402


class MachineFallbackResumeTests(unittest.TestCase):
    def test_inventory_extension_reuses_cached_rows_and_discards_stale_rows(self):
        inventory = {"sha256": "NEW", "entries": ["Existing", "Bad", "New"]}
        existing = {
            "inventorySha256": "OLD",
            "entries": {
                "Existing": "기존",
                "Bad": "ZXQPH 1 QXZ",
                "Stale": "오래됨",
            },
            "rejected": {"New": "format mismatch", "Stale": "old failure"},
        }

        entries, rejected, pending = resume_machine_fallback(inventory, existing)

        self.assertEqual(entries, {"Existing": "기존"})
        self.assertEqual(rejected, {"New": "format mismatch"})
        self.assertEqual(pending, ["Bad", "New"])

    def test_unrestored_machine_marker_is_detected_despite_spacing_or_case(self):
        self.assertTrue(has_unrestored_marker("앞 ZXQPH 12 qxz 뒤"))
        self.assertTrue(has_unrestored_marker("손상된 ZXQPH0QZ 표식"))
        self.assertFalse(has_unrestored_marker("정상 번역"))


if __name__ == "__main__":
    unittest.main()
