import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


LOCALE_ROOT = Path(__file__).resolve().parents[1]
MIGRATION_SCRIPT = LOCALE_ROOT / "migrate-source-translations.py"


def load_migration_module():
    spec = importlib.util.spec_from_file_location("migrate_source_translations", MIGRATION_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {MIGRATION_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


migration = load_migration_module()


class SourceMigrationTests(unittest.TestCase):
    def test_reviewed_override_beats_machine_suggestion(self):
        result = migration.migrate(
            legacy={"entries": {"設定": "환경 설정"}},
            overrides={"entries": {"設定": "설정"}},
            official={},
        )

        self.assertEqual(result.accepted["entries"]["設定"]["target"], "설정")
        self.assertEqual(result.accepted["entries"]["設定"]["status"], "reviewed")
        self.assertEqual(
            result.accepted["entries"]["設定"]["provenance"],
            "manual-reviewed-override",
        )
        self.assertEqual(result.suggestions["entries"]["設定"]["target"], "환경 설정")

    def test_machine_only_row_never_enters_accepted_map(self):
        result = migration.migrate(
            legacy={"entries": {"新增": "새 추가"}},
            overrides={"entries": {}},
            official={},
        )

        self.assertNotIn("新增", result.accepted["entries"])
        self.assertEqual(result.suggestions["entries"]["新增"]["status"], "suggested")

    def test_official_identity_has_highest_precedence(self):
        result = migration.migrate(
            legacy={"entries": {"傳奇": "레전드"}},
            overrides={"entries": {"傳奇": "전설"}},
            official={"傳奇": "고유"},
        )

        self.assertEqual(
            result.accepted["entries"]["傳奇"],
            {
                "target": "고유",
                "status": "official",
                "provenance": "official-runtime-identity",
                "formatSignature": [],
            },
        )

    def test_structural_alignment_records_current_baseline_provenance(self):
        alignment = migration.Alignment(
            path="host/ui.cpp",
            function="Draw",
            source="新增 %d",
            target="추가 %d",
            occurrence_index=2,
            line=9,
        )

        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[alignment],
        )

        self.assertEqual(
            result.accepted["entries"]["新增 %d"],
            {
                "target": "추가 %d",
                "status": "reviewed",
                "provenance": "current-ko-baseline",
                "formatSignature": ["%d"],
            },
        )

    def test_contexts_are_emitted_when_reviewed_targets_differ_by_function(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment("host/a.cpp", "DrawAtlas", "開啟", "아틀라스 열기", 0, 4),
                migration.Alignment("host/b.cpp", "DrawFile", "開啟", "파일 열기", 0, 7),
            ],
        )

        self.assertNotIn("開啟", result.accepted["entries"])
        self.assertEqual(
            [(row["path"], row["function"], row["target"]) for row in result.accepted["contexts"]],
            [
                ("host/a.cpp", "DrawAtlas", "아틀라스 열기"),
                ("host/b.cpp", "DrawFile", "파일 열기"),
            ],
        )

    def test_same_context_collision_blocks_acceptance(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment("host/a.cpp", "Draw", "開啟", "열기", 0, 4),
                migration.Alignment("host/a.cpp", "Draw", "開啟", "열어 보기", 1, 5),
            ],
        )

        self.assertNotIn("開啟", result.accepted["entries"])
        self.assertEqual(result.report["issues"][0]["code"], "ALIGNMENT_COLLISION")

    def test_alignment_requires_han_hangul_and_equal_format_signature(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment("host/a.cpp", "Draw", "設定 %d", "설정 %s", 0, 4),
                migration.Alignment("host/a.cpp", "Draw", "English", "영어", 1, 5),
                migration.Alignment("host/a.cpp", "Draw", "新增", "Add", 2, 6),
            ],
        )

        self.assertEqual(
            [row["code"] for row in result.report["issues"]],
            ["FORMAT_SIGNATURE_MISMATCH", "UPSTREAM_NOT_HAN", "CURRENT_NOT_HANGUL"],
        )
        self.assertEqual(result.report["counts"]["unmapped"], 2)
        self.assertEqual(result.accepted["entries"], {})

    def test_structural_token_alignment_survives_an_inserted_current_statement(self):
        upstream = (
            'void Draw(){ Label(u8"設定"); int keep = 1; Label(u8"新增 %d"); }'
        ).encode("utf-8")
        current = (
            'void Draw(){ Label(u8"설정"); Log("current-only"); int keep = 1; '
            'Label(u8"추가 %d"); }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(Path("host/ui.cpp"), upstream, current)

        self.assertEqual(issues, [])
        self.assertEqual(
            [(row.source, row.target, row.occurrence_index) for row in alignments],
            [("設定", "설정", 0), ("新增 %d", "추가 %d", 1)],
        )

    def test_occurrence_index_follows_source_order_across_structural_groups(self):
        upstream = (
            'void Draw(){ Label(u8"甲"); Count(u8"乙"); Label(u8"丙"); }'
        ).encode("utf-8")
        current = (
            'void Draw(){ Label(u8"갑"); Count(u8"을"); Label(u8"병"); }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/order.cpp"), upstream, current
        )

        self.assertEqual(issues, [])
        self.assertEqual(
            [(row.source, row.occurrence_index) for row in alignments],
            [("甲", 0), ("乙", 1), ("丙", 2)],
        )

    def test_class_initializer_does_not_duplicate_nested_function_literals(self):
        upstream = (
            'class Ui { const char* name = u8"類別"; '
            'void Draw(){ Label(u8"設定"); } };'
        ).encode("utf-8")
        current = (
            'class Ui { const char* name = u8"분류"; '
            'void Draw(){ Label(u8"설정"); } };'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/class.cpp"), upstream, current
        )

        self.assertEqual(issues, [])
        self.assertEqual(
            [(row.function, row.source, row.target) for row in alignments],
            [("", "類別", "분류"), ("Draw", "設定", "설정")],
        )

    def test_ambiguous_structural_block_is_reported_instead_of_inferred(self):
        upstream = 'void Draw(){ Label(u8"設定"); Label(u8"新增"); }'.encode("utf-8")
        current = 'void Draw(){ Label(u8"설정 및 추가"); }'.encode("utf-8")

        alignments, issues = migration.align_file_literals(Path("host/ui.cpp"), upstream, current)

        self.assertEqual(alignments, [])
        self.assertEqual([row["code"] for row in issues], ["AMBIGUOUS_ALIGNMENT"])
        self.assertEqual(issues[0]["sources"], ["設定", "新增"])

    def test_output_documents_are_canonical_sorted_schema_version_one(self):
        result = migration.migrate(
            legacy={
                "source": "legacy machine pass",
                "models": ["example/model"],
                "licenses": {"example/model": "CC-BY-4.0"},
                "entries": {"設定": "환경 설정", "新增": "새 추가"},
            },
            overrides={"entries": {"設定": "설정"}},
            official={"傳奇": "고유"},
        )

        self.assertEqual(result.accepted["schemaVersion"], 1)
        self.assertEqual(result.suggestions["schemaVersion"], 1)
        self.assertEqual(list(result.accepted["entries"]), ["傳奇", "設定"])
        self.assertEqual(list(result.suggestions["entries"]), ["新增", "設定"])
        self.assertEqual(result.suggestions["models"], ["example/model"])
        self.assertEqual(result.suggestions["licenses"], {"example/model": "CC-BY-4.0"})
        self.assertEqual(result.report["counts"]["suggested"], 2)

    def test_machine_cli_refuses_canonical_accepted_map_output(self):
        script = LOCALE_ROOT / "machine_translate_source_literals.py"
        with tempfile.TemporaryDirectory() as temporary:
            canonical = Path(temporary) / "source-translations.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "generate",
                    "--output",
                    str(canonical),
                ],
                cwd=LOCALE_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("refusing canonical accepted-map output", completed.stderr)
        self.assertFalse(canonical.exists())

    def test_json_writer_is_byte_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first.json"
            second = Path(temporary) / "second.json"
            document = {"schemaVersion": 1, "entries": {"設定": {"target": "설정"}}, "contexts": []}

            migration.write_json(first, document)
            migration.write_json(second, json.loads(first.read_text(encoding="utf-8")))

            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertTrue(first.read_bytes().endswith(b"\n"))


if __name__ == "__main__":
    unittest.main()
