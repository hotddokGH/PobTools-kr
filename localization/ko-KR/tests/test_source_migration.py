import importlib.util
import hashlib
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
    def align_real_file(self, relative: str):
        upstream = migration._git_bytes(
            ["show", f"{migration.PINNED_UPSTREAM}:pob-zh-engine/{relative}"]
        )
        current = (migration.REPOSITORY_ROOT / "pob-zh-engine" / relative).read_bytes()
        return migration.align_file_literals(Path(relative), upstream, current)

    def context_inventory(self, path: str, upstream_rows, current_rows):
        def literals(rows):
            return [
                migration.Literal(path, index, index + 1, text, "u8", function, index + 1)
                for index, (function, text) in enumerate(rows)
            ]

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
                    "sources": ["發現新賽季天賦樹 "],
                    "currentCandidates": [],
                }
            ],
        )

        self.assertNotIn("發現新賽季天賦樹 ", result.accepted["entries"])
        self.assertEqual(
            [
                (row["path"], row["function"], row["target"])
                for row in result.accepted["contexts"]
            ],
            [("host/known.cpp", "Draw", "새 시즌 패시브 트리 ")],
        )
        self.assertEqual(
            [row["code"] for row in result.report["issues"]],
            ["UNMAPPED_ALIGNMENT"],
        )

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
                    "sources": [source],
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
                (row["path"], row["function"], row["target"], row["provenance"])
                for row in result.accepted["contexts"]
            ],
            [
                (
                    "host/passive_tree_update.cpp",
                    "PassiveTreeUpdater::doCheck",
                    "새 시즌 패시브 스킬 트리 ",
                    "manual-reviewed-context",
                ),
                (
                    "host/timeless_jewel_ui.cpp",
                    "Frame",
                    "새 시즌 패시브 트리 ",
                    "current-ko-baseline",
                ),
            ],
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
            ),
            migration.source_overlay.Literal(
                "host/timeless_jewel_ui.cpp",
                0,
                0,
                source,
                "u8",
                "Frame",
                440,
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
