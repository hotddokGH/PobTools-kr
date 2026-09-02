import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path


LOCALE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = LOCALE_ROOT.parents[1]
MIGRATION_SCRIPT = LOCALE_ROOT / "migrate-source-translations.py"
REMEDIATION_PATH = LOCALE_ROOT / "manual" / "source-overlay-remediation.json"
BLOCKER_REPORT_PATH = (
    REPOSITORY_ROOT / "reports" / "maintenance" / "baseline-overlay-blockers.json"
)


def load_migration_module():
    spec = importlib.util.spec_from_file_location(
        "migrate_source_translations_for_overlay_remediation", MIGRATION_SCRIPT
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {MIGRATION_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


migration = load_migration_module()


class OverlayRemediationTests(unittest.TestCase):
    def load_reviewed_documents(self):
        return (
            json.loads(REMEDIATION_PATH.read_text(encoding="utf-8")),
            json.loads(BLOCKER_REPORT_PATH.read_text(encoding="utf-8")),
        )

    def validate(self, document, blocker_report):
        return migration.validate_remediation_document(
            document,
            blocker_report,
            repository_root=REPOSITORY_ROOT,
        )

    def test_reviewed_remediation_decisions_cover_every_baseline_consumer(self):
        document, blocker_report = self.load_reviewed_documents()

        result = self.validate(document, blocker_report)

        self.assertEqual((), result.issues)
        self.assertEqual(
            migration.blocker_consumer_identities(blocker_report),
            result.consumed_consumer_identities,
        )
        self.assertEqual(66, len(document["contexts"]))
        self.assertEqual(91, len(result.overrides["contexts"]))
        self.assertEqual({}, result.overrides["entries"])
        self.assertEqual(2, len(result.internal_fixtures))

    def test_validator_rejects_missing_or_extra_consumer_decisions(self):
        document, blocker_report = self.load_reviewed_documents()

        missing = copy.deepcopy(document)
        missing["contexts"].pop()
        missing_result = self.validate(missing, blocker_report)
        self.assertIn("MISSING_REMEDIATION_DECISION", {issue["code"] for issue in missing_result.issues})

        extra = copy.deepcopy(document)
        extra["contexts"].append(copy.deepcopy(extra["contexts"][0]))
        extra["contexts"][-1]["occurrenceIndex"] = 999999
        extra_result = self.validate(extra, blocker_report)
        self.assertIn("UNCONSUMED_REMEDIATION_DECISION", {issue["code"] for issue in extra_result.issues})

    def test_validator_rejects_provenance_and_pinned_identity_drift(self):
        document, blocker_report = self.load_reviewed_documents()

        commit_drift = copy.deepcopy(document)
        commit_drift["upstreamCommit"] = "0" * 40
        commit_result = self.validate(commit_drift, blocker_report)
        self.assertIn("INVALID_REMEDIATION_PIN", {issue["code"] for issue in commit_result.issues})

        suggested = copy.deepcopy(document)
        suggested["contexts"][0]["provenance"] = "suggested"
        suggested_result = self.validate(suggested, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_PROVENANCE",
            {issue["code"] for issue in suggested_result.issues},
        )

    def test_validator_rejects_invented_evidence_and_signature_drift(self):
        document, blocker_report = self.load_reviewed_documents()

        invented = copy.deepcopy(document)
        invented["contexts"][0]["source"] = "不存在的字串"
        invented_result = self.validate(invented, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_SOURCE",
            {issue["code"] for issue in invented_result.issues},
        )

        signature_drift = copy.deepcopy(document)
        signature_drift["contexts"][0]["formatSignature"] = ["%d"]
        signature_result = self.validate(signature_drift, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_SIGNATURE",
            {issue["code"] for issue in signature_result.issues},
        )

        unsupported_target = copy.deepcopy(document)
        unsupported_target["contexts"][0]["target"] = "근거 없는 번역"
        target_result = self.validate(unsupported_target, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_TARGET_EVIDENCE",
            {issue["code"] for issue in target_result.issues},
        )

    def test_validator_rejects_any_fixture_outside_the_two_reviewed_json_expressions(self):
        document, blocker_report = self.load_reviewed_documents()
        invalid_fixture = copy.deepcopy(document)
        invalid_fixture["internalFixtures"].append(
            {
                "path": "host/atlas_planner.cpp",
                "sha256": "A" * 64,
                "reason": "not a reviewed internal fixture",
            }
        )

        result = self.validate(invalid_fixture, blocker_report)

        self.assertIn("UNEXPECTED_INTERNAL_FIXTURE", {issue["code"] for issue in result.issues})

    def test_supporting_contexts_are_exactly_the_twenty_five_pinned_migration_rows(self):
        document, blocker_report = self.load_reviewed_documents()

        supporting = document["supportingContexts"]
        result = self.validate(document, blocker_report)

        app_update_seed = (
            "host/app_update.cpp",
            "",
            60,
            "已取消回應為空連線失敗（網路無法使用？）建立 HTTP 請求 HTTPS 初始化無法建立解壓目錄格式無效條目資訊讀取路徑非法檔案寫入失敗回滾備份",
        )

        self.assertEqual(25, len(supporting))
        self.assertEqual(66, len(document["contexts"]))
        self.assertIn(app_update_seed, migration.supporting_context_identities())
        self.assertEqual(
            migration.supporting_context_identities(),
            result.consumed_supporting_context_identities,
        )
        self.assertEqual((), result.issues)
        app_update_row = next(
            row
            for row in supporting
            if (
                row["path"],
                row["function"],
                row["occurrenceIndex"],
                row["source"],
            )
            == app_update_seed
        )
        self.assertEqual(
            [
                {
                    "source": "已取消回應為空連線失敗（網路無法使用？）建立 HTTP 請求 HTTPS 初始化",
                    "target": "취소됨 응답 없음 연결 실패(네트워크 사용 불가?) HTTP 요청 생성 실패 HTTPS 초기화 실패",
                },
                {
                    "source": "無法建立解壓目錄格式無效條目資訊讀取路徑非法檔案寫入失敗回滾備份",
                    "target": "압축 해제 폴더 생성 실패 잘못된 형식 항목 정보 읽기 실패 잘못된 경로 파일 쓰기 실패 롤백 백업",
                },
            ],
            app_update_row["components"],
        )
        for row in supporting:
            self.assertEqual("manual-reviewed-supporting-context", row["provenance"])
            self.assertEqual("localized-literal", row["evidenceMode"])
            expected_components = 2 if row is app_update_row else (1 if row["source"] else 0)
            self.assertEqual(expected_components, len(row["components"]))

    def test_supporting_contexts_fail_closed_for_duplicate_extra_and_invented_rows(self):
        document, blocker_report = self.load_reviewed_documents()

        missing = copy.deepcopy(document)
        missing["supportingContexts"].pop()
        missing_result = self.validate(missing, blocker_report)
        self.assertIn(
            "MISSING_SUPPORTING_CONTEXT",
            {issue["code"] for issue in missing_result.issues},
        )

        duplicate = copy.deepcopy(document)
        duplicate["supportingContexts"].append(
            copy.deepcopy(duplicate["supportingContexts"][0])
        )
        duplicate_result = self.validate(duplicate, blocker_report)
        self.assertIn(
            "DUPLICATE_SUPPORTING_CONTEXT",
            {issue["code"] for issue in duplicate_result.issues},
        )

        extra = copy.deepcopy(document)
        extra["supportingContexts"].append(
            {
                **copy.deepcopy(extra["supportingContexts"][0]),
                "occurrenceIndex": 999999,
                "upstreamOccurrenceIndex": 999999,
            }
        )
        extra_result = self.validate(extra, blocker_report)
        self.assertIn(
            "UNCONSUMED_SUPPORTING_CONTEXT",
            {issue["code"] for issue in extra_result.issues},
        )

        invented = copy.deepcopy(document)
        invented["supportingContexts"][0]["target"] = "근거 없는 지원 번역"
        invented_result = self.validate(invented, blocker_report)
        self.assertIn(
            "INVALID_SUPPORTING_CONTEXT_EVIDENCE",
            {issue["code"] for issue in invented_result.issues},
        )

        suggested = copy.deepcopy(document)
        suggested["supportingContexts"][0]["provenance"] = "suggested"
        suggested_result = self.validate(suggested, blocker_report)
        self.assertIn(
            "INVALID_SUPPORTING_CONTEXT_PROVENANCE",
            {issue["code"] for issue in suggested_result.issues},
        )

    def test_validated_internal_fixture_rows_are_removed_before_migration_alignment(self):
        document, blocker_report = self.load_reviewed_documents()
        fixture_issue = next(
            issue
            for issue in blocker_report["issues"]
            if issue["path"] == "host/atlas_diff.cpp"
        )
        matching = migration.Alignment(
            fixture_issue["path"],
            fixture_issue["function"],
            fixture_issue["source"],
            "raw Korean fixture evidence",
            fixture_issue["occurrenceIndex"],
            fixture_issue["line"],
        )
        nonmatching = migration.Alignment(
            fixture_issue["path"],
            fixture_issue["function"],
            fixture_issue["source"] + " drift",
            "raw Korean fixture evidence",
            fixture_issue["occurrenceIndex"],
            fixture_issue["line"],
        )

        alignments, issues = migration.remove_validated_internal_fixture_rows(
            [matching, nonmatching], [fixture_issue], document["internalFixtures"]
        )

        self.assertEqual([nonmatching], alignments)
        self.assertEqual([], issues)

    def test_manual_ui_reflow_is_exclusive_to_the_pinned_changelog_identity(self):
        document, blocker_report = self.load_reviewed_documents()
        changelog = next(
            context
            for context in document["contexts"]
            if context["path"] == "host/changelog.h"
            and context["function"] == ""
            and context["occurrenceIndex"] == 0
        )
        self.assertEqual("manual-ui-reflow", changelog["evidenceMode"])

        invalid = copy.deepcopy(document)
        other = next(
            context
            for context in invalid["contexts"]
            if context["path"] != "host/changelog.h"
        )
        other["evidenceMode"] = "manual-ui-reflow"
        result = self.validate(invalid, blocker_report)

        self.assertIn(
            "INVALID_REMEDIATION_EVIDENCE_MODE",
            {issue["code"] for issue in result.issues},
        )

    def test_changelog_manual_reflow_rejects_blank_visible_components_and_missing_versions(self):
        document, blocker_report = self.load_reviewed_documents()
        changelog = next(
            context
            for context in document["contexts"]
            if context["path"] == "host/changelog.h"
            and context["function"] == ""
            and context["occurrenceIndex"] == 0
        )
        self.assertEqual(419, len(changelog["components"]))

        blanked = copy.deepcopy(document)
        blanked_changelog = next(
            context
            for context in blanked["contexts"]
            if context["path"] == "host/changelog.h"
        )
        first_visible = next(
            component
            for component in blanked_changelog["components"]
            if component["source"].strip()
        )
        first_visible["target"] = "\n" if first_visible["source"].endswith("\n") else ""
        blanked_changelog["target"] = "".join(
            component["target"] for component in blanked_changelog["components"]
        )
        result = self.validate(blanked, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_CHANGELOG_REFLOW",
            {issue["code"] for issue in result.issues},
        )

        missing_version = copy.deepcopy(document)
        version_changelog = next(
            context
            for context in missing_version["contexts"]
            if context["path"] == "host/changelog.h"
        )
        version_changelog["components"][0]["target"] = "한국어판 변경 기록\n"
        version_changelog["target"] = "".join(
            component["target"] for component in version_changelog["components"]
        )
        version_result = self.validate(missing_version, blocker_report)
        self.assertIn(
            "INVALID_REMEDIATION_CHANGELOG_REFLOW",
            {issue["code"] for issue in version_result.issues},
        )

    def test_manual_third_party_review_is_exclusive_to_the_reviewed_poedb_label(self):
        document, blocker_report = self.load_reviewed_documents()
        poedb = next(
            context
            for context in document["contexts"]
            if context["path"] == "host/launcher_ui.cpp"
            and context["function"] == ""
            and context["occurrenceIndex"] == 20
        )
        self.assertEqual("manual-third-party-ui", poedb["evidenceMode"])
        self.assertEqual("PoeDB 패스 오브 엑자일 위키", poedb["target"])
        self.assertEqual("https://poedb.tw/kr/", poedb["evidenceUrl"])

        invalid = copy.deepcopy(document)
        other = next(
            context
            for context in invalid["contexts"]
            if context["path"] != "host/launcher_ui.cpp"
        )
        other["evidenceMode"] = "manual-third-party-ui"
        result = self.validate(invalid, blocker_report)

        self.assertIn(
            "INVALID_REMEDIATION_EVIDENCE_MODE",
            {issue["code"] for issue in result.issues},
        )


if __name__ == "__main__":
    unittest.main()
