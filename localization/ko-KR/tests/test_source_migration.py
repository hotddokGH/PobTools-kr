import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


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
    CORRECTED_LOCALIZED_COMMIT = "2997715df0d6257192107d799a9f414b54e6c02b"
    CORRECTED_LOCALIZED_TREE = "6c113669065ed84d160fb186ce3dfa2701e839cb"

    def align_real_file(self, relative: str):
        upstream = migration._git_bytes(
            ["show", f"{migration.PINNED_UPSTREAM}:pob-zh-engine/{relative}"]
        )
        current = (migration.REPOSITORY_ROOT / "pob-zh-engine" / relative).read_bytes()
        return migration.align_file_literals(Path(relative), upstream, current)

    def context_inventory(self, path: str, upstream_rows, current_rows):
        def literals(rows):
            occurrence_by_function = {}
            result = []
            for index, (function, text) in enumerate(rows):
                occurrence_index = occurrence_by_function.get(function, 0)
                occurrence_by_function[function] = occurrence_index + 1
                result.append(
                    migration.Literal(
                        path,
                        index,
                        index + 1,
                        text,
                        "u8",
                        function,
                        index + 1,
                        occurrence_index,
                    )
                )
            return result

        return {path: (literals(upstream_rows), literals(current_rows))}

    def write_stable_evidence_fixture(self, root: Path) -> tuple[Path, Path, Path, Path]:
        english = root / "English.json"
        korean = root / "Korean.json"
        manifest = root / "manifest.json"
        accepted = root / "accepted.json"
        english_rows = [{"Id": "one", "Name": "One"}, {"Id": "two", "Name": "Two"}]
        korean_rows = [{"Id": "one", "Name": "하나"}, {"Id": "two", "Name": "둘"}]
        english.write_text(json.dumps(english_rows), encoding="utf-8")
        korean.write_text(json.dumps(korean_rows, ensure_ascii=False), encoding="utf-8")
        manifest.write_text(
            json.dumps(
                {
                    "patch": "3.29.3.2",
                    "table": "Fixture",
                    "clientEvidence": {
                        "detectedPatch": "3.29.3.2",
                        "matchesExportPatch": True,
                    },
                    "inputs": {
                        "englishRows": 2,
                        "koreanRows": 2,
                        "stableIds": 2,
                        "englishSha256": hashlib.sha256(english.read_bytes()).hexdigest().upper(),
                        "koreanSha256": hashlib.sha256(korean.read_bytes()).hexdigest().upper(),
                    },
                    "counts": {"accepted": 2},
                }
            ),
            encoding="utf-8",
        )
        accepted.write_text(
            json.dumps(
                {
                    "patch": "3.29.3.2",
                    "table": "Fixture",
                    "join": "Id",
                    "rows": [
                        {"id": "one", "english": "One", "korean": "하나"},
                        {"id": "two", "english": "Two", "korean": "둘"},
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return manifest, english, korean, accepted

    def write_runtime_identity_fixture(
        self, root: Path
    ) -> tuple[Path, Path, Path, dict[str, str]]:
        report_root = root / "reports" / "official-terms"
        accepted_reports = {
            "BaseItemTypes": report_root / "accepted.json",
            "ActiveSkills": report_root / "tables" / "ActiveSkills" / "accepted.json",
            "PassiveSkills": report_root / "tables" / "PassiveSkills" / "accepted.json",
            "MonsterVarieties": report_root / "tables" / "MonsterVarieties" / "accepted.json",
            "ClientStrings": report_root / "tables" / "ClientStrings" / "accepted.json",
            "ClientStrings2": report_root / "tables" / "ClientStrings2" / "accepted.json",
            "stat-descriptions": report_root / "stat-descriptions" / "accepted.json",
            "unique-items": report_root / "unique-items" / "accepted.json",
            "mod-names": report_root / "mod-names" / "accepted.json",
        }
        for name, path in accepted_reports.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            rows = []
            if name == "BaseItemTypes":
                rows = [
                    {
                        "id": "Metadata/Items/Scarabs/ScarabAbyssNew1",
                        "english": "Abyss Scarab",
                        "korean": "심연 갑충석",
                    }
                ]
            path.write_text(
                json.dumps({"patch": migration.OFFICIAL_PATCH, "rows": rows}, ensure_ascii=False),
                encoding="utf-8",
            )

        runtime_root = root / "pob-zh-engine" / "dist" / "Data" / "poe1"
        for locale in ("zh-rTW", "ko-KR"):
            locale_root = runtime_root / locale
            locale_root.mkdir(parents=True, exist_ok=True)
            for dictionary in migration.DICTIONARIES:
                entries = {}
                if dictionary == "items":
                    entries = {
                        "Abyss Scarab": (
                            "聖甲蟲：深淵" if locale == "zh-rTW" else "심연 갑충석"
                        )
                    }
                (locale_root / f"{dictionary}.json").write_text(
                    json.dumps({"entries": entries}, ensure_ascii=False),
                    encoding="utf-8",
                )

        provenance_path = root / "reports" / "display-closure" / "provenance.json"
        provenance_path.parent.mkdir(parents=True, exist_ok=True)
        provenance_path.write_text(
            json.dumps(
                {
                    "patch": migration.OFFICIAL_PATCH,
                    "dictionaries": {
                        **{dictionary: {} for dictionary in migration.DICTIONARIES},
                        "items": {
                            "Abyss Scarab": {
                                "layer": "official-exact",
                                "source": (
                                    "BaseItemTypes:"
                                    "Metadata/Items/Scarabs/ScarabAbyssNew1"
                                ),
                            }
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        trusted_hashes = {
            dictionary: hashlib.sha256(
                (runtime_root / "zh-rTW" / f"{dictionary}.json").read_bytes()
            ).hexdigest().upper()
            for dictionary in migration.DICTIONARIES
        }
        return (
            runtime_root / "ko-KR" / "items.json",
            runtime_root / "zh-rTW" / "items.json",
            provenance_path,
            trusted_hashes,
        )

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
            [
                (row["path"], row["function"], row["occurrenceIndex"], row["target"])
                for row in result.accepted["contexts"]
            ],
            [
                ("host/a.cpp", "DrawAtlas", 0, "아틀라스 열기"),
                ("host/b.cpp", "DrawFile", 0, "파일 열기"),
            ],
        )

    def test_same_source_contexts_are_sorted_and_preserve_automatic_indexes(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment("host/a.cpp", "Draw", "設定", "둘째 설정", 2, 8),
                migration.Alignment("host/a.cpp", "Draw", "設定", "첫 설정", 0, 4),
            ],
        )

        self.assertEqual(result.report["issues"], [])
        self.assertEqual(
            [
                (row["path"], row["function"], row["source"], row["occurrenceIndex"], row["target"])
                for row in result.accepted["contexts"]
            ],
            [
                ("host/a.cpp", "Draw", "設定", 0, "첫 설정"),
                ("host/a.cpp", "Draw", "設定", 2, "둘째 설정"),
            ],
        )

    def test_same_context_collision_blocks_acceptance(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment("host/a.cpp", "Draw", "開啟", "열기", 0, 4),
                migration.Alignment("host/a.cpp", "Draw", "開啟", "열어 보기", 0, 5),
            ],
        )

        self.assertNotIn("開啟", result.accepted["entries"])
        self.assertEqual(result.report["issues"][0]["code"], "ALIGNMENT_COLLISION")

    def test_failed_occurrence_is_not_hidden_by_a_global_candidate(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[
                migration.Alignment(
                    "host/known.cpp", "Draw", "發現新賽季天賦樹 ",
                    "새 시즌 패시브 트리 ", 0, 4,
                ),
            ],
            alignment_issues=[
                {
                    "code": "UNMAPPED_ALIGNMENT",
                    "path": "host/unknown.cpp",
                    "function": "Check",
                    "line": 8,
                    "occurrenceIndex": 0,
                    "source": "發現新賽季天賦樹 ",
                    "currentCandidates": [],
                }
            ],
        )

        self.assertNotIn("發現新賽季天賦樹 ", result.accepted["entries"])
        self.assertEqual(
            [
                (row["path"], row["function"], row["occurrenceIndex"], row["target"])
                for row in result.accepted["contexts"]
            ],
            [("host/known.cpp", "Draw", 0, "새 시즌 패시브 트리 ")],
        )
        self.assertEqual(
            [row["code"] for row in result.report["issues"]],
            ["UNMAPPED_ALIGNMENT"],
        )

    def test_distinct_multi_source_issues_are_fully_resolved_by_exact_contexts(self):
        path = "host/a.cpp"
        upstream = 'void Draw(){ Label(u8"設定"); Label(u8"更新"); }'.encode("utf-8")
        current = 'void Draw(){ Label(u8"설정 및 업데이트"); }'.encode("utf-8")
        _, alignment_issues = migration.align_file_literals(
            Path(path), upstream, current
        )
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "設定",
                        "target": "설정",
                        "occurrenceIndex": 0,
                    },
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "更新",
                        "target": "업데이트",
                        "occurrenceIndex": 1,
                    },
                ],
            },
            official={},
            alignment_issues=alignment_issues,
            context_inventories=self.context_inventory(
                path,
                [("Draw", "設定"), ("Draw", "更新")],
                [("Draw", "설정"), ("Draw", "업데이트")],
            ),
        )

        self.assertEqual(result.report["issues"], [])
        self.assertEqual(result.report["counts"]["unmapped"], 0)

    def test_same_source_multi_issue_keeps_only_unreviewed_index_blocking(self):
        path = "host/a.cpp"
        upstream = (
            'void Draw(){ Label(u8"設定"); Log("trace"); Label(u8"設定"); }'
        ).encode("utf-8")
        current = 'void Draw(){ Label(u8"설정"); }'.encode("utf-8")
        _, alignment_issues = migration.align_file_literals(
            Path(path), upstream, current
        )
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "設定",
                        "target": "설정",
                        "occurrenceIndex": 0,
                    }
                ],
            },
            official={},
            alignment_issues=alignment_issues,
            context_inventories=self.context_inventory(
                path,
                [("Draw", "設定"), ("Draw", "trace"), ("Draw", "設定")],
                [("Draw", "설정")],
            ),
        )

        self.assertEqual(
            [
                (row["code"], row["source"], row["occurrenceIndex"])
                for row in result.report["issues"]
            ],
            [("AMBIGUOUS_ALIGNMENT", "設定", 2)],
        )
        self.assertEqual(result.report["counts"]["ambiguous"], 1)

    def test_same_source_multi_issue_is_clean_when_both_indexes_are_reviewed(self):
        path = "host/a.cpp"
        upstream = (
            'void Draw(){ Label(u8"設定"); Log("trace"); Label(u8"設定"); }'
        ).encode("utf-8")
        current = 'void Draw(){ Label(u8"설정 및 환경 설정"); }'.encode("utf-8")
        _, alignment_issues = migration.align_file_literals(
            Path(path), upstream, current
        )
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "設定",
                        "target": "설정",
                        "occurrenceIndex": 0,
                    },
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "設定",
                        "target": "환경 설정",
                        "occurrenceIndex": 2,
                    },
                ],
            },
            official={},
            alignment_issues=alignment_issues,
            context_inventories=self.context_inventory(
                path,
                [("Draw", "設定"), ("Draw", "trace"), ("Draw", "設定")],
                [("Draw", "설정"), ("Draw", "환경 설정")],
            ),
        )

        self.assertEqual(result.report["issues"], [])
        self.assertEqual(result.report["counts"]["ambiguous"], 0)

    def test_explicit_reviewed_context_resolves_one_failed_occurrence(self):
        source = "發現新賽季天賦樹 "
        path = "host/passive_tree_update.cpp"
        function = "PassiveTreeUpdater::doCheck"
        upstream_rows = [(function, f"非目標{index}") for index in range(7)] + [
            (function, source)
        ]
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": "host/passive_tree_update.cpp",
                        "function": "PassiveTreeUpdater::doCheck",
                        "source": source,
                        "target": "새 시즌 패시브 스킬 트리 ",
                        "occurrenceIndex": 7,
                    }
                ],
            },
            official={},
            alignments=[
                migration.Alignment(
                    "host/timeless_jewel_ui.cpp",
                    "Frame",
                    source,
                    "새 시즌 패시브 트리 ",
                    3,
                    440,
                )
            ],
            alignment_issues=[
                {
                    "code": "UNMAPPED_ALIGNMENT",
                    "path": "host/passive_tree_update.cpp",
                    "function": "PassiveTreeUpdater::doCheck",
                    "line": 340,
                    "occurrenceIndex": 7,
                    "source": source,
                    "currentCandidates": [],
                }
            ],
            context_inventories=self.context_inventory(
                path,
                upstream_rows,
                [(function, "새 시즌 패시브 스킬 트리 ")],
            ),
        )

        self.assertEqual(
            [
                (
                    row["path"],
                    row["function"],
                    row["occurrenceIndex"],
                    row["target"],
                    row["provenance"],
                )
                for row in result.accepted["contexts"]
            ],
            [
                (
                    "host/passive_tree_update.cpp",
                    "PassiveTreeUpdater::doCheck",
                    7,
                    "새 시즌 패시브 스킬 트리 ",
                    "manual-reviewed-context",
                ),
                (
                    "host/timeless_jewel_ui.cpp",
                    "Frame",
                    3,
                    "새 시즌 패시브 트리 ",
                    "current-ko-baseline",
                ),
            ],
        )

    def test_validated_supporting_context_can_override_an_official_global_at_one_identity(self):
        path = "host/supporting.cpp"
        function = "Draw"
        source = "地圖階級"
        target = "지도 등급"
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": function,
                        "source": source,
                        "occurrenceIndex": 0,
                        "target": target,
                        "components": [{"source": source, "target": target}],
                    }
                ],
            },
            official={source: "지도 레벨"},
            alignments=[
                migration.Alignment(path, function, source, target, 0, 1)
            ],
            context_inventories={
                path: (
                    migration.source_overlay.scan_cpp_literals(
                        Path(path), f'void Draw() {{ Label(u8"{source}"); }}'.encode()
                    ),
                    migration.source_overlay.scan_cpp_literals(
                        Path(path), f'void Draw() {{ Label(u8"{target}"); }}'.encode()
                    ),
                )
            },
            validated_reflow_contexts=frozenset({(path, function, source, 0)}),
            validated_official_contexts=frozenset({(path, function, source, 0)}),
        )

        self.assertEqual([], result.report["issues"])
        self.assertEqual(target, result.accepted["contexts"][0]["target"])
        self.assertEqual(
            [{"source": source, "target": target}],
            result.accepted["contexts"][0]["components"],
        )
        self.assertEqual(result.report["issues"], [])

    def test_reviewed_context_without_inventory_path_is_rejected(self):
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": "host/not-real.cpp",
                        "function": "NotReal",
                        "source": "任意來源",
                        "target": "임의 대상",
                        "occurrenceIndex": 0,
                    }
                ],
            },
            official={},
        )

        self.assertEqual(result.accepted["contexts"], [])
        self.assertEqual(
            [row["code"] for row in result.report["issues"]],
            ["INVALID_REVIEWED_CONTEXT_PATH"],
        )

    def test_reviewed_context_requires_exact_function_source_and_occurrence(self):
        path = "host/a.cpp"
        inventory = self.context_inventory(
            path,
            [("Draw", "設定")],
            [("Draw", "설정")],
        )
        cases = [
            ("Missing", "設定", 0, "INVALID_REVIEWED_CONTEXT_FUNCTION"),
            ("Draw", "不存在", 0, "INVALID_REVIEWED_CONTEXT_SOURCE"),
            ("Draw", "設定", 1, "INVALID_REVIEWED_CONTEXT_SOURCE"),
        ]
        for function, source, occurrence_index, expected_code in cases:
            with self.subTest(function=function, source=source, occurrence=occurrence_index):
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={
                        "entries": {},
                        "contexts": [
                            {
                                "path": path,
                                "function": function,
                                "source": source,
                                "target": "설정",
                                "occurrenceIndex": occurrence_index,
                            }
                        ],
                    },
                    official={},
                    context_inventories=inventory,
                )

                self.assertEqual(result.accepted["contexts"], [])
                self.assertEqual(
                    [row["code"] for row in result.report["issues"]],
                    [expected_code],
                )

    def test_reviewed_context_uses_carried_index_for_same_named_functions(self):
        path = "host/overloads.cpp"
        upstream = [
            migration.Literal(path, 0, 1, "設定", "u8", "Draw", 1, 0),
            migration.Literal(path, 2, 3, "更新", "u8", "Draw", 2, 0),
        ]
        current = [
            migration.Literal(path, 0, 1, "설정", "u8", "Draw", 1, 0),
            migration.Literal(path, 2, 3, "업데이트", "u8", "Draw", 2, 0),
        ]

        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": "Draw",
                        "source": "更新",
                        "target": "업데이트",
                        "occurrenceIndex": 0,
                    }
                ],
            },
            official={},
            context_inventories={path: (upstream, current)},
        )

        self.assertEqual(result.report["issues"], [])
        self.assertEqual(
            [(row["source"], row["occurrenceIndex"], row["target"]) for row in result.accepted["contexts"]],
            [("更新", 0, "업데이트")],
        )

    def test_reviewed_context_target_must_be_unique_actual_hangul_literal(self):
        path = "host/a.cpp"
        base = {
            "path": path,
            "function": "Draw",
            "source": "設定",
            "occurrenceIndex": 0,
        }
        cases = [
            (
                "없는 대상",
                [("Draw", "설정")],
                "INVALID_REVIEWED_CONTEXT_TARGET",
            ),
            (
                "設定",
                [("Draw", "設定")],
                "CURRENT_NOT_HANGUL",
            ),
            (
                "설정",
                [("Draw", "설정"), ("Draw", "설정")],
                "AMBIGUOUS_REVIEWED_CONTEXT_TARGET",
            ),
        ]
        for target, current_rows, expected_code in cases:
            with self.subTest(target=target, expected_code=expected_code):
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={"entries": {}, "contexts": [{**base, "target": target}]},
                    official={},
                    context_inventories=self.context_inventory(
                        path, [("Draw", "設定")], current_rows
                    ),
                )

                self.assertEqual(result.accepted["contexts"], [])
                self.assertEqual(
                    [row["code"] for row in result.report["issues"]],
                    [expected_code],
                )

    def test_reviewed_context_rejects_absolute_and_traversal_paths(self):
        unsafe_paths = [
            "../host/a.cpp",
            "host/../a.cpp",
            "/host/a.cpp",
            "C:/host/a.cpp",
        ]
        for path in unsafe_paths:
            with self.subTest(path=path):
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={
                        "entries": {},
                        "contexts": [
                            {
                                "path": path,
                                "function": "Draw",
                                "source": "設定",
                                "target": "설정",
                                "occurrenceIndex": 0,
                            }
                        ],
                    },
                    official={},
                    context_inventories=self.context_inventory(
                        path, [("Draw", "設定")], [("Draw", "설정")]
                    ),
                )

                self.assertEqual(result.accepted["contexts"], [])
                self.assertEqual(
                    [row["code"] for row in result.report["issues"]],
                    ["INVALID_REVIEWED_CONTEXT_PATH"],
                )

    def test_duplicate_and_conflicting_reviewed_contexts_block_identity(self):
        path = "host/a.cpp"
        base = {
            "path": path,
            "function": "Draw",
            "source": "設定",
            "target": "설정",
            "occurrenceIndex": 0,
        }
        for rows in ([base, dict(base)], [base, {**base, "target": "환경 설정"}]):
            with self.subTest(rows=rows):
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={"entries": {}, "contexts": rows},
                    official={},
                    context_inventories=self.context_inventory(
                        path,
                        [("Draw", "設定")],
                        [("Draw", "설정"), ("Draw", "환경 설정")],
                    ),
                )

                self.assertEqual(result.accepted["contexts"], [])
                self.assertEqual(
                    {row["code"] for row in result.report["issues"]},
                    {"DUPLICATE_REVIEWED_CONTEXT"},
                )

    def test_repeated_upstream_source_is_validated_and_emitted_by_occurrence(self):
        path = "host/a.cpp"
        source = "設定"
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [
                    {
                        "path": path,
                        "function": "Draw",
                        "source": source,
                        "target": "첫 설정",
                        "occurrenceIndex": 0,
                    },
                    {
                        "path": path,
                        "function": "Draw",
                        "source": source,
                        "target": "둘째 설정",
                        "occurrenceIndex": 2,
                    },
                ],
            },
            official={},
            context_inventories=self.context_inventory(
                path,
                [("Draw", source), ("Draw", "trace"), ("Draw", source)],
                [("Draw", "첫 설정"), ("Draw", "trace"), ("Draw", "둘째 설정")],
            ),
        )

        self.assertEqual(result.report["issues"], [])
        self.assertEqual(
            [(row["occurrenceIndex"], row["target"]) for row in result.accepted["contexts"]],
            [(0, "첫 설정"), (2, "둘째 설정")],
        )
        probes = [
            migration.Literal(
                path,
                index,
                index + 1,
                source,
                "u8",
                "Draw",
                index + 1,
                occurrence_index,
            )
            for index, occurrence_index in enumerate((0, 2))
        ]
        self.assertEqual(
            [
                migration.source_overlay._resolve_mapping(literal, {}, result.accepted["contexts"])[
                    "target"
                ]
                for literal in probes
            ],
            ["첫 설정", "둘째 설정"],
        )

    def test_same_structure_concatenation_emits_ordered_component_plan(self):
        path = Path("host/components.cpp")
        upstream = (
            'void Draw(){ Label(u8"設定" /* keep */ L"更新"); }'
        ).encode("utf-8")
        current = (
            'void Draw(){ Label(u8"설정" /* keep */ L"업데이트"); }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(path, upstream, current)
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={"設定": "설정", "更新": "업데이트"},
            alignments=alignments,
        )

        self.assertEqual(issues, [])
        self.assertEqual(result.report["issues"], [])
        self.assertEqual(
            result.accepted["entries"]["設定更新"]["components"],
            [
                {"source": "設定", "target": "설정"},
                {"source": "更新", "target": "업데이트"},
            ],
        )

        official = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={
                "設定": "설정",
                "更新": "업데이트",
                "設定更新": "설정업데이트",
            },
            alignments=alignments,
        )
        self.assertEqual(official.report["issues"], [])
        self.assertEqual(official.accepted["entries"]["設定更新"]["status"], "official")
        self.assertEqual(
            official.accepted["entries"]["設定更新"]["components"],
            [
                {"source": "設定", "target": "설정"},
                {"source": "更新", "target": "업데이트"},
            ],
        )

    def test_reordered_localized_components_require_exact_correspondence_evidence(self):
        path = Path("host/components.cpp")
        upstream = 'void Draw(){ Label(u8"設定" L"更新"); }'.encode("utf-8")
        current = 'void Draw(){ Label(u8"업데이트" L"설정"); }'.encode("utf-8")
        alignments, alignment_issues = migration.align_file_literals(
            path, upstream, current
        )
        evidence = {"設定": "설정", "更新": "업데이트"}

        automatic = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official=evidence,
            alignments=alignments,
            alignment_issues=alignment_issues,
        )
        official = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={**evidence, "設定更新": "업데이트설정"},
            alignments=alignments,
            alignment_issues=alignment_issues,
        )

        for result in (automatic, official):
            with self.subTest(status=result.accepted["entries"].get("設定更新", {})):
                self.assertEqual(
                    [issue["code"] for issue in result.report["issues"]],
                    ["COMPONENT_ALIGNMENT_REQUIRED"],
                )
                self.assertNotIn("components", result.accepted["entries"].get("設定更新", {}))

    def test_split_or_merged_concatenation_requires_explicit_review(self):
        path = Path("host/components.cpp")
        upstream = 'void Draw(){ Label(u8"設定" u8"更新"); }'.encode("utf-8")
        current = 'void Draw(){ Label(u8"설정 및 업데이트"); }'.encode("utf-8")

        alignments, issues = migration.align_file_literals(path, upstream, current)

        self.assertEqual(alignments, [])
        self.assertEqual(
            [(row["code"], row["source"], row["occurrenceIndex"]) for row in issues],
            [("COMPONENT_ALIGNMENT_REQUIRED", "設定更新", 0)],
        )

    def test_manual_context_components_validate_against_exact_inventories(self):
        path = "host/components.cpp"
        upstream_text = 'void Draw(){ Label(u8"設定" L"更新"); }'.encode("utf-8")
        current_text = 'void Draw(){ Label(u8"설정" L"업데이트"); }'.encode("utf-8")
        inventory = {
            path: (
                migration.source_overlay.scan_cpp_literals(Path(path), upstream_text),
                migration.source_overlay.scan_cpp_literals(Path(path), current_text),
            )
        }
        base = {
            "path": path,
            "function": "Draw",
            "source": "設定更新",
            "target": "설정업데이트",
            "occurrenceIndex": 0,
        }
        valid_components = [
            {"source": "設定", "target": "설정"},
            {"source": "更新", "target": "업데이트"},
        ]

        accepted = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {},
                "contexts": [{**base, "components": valid_components}],
            },
            official={},
            context_inventories=inventory,
        )

        self.assertEqual(accepted.report["issues"], [])
        self.assertEqual(
            accepted.accepted["contexts"][0]["components"], valid_components
        )

        invalid_components = [
            None,
            valid_components[:1],
            [valid_components[1], valid_components[0]],
            [valid_components[0], {"source": "更新", "target": "갱신"}],
        ]
        for components in invalid_components:
            with self.subTest(components=components):
                row = dict(base)
                if components is not None:
                    row["components"] = components
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={"entries": {}, "contexts": [row]},
                    official={},
                    context_inventories=inventory,
                )
                self.assertEqual(result.accepted["contexts"], [])
                self.assertEqual(
                    [issue["code"] for issue in result.report["issues"]],
                    ["INVALID_REVIEWED_CONTEXT_COMPONENTS"],
                )

    def test_manual_global_components_validate_against_exact_inventories(self):
        path = "host/components.cpp"
        upstream_text = 'void Draw(){ Label(u8"設定" L"更新"); }'.encode("utf-8")
        current_text = 'void Draw(){ Label(u8"설정" L"업데이트"); }'.encode("utf-8")
        inventory = {
            path: (
                migration.source_overlay.scan_cpp_literals(Path(path), upstream_text),
                migration.source_overlay.scan_cpp_literals(Path(path), current_text),
            )
        }
        components = [
            {"source": "設定", "target": "설정"},
            {"source": "更新", "target": "업데이트"},
        ]

        accepted = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {
                    "設定更新": {
                        "target": "설정업데이트",
                        "components": components,
                    }
                }
            },
            official={},
            context_inventories=inventory,
        )
        self.assertEqual(accepted.report["issues"], [])
        self.assertEqual(
            accepted.accepted["entries"]["設定更新"]["components"], components
        )

        for value in (
            {"target": "설정업데이트"},
            {"target": "설정업데이트", "components": components[:1]},
            {
                "target": "설정업데이트",
                "components": [components[1], components[0]],
            },
        ):
            with self.subTest(value=value):
                result = migration.migrate(
                    legacy={"entries": {}},
                    overrides={"entries": {"設定更新": value}},
                    official={},
                    context_inventories=inventory,
                )
                self.assertEqual(result.accepted["entries"], {})
                self.assertEqual(
                    [issue["code"] for issue in result.report["issues"]],
                    ["INVALID_REVIEWED_OVERRIDE_COMPONENTS"],
                )

    def test_manual_components_reject_merged_localized_reference_boundaries(self):
        path = "host/components.cpp"
        upstream_text = 'void Draw(){ Label(u8"設定" L"更新"); }'.encode("utf-8")
        current_text = 'void Draw(){ Label(u8"설정업데이트"); }'.encode("utf-8")
        inventory = {
            path: (
                migration.source_overlay.scan_cpp_literals(Path(path), upstream_text),
                migration.source_overlay.scan_cpp_literals(Path(path), current_text),
            )
        }
        components = [
            {"source": "設定", "target": "설정"},
            {"source": "更新", "target": "업데이트"},
        ]
        context = {
            "path": path,
            "function": "Draw",
            "source": "設定更新",
            "target": "설정업데이트",
            "occurrenceIndex": 0,
            "components": components,
        }

        global_result = migration.migrate(
            legacy={"entries": {}},
            overrides={
                "entries": {
                    "設定更新": {
                        "target": "설정업데이트",
                        "components": components,
                    }
                }
            },
            official={},
            context_inventories=inventory,
        )
        context_result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}, "contexts": [context]},
            official={},
            context_inventories=inventory,
        )

        self.assertEqual(global_result.accepted["entries"], {})
        self.assertEqual(
            [issue["code"] for issue in global_result.report["issues"]],
            ["INVALID_REVIEWED_OVERRIDE_COMPONENTS"],
        )
        self.assertEqual(context_result.accepted["contexts"], [])
        self.assertEqual(
            [issue["code"] for issue in context_result.report["issues"]],
            ["INVALID_REVIEWED_CONTEXT_COMPONENTS"],
        )

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

    def test_structural_groups_include_shared_scanner_macro_literals(self):
        upstream = (
            '#define UPDATE_TEXT(X) X(kChecking, u8"檢查更新中…")\n'
            '#define EXTERNAL_SEED u8"已取消" u8"連線失敗"\n'
        ).encode("utf-8")
        current = (
            '#define UPDATE_TEXT(X) X(kChecking, u8"업데이트 확인 중…")\n'
            '#define EXTERNAL_SEED u8"취소됨" u8"연결 실패"\n'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/app_update.cpp"), upstream, current
        )

        self.assertEqual([], issues)
        self.assertEqual(
            [
                (row.source, row.target, row.components)
                for row in alignments
            ],
            [
                ("檢查更新中…", "업데이트 확인 중…", ()),
                (
                    "已取消連線失敗",
                    "취소됨연결 실패",
                    (("已取消", "취소됨"), ("連線失敗", "연결 실패")),
                ),
            ],
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

    def test_occurrence_index_resets_for_distinct_same_named_functions(self):
        upstream = (
            'void Draw(){ Label(u8"設定"); } '
            'void Draw(int mode){ Label(u8"更新"); }'
        ).encode("utf-8")
        current = (
            'void Draw(){ Label(u8"설정"); } '
            'void Draw(int mode){ Label(u8"업데이트"); }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/overloads.cpp"), upstream, current
        )

        self.assertEqual(issues, [])
        self.assertEqual(
            {row.source: row.occurrence_index for row in alignments},
            {"設定": 0, "更新": 0},
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

    def test_nested_if_body_literals_are_not_grouped_with_the_condition_literal(self):
        upstream = (
            'void Draw(){ if (Button(u8"全部替換")) { status = u8"已將 "; } }'
        ).encode("utf-8")
        current = (
            'void Draw(){ if (Button(u8"모두 교체")) { status = u8"교체됨"; } }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/nested.cpp"), upstream, current
        )

        self.assertEqual(
            [(row.source, row.target) for row in alignments],
            [("全部替換", "모두 교체"), ("已將 ", "교체됨")],
        )
        self.assertEqual(issues, [])

    def test_direct_occurrence_aligns_when_enclosing_if_body_changes(self):
        upstream = (
            'void Draw(){ if (Button(u8"全部替換")) { OldBody(); } }'
        ).encode("utf-8")
        current = (
            'void Draw(){ if (Button(u8"모두 교체")) { NewBody(); More(); } }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/button.cpp"), upstream, current
        )

        self.assertEqual(
            [(row.source, row.target, row.occurrence_index) for row in alignments],
            [("全部替換", "모두 교체", 0)],
        )
        self.assertEqual(issues, [])

    def test_real_files_never_align_fragments_by_function_ordinal(self):
        unsafe_pairs = {
            "host/launcher_editor.cpp": (" 個檔案", "저장 실패: "),
            "host/atlas_planner.cpp": (
                "」不能同時使用",
                "이 갑충석은 현재 데이터에 없습니다.",
            ),
            "host/atlas_import.cpp": (
                "有 ",
                "개 노드가 시작 노드에서 연결되지 않았습니다. 데이터 오류로 가져오기를 중단했습니다.",
            ),
            "host/section_sounds.cpp": (
                "（未儲存，請按「儲存」寫入）",
                "취소",
            ),
            "host/timeless_jewel.cpp": (
                "找不到 ",
                ".bin/.zip 파일을 찾을 수 없습니다(옆에 PoE1 POB와 해당 주얼의 조회 테이블 파일이 있어야 함).",
            ),
        }

        for relative, unsafe_pair in unsafe_pairs.items():
            with self.subTest(relative=relative):
                alignments, issues = self.align_real_file(relative)
                self.assertNotIn(
                    unsafe_pair,
                    {(row.source, row.target) for row in alignments},
                )
                blocked_sources = {
                    source
                    for issue in issues
                    for source in (
                        [issue["source"]]
                        if isinstance(issue.get("source"), str)
                        else issue.get("sources", [])
                    )
                }
                self.assertIn(unsafe_pair[0], blocked_sources)

    def test_real_files_keep_only_narrowly_provable_intended_matches(self):
        sounds, sound_issues = self.align_real_file("host/section_sounds.cpp")
        filters, filter_issues = self.align_real_file("host/filter_i18n.cpp")

        self.assertIn(
            ("全部替換", "모두 교체"),
            {(row.source, row.target) for row in sounds},
        )
        self.assertIn(
            ("深淵珠寶", "심연 주얼"),
            {(row.source, row.target) for row in filters},
        )
        self.assertNotIn(
            "全部替換",
            {
                source
                for issue in sound_issues
                for source in issue.get("sources", [issue.get("source")])
            },
        )
        self.assertNotIn(
            "深淵珠寶",
            {
                source
                for issue in filter_issues
                for source in issue.get("sources", [issue.get("source")])
            },
        )

    def test_real_multi_source_groups_preserve_every_occurrence_identity(self):
        expected = {
            "host/atlas_import.cpp": {
                ("sheetFor", "圖集 ", 2),
                ("sheetFor", "圖集 ", 6),
                ("sheetFor", " 是 webp 格式，目前不支援（需要 png/jpg）", 3),
                ("sheetFor", " 尺寸異常或超過 4096", 7),
            },
            "host/filter_i18n.cpp": {
                ("FilterI18n::Load", "地圖階級", 47),
                ("FilterI18n::Load", "堆疊數量", 49),
            },
            "host/launcher_editor.cpp": {
                ("Frame", "儲存全部 (", 10),
                ("Frame", "已儲存 ", 13),
                ("Frame", "儲存失敗：", 15),
                ("Frame", "改寫入 ", 44),
                ("Frame", "即將切換到 ", 85),
                ("Frame", "即將切換到 ", 87),
            },
        }

        for relative, expected_identities in expected.items():
            with self.subTest(relative=relative):
                _, issues = self.align_real_file(relative)
                identities = {
                    (row["function"], row["source"], row["occurrenceIndex"])
                    for row in issues
                }
                self.assertTrue(expected_identities <= identities)
                self.assertEqual(len(identities), len(issues))

    def test_real_pinned_recovery_inventories_require_only_exact_policy_rows(self):
        self.assertEqual(migration.PINNED_LOCALIZED, self.CORRECTED_LOCALIZED_COMMIT)
        self.assertEqual(migration.PINNED_LOCALIZED_TREE, self.CORRECTED_LOCALIZED_TREE)
        self.assertEqual(
            migration._git_bytes(
                ["rev-parse", f"{migration.PINNED_LOCALIZED}:pob-zh-engine"]
            ).decode("ascii").strip(),
            self.CORRECTED_LOCALIZED_TREE,
        )
        expected_paths = {
            "host/app_update.cpp",
            "host/atlas_tree_data.h",
            "host/error_log.cpp",
            "host/filter_preview.h",
            "host/host_main.cpp",
            "host/launcher_ui.cpp",
            "host/passive_tree_data.h",
            "host/passive_tree_view.h",
            "host/pob_launch.cpp",
            "host/window_dock.cpp",
            "ui_api.cpp",
            "ui_main.cpp",
        }
        policy = json.loads(
            (LOCALE_ROOT / "source-display-policy.json").read_text(encoding="utf-8")
        )
        evidence = migration.source_overlay.validate_parse_recovery_allowlist(
            policy["parseRecoveryAllowlist"]
        )
        raw_evidence = tuple(
            row for row in evidence if row.compatibility_patch_sha256 is None
        )
        evidence_by_role_path = {
            (row.source_role, row.path): row for row in raw_evidence
        }
        excluded = migration._excluded_paths()
        used = set()
        blocked_without_evidence = set()

        upstream_paths = migration._source_paths(migration.PINNED_UPSTREAM, "upstream")
        localized_paths = migration._source_paths(
            migration.PINNED_LOCALIZED, "localized"
        )
        self.assertEqual(upstream_paths, localized_paths)
        included_paths = [
            path
            for path in upstream_paths
            if path.removeprefix("pob-zh-engine/") not in excluded
        ]
        self.assertEqual(len(included_paths) * 2, 320)

        for repository_path in included_paths:
            relative = repository_path.removeprefix("pob-zh-engine/")
            sources = {
                "upstream": migration._git_bytes(
                    ["show", f"{migration.PINNED_UPSTREAM}:{repository_path}"]
                ),
                "localized": migration._git_bytes(
                    [
                        "show",
                        f"{migration.PINNED_LOCALIZED}:pob-zh-engine/{relative}",
                    ]
                ),
            }
            for role, text in sources.items():
                commit = migration.source_overlay.PINNED_SOURCE_COMMITS[role]
                try:
                    migration.source_overlay.scan_cpp_literals(Path(relative), text)
                except migration.source_overlay.CppParseError:
                    blocked_without_evidence.add((role, relative))
                except migration.source_overlay.UnsupportedEscape:
                    pass
                policy_row = evidence_by_role_path.get((role, relative))
                if policy_row is not None:
                    self.assertEqual(
                        policy_row.file_sha256,
                        hashlib.sha256(text).hexdigest().upper(),
                    )
                try:
                    migration.source_overlay.scan_cpp_literals(
                        Path(relative),
                        text,
                        parse_recovery_allowlist=evidence,
                        source_role=role,
                        source_commit=commit,
                        used_recovery_evidence=used,
                    )
                except migration.source_overlay.UnsupportedEscape:
                    pass

        self.assertEqual(len(raw_evidence), 24)
        self.assertEqual(len(used), 24)
        self.assertEqual(
            blocked_without_evidence,
            {(role, path) for role in ("upstream", "localized") for path in expected_paths},
        )
        self.assertEqual(
            {(row.source_role, row.path) for row in used},
            blocked_without_evidence,
        )

    def test_run_migration_ignores_localized_root_content_and_eol_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            foreign_root = root / "foreign-source"
            foreign_file = foreign_root / "host/app_update.cpp"
            foreign_file.parent.mkdir(parents=True)
            pinned = migration._git_bytes(
                [
                    "show",
                    f"{migration.PINNED_LOCALIZED}:pob-zh-engine/host/app_update.cpp",
                ]
            )
            drifted = pinned.replace(b"\n", b"\r\n") + b"BROKEN checkout-only source\r\n"
            foreign_file.write_bytes(drifted)
            self.assertNotEqual(drifted, pinned)
            self.assertIn(b"\r\n", drifted)

            def run(name, localized_root):
                output_root = root / name
                return migration.run_migration(
                    upstream_ref=migration.PINNED_UPSTREAM,
                    localized_root=localized_root,
                    output=output_root / "accepted.json",
                    suggestions=output_root / "suggestions.json",
                    report_path=output_root / "report.json",
                )

            baseline = run("baseline", migration.REPOSITORY_ROOT / "pob-zh-engine")
            foreign = run("foreign", foreign_root)

        self.assertEqual(foreign.accepted, baseline.accepted)
        self.assertEqual(foreign.suggestions, baseline.suggestions)
        self.assertEqual(foreign.report, baseline.report)
        self.assertEqual(foreign.report["parseRecoveryEvidence"]["useCount"], 24)

    def test_wrong_localized_ref_blocks_before_accepted_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accepted = root / "accepted.json"
            suggestions = root / "suggestions.json"
            report = root / "report.json"

            with self.assertRaisesRegex(ValueError, "localized ref"):
                migration.run_migration(
                    upstream_ref=migration.PINNED_UPSTREAM,
                    localized_ref="0" * 40,
                    localized_root=root / "irrelevant-source",
                    output=accepted,
                    suggestions=suggestions,
                    report_path=report,
                )

            self.assertFalse(accepted.exists())
            self.assertFalse(suggestions.exists())

    def test_missing_pinned_ref_or_blob_is_a_deterministic_validation_error(self):
        missing = subprocess.CalledProcessError(128, ["git"])
        with patch.object(migration, "_git_bytes", side_effect=missing):
            with self.assertRaisesRegex(ValueError, "pinned localized ref is unavailable"):
                migration._validate_pinned_source_ref(
                    migration.PINNED_LOCALIZED,
                    migration.PINNED_LOCALIZED,
                    "localized",
                )
            with self.assertRaisesRegex(ValueError, "pinned localized Git blob is unavailable"):
                migration._git_source_bytes(
                    migration.PINNED_LOCALIZED,
                    "pob-zh-engine/host/app_update.cpp",
                    "localized",
                )

    def test_localized_engine_tree_mismatch_is_rejected(self):
        wrong_tree = b"0" * 40 + b"\n"
        with patch.object(
            migration,
            "_git_bytes",
            side_effect=[
                (self.CORRECTED_LOCALIZED_COMMIT + "\n").encode("ascii"),
                wrong_tree,
            ],
        ):
            with self.assertRaisesRegex(ValueError, "localized engine tree"):
                migration._validate_pinned_source_ref(
                    self.CORRECTED_LOCALIZED_COMMIT,
                    self.CORRECTED_LOCALIZED_COMMIT,
                    "localized",
                    expected_tree=self.CORRECTED_LOCALIZED_TREE,
                )

    def test_checkout_only_recovery_row_cannot_validate_a_pinned_blob(self):
        relative = "host/app_update.cpp"
        repository_path = f"pob-zh-engine/{relative}"
        pinned = migration._git_bytes(
            ["show", f"{migration.PINNED_LOCALIZED}:{repository_path}"]
        )
        checkout = (migration.REPOSITORY_ROOT / repository_path).read_bytes()
        checkout_only = (
            checkout
            if checkout != pinned
            else pinned.replace(b"\n", b"\r\n") + b"checkout drift\r\n"
        )
        self.assertNotEqual(pinned, checkout_only)
        policy = json.loads(
            (LOCALE_ROOT / "source-display-policy.json").read_text(encoding="utf-8")
        )
        row = next(
            dict(value)
            for value in policy["parseRecoveryAllowlist"]
            if value["sourceRole"] == "localized" and value["path"] == relative
        )
        row["fileSha256"] = hashlib.sha256(checkout_only).hexdigest().upper()
        evidence = migration.source_overlay.validate_parse_recovery_allowlist([row])

        with self.assertRaises(migration.source_overlay.CppParseError):
            migration.source_overlay.scan_cpp_literals(
                Path(relative),
                pinned,
                parse_recovery_allowlist=evidence,
                source_role="localized",
                source_commit=migration.PINNED_LOCALIZED,
            )

    def test_alignment_uses_exact_recovery_evidence_for_both_source_roles(self):
        path = Path("host/reviewed.cpp")
        source = (
            'enum : int { Value = 1 };\nvoid Draw(){ Label(u8"設定"); }'
        ).encode("utf-8")
        file_sha256 = hashlib.sha256(source).hexdigest().upper()
        recovery_sha256 = (
            "E8ADBC953EFC45BA69E3646DAC65FE5C00D6BF7436AC3F0BA0EC9C6C2D702340"
        )
        raw_rows = [
            {
                "path": path.as_posix(),
                "sourceRole": role,
                "sourceCommit": migration.source_overlay.PINNED_SOURCE_COMMITS[role],
                "fileSha256": file_sha256,
                "recoverySha256": recovery_sha256,
                "reason": f"reviewed {role} anonymous typed enum recovery",
            }
            for role in ("upstream", "localized")
        ]
        evidence = migration.source_overlay.validate_parse_recovery_allowlist(raw_rows)
        used = set()

        migration.align_file_literals(
            path,
            source,
            source,
            parse_recovery_allowlist=evidence,
            used_recovery_evidence=used,
        )

        self.assertEqual({row.source_role for row in used}, {"upstream", "localized"})

    def test_real_season_tree_source_emits_exact_context_targets(self):
        source = "發現新賽季天賦樹 "
        passive, passive_issues = migration.align_file_literals(
            Path("host/passive_tree_update.cpp"),
            f'void Check(){{ Emit(u8"{source}" + version + u8"（目前 "); }}'.encode("utf-8"),
            'void Check(){ Emit(u8"새 시즌 패시브 스킬 트리 " + version + u8" 발견"); }'.encode("utf-8"),
        )
        timeless, timeless_issues = migration.align_file_literals(
            Path("host/timeless_jewel_ui.cpp"),
            f'void Frame(){{ Button(u8"{source}" + version + u8"，點擊更新"); }}'.encode("utf-8"),
            'void Frame(){ Button(u8"새 시즌 패시브 트리 " + version + u8" 발견 — 업데이트"); }'.encode("utf-8"),
        )

        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {}},
            official={},
            alignments=[*passive, *timeless],
            alignment_issues=[*passive_issues, *timeless_issues],
        )

        self.assertNotIn(source, result.accepted["entries"])
        self.assertEqual(
            [
                (row["path"], row["function"], row["target"])
                for row in result.accepted["contexts"]
                if row["source"] == source
            ],
            [
                (
                    "host/passive_tree_update.cpp",
                    "Check",
                    "새 시즌 패시브 스킬 트리 ",
                ),
                ("host/timeless_jewel_ui.cpp", "Frame", "새 시즌 패시브 트리 "),
            ],
        )

    def test_checked_in_map_resolves_both_real_season_tree_contexts(self):
        mapping = json.loads(
            (LOCALE_ROOT / "source-translations.json").read_text(encoding="utf-8")
        )
        source = "發現新賽季天賦樹 "
        probes = [
            migration.source_overlay.Literal(
                "host/passive_tree_update.cpp",
                0,
                0,
                source,
                "u8",
                "PassiveTreeUpdater::doCheck",
                340,
                7,
            ),
            migration.source_overlay.Literal(
                "host/timeless_jewel_ui.cpp",
                0,
                0,
                source,
                "u8",
                "Frame",
                440,
                141,
            ),
        ]

        resolved = [
            migration.source_overlay._resolve_mapping(
                literal, mapping["entries"], mapping["contexts"]
            )
            for literal in probes
        ]

        self.assertEqual(
            [(row["target"], row["status"]) for row in resolved],
            [
                ("새 시즌 패시브 스킬 트리 ", "reviewed"),
                ("새 시즌 패시브 트리 ", "reviewed"),
            ],
        )

    def test_single_viable_hangul_candidate_ignores_legacy_non_hangul_alias(self):
        upstream = (
            'void Load(){ map.emplace(u8"深淵珠寶", "Abyss Jewels"); }'
        ).encode("utf-8")
        current = (
            'void Load(){ if (korean) map.emplace(u8"심연 주얼", "Abyss Jewels"); '
            'else map.emplace("\\xe6\\xb7\\xb1\\xe6\\xb7\\xb5\\xe7\\x8f\\xa0\\xe5\\xaf\\xb6", '
            '"Abyss Jewels"); }'
        ).encode("utf-8")

        alignments, issues = migration.align_file_literals(
            Path("host/alias.cpp"), upstream, current
        )

        self.assertEqual(
            [(row.source, row.target) for row in alignments],
            [("深淵珠寶", "심연 주얼")],
        )
        self.assertEqual(issues, [])

    def test_ambiguous_structural_block_is_reported_instead_of_inferred(self):
        upstream = 'void Draw(){ Label(u8"設定"); Label(u8"新增"); }'.encode("utf-8")
        current = 'void Draw(){ Label(u8"설정 및 추가"); }'.encode("utf-8")

        alignments, issues = migration.align_file_literals(Path("host/ui.cpp"), upstream, current)

        self.assertEqual(alignments, [])
        self.assertEqual(
            [
                (row["code"], row["source"], row["occurrenceIndex"])
                for row in issues
            ],
            [
                ("AMBIGUOUS_ALIGNMENT", "設定", 0),
                ("AMBIGUOUS_ALIGNMENT", "新增", 1),
            ],
        )

    def test_output_documents_are_canonical_sorted_schema_version_two(self):
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

        self.assertEqual(result.accepted["schemaVersion"], 2)
        self.assertEqual(result.suggestions["schemaVersion"], 2)
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

    def test_migration_rejects_overlapping_resolved_output_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accepted = root / "accepted.json"
            suggestions = root / "nested" / ".." / "accepted.json"
            report = root / "report.json"

            with self.assertRaisesRegex(ValueError, "output paths must be distinct"):
                migration.validate_output_paths(accepted, suggestions, report)

            self.assertFalse(accepted.exists())
            self.assertFalse(report.exists())

    def test_valid_official_stable_id_evidence_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = self.write_stable_evidence_fixture(Path(temporary))

            issues = migration.verify_stable_id_evidence(*paths, expected_table="Fixture")

        self.assertEqual(issues, [])

    def test_tampered_official_input_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = self.write_stable_evidence_fixture(Path(temporary))
            paths[2].write_text('[]', encoding="utf-8")

            issues = migration.verify_stable_id_evidence(*paths, expected_table="Fixture")

        self.assertIn("OFFICIAL_INPUT_HASH_MISMATCH", {row["code"] for row in issues})

    def test_stale_or_missing_official_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = self.write_stable_evidence_fixture(Path(temporary))
            document = json.loads(paths[0].read_text(encoding="utf-8"))
            document["patch"] = "3.29.3.1"
            paths[0].write_text(json.dumps(document), encoding="utf-8")

            stale = migration.verify_stable_id_evidence(*paths, expected_table="Fixture")
            paths[0].unlink()
            missing = migration.verify_stable_id_evidence(*paths, expected_table="Fixture")

        self.assertIn("OFFICIAL_PATCH_MISMATCH", {row["code"] for row in stale})
        self.assertIn("OFFICIAL_MANIFEST_MISSING", {row["code"] for row in missing})

    def test_official_evidence_failure_writes_only_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            accepted = root / "accepted-output.json"
            suggestions = root / "suggestions.json"
            report = root / "report.json"

            with self.assertRaises(migration.OfficialEvidenceError):
                migration.run_migration(
                    upstream_ref=migration.PINNED_UPSTREAM,
                    localized_root=root / "source",
                    output=accepted,
                    suggestions=suggestions,
                    report_path=report,
                    repository_root=root,
                )

            report_document = json.loads(report.read_text(encoding="utf-8"))

        self.assertFalse(accepted.exists())
        self.assertFalse(suggestions.exists())
        self.assertEqual(report_document["counts"]["official"], 0)
        self.assertTrue(report_document["issues"])

    def test_runtime_official_identity_is_derived_from_accepted_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, _, _, trusted_hashes = self.write_runtime_identity_fixture(root)

            identities = migration.load_official_runtime_identity(
                root, trusted_reference_hashes=trusted_hashes
            )

        self.assertEqual(identities, {"聖甲蟲：深淵": "심연 갑충석"})

    def test_trusted_zh_hashes_equal_committed_baseline_manifest(self):
        self.assertEqual(
            migration.load_trusted_zh_reference_hashes(migration.REPOSITORY_ROOT),
            migration.TRUSTED_ZH_REFERENCE_HASHES,
        )

    def test_trusted_zh_baseline_manifest_drift_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "reports" / "baseline" / "original-distribution.sha256.json"
            manifest.parent.mkdir(parents=True)
            rows = [
                {
                    "path": f"Data/poe1/zh-rTW/{dictionary}.json",
                    "sha256": (
                        "0" * 64
                        if dictionary == "items"
                        else migration.TRUSTED_ZH_REFERENCE_HASHES[dictionary]
                    ),
                }
                for dictionary in migration.DICTIONARIES
            ]
            manifest.write_text(
                json.dumps({"algorithm": "SHA256", "files": rows}),
                encoding="utf-8",
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_trusted_zh_reference_hashes(root)

        self.assertIn(
            "OFFICIAL_REFERENCE_MANIFEST_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_trusted_zh_manifest_fails_closed_on_every_malformed_row(self):
        valid_rows = [
            {
                "path": f"Data/poe1/zh-rTW/{dictionary}.json",
                "sha256": migration.TRUSTED_ZH_REFERENCE_HASHES[dictionary],
            }
            for dictionary in migration.DICTIONARIES
        ]
        items = dict(valid_rows[1])
        malformed_rows = [
            [],
            {"path": ["unhashable"], "sha256": "0" * 64},
            {"path": "extra.json", "sha256": ["unhashable"]},
            {"path": "extra.json", "sha256": "not-a-sha256"},
            {"path": "extra.json"},
            {"path": "extra.json", "sha256": "0" * 64, "extra": True},
        ]
        for malformed in malformed_rows:
            with self.subTest(malformed=malformed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = root / "reports/baseline/original-distribution.sha256.json"
                manifest.parent.mkdir(parents=True)
                manifest.write_text(
                    json.dumps(
                        {"algorithm": "SHA256", "files": [*valid_rows, malformed]}
                    ),
                    encoding="utf-8",
                )

                with self.assertRaises(migration.OfficialEvidenceError) as raised:
                    migration.load_trusted_zh_reference_hashes(root)

                self.assertIn(
                    "OFFICIAL_REFERENCE_MANIFEST_INVALID_ROW",
                    {row["code"] for row in raised.exception.issues},
                )

        for rows in ([{**items, "sha256": "bad"}, *valid_rows], [*valid_rows, {**items, "sha256": "bad"}]):
            with self.subTest(order=rows[0].get("sha256")), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = root / "reports/baseline/original-distribution.sha256.json"
                manifest.parent.mkdir(parents=True)
                manifest.write_text(
                    json.dumps({"algorithm": "SHA256", "files": rows}),
                    encoding="utf-8",
                )
                with self.assertRaises(migration.OfficialEvidenceError) as raised:
                    migration.load_trusted_zh_reference_hashes(root)
                self.assertIn(
                    "OFFICIAL_REFERENCE_MANIFEST_DUPLICATE_PATH",
                    {row["code"] for row in raised.exception.issues},
                )

    def test_trusted_zh_manifest_rejects_duplicate_path_even_when_hash_matches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "reports/baseline/original-distribution.sha256.json"
            manifest.parent.mkdir(parents=True)
            rows = [
                {
                    "path": f"Data/poe1/zh-rTW/{dictionary}.json",
                    "sha256": migration.TRUSTED_ZH_REFERENCE_HASHES[dictionary],
                }
                for dictionary in migration.DICTIONARIES
            ]
            rows.append(dict(rows[0]))
            manifest.write_text(
                json.dumps({"algorithm": "SHA256", "files": rows}),
                encoding="utf-8",
            )
            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_trusted_zh_reference_hashes(root)

        self.assertIn(
            "OFFICIAL_REFERENCE_MANIFEST_DUPLICATE_PATH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_trusted_zh_manifest_rejects_hash_reused_by_relevant_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = root / "reports/baseline/original-distribution.sha256.json"
            manifest.parent.mkdir(parents=True)
            rows = [
                {
                    "path": f"Data/poe1/zh-rTW/{dictionary}.json",
                    "sha256": migration.TRUSTED_ZH_REFERENCE_HASHES[dictionary],
                }
                for dictionary in migration.DICTIONARIES
            ]
            rows[1]["sha256"] = rows[0]["sha256"]
            manifest.write_text(
                json.dumps({"algorithm": "SHA256", "files": rows}),
                encoding="utf-8",
            )
            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_trusted_zh_reference_hashes(root)

        self.assertIn(
            "OFFICIAL_REFERENCE_MANIFEST_DUPLICATE_HASH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_runtime_official_target_tamper_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            items_path, _, _, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(items_path.read_text(encoding="utf-8"))
            document["entries"]["Abyss Scarab"] = "변조된 갑충석"
            items_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_DERIVED_TARGET_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_runtime_official_provenance_layer_tamper_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, _, provenance_path, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(provenance_path.read_text(encoding="utf-8"))
            document["dictionaries"]["items"]["Abyss Scarab"]["layer"] = "manual-pob-ui"
            provenance_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_DERIVED_PROVENANCE_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_runtime_official_provenance_identity_tamper_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, _, provenance_path, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(provenance_path.read_text(encoding="utf-8"))
            document["dictionaries"]["items"]["Abyss Scarab"]["source"] = (
                "BaseItemTypes:Metadata/Items/Scarabs/AnotherScarab"
            )
            provenance_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_DERIVED_PROVENANCE_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_runtime_official_traditional_chinese_source_substitution_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, chinese_path, _, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(chinese_path.read_text(encoding="utf-8"))
            document["entries"]["Abyss Scarab"] = "全部替換"
            chinese_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_REFERENCE_HASH_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )
        result = migration.migrate(
            legacy={"entries": {}},
            overrides={"entries": {"全部替換": "모두 교체"}},
            official={},
        )
        self.assertEqual(result.accepted["entries"]["全部替換"]["target"], "모두 교체")
        self.assertEqual(result.accepted["entries"]["全部替換"]["status"], "reviewed")

    def test_runtime_official_traditional_chinese_key_reassignment_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, chinese_path, _, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(chinese_path.read_text(encoding="utf-8"))
            source = document["entries"].pop("Abyss Scarab")
            document["entries"]["Other English Key"] = source
            chinese_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_REFERENCE_HASH_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

    def test_runtime_official_traditional_chinese_source_collision_is_blocked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _, chinese_path, _, trusted_hashes = self.write_runtime_identity_fixture(root)
            document = json.loads(chinese_path.read_text(encoding="utf-8"))
            document["entries"]["Other English Key"] = "聖甲蟲：深淵"
            chinese_path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )

            with self.assertRaises(migration.OfficialEvidenceError) as raised:
                migration.load_official_runtime_identity(
                    root, trusted_reference_hashes=trusted_hashes
                )

        self.assertIn(
            "OFFICIAL_REFERENCE_HASH_MISMATCH",
            {row["code"] for row in raised.exception.issues},
        )

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
