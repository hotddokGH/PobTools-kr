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

    def entry(self, target, status, signature=None, provenance="manual", components=None):
        row = {
            "target": target,
            "status": status,
            "provenance": provenance,
            "formatSignature": [] if signature is None else signature,
        }
        if components is not None:
            row["components"] = components
        return row

    def mapping(self, entries, contexts=None):
        path = self.root / "source-literal-mapping.json"
        path.write_text(
            json.dumps(
                {"schemaVersion": 2, "entries": entries, "contexts": contexts or []},
                ensure_ascii=True,
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

    def write_policy(self, rows, internal=...):
        self.policy.write_text(
            json.dumps(
                {
                    "excludedPaths": [],
                    "internalLiteralAllowlist": [] if internal is ... else internal,
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

    def test_scans_immutable_ordered_components_for_regular_raw_and_mixed_prefixes(self):
        cases = {
            "comment": 'void Draw(){ Label(u8"設定" /* keep */ u8"更新"); }',
            "mixed": 'void Draw(){ Label(u8"設定" L"更新"); }',
            "raw": 'void Draw(){ Label(R"tag(設定)tag" "更新"); }',
        }
        expected = {
            "comment": [("設定", "u8", "regular"), ("更新", "u8", "regular")],
            "mixed": [("設定", "u8", "regular"), ("更新", "L", "regular")],
            "raw": [("設定", "R", "raw"), ("更新", "", "regular")],
        }
        for name, source in cases.items():
            with self.subTest(name=name):
                row = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))[0]
                self.assertEqual(
                    [(part.decoded, part.prefix, part.kind) for part in row.components],
                    expected[name],
                )
                self.assertEqual(row.decoded, "".join(part.decoded for part in row.components))
                self.assertEqual(
                    [source.encode("utf-8")[part.start : part.end].decode("utf-8") for part in row.components],
                    [
                        token
                        for token in (
                            ['u8"設定"', 'u8"更新"']
                            if name == "comment"
                            else ['u8"設定"', 'L"更新"']
                            if name == "mixed"
                            else ['R"tag(設定)tag"', '"更新"']
                        )
                    ],
                )
                with self.assertRaises((AttributeError, TypeError)):
                    row.components[0].decoded = "變更"

    def test_apply_replaces_each_component_without_touching_interstitial_bytes(self):
        original = (
            'void Draw(){ Label(u8"設定" /* keep */ L"更新"); }\r\n'
            'void Raw(){ Label(R"tag(設定)tag"  "更新"); }\r\n'
        )
        self.write("host/ui.cpp", original, newline="")
        components = [
            {"source": "設定", "target": "설정"},
            {"source": "更新", "target": "업데이트"},
        ]
        mapping = self.mapping(
            {
                "設定更新": self.entry(
                    "설정업데이트", "reviewed", components=components
                )
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"], [])
        expected = (
            'void Draw(){ Label(u8"설정" /* keep */ L"업데이트"); }\r\n'
            'void Raw(){ Label(R"tag(설정)tag"  "업데이트"); }\r\n'
        )
        self.assertEqual((self.root / "host/ui.cpp").read_bytes(), expected.encode("utf-8"))

    def test_component_plan_mismatches_block_all_files(self):
        bad_plans = {
            "missing": (None, None),
            "count": (
                [{"source": "設定", "target": "설정업데이트"}],
                (1, "更新"),
            ),
            "order": (
                [
                    {"source": "更新", "target": "업데이트"},
                    {"source": "設定", "target": "설정"},
                ],
                (0, "設定"),
            ),
            "joined-target": (
                [
                    {"source": "設定", "target": "설정"},
                    {"source": "更新", "target": "갱신"},
                ],
                (1, "更新"),
            ),
            "non-array": (
                {"source": "設定", "target": "설정업데이트"},
                (-1, "設定更新"),
            ),
            "non-string-source": (
                [
                    {"source": 7, "target": "설정"},
                    {"source": "更新", "target": "업데이트"},
                ],
                (0, "設定"),
            ),
            "non-string-target": (
                [
                    {"source": "設定", "target": "설정"},
                    {"source": "更新", "target": 7},
                ],
                (1, "更新"),
            ),
        }
        original = 'void Draw(){ Label(u8"設定" /* keep */ u8"更新"); }'
        valid = 'void Other(){ Label(u8"新增"); }'
        for name, (components, expected_detail) in bad_plans.items():
            with self.subTest(name=name):
                self.write("host/ui.cpp", original)
                self.write("host/other.cpp", valid)
                mapping = self.mapping(
                    {
                        "設定更新": self.entry(
                            "설정업데이트", "reviewed", components=components
                        ),
                        "新增": self.entry("추가", "reviewed"),
                    }
                )
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                expected_code = (
                    "MISSING_COMPONENT_MAPPING"
                    if name == "missing"
                    else "INVALID_COMPONENT_MAPPING"
                )
                self.assertEqual(report["issues"][0]["code"], expected_code)
                if expected_detail is not None:
                    self.assertEqual(
                        (
                            report["issues"][0]["componentIndex"],
                            report["issues"][0]["componentSource"],
                        ),
                        expected_detail,
                    )
                    self.assertTrue(report["issues"][0]["detail"])
                self.assertEqual(self.read("host/ui.cpp"), original)
                self.assertEqual(self.read("host/other.cpp"), valid)

    def test_unused_malformed_component_document_still_blocks_all_writes(self):
        original = 'void Draw(){ Label(u8"新增"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping(
            {
                "新增": self.entry("추가", "reviewed"),
                "設定更新": self.entry(
                    "설정업데이트", "reviewed", components={"invalid": True}
                ),
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(
            [issue["code"] for issue in report["issues"]],
            ["INVALID_COMPONENT_MAPPING"],
        )
        self.assertEqual(report["issues"][0]["componentIndex"], -1)
        self.assertEqual(report["issues"][0]["componentSource"], "設定更新")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_unused_malformed_component_issues_have_stable_consumer_identities(self):
        original = 'void Draw(){ Label(u8"English"); }'
        self.write("host/ui.cpp", original)
        bad = {"invalid": True}
        contexts = [
            {
                **self.entry("설정", "reviewed", components=bad),
                "path": "host\\b.cpp",
                "function": "Second",
                "source": "設定",
                "occurrenceIndex": 2,
            },
            {
                **self.entry("업데이트", "reviewed", components=bad),
                "path": "host/a.cpp",
                "function": "First",
                "source": "更新",
                "occurrenceIndex": 1,
            },
        ]
        mapping = self.mapping(
            {
                "更新": self.entry("업데이트", "reviewed", components=bad),
                "設定": self.entry("설정", "reviewed", components=bad),
            },
            contexts,
        )

        first = apply_overlay(self.root, mapping, self.policy, self.report)
        second = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(first["issues"], second["issues"])
        self.assertEqual(
            [
                (row.get("entryIndex"), row["componentSource"])
                for row in first["issues"]
                if "entryIndex" in row
            ],
            [(0, "更新"), (1, "設定")],
        )
        self.assertEqual(
            [
                (
                    row["contextIndex"], row["path"], row["function"],
                    row["occurrenceIndex"], row["source"],
                )
                for row in first["issues"]
                if "contextIndex" in row
            ],
            [
                (0, "host/b.cpp", "Second", 2, "設定"),
                (1, "host/a.cpp", "First", 1, "更新"),
            ],
        )
        self.assertEqual(len({json.dumps(row, sort_keys=True) for row in first["issues"]}), 4)
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_component_encoding_and_raw_delimiter_failures_are_transactional(self):
        cases = {
            "encoding": (
                'void Draw(){ Label(u8"設定" u8"更新"); }',
                [
                    {"source": "設定", "target": "설정"},
                    {"source": "更新", "target": "\ud800"},
                ],
                "INVALID_MAPPING_ENCODING",
            ),
            "raw-delimiter": (
                'void Draw(){ Label(R"tag(設定)tag" "更新"); }',
                [
                    {"source": "設定", "target": '끝 )tag" 충돌'},
                    {"source": "更新", "target": "업데이트"},
                ],
                "RAW_DELIMITER_COLLISION",
            ),
        }
        for name, (original, components, code) in cases.items():
            with self.subTest(name=name):
                self.write("host/ui.cpp", original)
                target = "".join(row["target"] for row in components)
                mapping = self.mapping(
                    {"設定更新": self.entry(target, "reviewed", components=components)}
                )
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                self.assertEqual(report["issues"][0]["code"], code)
                self.assertEqual(self.read("host/ui.cpp"), original)

    def test_internal_literal_allowlist_requires_exact_path_and_expression_hash(self):
        source = (
            'void Draw(){ auto json = u8R"json({"key":")json" /* gap */ '
            'u8"設定" R"json("})json"; }'
        )
        decoded = '{"key":"設定"}'
        digest = hashlib.sha256(decoded.encode("utf-8")).hexdigest().upper()
        mapping = self.mapping({})

        for relative, allowed_path, allowed_digest, expected_code in (
            ("host/fixture.cpp", "host/fixture.cpp", digest, None),
            ("host/other.cpp", "host/fixture.cpp", digest, "MISSING_MAPPING"),
            ("host/wrong-hash.cpp", "host/wrong-hash.cpp", "0" * 64, "MISSING_MAPPING"),
        ):
            with self.subTest(relative=relative):
                self.write(relative, source)
                self.write_policy(
                    [],
                    [
                        {
                            "path": allowed_path,
                            "sha256": allowed_digest,
                            "reason": "exact synthetic JSON parser fixture",
                        }
                    ],
                )
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                if expected_code is None:
                    self.assertEqual(report["issues"], [])
                    self.assertEqual(report["intentional"], 1)
                else:
                    self.assertIn(expected_code, {row["code"] for row in report["issues"]})

    def test_internal_allowlist_does_not_hide_a_different_expression_in_same_file(self):
        allowed = '{"key":"設定"}'
        source = (
            'void Draw(){ auto internal = u8R"json({"key":")json" u8"設定" '
            'R"json("})json"; Label(u8"更新" "顯示"); }'
        )
        self.write("host/fixture.cpp", source)
        self.write_policy(
            [],
            [
                {
                    "path": "host/fixture.cpp",
                    "sha256": hashlib.sha256(allowed.encode("utf-8")).hexdigest().upper(),
                    "reason": "exact synthetic JSON parser fixture",
                }
            ],
        )

        report = apply_overlay(self.root, self.mapping({}), self.policy, self.report)

        self.assertEqual(report["intentional"], 1)
        self.assertEqual(
            [(row["code"], row["source"]) for row in report["issues"]],
            [("MISSING_MAPPING", "更新顯示")],
        )

    def test_malformed_or_duplicate_internal_allowlist_blocks_before_scanning(self):
        valid = {
            "path": "host/fixture.cpp",
            "sha256": "A" * 64,
            "reason": "reviewed internal fixture",
        }
        invalid_lists = [
            None,
            {},
            ["not-an-object"],
            [{key: value for key, value in valid.items() if key != "path"}],
            [{**valid, "path": 7}],
            [{**valid, "path": "host\\fixture.cpp"}],
            [{**valid, "path": "C:/host/fixture.cpp"}],
            [{**valid, "path": "host/\ud800.cpp"}],
            [{**valid, "sha256": 7}],
            [{**valid, "sha256": "a" * 64}],
            [{**valid, "sha256": "BAD"}],
            [{**valid, "reason": "   "}],
            [{**valid, "extra": True}],
            [valid, dict(valid)],
        ]
        original = 'void Draw(){ Label(u8"設定"); }'
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        for rows in invalid_lists:
            with self.subTest(rows=rows):
                self.write("host/fixture.cpp", original)
                self.write_policy([], rows)
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                self.assertTrue(report["issues"])
                self.assertEqual(
                    {row["code"] for row in report["issues"]},
                    {"INVALID_POLICY_DOCUMENT"},
                )
                self.assertEqual(self.read("host/fixture.cpp"), original)

    def test_internal_allowlist_accepts_valid_korean_path_and_replacement_scalar(self):
        relative = "host/한글.cpp"
        decoded = "設定\ufffd"
        original = f'void Draw(){{ Label(u8"{decoded}"); }}'
        self.write(relative, original)
        self.write_policy(
            [],
            [{
                "path": relative,
                "sha256": hashlib.sha256(decoded.encode("utf-8")).hexdigest().upper(),
                "reason": "valid non-ASCII path and replacement scalar",
            }],
        )

        report = apply_overlay(self.root, self.mapping({}), self.policy, self.report)

        self.assertEqual(report["issues"], [])
        self.assertEqual(report["intentional"], 1)

    def test_invalid_utf8_source_bytes_are_structured_and_transactional(self):
        valid = 'void Other(){ Label(u8"更新"); }'
        self.write("host/valid.cpp", valid)
        mapping = self.mapping({"更新": self.entry("업데이트", "reviewed")})
        for invalid in (b"\xED\xA0\x80", b"\xFF"):
            with self.subTest(invalid=invalid.hex().upper()):
                path = self.root / "host" / "invalid.cpp"
                original = b'void Draw(){ Label(u8"' + invalid + b'"); }'
                path.write_bytes(original)
                try:
                    report = apply_overlay(self.root, mapping, self.policy, self.report)
                except UnicodeDecodeError as error:
                    self.fail(f"source decoding escaped the report boundary: {error}")

                self.assertEqual(
                    [issue["code"] for issue in report["issues"]],
                    ["INVALID_SOURCE_ENCODING"],
                )
                self.assertEqual(report["issues"][0]["path"], "host/invalid.cpp")
                self.assertIs(type(report["issues"][0]["startByte"]), int)
                self.assertTrue(self.report.is_file())
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(self.read("host/valid.cpp"), valid)

    def test_apply_blocks_concatenation_with_interstitial_comment(self):
        original = 'void Draw(){ ImGui::Text(u8"設定" /* keep */ u8"更新"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"設定更新": self.entry("설정 업데이트", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "MISSING_COMPONENT_MAPPING")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_apply_blocks_concatenation_with_mixed_prefixes(self):
        original = 'void Draw(){ ImGui::Text(u8"設定" L"更新"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({"設定更新": self.entry("설정 업데이트", "reviewed")})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "MISSING_COMPONENT_MAPPING")
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_format_signature_counts_decoded_newlines(self):
        self.assertEqual(
            format_signature("Gain {0} %s\n^xFF00FF"),
            ("%s", "<NL>", "^xFF00FF", "{0}"),
        )

    def test_format_signature_counts_exact_nul(self):
        self.assertIn("<NUL>", format_signature("필터\0모든 파일\0\0"))

    def test_exact_nul_wide_table_round_trips_semantically(self):
        original = 'void Draw(){ auto table = L"篩選器\\0所有檔案\\0\\0"; }'
        self.write("host/ui.cpp", original)
        source = "篩選器\0所有檔案\0\0"
        target = "필터\0모든 파일\0\0"
        mapping = self.mapping(
            {source: self.entry(target, "reviewed", ["<NUL>", "<NUL>", "<NUL>"])}
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"], [])
        changed = (self.root / "host/ui.cpp").read_bytes()
        self.assertIn('L"필터\\0모든 파일\\0\\0"'.encode("utf-8"), changed)
        rescanned = scan_cpp_literals(Path("host/ui.cpp"), changed)
        self.assertEqual(rescanned[0].decoded, target)

    def test_octal_and_extended_nul_escapes_are_rejected_transactionally(self):
        for escape in (r"\1", r"\00", r"\07", r"\01"):
            with self.subTest(escape=escape):
                original = f'void Draw(){{ Label(u8"設定{escape}"); }}'
                self.write("host/ui.cpp", original)
                mapping = self.mapping({})
                report = apply_overlay(self.root, mapping, self.policy, self.report)
                self.assertEqual(report["issues"][0]["code"], "UNSUPPORTED_ESCAPE")
                self.assertEqual(report["issues"][0]["escape"], escape)
                self.assertEqual(self.read("host/ui.cpp"), original)

    def test_unicode_surrogate_escape_is_a_structured_transactional_issue(self):
        malformed = 'void Draw(){ Label(u8"設定\\uD800"); }'
        valid = 'void Other(){ Label(u8"更新"); }'
        self.write("host/malformed.cpp", malformed)
        self.write("host/valid.cpp", valid)
        mapping = self.mapping({"更新": self.entry("업데이트", "reviewed")})

        try:
            report = apply_overlay(self.root, mapping, self.policy, self.report)
        except UnicodeEncodeError as error:
            self.fail(f"surrogate escaped the structured issue boundary: {error}")

        self.assertEqual(report["issues"][0]["code"], "UNSUPPORTED_ESCAPE")
        self.assertEqual(report["issues"][0]["escape"], r"\uD800")
        self.assertEqual(self.read("host/malformed.cpp"), malformed)
        self.assertEqual(self.read("host/valid.cpp"), valid)

    def test_line_splices_preserve_one_semantic_adjacent_expression(self):
        decoded = "設定更新"
        digest = hashlib.sha256(decoded.encode("utf-8")).hexdigest().upper()
        mapping = self.mapping({})
        for newline in ("\n", "\r\n"):
            with self.subTest(newline=repr(newline)):
                source = (
                    f'void Draw(){{ auto between = u8"設定" \\{newline} L"更新"; '
                    f'auto inside = u8"設定\\{newline}更新"; }}'
                )
                self.write("host/splice.cpp", source, newline="")
                self.write_policy(
                    [],
                    [{
                        "path": "host/splice.cpp",
                        "sha256": digest,
                        "reason": "line-spliced semantic fixture",
                    }],
                )

                report = apply_overlay(self.root, mapping, self.policy, self.report)

                self.assertEqual(report["issues"], [])
                self.assertEqual(report["displayLiterals"], 2)
                self.assertEqual(report["intentional"], 2)
                self.assertEqual(
                    [row.decoded for row in scan_cpp_literals(
                        Path("host/splice.cpp"), source.encode("utf-8")
                    )],
                    [decoded, decoded],
                )

    def test_prefix_line_splices_are_preserved_byte_exact_during_replacement(self):
        cases = (
            ("u8", '"設定"', '"설정"'),
            ("u", '"設定"', '"설정"'),
            ("U", '"設定"', '"설정"'),
            ("L", '"設定"', '"설정"'),
            ("u8", 'R"tag(設定)tag"', 'R"tag(설정)tag"'),
            ("L", 'R"tag(設定)tag"', 'R"tag(설정)tag"'),
        )
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        for prefix, original_token, target_token in cases:
            for newline in ("\n", "\r\n"):
                with self.subTest(prefix=prefix, token=original_token, newline=repr(newline)):
                    original = (
                        f"void Draw(){{ auto value = {prefix}\\{newline}"
                        f"{original_token}; }}"
                    )
                    expected = original.replace(original_token, target_token)
                    self.write("host/prefix.cpp", original, newline="")

                    rows = scan_cpp_literals(
                        Path("host/prefix.cpp"), original.encode("utf-8")
                    )
                    self.assertEqual(
                        rows[0].prefix,
                        prefix + ("R" if original_token.startswith("R") else ""),
                    )
                    report = apply_overlay(
                        self.root, mapping, self.policy, self.report
                    )

                    self.assertEqual(report["issues"], [])
                    self.assertEqual(
                        (self.root / "host/prefix.cpp").read_bytes(),
                        expected.encode("utf-8"),
                    )

    def test_spliced_raw_prefixes_use_payload_identity_and_preserve_original_bytes(self):
        forms = (
            "R\\{nl}", "u8R\\{nl}", "uR\\{nl}", "UR\\{nl}", "LR\\{nl}",
            "u\\{nl}8R", "u8\\{nl}R", "u\\{nl}R", "U\\{nl}R", "L\\{nl}R",
            "u\\{nl}8\\{nl}R\\{nl}",
        )
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})
        for form in forms:
            semantic_prefix = form.replace("\\{nl}", "").replace("{nl}", "")
            for delimiter in ("", "tag"):
                for newline in ("\n", "\r\n"):
                    with self.subTest(form=form, delimiter=delimiter, newline=repr(newline)):
                        prefix = form.format(nl=newline)
                        token = f'{prefix}"{delimiter}(設定){delimiter}"'
                        original = f"void Draw(){{ auto value = {token}; }}"
                        expected = original.replace("設定", "설정")
                        self.write("host/raw-prefix.cpp", original, newline="")

                        rows = scan_cpp_literals(
                            Path("host/raw-prefix.cpp"), original.encode("utf-8")
                        )
                        self.assertEqual(
                            [(row.decoded, row.prefix, row.start, row.end) for row in rows],
                            [("設定", semantic_prefix, original.encode("utf-8").index(token.encode("utf-8")), original.encode("utf-8").index(token.encode("utf-8")) + len(token.encode("utf-8")))],
                        )
                        report = apply_overlay(
                            self.root, mapping, self.policy, self.report
                        )

                        self.assertEqual(report["issues"], [])
                        self.assertEqual(
                            (self.root / "host/raw-prefix.cpp").read_bytes(),
                            expected.encode("utf-8"),
                        )

    def test_spliced_raw_prefix_does_not_accept_regular_delimiter_text_identity(self):
        original = 'void Draw(){ auto value = u\\\n8R"tag(設定)tag"; }'
        self.write("host/raw-prefix.cpp", original, newline="")
        wrong = self.mapping(
            {"tag(設定)tag": self.entry("잘못된 값", "reviewed")}
        )

        report = apply_overlay(self.root, wrong, self.policy, self.report)

        self.assertEqual(
            [(row["code"], row["source"]) for row in report["issues"]],
            [("MISSING_MAPPING", "設定")],
        )
        self.assertEqual(self.read("host/raw-prefix.cpp"), original)

    def test_spliced_raw_component_replacement_preserves_adjacent_trivia(self):
        original = (
            'void Draw(){ Label(u\\\r\n8R"tag(設定)tag" /* keep */ L"更新"); }'
        )
        expected = original.replace("設定", "설정").replace("更新", "업데이트")
        self.write("host/raw-prefix.cpp", original, newline="")
        mapping = self.mapping(
            {
                "設定更新": self.entry(
                    "설정업데이트",
                    "reviewed",
                    components=[
                        {"source": "設定", "target": "설정"},
                        {"source": "更新", "target": "업데이트"},
                    ],
                )
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"], [])
        self.assertEqual(
            (self.root / "host/raw-prefix.cpp").read_bytes(), expected.encode("utf-8")
        )

    def test_raw_payload_splices_retain_original_semantics_and_bytes(self):
        for prefix_newline in ("\n", "\r\n"):
            for payload_newline in ("\n", "\r\n"):
                for delimiter in ("", "tag"):
                    with self.subTest(
                        prefix_newline=repr(prefix_newline),
                        payload_newline=repr(payload_newline),
                        delimiter=delimiter,
                    ):
                        raw_source = f"設定\\{payload_newline}更新"
                        raw_target = f"설정\\{payload_newline}업데이트"
                        prefix = f"u\\{prefix_newline}8R\\{prefix_newline}"
                        token = f'{prefix}"{delimiter}({raw_source}){delimiter}"'
                        original = (
                            f"void Draw(){{ Label({token} /* keep */ L\"追加\"); }}"
                        )
                        expected = original.replace("設定", "설정").replace(
                            "更新", "업데이트"
                        ).replace("追加", "추가")
                        self.write("host/raw-payload.cpp", original, newline="")
                        joined_source = raw_source + "追加"
                        joined_target = raw_target + "추가"
                        mapping = self.mapping(
                            {
                                joined_source: self.entry(
                                    joined_target,
                                    "reviewed",
                                    list(format_signature(joined_source)),
                                    components=[
                                        {"source": raw_source, "target": raw_target},
                                        {"source": "追加", "target": "추가"},
                                    ],
                                )
                            }
                        )

                        rows = scan_cpp_literals(
                            Path("host/raw-payload.cpp"), original.encode("utf-8")
                        )
                        self.assertEqual(rows[0].decoded, joined_source)
                        self.assertEqual(
                            [component.decoded for component in rows[0].components],
                            [raw_source, "追加"],
                        )
                        report = apply_overlay(
                            self.root, mapping, self.policy, self.report
                        )

                        self.assertEqual(report["issues"], [])
                        self.assertEqual(
                            (self.root / "host/raw-payload.cpp").read_bytes(),
                            expected.encode("utf-8"),
                        )

    def test_collapsed_raw_payload_mapping_is_missing_and_transactional(self):
        original = 'void Draw(){ Label(R"tag(設定\\\r\n更新)tag"); }'
        self.write("host/raw-payload.cpp", original, newline="")
        mapping = self.mapping(
            {"設定更新": self.entry("설정업데이트", "reviewed")}
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(
            [(issue["code"], issue["source"]) for issue in report["issues"]],
            [("MISSING_MAPPING", "設定\\\r\n更新")],
        )
        self.assertEqual(self.read("host/raw-payload.cpp"), original)

    def test_raw_payload_plan_is_not_written_when_neighbor_has_parse_error(self):
        valid = 'void Draw(){ Label(u\\\n8R"tag(設定\\\n更新)tag"); }'
        malformed = 'void Broken( { Label(u8"設定"); }'
        self.write("host/valid.cpp", valid, newline="")
        self.write("host/malformed.cpp", malformed, newline="")
        source = "設定\\\n更新"
        target = "설정\\\n업데이트"
        mapping = self.mapping(
            {
                source: self.entry(
                    target, "reviewed", list(format_signature(source))
                )
            }
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertTrue(any(row["code"] == "CPP_PARSE_ERROR" for row in report["issues"]))
        self.assertEqual(self.read("host/valid.cpp"), valid)
        self.assertEqual(self.read("host/malformed.cpp"), malformed)

    def test_nul_followed_by_octal_digit_cannot_be_encoded(self):
        original = 'void Draw(){ Label(u8"設定\\0X"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping(
            {"設定\0X": self.entry("설정\0" + "7", "reviewed", ["<NUL>"])}
        )

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"][0]["code"], "UNSAFE_NUL_ENCODING")
        self.assertEqual(self.read("host/ui.cpp"), original)

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

    def test_recovery_evidence_rejects_normalized_line_endings(self):
        crlf_source = self.RECOVERY_FIXTURE.replace("\n", "\r\n")
        self.write("host/reviewed.cpp", crlf_source, newline="")
        self.write_policy([self.recovery_row()])
        mapping = self.mapping({"設定": self.entry("설정", "reviewed")})

        report = apply_overlay(self.root, mapping, self.policy, self.report)

        self.assertEqual(report["issues"][0]["code"], "CPP_PARSE_ERROR")
        self.assertNotEqual(
            report["issues"][0]["fileSha256"], self.RECOVERY_FILE_SHA256
        )
        self.assertEqual(self.read("host/reviewed.cpp"), crlf_source)

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
