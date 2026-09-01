import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


LIB_ROOT = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB_ROOT))

import source_overlay
from source_overlay import CppParseError, apply_overlay, format_signature, scan_cpp_literals


class SourceOverlayTests(unittest.TestCase):
    PINNED_UPSTREAM = "baf07d41d2df524d4330a58b411826339c93fac1"
    RECOVERY_FIXTURE = (
        'enum : int { Value = 1 };\nvoid Draw(){ Label(u8"設定"); }'
    )
    RECOVERY_FILE_SHA256 = (
        "25AC04BAF01FF1257D4F3343B76064F3471C6638744B6FE30CE2E110EAA87575"
    )
    RECOVERY_FINGERPRINT_SHA256 = (
        "E8ADBC953EFC45BA69E3646DAC65FE5C00D6BF7436AC3F0BA0EC9C6C2D702340"
    )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.policy = self.root / "source-display-policy.json"
        self.report = self.root / "overlay-report.json"
        self.policy.write_text(
            json.dumps(
                {
                    "excludedPaths": [],
                    "internalLiteralAllowlist": [],
                    "parseRecoveryAllowlist": [],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, relative, text, newline=None):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline=newline)
        return path

    def read(self, relative):
        return (self.root / relative).read_text(encoding="utf-8", newline="")

    def entry(self, target, status, signature=None, provenance="manual"):
        return {
            "target": target,
            "status": status,
            "provenance": provenance,
            "formatSignature": [] if signature is None else signature,
        }

    def mapping(self, entries, contexts=None):
        path = self.root / "source-literal-mapping.json"
        path.write_text(
            json.dumps(
                {"schemaVersion": 2, "entries": entries, "contexts": contexts or []},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return path

    def recovery_row(self, **overrides):
        return {
            "path": "host/reviewed.cpp",
            "sourceRole": "upstream",
            "sourceCommit": self.PINNED_UPSTREAM,
            "fileSha256": self.RECOVERY_FILE_SHA256,
            "recoverySha256": self.RECOVERY_FINGERPRINT_SHA256,
            "reason": "reviewed anonymous typed enum parser recovery",
            **overrides,
        }

    def write_policy(self, rows):
        self.policy.write_text(
            json.dumps(
                {
                    "excludedPaths": [],
                    "internalLiteralAllowlist": [],
                    "parseRecoveryAllowlist": rows,
                }
            ),
            encoding="utf-8",
        )

    def test_scans_prefixes_raw_strings_comments_and_function_context(self):
        source = (
            '// u8"忽略"\n'
            'void Draw(){ ImGui::Text(u8"設定 %d\\n"); '
            'auto a = L"寬字"; auto b = LR"tag(更新)tag"; }'
        )
        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))
        self.assertEqual([row.decoded for row in rows], ["設定 %d\n", "寬字", "更新"])
        self.assertEqual({row.function for row in rows}, {"Draw"})
        self.assertEqual([row.occurrence_index for row in rows], [0, 1, 2])

    def test_file_scope_occurrence_indexes_use_empty_function(self):
        source = 'auto first = u8"全域"; auto second = "trace";'
        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))
        self.assertEqual(
            [(row.function, row.decoded, row.occurrence_index) for row in rows],
            [("", "全域", 0), ("", "trace", 1)],
        )

    def test_occurrence_indexes_reset_for_distinct_same_named_functions(self):
        source = (
            'void Draw(){ ImGui::Text(u8"設定"); } '
            'void Draw(int mode){ ImGui::Text(u8"更新"); }'
        )
        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))
        self.assertEqual(
            [(row.function, row.decoded, row.occurrence_index) for row in rows],
            [("Draw", "設定", 0), ("Draw", "更新", 0)],
        )

    def test_scans_concatenated_literals_as_one_value(self):
        source = 'void Draw(){ ImGui::Text(u8"設定 " "更新"); }'
        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))
        self.assertEqual([row.decoded for row in rows], ["設定 更新"])
        self.assertEqual(source.encode("utf-8")[rows[0].start : rows[0].end], b'u8"\xe8\xa8\xad\xe5\xae\x9a " "\xe6\x9b\xb4\xe6\x96\xb0"')

    def test_apply_blocks_concatenation_with_interstitial_comment(self):
        original = 'void Draw(){ ImGui::Text(u8"設定" /* keep */ u8"更新"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"設定更新": self.entry("설정 업데이트", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "UNSAFE_CONCATENATED_LITERAL")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_apply_blocks_concatenation_with_mixed_prefixes(self):
        original = 'void Draw(){ ImGui::Text(u8"設定" L"更新"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"設定更新": self.entry("설정 업데이트", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "UNSAFE_CONCATENATED_LITERAL")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_format_signature_counts_decoded_newlines(self):
        self.assertEqual(
            format_signature("Gain {0} %s\n^xFF00FF"),
            ("%s", "<NL>", "^xFF00FF", "{0}"),
        )

    def test_apply_replaces_by_byte_offset_without_corrupting_utf8_or_crlf(self):
        original = '/* 前置 */\r\nvoid Draw(){ ImGui::Text(u8"設定"); }\r\n'
        self.write("host/ui.cpp", original, newline="")
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"], [])
        self.assertEqual(self.read("host/ui.cpp"), original.replace("設定", "설정"))
        self.assertEqual((self.root / "host/ui.cpp").read_bytes().count(b"\r\n"), 2)

    def test_raw_delimiter_collision_blocks_without_writing(self):
        original = 'void Draw(){ auto value = LR"tag(更新)tag"; }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"更新": self.entry('끝 )tag" 계속', "official")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "RAW_DELIMITER_COLLISION")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_multiline_raw_replacement_preserves_crlf_newline_bytes(self):
        original = 'void Draw(){ auto value = R"(設定\r\n更新)"; }\r\n'
        self.write("host/ui.cpp", original, newline="")
        mapping = self.mapping(
            {"設定\r\n更新": self.entry("설정\n업데이트", "reviewed", ["<NL>"])}
        )
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"], [])
        expected = original.replace("設定\r\n更新", "설정\r\n업데이트")
        self.assertEqual((self.root / "host/ui.cpp").read_bytes(), expected.encode("utf-8"))

    def test_unsupported_escape_is_reported_without_writing(self):
        original = 'void Draw(){ ImGui::Text(u8"設定\\q"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "UNSUPPORTED_ESCAPE")
        self.assertEqual(report["issues"][0]["source"], 'u8"設定\\q"')
        self.assertEqual(report["issues"][0]["occurrenceIndex"], 0)
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_long_hex_escape_is_rejected_instead_of_partially_decoded(self):
        original = 'void Draw(){ ImGui::Text(u8"設定\\x414"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "UNSUPPORTED_ESCAPE")
        self.assertEqual(report["issues"][0]["escape"], "\\x414")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_cpp_parse_error_blocks_all_files_without_writing(self):
        malformed = 'void Draw( { Label(u8"設定"); }'
        valid = 'void Draw(){ Label(u8"更新"); }'
        self.write("host/bad.cpp", malformed)
        self.write("host/good.cpp", valid)
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "reviewed"),
                "更新": self.entry("업데이트", "reviewed"),
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(
            [
                {
                    key: issue[key]
                    for key in (
                        "code",
                        "path",
                        "function",
                        "line",
                        "startByte",
                        "endByte",
                        "occurrenceIndex",
                    )
                }
                for issue in report["issues"]
            ],
            [
                {
                    "code": "CPP_PARSE_ERROR",
                    "path": "host/bad.cpp",
                    "function": "",
                    "line": 1,
                    "startByte": 0,
                    "endByte": len(malformed.encode("utf-8")),
                    "occurrenceIndex": 0,
                }
            ],
        )
        self.assertEqual(self.read("host/bad.cpp"), malformed)
        self.assertEqual(self.read("host/good.cpp"), valid)

    def test_unreviewed_recovery_shapes_block_every_file_transactionally(self):
        malformed_sources = {
            "regular": 'void Draw(){ auto value = "設定" BROKEN; }',
            "raw": 'void Draw(){ auto value = R"(設定)" BROKEN; }',
            "x-macro": 'BROKEN(u8"設定")',
            "anonymous-enum": (
                'enum : int { BROKEN }; void Draw(){ Label(u8"設定"); }'
            ),
            "sg-prefix": (
                'SG_BROKEN static void Draw(){ Label(u8"設定"); }'
            ),
        }
        valid = 'void Draw(){ Label(u8"更新"); }'
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "reviewed"),
                "更新": self.entry("업데이트", "reviewed"),
            }
        )

        for name, malformed in malformed_sources.items():
            with self.subTest(shape=name):
                self.write("host/bad.cpp", malformed)
                self.write("host/good.cpp", valid)

                report = apply_overlay(self.root, mapping, self.policy, self.report)

                self.assertIn(
                    "CPP_PARSE_ERROR", {issue["code"] for issue in report["issues"]}
                )
                bad_issues = [
                    issue
                    for issue in report["issues"]
                    if issue.get("path") == "host/bad.cpp"
                ]
                if name != "anonymous-enum":
                    self.assertIn(0, {issue.get("occurrenceIndex") for issue in bad_issues})
                self.assertEqual(self.read("host/bad.cpp"), malformed)
                self.assertEqual(self.read("host/good.cpp"), valid)

    def test_exact_reviewed_recovery_evidence_allows_scanning_and_is_reported(self):
        original = self.RECOVERY_FIXTURE
        self.write("host/reviewed.cpp", original, newline="")
        self.write_policy([self.recovery_row()])
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"], [])
        self.assertEqual(
            report["parseRecoveryEvidence"],
            {
                "useCount": 1,
                "identities": [
                    {
                        "path": "host/reviewed.cpp",
                        "sourceRole": "upstream",
                        "sourceCommit": self.PINNED_UPSTREAM,
                        "fileSha256": self.RECOVERY_FILE_SHA256,
                        "recoverySha256": self.RECOVERY_FINGERPRINT_SHA256,
                    }
                ],
            },
        )
        self.assertIn("설정", self.read("host/reviewed.cpp"))

    def test_reviewed_recovery_file_hash_mismatch_blocks_all_writes(self):
        mutated = self.RECOVERY_FIXTURE.replace("Value", "Changed")
        valid = 'void Draw(){ Label(u8"更新"); }'
        self.write("host/reviewed.cpp", mutated, newline="")
        self.write("host/good.cpp", valid)
        self.write_policy([self.recovery_row()])
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "reviewed"),
                "更新": self.entry("업데이트", "reviewed"),
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"][0]["code"], "CPP_PARSE_ERROR")
        self.assertEqual(self.read("host/reviewed.cpp"), mutated)
        self.assertEqual(self.read("host/good.cpp"), valid)

    def test_recovery_fingerprint_mismatch_blocks_even_with_matching_file_hash(self):
        changed_shape = 'BROKEN(u8"設定")'
        changed_file_hash = hashlib.sha256(changed_shape.encode("utf-8")).hexdigest().upper()
        self.write("host/reviewed.cpp", changed_shape, newline="")
        self.write_policy([self.recovery_row(fileSha256=changed_file_hash)])
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"][0]["code"], "CPP_PARSE_ERROR")
        self.assertEqual(self.read("host/reviewed.cpp"), changed_shape)

    def test_wrong_recovery_path_hash_or_fingerprint_never_matches(self):
        wrong_rows = [
            self.recovery_row(path="host/other.cpp"),
            self.recovery_row(fileSha256="0" * 64),
            self.recovery_row(recoverySha256="0" * 64),
        ]
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        for row in wrong_rows:
            with self.subTest(row=row):
                self.write("host/reviewed.cpp", self.RECOVERY_FIXTURE, newline="")
                self.write_policy([row])

                report = apply_overlay(self.root, mapping, self.policy, self.report)

                self.assertEqual(report["issues"][0]["code"], "CPP_PARSE_ERROR")
                self.assertEqual(self.read("host/reviewed.cpp"), self.RECOVERY_FIXTURE)

    def test_malformed_or_duplicate_recovery_policy_blocks_before_scanning(self):
        invalid_lists = [
            None,
            {},
            ["not-an-object"],
            [self.recovery_row(reason="   ")],
            [self.recovery_row(fileSha256="a" * 64)],
            [self.recovery_row(recoverySha256="not-a-hash")],
            [self.recovery_row(sourceRole="other")],
            [self.recovery_row(sourceCommit="0" * 40)],
            [{**self.recovery_row(), "extra": True}],
            [self.recovery_row(), self.recovery_row()],
        ]
        original = self.RECOVERY_FIXTURE
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        for rows in invalid_lists:
            with self.subTest(rows=rows):
                self.write("host/reviewed.cpp", original, newline="")
                self.write_policy(rows)

                report = apply_overlay(self.root, mapping, self.policy, self.report)

                self.assertEqual(
                    {issue["code"] for issue in report["issues"]},
                    {"INVALID_POLICY_DOCUMENT"},
                )
                self.assertEqual(report["displayLiterals"], 0)
                self.assertEqual(self.read("host/reviewed.cpp"), original)

    def test_valid_file_without_recovery_needs_no_policy_row(self):
        source = 'void Draw(){ Label(u8"設定"); }'

        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))

        self.assertEqual([row.decoded for row in rows], ["設定"])

    def test_apply_is_transactional_when_any_row_is_unreviewed(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); ImGui::Text(u8"更新"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "reviewed"),
                "更新": self.entry("업데이트", "suggested"),
            }
        )
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "SUGGESTION_ONLY")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_unused_rows_with_unaccepted_statuses_block_all_writes(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "reviewed"),
                "未使用": self.entry("미사용", "suggested"),
            },
            contexts=[
                {
                    "path": "host/unused.cpp",
                    "function": "Unused",
                    "source": "未使用文脈",
                    "occurrenceIndex": 0,
                    "target": "미사용 문맥",
                    "status": "draft",
                    "provenance": "manual-context",
                    "formatSignature": [],
                }
            ],
        )
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(
            [issue["code"] for issue in report["issues"]],
            ["SUGGESTION_ONLY", "STATUS_REJECTED"],
        )
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_context_override_wins_and_preserves_signature(self):
        mapping = self.mapping(
            {"開啟 %s": self.entry("%s 열기", "reviewed", ["%s"])},
            contexts=[
                {
                    "path": "host/a.cpp",
                    "function": "DrawAtlas",
                    "source": "開啟 %s",
                    "occurrenceIndex": 0,
                    "target": "아틀라스 %s 열기",
                    "status": "reviewed",
                    "provenance": "manual-context",
                    "formatSignature": ["%s"],
                }
            ],
        )
        self.write("host/a.cpp", 'void DrawAtlas(){ ImGui::Text(u8"開啟 %s", name); }')
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"], [])
        self.assertIn("아틀라스 %s 열기", self.read("host/a.cpp"))
        self.assertEqual(report["reviewed"], 1)

    def test_signature_mismatch_blocks_all_files(self):
        first = 'void Draw(){ ImGui::Text(u8"設定"); }'
        second = 'void Draw(){ ImGui::Text(u8"開啟 %s", name); }'
        self.write("host/a.cpp", first)
        self.write("host/b.cpp", second)
        mapping = self.mapping(
            {
                "設定": self.entry("설정", "intentional"),
                "開啟 %s": self.entry("열기", "reviewed", []),
            }
        )
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "FORMAT_SIGNATURE_MISMATCH")
        self.assertEqual(self.read("host/a.cpp"), first)
        self.assertEqual(self.read("host/b.cpp"), second)

    def test_missing_mapping_blocks_all_files_and_report_is_written(self):
        first = 'void Draw(){ ImGui::Text(u8"設定"); }'
        second = 'void Draw(){ ImGui::Text(u8"新增"); }'
        self.write("host/a.cpp", first)
        self.write("host/b.cpp", second)
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "MISSING_MAPPING")
        self.assertEqual(json.loads(self.report.read_text(encoding="utf-8")), report)
        self.assertEqual(self.read("host/a.cpp"), first)
        self.assertEqual(self.read("host/b.cpp"), second)

    def test_non_object_mapping_root_writes_blocking_report(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.root / "source-literal-mapping.json"
        mapping.write_text("[]", encoding="utf-8")
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "INVALID_MAPPING_DOCUMENT")
        self.assertEqual(json.loads(self.report.read_text(encoding="utf-8")), report)
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_schema_v1_is_rejected_after_v2_cutover(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.root / "source-literal-mapping.json"
        mapping.write_text(
            json.dumps({"schemaVersion": 1, "entries": {}, "contexts": []}),
            encoding="utf-8",
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"][0]["code"], "INVALID_MAPPING_DOCUMENT")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_mapping_schema_requires_version_two_entries_and_contexts(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        invalid_documents = [
            {},
            {"schemaVersion": 3, "entries": {}, "contexts": []},
            {"schemaVersion": 2, "contexts": []},
            {"schemaVersion": 2, "entries": {}},
            {"schemaVersion": 2, "entries": [], "contexts": []},
            {"schemaVersion": 2, "entries": {}, "contexts": {}},
        ]
        for document in invalid_documents:
            with self.subTest(document=document):
                self.write("host/ui.cpp", original)
                mapping = self.root / "source-literal-mapping.json"
                mapping.write_text(
                    json.dumps(document, ensure_ascii=False), encoding="utf-8"
                )
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                self.assertEqual(
                    report["issues"][0]["code"], "INVALID_MAPPING_DOCUMENT"
                )
                self.assertEqual(
                    json.loads(self.report.read_text(encoding="utf-8")), report
                )
                self.assertEqual(self.read("host/ui.cpp"), original)

    def test_malformed_global_entry_writes_blocking_report(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"設定": "설정"})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "INVALID_MAPPING_ENTRY")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_malformed_context_entry_writes_blocking_report(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping(
            {"設定": self.entry("설정", "reviewed")},
            contexts=[{"path": "host/ui.cpp", "function": "Draw", "source": "設定"}],
        )
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "INVALID_CONTEXT_ENTRY")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_context_requires_nonnegative_occurrence_index(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        invalid_indexes = [None, True, "0", -1]
        for invalid_index in invalid_indexes:
            with self.subTest(occurrenceIndex=invalid_index):
                self.write("host/ui.cpp", original)
                context = {
                    "path": "host/ui.cpp",
                    "function": "Draw",
                    "source": "設定",
                    "target": "설정",
                    "status": "reviewed",
                    "provenance": "manual-context",
                    "formatSignature": [],
                }
                if invalid_index is not None:
                    context["occurrenceIndex"] = invalid_index
                mapping = self.mapping({}, contexts=[context])

                report = apply_overlay(self.root, mapping, self.policy, self.report)

                self.assertEqual(report["issues"][0]["code"], "INVALID_CONTEXT_ENTRY")
                self.assertEqual(self.read("host/ui.cpp"), original)

    def test_repeated_source_literals_resolve_by_function_occurrence_index(self):
        original = (
            'void Draw(){ ImGui::Text(u8"設定"); Log("trace"); '
            'ImGui::Text(u8"設定"); }'
        )
        self.write("host/ui.cpp", original)
        contexts = [
            {
                "path": "host/ui.cpp",
                "function": "Draw",
                "source": "設定",
                "occurrenceIndex": 0,
                "target": "첫 설정",
                "status": "reviewed",
                "provenance": "manual-context",
                "formatSignature": [],
            },
            {
                "path": "host/ui.cpp",
                "function": "Draw",
                "source": "設定",
                "occurrenceIndex": 2,
                "target": "둘째 설정",
                "status": "reviewed",
                "provenance": "manual-context",
                "formatSignature": [],
            },
        ]
        mapping = self.mapping(
            {"設定": self.entry("전역 설정", "reviewed")}, contexts=contexts
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"], [])
        self.assertEqual(
            self.read("host/ui.cpp"),
            original.replace("設定", "첫 설정", 1).replace("設定", "둘째 설정", 1),
        )
        self.assertNotIn("전역 설정", self.read("host/ui.cpp"))

    def test_duplicate_context_consumer_key_blocks_all_writes(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        context = {
            "path": "host/ui.cpp",
            "function": "Draw",
            "source": "設定",
            "occurrenceIndex": 0,
            "target": "설정",
            "status": "reviewed",
            "provenance": "manual-context",
            "formatSignature": [],
        }
        duplicate = {**context, "target": "환경 설정"}
        mapping = self.mapping({}, contexts=[context, duplicate])

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(
            [issue["code"] for issue in report["issues"]],
            ["INVALID_CONTEXT_ENTRY", "INVALID_CONTEXT_ENTRY"],
        )
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_unused_surrogate_target_writes_encoding_issue_without_mutation(self):
        original = 'void Draw(){ ImGui::Text(u8"設定"); }'
        self.write("host/ui.cpp", original)
        mapping = self.root / "source-literal-mapping.json"
        document = {
            "schemaVersion": 2,
            "entries": {
                "設定": self.entry("설정", "reviewed"),
                "未使用": self.entry("\ud800", "reviewed"),
            },
            "contexts": [],
        }
        mapping.write_text(json.dumps(document), encoding="utf-8")
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "INVALID_MAPPING_ENCODING")
        self.assertEqual(json.loads(self.report.read_text(encoding="utf-8")), report)
        self.assertEqual(self.read("host/ui.cpp"), original)


if __name__ == "__main__":
    unittest.main()
