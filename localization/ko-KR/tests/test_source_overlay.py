import json
import sys
import tempfile
import unittest
from pathlib import Path


LIB_ROOT = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(LIB_ROOT))

from source_overlay import apply_overlay, format_signature, scan_cpp_literals


class SourceOverlayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.policy = self.root / "source-display-policy.json"
        self.report = self.root / "overlay-report.json"
        self.policy.write_text(
            json.dumps({"excludedPaths": [], "internalLiteralAllowlist": []}),
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
            json.dumps({"entries": entries, "contexts": contexts or []}, ensure_ascii=False),
            encoding="utf-8",
        )
        return path

    def test_scans_prefixes_raw_strings_comments_and_function_context(self):
        source = (
            '// u8"忽略"\n'
            'void Draw(){ ImGui::Text(u8"設定 %d\\n"); '
            'auto a = L"寬字"; auto b = LR"tag(更新)tag"; }'
        )
        rows = scan_cpp_literals(Path("host/ui.cpp"), source.encode("utf-8"))
        self.assertEqual([row.decoded for row in rows], ["設定 %d\n", "寬字", "更新"])
        self.assertEqual({row.function for row in rows}, {"Draw"})

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
        self.assertEqual(self.read("host/ui.cpp"), original)

    def test_long_hex_escape_is_rejected_instead_of_partially_decoded(self):
        original = 'void Draw(){ ImGui::Text(u8"設定\\x414"); }'
        self.write("host/ui.cpp", original)
        mapping = self.mapping({})
        report = apply_overlay(self.root, mapping, self.policy, self.report)
        self.assertEqual(report["issues"][0]["code"], "UNSUPPORTED_ESCAPE")
        self.assertEqual(report["issues"][0]["escape"], "\\x414")
        self.assertEqual(self.read("host/ui.cpp"), original)

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

    def test_context_override_wins_and_preserves_signature(self):
        mapping = self.mapping(
            {"開啟 %s": self.entry("%s 열기", "reviewed", ["%s"])},
            contexts=[
                {
                    "path": "host/a.cpp",
                    "function": "DrawAtlas",
                    "source": "開啟 %s",
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


if __name__ == "__main__":
    unittest.main()
