"""Migrate the pinned PoE1 Korean source baseline into reviewed overlay data.

The pinned upstream tree is read with Git object commands only.  No source from
that tree is imported, compiled, or executed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


LOCALE_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = LOCALE_ROOT.parent.parent
LIB_ROOT = LOCALE_ROOT / "lib"
if str(LIB_ROOT) not in sys.path:
    sys.path.insert(0, str(LIB_ROOT))

import source_overlay  # noqa: E402
from source_overlay import Literal, format_signature  # noqa: E402


PINNED_UPSTREAM = "baf07d41d2df524d4330a58b411826339c93fac1"
HAN = re.compile(
    r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF"
    r"\U00020000-\U0002FA1F\U00030000-\U000323AF]"
)
HANGUL = re.compile(r"[가-힣]")
SOURCE_SUFFIXES = frozenset({".cpp", ".h"})
DICTIONARIES = ("tags", "items", "gems", "ui", "stats", "passives", "uniques", "monsters")


@dataclass(frozen=True)
class Alignment:
    path: str
    function: str
    source: str
    target: str
    occurrence_index: int
    line: int


@dataclass(frozen=True)
class MigrationResult:
    accepted: dict[str, Any]
    suggestions: dict[str, Any]
    report: dict[str, Any]


@dataclass
class _StructuralUnit:
    tokens: list[tuple[str, str]]
    literals: list[Literal]


def _entry(target: str, status: str, provenance: str, source: str) -> dict[str, Any]:
    return {
        "target": target,
        "status": status,
        "provenance": provenance,
        "formatSignature": list(format_signature(source)),
    }


def _target(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("target"), str):
        return value["target"]
    return None


def _issue_sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        str(row.get("path", "")),
        str(row.get("function", "")),
        int(row.get("occurrenceIndex", -1)),
        str(row.get("source", "")),
        str(row.get("code", "")),
    )


def _alignment_issue(code: str, row: Alignment, **extra: Any) -> dict[str, Any]:
    return {
        "code": code,
        "path": row.path,
        "function": row.function,
        "line": row.line,
        "occurrenceIndex": row.occurrence_index,
        "source": row.source,
        **extra,
    }


def migrate(
    *,
    legacy: dict[str, Any],
    overrides: dict[str, Any],
    official: dict[str, str],
    alignments: Iterable[Alignment] = (),
    alignment_issues: Iterable[dict[str, Any]] = (),
) -> MigrationResult:
    """Apply the binding acceptance precedence without promoting suggestions."""
    accepted_entries: dict[str, dict[str, Any]] = {}
    contexts: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    for source, target in sorted(official.items()):
        if not isinstance(source, str) or not isinstance(target, str):
            continue
        if format_signature(source) != format_signature(target):
            issues.append(
                {
                    "code": "FORMAT_SIGNATURE_MISMATCH",
                    "source": source,
                    "provenance": "official-runtime-identity",
                    "sourceSignature": list(format_signature(source)),
                    "targetSignature": list(format_signature(target)),
                }
            )
            continue
        accepted_entries[source] = _entry(target, "official", "official-runtime-identity", source)

    override_entries = overrides.get("entries", {}) if isinstance(overrides, dict) else {}
    if isinstance(override_entries, dict):
        for source, value in sorted(override_entries.items()):
            if source in accepted_entries or not isinstance(source, str):
                continue
            target = _target(value)
            if target is None:
                issues.append({"code": "INVALID_REVIEWED_OVERRIDE", "source": str(source)})
                continue
            if format_signature(source) != format_signature(target):
                issues.append(
                    {
                        "code": "FORMAT_SIGNATURE_MISMATCH",
                        "source": source,
                        "provenance": "manual-reviewed-override",
                        "sourceSignature": list(format_signature(source)),
                        "targetSignature": list(format_signature(target)),
                    }
                )
                continue
            accepted_entries[source] = _entry(
                target, "reviewed", "manual-reviewed-override", source
            )

    candidates: dict[str, list[Alignment]] = defaultdict(list)
    for row in sorted(
        alignments,
        key=lambda item: (
            item.path,
            item.function,
            item.occurrence_index,
            item.source,
            item.target,
        ),
    ):
        if row.source in accepted_entries:
            continue
        if not HAN.search(row.source):
            issues.append(_alignment_issue("UPSTREAM_NOT_HAN", row))
            continue
        if not HANGUL.search(row.target):
            issues.append(_alignment_issue("CURRENT_NOT_HANGUL", row))
            continue
        source_signature = format_signature(row.source)
        target_signature = format_signature(row.target)
        if source_signature != target_signature:
            issues.append(
                _alignment_issue(
                    "FORMAT_SIGNATURE_MISMATCH",
                    row,
                    sourceSignature=list(source_signature),
                    targetSignature=list(target_signature),
                )
            )
            continue
        candidates[row.source].append(row)

    for source, rows in sorted(candidates.items()):
        targets = {row.target for row in rows}
        if len(targets) == 1:
            accepted_entries[source] = _entry(
                next(iter(targets)), "reviewed", "current-ko-baseline", source
            )
            continue
        by_context: dict[tuple[str, str], list[Alignment]] = defaultdict(list)
        for row in rows:
            by_context[(row.path, row.function)].append(row)
        if any(len({row.target for row in values}) != 1 for values in by_context.values()):
            first = rows[0]
            issues.append(
                _alignment_issue(
                    "ALIGNMENT_COLLISION",
                    first,
                    targets=sorted(targets),
                )
            )
            continue
        for (path, function), values in sorted(by_context.items()):
            target = values[0].target
            contexts.append(
                {
                    "path": path,
                    "function": function,
                    "source": source,
                    "target": target,
                    "status": "reviewed",
                    "provenance": "current-ko-baseline",
                    "formatSignature": list(format_signature(source)),
                }
            )

    for issue in alignment_issues:
        sources = issue.get("sources")
        if isinstance(sources, list) and sources and all(
            isinstance(source, str) and source in accepted_entries for source in sources
        ):
            continue
        source = issue.get("source")
        if isinstance(source, str) and source in accepted_entries:
            continue
        issues.append(dict(issue))

    legacy_entries = legacy.get("entries", {}) if isinstance(legacy, dict) else {}
    suggestion_entries: dict[str, dict[str, Any]] = {}
    if isinstance(legacy_entries, dict):
        for source, value in sorted(legacy_entries.items()):
            target = _target(value)
            if not isinstance(source, str) or target is None:
                continue
            suggestion_entries[source] = _entry(
                target, "suggested", "legacy-machine-suggestion", source
            )

    accepted_entries = dict(sorted(accepted_entries.items()))
    contexts.sort(key=lambda row: (row["path"], row["function"], row["source"], row["target"]))
    issues.sort(key=_issue_sort_key)
    accepted = {"schemaVersion": 1, "entries": accepted_entries, "contexts": contexts}
    suggestions: dict[str, Any] = {
        "schemaVersion": 1,
        "source": str(legacy.get("source", "legacy source-literal machine draft")),
    }
    for field in ("models", "licenses"):
        if field in legacy:
            suggestions[field] = legacy[field]
    suggestions["entries"] = suggestion_entries
    suggestions["contexts"] = []

    ambiguous_codes = {"AMBIGUOUS_ALIGNMENT", "ALIGNMENT_COLLISION"}
    unmapped_codes = {
        "CURRENT_NOT_HANGUL",
        "UNMAPPED_ALIGNMENT",
        "CURRENT_PATH_MISSING",
        "UNSUPPORTED_ESCAPE",
        "FORMAT_SIGNATURE_MISMATCH",
    }
    report = {
        "counts": {
            "official": sum(row["status"] == "official" for row in accepted_entries.values()),
            "reviewed": sum(row["status"] == "reviewed" for row in accepted_entries.values())
            + len(contexts),
            "suggested": len(suggestion_entries),
            "ambiguous": sum(row.get("code") in ambiguous_codes for row in issues),
            "unmapped": sum(row.get("code") in unmapped_codes for row in issues),
        },
        "issues": issues,
    }
    return MigrationResult(accepted=accepted, suggestions=suggestions, report=report)


def _sanitize_legacy_null_escapes(text: bytes) -> bytes:
    # The one-time baseline contains C++ ``\0`` escapes.  Task 2 deliberately
    # rejects unsupported escapes for writes; migration only needs a decoded,
    # read-only structural inventory, so normalize the unambiguous zero escape.
    return re.sub(rb"\\0(?![0-7])", rb"\\u0000", text)


def _decoded_literal(node: Any, text: bytes, function: str) -> Literal:
    line = text.count(b"\n", 0, node.start_byte) + 1
    if node.type == "concatenated_string":
        children = [
            child
            for child in node.named_children
            if child.type in {"string_literal", "raw_string_literal"}
        ]
        decoded = "".join(
            source_overlay._decode_literal(child, text, function, line)[0] for child in children
        )
        prefix = source_overlay._decode_literal(children[0], text, function, line)[1]
        return Literal("", node.start_byte, node.end_byte, decoded, prefix, function, line)
    decoded, prefix = source_overlay._decode_literal(node, text, function, line)
    return Literal("", node.start_byte, node.end_byte, decoded, prefix, function, line)


def _unit_for_literal(node: Any) -> Any:
    unit = node
    while unit.parent is not None:
        if unit is not node and (
            unit.type.endswith("_statement")
            or unit.type in {"declaration", "field_declaration", "parameter_declaration"}
        ):
            break
        parent = unit.parent
        if parent.type in {"function_definition", "translation_unit"}:
            break
        if parent.type == "compound_statement":
            break
        unit = parent
    return unit


def _normalized_unit(unit: Any, text: bytes, function: str) -> _StructuralUnit:
    tokens: list[tuple[str, str]] = []
    literals: list[Literal] = []

    def visit(node: Any) -> None:
        if node.type == "comment":
            return
        if node.type == "concatenated_string":
            tokens.append(("LITERAL", ""))
            literals.append(_decoded_literal(node, text, function))
            return
        if node.type in {"string_literal", "raw_string_literal"}:
            tokens.append(("LITERAL", ""))
            literals.append(_decoded_literal(node, text, function))
            return
        if not node.named_children:
            tokens.append(
                (
                    node.type,
                    text[node.start_byte : node.end_byte].decode("utf-8", errors="replace"),
                )
            )
            return
        for child in node.named_children:
            visit(child)

    visit(unit)
    return _StructuralUnit(tokens=tokens, literals=literals)


def _structural_groups(path: Path, original: bytes) -> dict[tuple[str, tuple[Any, ...], int], list[Literal]]:
    text = _sanitize_legacy_null_escapes(original)
    tree = source_overlay._PARSER.parse(text)
    groups: dict[tuple[str, tuple[Any, ...], int], list[Literal]] = defaultdict(list)
    seen_units: set[tuple[int, int, str]] = set()

    def walk(node: Any, function: str) -> None:
        if node.type == "function_definition":
            function = source_overlay._function_name(node, text)
        if node.type == "concatenated_string" or node.type in {
            "string_literal",
            "raw_string_literal",
        }:
            unit = _unit_for_literal(node)
            identity = (unit.start_byte, unit.end_byte, function)
            if identity not in seen_units:
                seen_units.add(identity)
                normalized = _normalized_unit(unit, text, function)
                fingerprint = tuple(normalized.tokens)
                for marker_index, literal in enumerate(normalized.literals):
                    groups[(function, fingerprint, marker_index)].append(
                        Literal(
                            path.as_posix(),
                            literal.start,
                            literal.end,
                            literal.decoded,
                            literal.prefix,
                            function,
                            literal.line,
                        )
                    )
            return
        for child in node.named_children:
            walk(child, function)

    walk(tree.root_node, "")
    return groups


def align_file_literals(
    path: Path, upstream_text: bytes, current_text: bytes
) -> tuple[list[Alignment], list[dict[str, Any]]]:
    """Align literals only when a structural fingerprint has one ordered match."""
    upstream = _structural_groups(path, upstream_text)
    current = _structural_groups(path, current_text)
    alignments: list[Alignment] = []
    issues: list[dict[str, Any]] = []
    rows_by_function: dict[str, dict[tuple[int, int], Literal]] = defaultdict(dict)
    for (function, _, _), rows in upstream.items():
        for row in rows:
            rows_by_function[function][(row.start, row.end)] = row
    occurrence_by_span = {
        (function, row.start, row.end): occurrence_index
        for function, rows in rows_by_function.items()
        for occurrence_index, row in enumerate(
            sorted(rows.values(), key=lambda item: (item.start, item.end))
        )
    }

    for key, upstream_rows in sorted(
        upstream.items(), key=lambda item: (item[0][0], item[1][0].start)
    ):
        function = key[0]
        current_rows = current.get(key, [])
        indexed_rows: list[tuple[Literal, int]] = []
        for row in upstream_rows:
            index = occurrence_by_span[(function, row.start, row.end)]
            indexed_rows.append((row, index))
        visible_rows = [(row, index) for row, index in indexed_rows if HAN.search(row.decoded)]
        if not visible_rows:
            continue
        if len(upstream_rows) != len(current_rows):
            candidates = [row.decoded for row in current_rows if HANGUL.search(row.decoded)]
            issues.append(
                {
                    "code": "AMBIGUOUS_ALIGNMENT" if candidates else "UNMAPPED_ALIGNMENT",
                    "path": path.as_posix(),
                    "function": function,
                    "line": visible_rows[0][0].line,
                    "occurrenceIndex": visible_rows[0][1],
                    "sources": [row.decoded for row, _ in visible_rows],
                    "currentCandidates": candidates,
                }
            )
            continue
        for (upstream_row, occurrence_index), current_row in zip(
            indexed_rows, current_rows, strict=True
        ):
            if not HAN.search(upstream_row.decoded):
                continue
            alignment = Alignment(
                path=path.as_posix(),
                function=function,
                source=upstream_row.decoded,
                target=current_row.decoded,
                occurrence_index=occurrence_index,
                line=upstream_row.line,
            )
            if not HANGUL.search(current_row.decoded):
                issues.append(_alignment_issue("CURRENT_NOT_HANGUL", alignment))
            elif format_signature(upstream_row.decoded) != format_signature(current_row.decoded):
                issues.append(
                    _alignment_issue(
                        "FORMAT_SIGNATURE_MISMATCH",
                        alignment,
                        sourceSignature=list(format_signature(upstream_row.decoded)),
                        targetSignature=list(format_signature(current_row.decoded)),
                    )
                )
            else:
                alignments.append(alignment)

    alignments.sort(
        key=lambda row: (row.path, row.function, row.occurrence_index, row.source, row.target)
    )
    issues.sort(key=_issue_sort_key)
    return alignments, issues


def _git_bytes(arguments: list[str]) -> bytes:
    return subprocess.check_output(["git", *arguments], cwd=REPOSITORY_ROOT)


def _upstream_paths(upstream_ref: str) -> list[str]:
    names = _git_bytes(
        ["ls-tree", "-r", "--name-only", upstream_ref, "--", "pob-zh-engine"]
    ).decode("utf-8").splitlines()
    paths = {
        name
        for name in names
        if (
            name.startswith("pob-zh-engine/host/")
            and Path(name).suffix.lower() in SOURCE_SUFFIXES
        )
        or (
            Path(name).parent.as_posix() == "pob-zh-engine"
            and re.fullmatch(r"ui_.*\.(?:cpp|h)", Path(name).name)
        )
    }
    return sorted(paths)


def _excluded_paths() -> set[str]:
    policy = json.loads((LOCALE_ROOT / "source-display-policy.json").read_text(encoding="utf-8"))
    return {
        str(row.get("path", "")).replace("\\", "/")
        for row in policy.get("excludedPaths", [])
        if isinstance(row, dict) and str(row.get("reason", "")).strip()
    }


def load_official_runtime_identity(repository_root: Path) -> dict[str, str]:
    provenance = json.loads(
        (repository_root / "reports/display-closure/provenance.json").read_text(encoding="utf-8")
    )
    locale_root = repository_root / "pob-zh-engine/dist/Data/poe1"
    candidates: dict[str, set[str]] = defaultdict(set)
    for dictionary in DICTIONARIES:
        chinese = json.loads(
            (locale_root / "zh-rTW" / f"{dictionary}.json").read_text(encoding="utf-8")
        )["entries"]
        korean = json.loads(
            (locale_root / "ko-KR" / f"{dictionary}.json").read_text(encoding="utf-8")
        )["entries"]
        dictionary_provenance = provenance["dictionaries"][dictionary]
        for english, target in korean.items():
            if dictionary_provenance.get(english, {}).get("layer") not in {
                "official-exact",
                "official-structural-pattern",
            }:
                continue
            source = chinese.get(english)
            if isinstance(source, str) and isinstance(target, str):
                candidates[source].add(target)
    return {
        source: next(iter(targets))
        for source, targets in sorted(candidates.items())
        if len(targets) == 1
    }


def write_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="",
    )


def run_migration(
    *,
    upstream_ref: str,
    localized_root: Path,
    output: Path,
    suggestions: Path,
    report_path: Path,
) -> MigrationResult:
    if upstream_ref != PINNED_UPSTREAM:
        raise ValueError(f"upstream ref must be pinned to {PINNED_UPSTREAM}")
    resolved = _git_bytes(["rev-parse", "--verify", f"{upstream_ref}^{{commit}}"])
    if resolved.decode("ascii").strip() != PINNED_UPSTREAM:
        raise ValueError("pinned upstream ref resolved to an unexpected commit")

    localized_root = localized_root.resolve()
    excluded = _excluded_paths()
    alignments: list[Alignment] = []
    alignment_issues: list[dict[str, Any]] = []
    upstream_sources: set[str] = set()
    files_scanned = 0
    for repository_path in _upstream_paths(upstream_ref):
        relative = repository_path.removeprefix("pob-zh-engine/")
        if relative in excluded:
            continue
        files_scanned += 1
        upstream_text = _git_bytes(["show", f"{upstream_ref}:{repository_path}"])
        current_path = localized_root / Path(relative)
        if not current_path.is_file():
            alignment_issues.append(
                {"code": "CURRENT_PATH_MISSING", "path": relative, "function": "", "source": ""}
            )
            continue
        file_alignments, file_issues = align_file_literals(
            Path(relative), upstream_text, current_path.read_bytes()
        )
        alignments.extend(file_alignments)
        alignment_issues.extend(file_issues)
        for rows in _structural_groups(Path(relative), upstream_text).values():
            upstream_sources.update(row.decoded for row in rows if HAN.search(row.decoded))

    legacy = json.loads(
        (LOCALE_ROOT / "manual/source-literal-translations.json").read_text(encoding="utf-8")
    )
    overrides = json.loads(
        (LOCALE_ROOT / "manual/source-literal-overrides.json").read_text(encoding="utf-8")
    )
    official = {
        source: target
        for source, target in load_official_runtime_identity(REPOSITORY_ROOT).items()
        if source in upstream_sources
    }
    override_entries = overrides.get("entries", {})
    overrides = {
        **{key: value for key, value in overrides.items() if key != "entries"},
        "entries": {
            source: target
            for source, target in override_entries.items()
            if source in upstream_sources
        },
    }
    result = migrate(
        legacy=legacy,
        overrides=overrides,
        official=official,
        alignments=alignments,
        alignment_issues=alignment_issues,
    )
    report = {
        "schemaVersion": 1,
        "upstreamRef": PINNED_UPSTREAM,
        "filesScanned": files_scanned,
        "upstreamHanSources": len(upstream_sources),
        **result.report,
    }
    result = MigrationResult(result.accepted, result.suggestions, report)
    write_json(output, result.accepted)
    write_json(suggestions, result.suggestions)
    write_json(report_path, result.report)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-ref", required=True)
    parser.add_argument("--localized-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--suggestions", type=Path, required=True)
    parser.add_argument("--report", dest="report_path", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        result = run_migration(**vars(arguments))
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        parser.error(str(error))
    counts = result.report["counts"]
    print(
        "source migration: "
        f"official={counts['official']}; reviewed={counts['reviewed']}; "
        f"suggested={counts['suggested']}; ambiguous={counts['ambiguous']}; "
        f"unmapped={counts['unmapped']}"
    )
    return 1 if result.report["issues"] else 0


if __name__ == "__main__":
    sys.exit(main())
