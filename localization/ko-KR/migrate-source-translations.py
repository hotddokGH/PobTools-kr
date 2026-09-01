"""Migrate the pinned PoE1 Korean source baseline into reviewed overlay data.

The pinned upstream tree is read with Git object commands only.  No source from
that tree is imported, compiled, or executed.
"""

from __future__ import annotations

import argparse
import hashlib
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
OFFICIAL_PATCH = "3.29.3.2"
HAN = re.compile(
    r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF"
    r"\U00020000-\U0002FA1F\U00030000-\U000323AF]"
)
HANGUL = re.compile(r"[가-힣]")
SOURCE_SUFFIXES = frozenset({".cpp", ".h"})
DICTIONARIES = ("tags", "items", "gems", "ui", "stats", "passives", "uniques", "monsters")
TRUSTED_ZH_REFERENCE_HASHES = {
    "tags": "BF43C0CD0A0AB7EED1B5E7D2AB192FA1844C1D08E86B08DF83B860C9F2730BF3",
    "items": "4766379F2A3BD0DD8DFE4D6F8133E676CBE78D2CA09F92C3BADB5E28A676522D",
    "gems": "B8E1C839B03BBC7D23E4030797477D92536F224D9202B5E76E45EADFD91B7F97",
    "ui": "CBBE60B7E26C131127713B5A7E2FADF222203B2C8C66ED61E1A7759D6DF785C6",
    "stats": "A78A893E027FA93518841621DF1AEE082D3CCE1512909523CF20E9C65CD99B3A",
    "passives": "92C9B7F034537FC25E630BEED69D94B1D208E7A79B66757E28EFE684B5D960AC",
    "uniques": "86F473E66445896C9AE9C187549D106D68F3046A2915A84D6658C976981B63A0",
    "monsters": "DE92D3D9FFA7F362419A618C1AB398DEEDA8F64E45A5667D16DD8C47FFD3A132",
}


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


class OfficialEvidenceError(ValueError):
    def __init__(self, issues: list[dict[str, Any]]) -> None:
        super().__init__(f"official evidence validation failed with {len(issues)} issue(s)")
        self.issues = issues


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


def _safe_context_path(value: str) -> str | None:
    normalized = value.replace("\\", "/")
    parts = normalized.split("/")
    if (
        not normalized
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(part in {"", ".", ".."} for part in parts)
    ):
        return None
    return normalized


def migrate(
    *,
    legacy: dict[str, Any],
    overrides: dict[str, Any],
    official: dict[str, str],
    alignments: Iterable[Alignment] = (),
    alignment_issues: Iterable[dict[str, Any]] = (),
    context_inventories: dict[str, tuple[list[Literal], list[Literal]]] | None = None,
) -> MigrationResult:
    """Apply the binding acceptance precedence without promoting suggestions."""
    accepted_entries: dict[str, dict[str, Any]] = {}
    contexts: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    alignment_issue_rows = [dict(issue) for issue in alignment_issues]
    failed_contexts: set[tuple[str, str, str]] = set()
    failed_sources: set[str] = set()

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

    reviewed_contexts: set[tuple[str, str, str]] = set()
    context_inventories = context_inventories or {}
    override_contexts = overrides.get("contexts", []) if isinstance(overrides, dict) else []
    if isinstance(override_contexts, list):
        prepared_contexts: list[dict[str, Any]] = []
        for value in override_contexts:
            if not isinstance(value, dict) or not all(
                isinstance(value.get(field), str)
                for field in ("path", "function", "source", "target")
            ) or type(value.get("occurrenceIndex")) is not int or value["occurrenceIndex"] < 0:
                issues.append({"code": "INVALID_REVIEWED_CONTEXT"})
                continue
            normalized_path = _safe_context_path(value["path"])
            if normalized_path is None:
                issues.append(
                    {
                        "code": "INVALID_REVIEWED_CONTEXT_PATH",
                        "path": value["path"].replace("\\", "/"),
                        "function": value["function"],
                        "source": value["source"],
                    }
                )
                continue
            prepared_contexts.append({**value, "path": normalized_path})

        contexts_by_consumer_identity: dict[tuple[str, str, str], list[dict[str, Any]]] = (
            defaultdict(list)
        )
        for value in prepared_contexts:
            contexts_by_consumer_identity[
                (value["path"], value["function"], value["source"])
            ].append(value)
        duplicate_identities = {
            key for key, values in contexts_by_consumer_identity.items() if len(values) != 1
        }
        for path, function, source in sorted(duplicate_identities):
            issues.append(
                {
                    "code": "DUPLICATE_REVIEWED_CONTEXT",
                    "path": path,
                    "function": function,
                    "source": source,
                }
            )

        for value in sorted(
            prepared_contexts,
            key=lambda row: (
                row["path"],
                row["function"],
                row["source"],
                row["occurrenceIndex"],
                row["target"],
            ),
        ):
            path = value["path"]
            function = value["function"]
            source = value["source"]
            target = value["target"]
            occurrence_index = value["occurrenceIndex"]
            if (path, function, source) in duplicate_identities:
                continue
            if path not in context_inventories:
                issues.append(
                    {
                        "code": "INVALID_REVIEWED_CONTEXT_PATH",
                        "path": path,
                        "function": function,
                        "source": source,
                    }
                )
                continue
            upstream_literals, current_literals = context_inventories[path]
            upstream_function = sorted(
                (row for row in upstream_literals if row.function == function),
                key=lambda row: (row.start, row.end),
            )
            current_function = sorted(
                (row for row in current_literals if row.function == function),
                key=lambda row: (row.start, row.end),
            )
            if not upstream_function or not current_function:
                issues.append(
                    {
                        "code": "INVALID_REVIEWED_CONTEXT_FUNCTION",
                        "path": path,
                        "function": function,
                        "source": source,
                    }
                )
                continue
            upstream_source_matches = [
                row for row in upstream_function if row.decoded == source
            ]
            if len(upstream_source_matches) > 1:
                issues.append(
                    {
                        "code": "AMBIGUOUS_REVIEWED_CONTEXT_SOURCE",
                        "path": path,
                        "function": function,
                        "source": source,
                    }
                )
                continue
            if (
                not upstream_source_matches
                or occurrence_index >= len(upstream_function)
                or upstream_function[occurrence_index].decoded != source
                or not HAN.search(source)
            ):
                issues.append(
                    {
                        "code": "INVALID_REVIEWED_CONTEXT_SOURCE",
                        "path": path,
                        "function": function,
                        "source": source,
                        "occurrenceIndex": occurrence_index,
                    }
                )
                continue
            if accepted_entries.get(source, {}).get("status") == "official":
                continue
            if not HANGUL.search(target):
                issues.append(
                    {
                        "code": "CURRENT_NOT_HANGUL",
                        "path": path,
                        "function": function,
                        "source": source,
                        "occurrenceIndex": occurrence_index,
                    }
                )
                continue
            if format_signature(source) != format_signature(target):
                issues.append(
                    {
                        "code": "FORMAT_SIGNATURE_MISMATCH",
                        "path": path,
                        "function": function,
                        "source": source,
                        "provenance": "manual-reviewed-context",
                        "sourceSignature": list(format_signature(source)),
                        "targetSignature": list(format_signature(target)),
                    }
                )
                continue
            target_matches = [row for row in current_function if row.decoded == target]
            if not target_matches:
                issues.append(
                    {
                        "code": "INVALID_REVIEWED_CONTEXT_TARGET",
                        "path": path,
                        "function": function,
                        "source": source,
                        "occurrenceIndex": occurrence_index,
                        "target": target,
                    }
                )
                continue
            if len(target_matches) != 1:
                issues.append(
                    {
                        "code": "AMBIGUOUS_REVIEWED_CONTEXT_TARGET",
                        "path": path,
                        "function": function,
                        "source": source,
                        "occurrenceIndex": occurrence_index,
                        "target": target,
                    }
                )
                continue
            key = (path, function, source)
            reviewed_contexts.add(key)
            contexts.append(
                {
                    "path": path,
                    "function": function,
                    "source": source,
                    "target": target,
                    "status": "reviewed",
                    "provenance": "manual-reviewed-context",
                    "formatSignature": list(format_signature(source)),
                }
            )

    filtered_alignment_issues: list[dict[str, Any]] = []
    for issue in alignment_issue_rows:
        path = str(issue.get("path", "")).replace("\\", "/")
        function = str(issue.get("function", ""))
        source = issue.get("source")
        if isinstance(source, str) and (path, function, source) in reviewed_contexts:
            continue
        sources = issue.get("sources")
        if isinstance(sources, list):
            remaining = [
                source
                for source in sources
                if isinstance(source, str)
                and (path, function, source) not in reviewed_contexts
            ]
            if not remaining:
                continue
            issue = {**issue, "sources": remaining}
        filtered_alignment_issues.append(issue)
    alignment_issue_rows = filtered_alignment_issues

    for issue in alignment_issue_rows:
        issue_sources: list[str] = []
        if isinstance(issue.get("source"), str):
            issue_sources.append(issue["source"])
        if isinstance(issue.get("sources"), list):
            issue_sources.extend(
                source for source in issue["sources"] if isinstance(source, str)
            )
        for source in issue_sources:
            failed_sources.add(source)
            failed_contexts.add(
                (str(issue.get("path", "")), str(issue.get("function", "")), source)
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
        if (row.path, row.function, row.source) in reviewed_contexts:
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
        if (
            len(targets) == 1
            and source not in failed_sources
            and source not in {key[2] for key in reviewed_contexts}
        ):
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
            if (path, function, source) in failed_contexts:
                continue
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

    issues.extend(alignment_issue_rows)

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
        "INVALID_REVIEWED_CONTEXT",
        "INVALID_REVIEWED_CONTEXT_PATH",
        "INVALID_REVIEWED_CONTEXT_FUNCTION",
        "INVALID_REVIEWED_CONTEXT_SOURCE",
        "INVALID_REVIEWED_CONTEXT_TARGET",
        "DUPLICATE_REVIEWED_CONTEXT",
        "AMBIGUOUS_REVIEWED_CONTEXT_TARGET",
        "AMBIGUOUS_REVIEWED_CONTEXT_SOURCE",
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
            or unit.type
            in {
                "assignment_expression",
                "call_expression",
                "declaration",
                "field_declaration",
                "parameter_declaration",
            }
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
            owner = _unit_for_literal(node)
            if (owner.start_byte, owner.end_byte) != (unit.start_byte, unit.end_byte):
                return
            tokens.append(("LITERAL", ""))
            literals.append(_decoded_literal(node, text, function))
            return
        if node.type in {"string_literal", "raw_string_literal"}:
            owner = _unit_for_literal(node)
            if (owner.start_byte, owner.end_byte) != (unit.start_byte, unit.end_byte):
                return
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


def _context_inventory(path: Path, original: bytes) -> list[Literal]:
    rows: dict[tuple[str, int, int], Literal] = {}
    for values in _structural_groups(path, original).values():
        for row in values:
            rows[(row.function, row.start, row.end)] = row
    return sorted(rows.values(), key=lambda row: (row.function, row.start, row.end))


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
    handled_spans: set[tuple[str, int, int]] = set()

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
            if len(visible_rows) == 1:
                upstream_row, occurrence_index = visible_rows[0]
                viable = [
                    row
                    for row in current_rows
                    if HANGUL.search(row.decoded)
                    and format_signature(row.decoded) == format_signature(upstream_row.decoded)
                ]
                if len(viable) == 1:
                    candidate = viable[0]
                    alignments.append(
                        Alignment(
                            path=path.as_posix(),
                            function=function,
                            source=upstream_row.decoded,
                            target=candidate.decoded,
                            occurrence_index=occurrence_index,
                            line=upstream_row.line,
                        )
                    )
                    handled_spans.add((function, upstream_row.start, upstream_row.end))
                    continue
            candidates = [
                row.decoded
                for row in current_rows
                if HANGUL.search(row.decoded)
            ]
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
            identity = (function, upstream_row.start, upstream_row.end)
            if identity in handled_spans:
                continue
            handled_spans.add(identity)
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


def _evidence_issue(code: str, path: Path, detail: str) -> dict[str, str]:
    return {"code": code, "path": path.as_posix(), "detail": detail}


def _read_evidence_json(path: Path) -> tuple[Any | None, list[dict[str, str]]]:
    if not path.is_file():
        return None, [_evidence_issue("OFFICIAL_MANIFEST_MISSING", path, "required file is missing")]
    try:
        return json.loads(path.read_text(encoding="utf-8")), []
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return None, [_evidence_issue("OFFICIAL_EVIDENCE_INVALID", path, str(error))]


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _matches_manifest_sha256(path: Path, expected: str) -> bool:
    expected = expected.upper()
    if _file_sha256(path) == expected:
        return True
    # Git may materialize text evidence with CRLF even though the pinned
    # manifest hashes the repository's LF blob. Only this reversible checkout
    # normalization is accepted; all other byte changes remain failures.
    normalized = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(normalized).hexdigest().upper() == expected


def verify_stable_id_evidence(
    manifest_path: Path,
    english_path: Path,
    korean_path: Path,
    accepted_path: Path,
    *,
    expected_table: str,
) -> list[dict[str, str]]:
    """Validate pinned table hashes and every accepted stable-ID join."""
    issues: list[dict[str, str]] = []
    manifest, manifest_issues = _read_evidence_json(manifest_path)
    issues.extend(manifest_issues)
    if not isinstance(manifest, dict):
        return issues
    if manifest.get("patch") != OFFICIAL_PATCH:
        issues.append(
            _evidence_issue(
                "OFFICIAL_PATCH_MISMATCH",
                manifest_path,
                f"expected {OFFICIAL_PATCH}, got {manifest.get('patch')}",
            )
        )
    if manifest.get("table") != expected_table:
        issues.append(
            _evidence_issue(
                "OFFICIAL_EVIDENCE_INVALID", manifest_path, "unexpected table identity"
            )
        )
    client = manifest.get("clientEvidence", {})
    if (
        not isinstance(client, dict)
        or client.get("detectedPatch") != OFFICIAL_PATCH
        or client.get("matchesExportPatch") is not True
    ):
        issues.append(
            _evidence_issue(
                "OFFICIAL_PATCH_MISMATCH", manifest_path, "client patch evidence is stale"
            )
        )

    inputs = manifest.get("inputs", {})
    documents: list[Any] = []
    for language, path in (("english", english_path), ("korean", korean_path)):
        document, document_issues = _read_evidence_json(path)
        if document_issues:
            issues.extend(
                _evidence_issue("OFFICIAL_INPUT_MISSING", path, row["detail"])
                for row in document_issues
            )
            documents.append(None)
            continue
        documents.append(document)
        expected_hash = str(inputs.get(f"{language}Sha256", "")).upper()
        if not expected_hash or not _matches_manifest_sha256(path, expected_hash):
            issues.append(
                _evidence_issue(
                    "OFFICIAL_INPUT_HASH_MISMATCH", path, f"{language} SHA-256 differs"
                )
            )
        expected_rows = inputs.get(f"{language}Rows")
        if not isinstance(document, list) or len(document) != expected_rows:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_STABLE_ID_MISMATCH", path, f"{language} row count differs"
                )
            )

    english_rows, korean_rows = documents
    if not isinstance(english_rows, list) or not isinstance(korean_rows, list):
        return sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))
    name_column = str(manifest.get("nameColumn", "Name"))

    def grouped(rows: list[Any]) -> dict[str, set[str]]:
        result: dict[str, set[str]] = defaultdict(set)
        for row in rows:
            if not isinstance(row, dict):
                continue
            stable_id = str(row.get("Id", ""))
            name = str(row.get(name_column, ""))
            if stable_id.strip() and name.strip():
                result[stable_id].add(name)
        return result

    english_by_id = grouped(english_rows)
    korean_by_id = grouped(korean_rows)
    stable_ids = {
        str(row.get("Id", ""))
        for row in [*english_rows, *korean_rows]
        if isinstance(row, dict) and str(row.get("Id", "")).strip()
    }
    if len(stable_ids) != inputs.get("stableIds"):
        issues.append(
            _evidence_issue(
                "OFFICIAL_STABLE_ID_MISMATCH", manifest_path, "stable-ID count differs"
            )
        )

    accepted, accepted_issues = _read_evidence_json(accepted_path)
    issues.extend(accepted_issues)
    rows = accepted.get("rows") if isinstance(accepted, dict) else None
    if (
        not isinstance(accepted, dict)
        or accepted.get("patch") != OFFICIAL_PATCH
        or accepted.get("table") != expected_table
        or accepted.get("join") != "Id"
        or not isinstance(rows, list)
        or len(rows) != manifest.get("counts", {}).get("accepted")
    ):
        issues.append(
            _evidence_issue(
                "OFFICIAL_EVIDENCE_INVALID", accepted_path, "accepted report metadata differs"
            )
        )
    else:
        for row in rows:
            if not isinstance(row, dict):
                issues.append(
                    _evidence_issue(
                        "OFFICIAL_STABLE_ID_MISMATCH", accepted_path, "accepted row is invalid"
                    )
                )
                continue
            stable_id = str(row.get("id", ""))
            if (
                english_by_id.get(stable_id) != {row.get("english")}
                or korean_by_id.get(stable_id) != {row.get("korean")}
            ):
                issues.append(
                    _evidence_issue(
                        "OFFICIAL_STABLE_ID_MISMATCH",
                        accepted_path,
                        f"accepted stable-ID join differs: {stable_id}",
                    )
                )
    return sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))


def _verify_structured_evidence(
    report_manifest_path: Path,
    source_manifest_path: Path,
    english_path: Path,
    korean_path: Path,
    accepted_path: Path,
    *,
    identity_kind: str,
) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    report_manifest, rows = _read_evidence_json(report_manifest_path)
    issues.extend(rows)
    source_manifest, rows = _read_evidence_json(source_manifest_path)
    issues.extend(rows)
    accepted, rows = _read_evidence_json(accepted_path)
    issues.extend(rows)
    if not all(isinstance(row, dict) for row in (report_manifest, source_manifest, accepted)):
        return issues
    for path, document in (
        (report_manifest_path, report_manifest),
        (source_manifest_path, source_manifest),
        (accepted_path, accepted),
    ):
        if document.get("patch") != OFFICIAL_PATCH:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_PATCH_MISMATCH",
                    path,
                    f"expected {OFFICIAL_PATCH}, got {document.get('patch')}",
                )
            )
    client = report_manifest.get("clientEvidence", {})
    if (
        not isinstance(client, dict)
        or client.get("detectedPatch") != OFFICIAL_PATCH
        or client.get("matchesExportPatch") is not True
    ):
        issues.append(
            _evidence_issue(
                "OFFICIAL_PATCH_MISMATCH",
                report_manifest_path,
                "client patch evidence is stale",
            )
        )

    documents: dict[str, Any] = {}
    for language, path in (("english", english_path), ("korean", korean_path)):
        document, document_issues = _read_evidence_json(path)
        if document_issues:
            issues.extend(
                _evidence_issue("OFFICIAL_INPUT_MISSING", path, row["detail"])
                for row in document_issues
            )
            continue
        documents[language] = document
        source_metadata = source_manifest.get(language, {})
        report_metadata = report_manifest.get("sources", {}).get(language, {})
        if source_metadata != report_metadata:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_MANIFEST_MISMATCH",
                    report_manifest_path,
                    f"{language} source metadata differs",
                )
            )
        if (
            not isinstance(source_metadata, dict)
            or path.name != source_metadata.get("file")
            or path.stat().st_size != source_metadata.get("bytes")
            or not _matches_manifest_sha256(
                path, str(source_metadata.get("sha256", "")).upper()
            )
        ):
            issues.append(
                _evidence_issue(
                    "OFFICIAL_INPUT_HASH_MISMATCH", path, f"{language} source differs"
                )
            )
        expected_entries = report_manifest.get("inputs", {}).get(f"{language}Entries")
        if not hasattr(document, "__len__") or len(document) != expected_entries:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_STABLE_ID_MISMATCH", path, f"{language} entry count differs"
                )
            )

    accepted_rows = accepted.get("rows")
    if (
        accepted.get("identity") != report_manifest.get("identity")
        or not isinstance(accepted_rows, list)
        or len(accepted_rows) != report_manifest.get("counts", {}).get("accepted")
    ):
        issues.append(
            _evidence_issue(
                "OFFICIAL_EVIDENCE_INVALID", accepted_path, "accepted report metadata differs"
            )
        )
    elif "english" in documents and "korean" in documents:
        english = documents["english"]
        korean = documents["korean"]
        if identity_kind == "mapping-key":
            english_ids = set(english)
            korean_ids = set(korean)
            valid_ids = english_ids | korean_ids
            for row in accepted_rows:
                stable_id = row.get("id") if isinstance(row, dict) else None
                english_entry = english.get(stable_id) if stable_id in valid_ids else None
                korean_entry = korean.get(stable_id) if stable_id in valid_ids else None
                if (
                    not isinstance(row, dict)
                    or not isinstance(english_entry, dict)
                    or not isinstance(korean_entry, dict)
                    or str(english_entry.get("name", "")).strip() != row.get("english")
                    or str(korean_entry.get("name", "")).strip() != row.get("korean")
                ):
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_STABLE_ID_MISMATCH",
                            accepted_path,
                            f"accepted mod identity differs: {stable_id or ''}",
                        )
                    )
        elif identity_kind == "unique-id":
            english_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
            korean_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in english.values():
                if isinstance(row, dict):
                    english_by_id[str(row.get("id", "")).strip()].append(row)
            for row in korean.values():
                if isinstance(row, dict):
                    korean_by_id[str(row.get("id", "")).strip()].append(row)
            for row in accepted_rows:
                stable_id = str(row.get("id", "")) if isinstance(row, dict) else ""
                english_matches = english_by_id.get(stable_id, [])
                korean_matches = korean_by_id.get(stable_id, [])
                if (
                    not isinstance(row, dict)
                    or len(english_matches) != 1
                    or len(korean_matches) != 1
                    or str(english_matches[0].get("name", "")).strip() != row.get("english")
                    or str(korean_matches[0].get("name", "")).strip() != row.get("korean")
                ):
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_STABLE_ID_MISMATCH",
                            accepted_path,
                            f"accepted unique identity differs: {stable_id}",
                        )
                    )
        else:
            english_variant_count = sum(
                len(row.get("English", []))
                for row in english.values()
                if isinstance(row, dict)
            ) if isinstance(english, dict) else sum(
                len(row.get("English", [])) for row in english if isinstance(row, dict)
            )
            korean_variant_count = sum(
                len(row.get("Korean", [])) for row in korean if isinstance(row, dict)
            )
            if (
                english_variant_count
                != report_manifest.get("inputs", {}).get("englishVariants")
                or korean_variant_count
                != report_manifest.get("inputs", {}).get("koreanVariants")
            ):
                issues.append(
                    _evidence_issue(
                        "OFFICIAL_STABLE_ID_MISMATCH",
                        report_manifest_path,
                        "stat variant counts differ",
                    )
                )

            def variant_key(variant: dict[str, Any]) -> str:
                identity = {
                    "condition": variant.get("condition", []),
                    "format": variant.get("format", []),
                    "index_handlers": variant.get("index_handlers", []),
                }
                encoded = json.dumps(identity, ensure_ascii=False, separators=(",", ":"))
                return hashlib.sha256(encoded.encode("utf-8")).hexdigest().upper()

            korean_by_ids: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
            for entry in korean:
                if isinstance(entry, dict):
                    korean_by_ids[tuple(entry.get("ids", []))].append(entry)
            valid_rows: dict[tuple[tuple[str, ...], str, str], tuple[str, str]] = {}
            for english_entry in english:
                if not isinstance(english_entry, dict):
                    continue
                ids = tuple(english_entry.get("ids", []))
                korean_matches = korean_by_ids.get(ids, [])
                if not ids or len(korean_matches) != 1:
                    continue
                english_variants: dict[str, list[dict[str, Any]]] = defaultdict(list)
                korean_variants: dict[str, list[dict[str, Any]]] = defaultdict(list)
                for variant in english_entry.get("English", []):
                    if isinstance(variant, dict):
                        english_variants[variant_key(variant)].append(variant)
                for variant in korean_matches[0].get("Korean", []):
                    if isinstance(variant, dict):
                        korean_variants[variant_key(variant)].append(variant)
                for identity in english_variants.keys() & korean_variants.keys():
                    if len(english_variants[identity]) != 1 or len(korean_variants[identity]) != 1:
                        continue
                    for kind in ("string", "reminder_text"):
                        english_text = str(english_variants[identity][0].get(kind, "")).replace(
                            "\r\n", "\n"
                        )
                        korean_text = str(korean_variants[identity][0].get(kind, "")).replace(
                            "\r\n", "\n"
                        )
                        if english_text and korean_text:
                            valid_rows[(ids, identity, kind)] = (english_text, korean_text)
            for row in accepted_rows:
                key = (
                    tuple(row.get("ids", [])),
                    row.get("variantIdentity"),
                    row.get("kind"),
                ) if isinstance(row, dict) else ((), None, None)
                if (
                    not isinstance(row, dict)
                    or valid_rows.get(key) != (row.get("english"), row.get("korean"))
                ):
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_STABLE_ID_MISMATCH",
                            accepted_path,
                            "accepted stat identity differs",
                        )
                    )
    return sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))


def verify_official_evidence(repository_root: Path) -> list[dict[str, str]]:
    locale_root = repository_root / "localization/ko-KR"
    source_root = locale_root / "official-terms"
    report_root = repository_root / "reports/official-terms"
    issues: list[dict[str, str]] = []
    stable_tables = (
        ("BaseItemTypes", report_root, source_root / "tables"),
        *(
            (table, report_root / "tables" / table, source_root / "tables")
            for table in (
                "ActiveSkills",
                "PassiveSkills",
                "MonsterVarieties",
                "ClientStrings",
                "ClientStrings2",
            )
        ),
    )
    for table, reports, sources in stable_tables:
        issues.extend(
            verify_stable_id_evidence(
                reports / "manifest.json",
                sources / "English" / f"{table}.json",
                sources / "Korean" / f"{table}.json",
                reports / "accepted.json",
                expected_table=table,
            )
        )
    structured = (
        (
            "unique-items",
            source_root / "names/sources.json",
            source_root / "names/English.uniques.min.json",
            source_root / "names/Korean.uniques.min.json",
            "unique-id",
        ),
        (
            "mod-names",
            source_root / "names/mod-sources.json",
            source_root / "names/English.mods.min.json",
            source_root / "names/Korean.mods.min.json",
            "mapping-key",
        ),
        (
            "stat-descriptions",
            source_root / "stat-descriptions/sources.json",
            source_root / "stat-descriptions/English.stat_translations.min.json",
            source_root / "stat-descriptions/Korean.stat_translations.min.json",
            "stat-ids",
        ),
    )
    for name, source_manifest, english, korean, identity_kind in structured:
        reports = report_root / name
        issues.extend(
            _verify_structured_evidence(
                reports / "manifest.json",
                source_manifest,
                english,
                korean,
                reports / "accepted.json",
                identity_kind=identity_kind,
            )
        )
    provenance_path = repository_root / "reports/display-closure/provenance.json"
    provenance, rows = _read_evidence_json(provenance_path)
    issues.extend(rows)
    if not isinstance(provenance, dict) or provenance.get("patch") != OFFICIAL_PATCH:
        issues.append(
            _evidence_issue(
                "OFFICIAL_PATCH_MISMATCH", provenance_path, "derived provenance patch differs"
            )
        )
    return sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))


def _official_identity(report_name: str, row: dict[str, Any]) -> str:
    if row.get("id"):
        return f"{report_name}:{row['id']}"
    if isinstance(row.get("ids"), list):
        joined = ",".join(str(value) for value in row["ids"])
        return f"{report_name}:{joined}#{row.get('variantIdentity', 'no-variant')}"
    return report_name


def _collect_official_candidates(
    named_reports: Iterable[tuple[str, dict[str, Any]]],
) -> dict[str, dict[str, str]]:
    candidates: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for name, report in named_reports:
        for row in report.get("rows", []):
            if not isinstance(row, dict):
                continue
            english = row.get("english")
            korean = row.get("korean")
            if not isinstance(english, str) or not isinstance(korean, str):
                continue
            candidates[english][korean].add(_official_identity(name, row))
    exact: dict[str, dict[str, str]] = {}
    for english, values in candidates.items():
        if len(values) != 1:
            continue
        korean, sources = next(iter(values.items()))
        exact[english] = {"value": korean, "source": " | ".join(sorted(sources))}
    return exact


def _add_official_fallback(
    primary: dict[str, dict[str, str]], fallback: dict[str, dict[str, str]]
) -> dict[str, dict[str, str]]:
    return {**fallback, **primary}


def _accepted_official_by_dictionary(
    repository_root: Path,
) -> dict[str, dict[str, dict[str, str]]]:
    report_root = repository_root / "reports/official-terms"
    paths = {
        "baseItems": ("BaseItemTypes", report_root / "accepted.json"),
        "activeSkills": (
            "ActiveSkills",
            report_root / "tables/ActiveSkills/accepted.json",
        ),
        "passiveSkills": (
            "PassiveSkills",
            report_root / "tables/PassiveSkills/accepted.json",
        ),
        "monsters": (
            "MonsterVarieties",
            report_root / "tables/MonsterVarieties/accepted.json",
        ),
        "clientStrings": (
            "ClientStrings",
            report_root / "tables/ClientStrings/accepted.json",
        ),
        "clientStrings2": (
            "ClientStrings2",
            report_root / "tables/ClientStrings2/accepted.json",
        ),
        "stats": (
            "stat-descriptions",
            report_root / "stat-descriptions/accepted.json",
        ),
        "uniques": ("unique-items", report_root / "unique-items/accepted.json"),
        "modNames": ("mod-names", report_root / "mod-names/accepted.json"),
    }
    reports: dict[str, tuple[str, dict[str, Any]]] = {}
    issues: list[dict[str, str]] = []
    for key, (name, path) in paths.items():
        document, rows = _read_evidence_json(path)
        issues.extend(rows)
        if not isinstance(document, dict) or document.get("patch") != OFFICIAL_PATCH:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_PATCH_MISMATCH",
                    path,
                    "accepted report cannot bind runtime identity",
                )
            )
            continue
        reports[key] = (name, document)
    if issues:
        raise OfficialEvidenceError(issues)

    def collect(*keys: str) -> dict[str, dict[str, str]]:
        return _collect_official_candidates(reports[key] for key in keys)

    direct = {
        "baseItems": collect("baseItems"),
        "activeAndItems": collect("activeSkills", "baseItems"),
        "passives": collect("passiveSkills"),
        "monsters": collect("monsters"),
        "stats": collect("stats"),
        "uniques": collect("uniques"),
        "modNames": collect("modNames"),
        "passiveSupplement": collect("stats", "clientStrings", "clientStrings2"),
        "uiPrimary": collect("clientStrings", "clientStrings2", "stats"),
        "uiSupplement": collect(
            "baseItems",
            "activeSkills",
            "passiveSkills",
            "monsters",
            "uniques",
            "modNames",
        ),
    }
    return {
        "tags": direct["modNames"],
        "items": direct["baseItems"],
        "gems": direct["activeAndItems"],
        "ui": _add_official_fallback(direct["uiPrimary"], direct["uiSupplement"]),
        "stats": direct["stats"],
        "passives": _add_official_fallback(
            direct["passives"], direct["passiveSupplement"]
        ),
        "uniques": direct["uniques"],
        "monsters": direct["monsters"],
    }


def load_trusted_zh_reference_hashes(repository_root: Path) -> dict[str, str]:
    manifest_path = repository_root / "reports/baseline/original-distribution.sha256.json"
    document, issues = _read_evidence_json(manifest_path)
    expected_paths = {
        f"Data/poe1/zh-rTW/{dictionary}.json": dictionary
        for dictionary in DICTIONARIES
    }
    observed: dict[str, list[str]] = defaultdict(list)
    seen_paths: set[str] = set()
    relevant_hash_paths: dict[str, list[str]] = defaultdict(list)
    if not isinstance(document, dict) or document.get("algorithm") != "SHA256":
        issues.append(
            _evidence_issue(
                "OFFICIAL_REFERENCE_MANIFEST_MISMATCH",
                manifest_path,
                "baseline manifest must declare SHA256",
            )
        )
    else:
        rows = document.get("files")
        if not isinstance(rows, list):
            issues.append(
                _evidence_issue(
                    "OFFICIAL_REFERENCE_MANIFEST_MISMATCH",
                    manifest_path,
                    "baseline manifest files must be an array",
                )
            )
        else:
            for index, row in enumerate(rows):
                if not isinstance(row, dict):
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_INVALID_ROW",
                            manifest_path,
                            f"baseline manifest row {index} must be an object",
                        )
                    )
                    continue
                if set(row) != {"path", "sha256"}:
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_INVALID_ROW",
                            manifest_path,
                            f"baseline manifest row {index} fields differ",
                        )
                    )
                path_value = row.get("path")
                sha256 = row.get("sha256")
                if not isinstance(path_value, str) or not path_value:
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_INVALID_ROW",
                            manifest_path,
                            f"baseline manifest row {index} path must be a string",
                        )
                    )
                    continue
                if path_value in seen_paths:
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_DUPLICATE_PATH",
                            manifest_path,
                            f"baseline manifest path is duplicated: {path_value}",
                        )
                    )
                seen_paths.add(path_value)
                if not isinstance(sha256, str) or not re.fullmatch(r"[0-9A-Fa-f]{64}", sha256):
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_INVALID_ROW",
                            manifest_path,
                            f"baseline manifest row {index} sha256 is malformed",
                        )
                    )
                    continue
                dictionary = expected_paths.get(path_value)
                if dictionary is not None:
                    normalized_hash = sha256.upper()
                    observed[dictionary].append(normalized_hash)
                    relevant_hash_paths[normalized_hash].append(path_value)
            for sha256, paths in sorted(relevant_hash_paths.items()):
                if len(paths) > 1:
                    issues.append(
                        _evidence_issue(
                            "OFFICIAL_REFERENCE_MANIFEST_DUPLICATE_HASH",
                            manifest_path,
                            f"trusted zh hash is reused by: {', '.join(sorted(paths))}",
                        )
                    )
    for dictionary in DICTIONARIES:
        values = observed.get(dictionary, [])
        expected = TRUSTED_ZH_REFERENCE_HASHES[dictionary]
        if values != [expected]:
            issues.append(
                _evidence_issue(
                    "OFFICIAL_REFERENCE_MANIFEST_MISMATCH",
                    manifest_path,
                    f"{dictionary} pinned baseline hash differs or is not unique",
                )
            )
    if issues:
        raise OfficialEvidenceError(
            sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))
        )
    return dict(TRUSTED_ZH_REFERENCE_HASHES)


def load_official_runtime_identity(
    repository_root: Path,
    *,
    trusted_reference_hashes: dict[str, str] | None = None,
) -> dict[str, str]:
    provenance = json.loads(
        (repository_root / "reports/display-closure/provenance.json").read_text(encoding="utf-8")
    )
    locale_root = repository_root / "pob-zh-engine/dist/Data/poe1"
    accepted = _accepted_official_by_dictionary(repository_root)
    dynamic_path = repository_root / "localization/ko-KR/manual/dynamic-patterns.json"
    dynamic = (
        json.loads(dynamic_path.read_text(encoding="utf-8"))
        if dynamic_path.is_file()
        else {"patterns": []}
    )
    corrected_by_dictionary: dict[str, set[str]] = defaultdict(set)
    for row in dynamic.get("patterns", []):
        if isinstance(row, dict) and isinstance(row.get("source"), str):
            corrected_by_dictionary[str(row.get("dictionary", "stats"))].add(row["source"])
    candidates: dict[str, set[str]] = defaultdict(set)
    issues: list[dict[str, str]] = []
    trusted_hashes = (
        load_trusted_zh_reference_hashes(repository_root)
        if trusted_reference_hashes is None
        else trusted_reference_hashes
    )
    for dictionary in DICTIONARIES:
        chinese_path = locale_root / "zh-rTW" / f"{dictionary}.json"
        korean_path = locale_root / "ko-KR" / f"{dictionary}.json"
        expected_hash = trusted_hashes.get(dictionary, "")
        if not expected_hash or not _matches_manifest_sha256(chinese_path, expected_hash):
            issues.append(
                _evidence_issue(
                    "OFFICIAL_REFERENCE_HASH_MISMATCH",
                    chinese_path,
                    f"{dictionary} Traditional Chinese reference differs from pinned bytes",
                )
            )
            continue
        chinese = json.loads(chinese_path.read_text(encoding="utf-8"))["entries"]
        korean = json.loads(korean_path.read_text(encoding="utf-8"))["entries"]
        dictionary_provenance = provenance["dictionaries"][dictionary]
        for english, record in accepted[dictionary].items():
            if english in corrected_by_dictionary[dictionary] or english not in chinese:
                continue
            target = record["value"]
            actual_target = korean.get(english)
            actual_provenance = dictionary_provenance.get(english)
            if actual_target != target:
                issues.append(
                    _evidence_issue(
                        "OFFICIAL_DERIVED_TARGET_MISMATCH",
                        korean_path,
                        f"{dictionary}/{english} differs from accepted evidence",
                    )
                )
                continue
            expected_sources = set(record["source"].split(" | "))
            actual_sources = (
                set(str(actual_provenance.get("source", "")).split(" | "))
                if isinstance(actual_provenance, dict)
                else set()
            )
            if (
                not isinstance(actual_provenance, dict)
                or actual_provenance.get("layer") != "official-exact"
                or actual_sources != expected_sources
            ):
                issues.append(
                    _evidence_issue(
                        "OFFICIAL_DERIVED_PROVENANCE_MISMATCH",
                        repository_root / "reports/display-closure/provenance.json",
                        f"{dictionary}/{english} provenance differs from accepted evidence",
                    )
                )
                continue
            source = chinese.get(english)
            if isinstance(source, str) and isinstance(actual_target, str):
                candidates[source].add(actual_target)
    if issues:
        raise OfficialEvidenceError(
            sorted(issues, key=lambda row: (row["path"], row["code"], row["detail"]))
        )
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


def validate_output_paths(output: Path, suggestions: Path, report: Path) -> None:
    resolved = [path.resolve() for path in (output, suggestions, report)]
    if len(set(resolved)) != len(resolved):
        raise ValueError("output paths must be distinct after resolution")


def run_migration(
    *,
    upstream_ref: str,
    localized_root: Path,
    output: Path,
    suggestions: Path,
    report_path: Path,
    repository_root: Path = REPOSITORY_ROOT,
) -> MigrationResult:
    validate_output_paths(output, suggestions, report_path)
    evidence_issues = verify_official_evidence(repository_root)
    if evidence_issues:
        failure_report = {
            "schemaVersion": 1,
            "upstreamRef": PINNED_UPSTREAM,
            "counts": {
                "official": 0,
                "reviewed": 0,
                "suggested": 0,
                "ambiguous": 0,
                "unmapped": len(evidence_issues),
            },
            "issues": evidence_issues,
        }
        write_json(report_path, failure_report)
        raise OfficialEvidenceError(evidence_issues)
    if upstream_ref != PINNED_UPSTREAM:
        raise ValueError(f"upstream ref must be pinned to {PINNED_UPSTREAM}")
    resolved = _git_bytes(["rev-parse", "--verify", f"{upstream_ref}^{{commit}}"])
    if resolved.decode("ascii").strip() != PINNED_UPSTREAM:
        raise ValueError("pinned upstream ref resolved to an unexpected commit")

    localized_root = localized_root.resolve()
    excluded = _excluded_paths()
    alignments: list[Alignment] = []
    alignment_issues: list[dict[str, Any]] = []
    context_inventories: dict[str, tuple[list[Literal], list[Literal]]] = {}
    upstream_sources: set[str] = set()
    files_scanned = 0
    for repository_path in _upstream_paths(upstream_ref):
        relative = repository_path.removeprefix("pob-zh-engine/")
        if relative in excluded:
            continue
        files_scanned += 1
        upstream_text = _git_bytes(["show", f"{upstream_ref}:{repository_path}"])
        current_path = localized_root / Path(relative)
        if (
            not current_path.is_file()
            or not current_path.resolve().is_relative_to(localized_root)
        ):
            alignment_issues.append(
                {"code": "CURRENT_PATH_MISSING", "path": relative, "function": "", "source": ""}
            )
            continue
        current_text = current_path.read_bytes()
        file_alignments, file_issues = align_file_literals(
            Path(relative), upstream_text, current_text
        )
        alignments.extend(file_alignments)
        alignment_issues.extend(file_issues)
        context_inventories[relative] = (
            _context_inventory(Path(relative), upstream_text),
            _context_inventory(Path(relative), current_text),
        )
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
        for source, target in load_official_runtime_identity(repository_root).items()
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
        context_inventories=context_inventories,
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
