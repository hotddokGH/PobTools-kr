"""Tree-sitter based, transactional Korean overlay for trusted C++ source trees."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tree_sitter import Language, Node, Parser
import tree_sitter_cpp


ACCEPTED_STATUSES = frozenset({"official", "reviewed", "intentional"})
PINNED_SOURCE_COMMITS = {
    "upstream": "baf07d41d2df524d4330a58b411826339c93fac1",
    "localized": "2997715df0d6257192107d799a9f414b54e6c02b",
}
_HAN = re.compile(
    r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF"
    r"\U00020000-\U0002FA1F\U00030000-\U000323AF]"
)
_PARSER = Parser(Language(tree_sitter_cpp.language()))
_REGULAR_OPEN = re.compile(rb'(?P<prefix>u8|u|U|L)?"')
_RAW_OPEN = re.compile(rb'(?P<prefix>u8R|uR|UR|LR|R)"(?P<delimiter>[^ ()\\\t\r\n]{0,16})\(')


@dataclass(frozen=True)
class LiteralComponent:
    start: int
    end: int
    decoded: str
    prefix: str
    kind: str
    line: int


@dataclass(frozen=True)
class Literal:
    path: str
    start: int
    end: int
    decoded: str
    prefix: str
    function: str
    line: int
    occurrence_index: int = 0
    components: tuple[LiteralComponent, ...] = ()


@dataclass(frozen=True)
class ParseRecoveryEvidence:
    path: str
    source_role: str
    source_commit: str
    file_sha256: str
    recovery_sha256: str
    reason: str


@dataclass(frozen=True)
class InternalLiteralEvidence:
    path: str
    sha256: str
    reason: str


class PolicyValidationError(ValueError):
    def __init__(self, details: list[str]):
        super().__init__("; ".join(details))
        self.details = details


class UnsupportedEscape(ValueError):
    def __init__(self, escape: str, start: int, end: int, line: int, function: str):
        super().__init__(f"unsupported C++ escape: {escape}")
        self.escape = escape
        self.start = start
        self.end = end
        self.line = line
        self.function = function
        self.occurrence_index = -1


class CppParseError(ValueError):
    def __init__(self, problems: list[dict[str, Any]]):
        super().__init__(f"C++ parse failed with {len(problems)} problem(s)")
        self.problems = problems


class RawDelimiterCollision(ValueError):
    pass


class UnsafeNulEncoding(ValueError):
    pass


def format_signature(value: str) -> tuple[str, ...]:
    tokens = re.findall(
        r"%(?:[-+0 #]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGaAcspn%])|\{\d+\}|\^x[0-9A-Fa-f]{6}",
        value,
    )
    tokens.extend("<NL>" for _ in range(value.count("\n")))
    tokens.extend("<NUL>" for _ in range(value.count("\0")))
    return tuple(sorted(tokens))


def _decode_escape_text(
    value: str,
    *,
    start: int,
    end: int,
    line: int,
    function: str,
    allow_legacy_nul: bool = False,
) -> str:
    output: list[str] = []
    cursor = 0
    simple = {"\\": "\\", '"': '"', "n": "\n", "r": "\r", "t": "\t"}
    while cursor < len(value):
        character = value[cursor]
        if character != "\\":
            output.append(character)
            cursor += 1
            continue
        if cursor + 1 >= len(value):
            raise UnsupportedEscape("\\<EOF>", start, end, line, function)
        marker = value[cursor + 1]
        if marker in "01234567":
            octal_end = cursor + 2
            while octal_end < len(value) and value[octal_end] in "01234567":
                octal_end += 1
            if marker == "0" and octal_end == cursor + 2:
                output.append("\0")
                cursor += 2
                continue
            raise UnsupportedEscape(value[cursor:octal_end], start, end, line, function)
        if marker in simple:
            output.append(simple[marker])
            cursor += 2
            continue
        if marker == "x":
            hex_end = cursor + 2
            while hex_end < len(value) and value[hex_end] in "0123456789abcdefABCDEF":
                hex_end += 1
            digits = value[cursor + 2 : hex_end]
            if len(digits) != 2:
                raise UnsupportedEscape(value[cursor:hex_end], start, end, line, function)
            output.append(chr(int(digits, 16)))
            cursor = hex_end
            continue
        widths = {"u": 4, "U": 8}
        width = widths.get(marker)
        digits = value[cursor + 2 : cursor + 2 + width] if width is not None else ""
        if width is not None and len(digits) == width and re.fullmatch(r"[0-9A-Fa-f]+", digits):
            try:
                output.append(chr(int(digits, 16)))
            except ValueError as error:
                raise UnsupportedEscape(f"\\{marker}{digits}", start, end, line, function) from error
            cursor += 2 + width
            continue
        escape_end = min(len(value), cursor + 2 + (width or 0))
        raise UnsupportedEscape(value[cursor:escape_end], start, end, line, function)
    return "".join(output)


def _function_name(node: Node, text: bytes) -> str:
    declarator = node.child_by_field_name("declarator")
    if declarator is None:
        return ""
    while True:
        inner = declarator.child_by_field_name("declarator")
        if inner is None:
            break
        declarator = inner
    return text[declarator.start_byte : declarator.end_byte].decode("utf-8")


def _decode_literal(
    node: Node,
    text: bytes,
    function: str,
    line: int,
    *,
    allow_legacy_nul: bool = False,
) -> tuple[str, str]:
    raw = text[node.start_byte : node.end_byte]
    if node.type == "raw_string_literal":
        match = _RAW_OPEN.fullmatch(raw[: raw.find(b"(") + 1])
        if match is None:
            raise ValueError(f"invalid raw string literal at byte {node.start_byte}")
        delimiter = match.group("delimiter")
        content_start = match.end()
        terminator = b")" + delimiter + b'"'
        if not raw.endswith(terminator):
            raise ValueError(f"unterminated raw string literal at byte {node.start_byte}")
        return raw[content_start : -len(terminator)].decode("utf-8"), match.group("prefix").decode("ascii")

    match = _REGULAR_OPEN.match(raw)
    if match is None or not raw.endswith(b'"'):
        raise ValueError(f"invalid string literal at byte {node.start_byte}")
    encoded = raw[match.end() : -1].decode("utf-8")
    return (
        _decode_escape_text(
            encoded,
            start=node.start_byte,
            end=node.end_byte,
            line=line,
            function=function,
            allow_legacy_nul=allow_legacy_nul,
        ),
        (match.group("prefix") or b"").decode("ascii"),
    )


def _normalized_policy_path(value: str) -> str | None:
    if (
        not value
        or value != value.replace("\\", "/")
        or value.startswith("/")
        or re.match(r"^[A-Za-z]:", value)
    ):
        return None
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return value


def validate_parse_recovery_allowlist(value: Any) -> tuple[ParseRecoveryEvidence, ...]:
    if not isinstance(value, list):
        raise PolicyValidationError(["parseRecoveryAllowlist must be an array"])
    required = {
        "path",
        "sourceRole",
        "sourceCommit",
        "fileSha256",
        "recoverySha256",
        "reason",
    }
    rows: list[ParseRecoveryEvidence] = []
    details: list[str] = []
    seen: dict[tuple[str, str, str], int] = {}
    for index, row in enumerate(value):
        if not isinstance(row, dict) or set(row) != required:
            details.append(f"parseRecoveryAllowlist[{index}] has an invalid shape")
            continue
        path = row["path"]
        source_role = row["sourceRole"]
        source_commit = row["sourceCommit"]
        file_sha256 = row["fileSha256"]
        recovery_sha256 = row["recoverySha256"]
        reason = row["reason"]
        if not isinstance(path, str) or _normalized_policy_path(path) is None:
            details.append(f"parseRecoveryAllowlist[{index}].path is invalid")
            continue
        if (
            not isinstance(source_role, str)
            or source_role not in PINNED_SOURCE_COMMITS
            or not isinstance(source_commit, str)
            or source_commit != PINNED_SOURCE_COMMITS.get(source_role)
        ):
            details.append(f"parseRecoveryAllowlist[{index}] has invalid source evidence")
            continue
        if (
            not isinstance(file_sha256, str)
            or re.fullmatch(r"[0-9A-F]{64}", file_sha256) is None
            or not isinstance(recovery_sha256, str)
            or re.fullmatch(r"[0-9A-F]{64}", recovery_sha256) is None
        ):
            details.append(f"parseRecoveryAllowlist[{index}] has an invalid SHA-256")
            continue
        if not isinstance(reason, str) or not reason.strip():
            details.append(f"parseRecoveryAllowlist[{index}].reason is blank")
            continue
        key = (path, source_role, source_commit)
        if key in seen:
            details.append(
                f"parseRecoveryAllowlist[{index}] duplicates row {seen[key]} consumer identity"
            )
            continue
        seen[key] = index
        rows.append(
            ParseRecoveryEvidence(
                path,
                source_role,
                source_commit,
                file_sha256,
                recovery_sha256,
                reason,
            )
        )
    if details:
        raise PolicyValidationError(details)
    return tuple(rows)


def validate_internal_literal_allowlist(
    value: Any,
) -> tuple[InternalLiteralEvidence, ...]:
    if not isinstance(value, list):
        raise PolicyValidationError(["internalLiteralAllowlist must be an array"])
    required = {"path", "sha256", "reason"}
    details: list[str] = []
    rows: list[InternalLiteralEvidence] = []
    identities: dict[tuple[str, str], list[int]] = {}
    for index, row in enumerate(value):
        label = f"internalLiteralAllowlist[{index}]"
        if not isinstance(row, dict):
            details.append(f"{label} must be an object")
            continue
        if set(row) != required:
            details.append(f"{label} must contain exactly path, sha256, reason")
            continue
        path = row["path"]
        sha256 = row["sha256"]
        reason = row["reason"]
        if not isinstance(path, str) or _normalized_policy_path(path) is None:
            details.append(f"{label}.path must be a normalized relative path")
            continue
        if not isinstance(sha256, str) or re.fullmatch(r"[0-9A-F]{64}", sha256) is None:
            details.append(f"{label}.sha256 must be uppercase SHA-256")
            continue
        if not isinstance(reason, str) or not reason.strip():
            details.append(f"{label}.reason must be nonblank")
            continue
        identities.setdefault((path, sha256), []).append(index)
        rows.append(InternalLiteralEvidence(path, sha256, reason.strip()))
    for identity, indexes in sorted(identities.items()):
        if len(indexes) > 1:
            details.append(
                "duplicate internalLiteralAllowlist identity "
                f"{identity[0]} {identity[1]} at indexes {indexes}"
            )
    if details:
        raise PolicyValidationError(details)
    return tuple(rows)


def _ordered_recovery_nodes(tree: Any) -> list[Node]:
    rows: list[Node] = []
    pending = [tree.root_node]
    while pending:
        node = pending.pop()
        if node.is_error or node.is_missing or node.type == "ERROR":
            rows.append(node)
        pending.extend(reversed(node.children))
    if tree.root_node.has_error and not rows:
        rows.append(tree.root_node)
    return rows


def _recovery_sha256(nodes: list[Node]) -> str:
    fingerprint = [
        [
            node.start_byte,
            node.end_byte,
            node.type,
            node.parent.type if node.parent is not None else "",
            bool(node.is_error),
            bool(node.is_missing),
        ]
        for node in nodes
    ]
    payload = json.dumps(
        fingerprint, ensure_ascii=True, separators=(",", ":")
    ).encode("ascii")
    return hashlib.sha256(payload).hexdigest().upper()


def _recovery_identity(row: ParseRecoveryEvidence) -> tuple[str, str, str, str, str]:
    return (
        row.path,
        row.source_role,
        row.source_commit,
        row.file_sha256,
        row.recovery_sha256,
    )


def recovery_evidence_report(
    rows: set[ParseRecoveryEvidence],
) -> dict[str, Any]:
    identities = [
        {
            "path": row.path,
            "sourceRole": row.source_role,
            "sourceCommit": row.source_commit,
            "fileSha256": row.file_sha256,
            "recoverySha256": row.recovery_sha256,
        }
        for row in sorted(rows, key=_recovery_identity)
    ]
    return {"useCount": len(identities), "identities": identities}


def scan_cpp_literals(
    path: Path,
    text: bytes,
    *,
    parse_recovery_allowlist: tuple[ParseRecoveryEvidence, ...] = (),
    source_role: str = "",
    source_commit: str = "",
    used_recovery_evidence: set[ParseRecoveryEvidence] | None = None,
    allow_legacy_nul: bool = False,
) -> list[Literal]:
    """Return semantic C++ string values with byte offsets into *text*."""
    tree = _PARSER.parse(text)
    normalized_path = path.as_posix()
    candidates: list[tuple[Node, str, int]] = []

    def collect(node: Node, function: str, function_scope: int) -> None:
        if node.type == "function_definition":
            function = _function_name(node, text)
            function_scope = node.start_byte
        if node.type in {"concatenated_string", "string_literal", "raw_string_literal"}:
            candidates.append((node, function, function_scope))
            return
        for child in node.named_children:
            collect(child, function, function_scope)

    collect(tree.root_node, "", -1)
    occurrence_by_span: dict[tuple[int, int, int], int] = {}
    by_function: dict[int, list[Node]] = {}
    for node, _, function_scope in candidates:
        by_function.setdefault(function_scope, []).append(node)
    for function_scope, nodes in by_function.items():
        for occurrence_index, node in enumerate(sorted(nodes, key=lambda value: value.start_byte)):
            occurrence_by_span[(function_scope, node.start_byte, node.end_byte)] = occurrence_index

    recovery_nodes = _ordered_recovery_nodes(tree)
    relevant_evidence = [
        row
        for row in parse_recovery_allowlist
        if row.path == normalized_path
        and row.source_role == source_role
        and row.source_commit == source_commit
    ]
    file_sha256 = hashlib.sha256(text).hexdigest().upper()
    recovery_sha256 = _recovery_sha256(recovery_nodes)
    matching_evidence = [
        row
        for row in relevant_evidence
        if row.file_sha256 == file_sha256
        and row.recovery_sha256 == recovery_sha256
    ]
    problem_nodes: list[Node] = []
    if recovery_nodes or relevant_evidence:
        if len(matching_evidence) == 1 and recovery_nodes:
            if used_recovery_evidence is not None:
                used_recovery_evidence.add(matching_evidence[0])
        else:
            problem_nodes = recovery_nodes or [tree.root_node]
    if problem_nodes:
        problems: list[dict[str, Any]] = []
        for problem in sorted(
            problem_nodes,
            key=lambda node: (node.start_byte, node.end_byte, node.type, node.is_missing),
        ):
            matching_candidates = [
                (node, function, function_scope)
                for node, function, function_scope in candidates
                if (
                    node.start_byte < problem.end_byte
                    and node.end_byte > problem.start_byte
                )
                or (
                    problem.start_byte == problem.end_byte
                    and node.start_byte <= problem.start_byte <= node.end_byte
                )
                or (
                    problem.parent is not None
                    and problem.parent.type != "translation_unit"
                    and node.start_byte >= problem.parent.start_byte
                    and node.end_byte <= problem.parent.end_byte
                )
            ]
            if matching_candidates:
                for node, function, function_scope in matching_candidates:
                    problems.append(
                        {
                            "function": function,
                            "line": text.count(b"\n", 0, problem.start_byte) + 1,
                            "startByte": problem.start_byte,
                            "endByte": problem.end_byte,
                            "fileSha256": file_sha256,
                            "recoverySha256": recovery_sha256,
                            "occurrenceIndex": occurrence_by_span[
                                (function_scope, node.start_byte, node.end_byte)
                            ],
                        }
                    )
            else:
                function = ""
                ancestor = problem.parent
                while ancestor is not None:
                    if ancestor.type == "function_definition":
                        function = _function_name(ancestor, text)
                        break
                    ancestor = ancestor.parent
                problems.append(
                    {
                        "function": function,
                        "line": text.count(b"\n", 0, problem.start_byte) + 1,
                        "startByte": problem.start_byte,
                        "endByte": problem.end_byte,
                        "fileSha256": file_sha256,
                        "recoverySha256": recovery_sha256,
                    }
                )
        unique_problems = {
            (
                row["function"],
                row["line"],
                row["startByte"],
                row["endByte"],
                row.get("occurrenceIndex", -1),
            ): row
            for row in problems
        }
        raise CppParseError([unique_problems[key] for key in sorted(unique_problems)])

    rows: list[Literal] = []
    for node, function, function_scope in sorted(
        candidates, key=lambda value: value[0].start_byte
    ):
        occurrence_index = occurrence_by_span[
            (function_scope, node.start_byte, node.end_byte)
        ]
        try:
            if node.type == "concatenated_string":
                literal_nodes = [
                    child
                    for child in node.named_children
                    if child.type in {"string_literal", "raw_string_literal"}
                ]
                if not literal_nodes:
                    continue
                line = text.count(b"\n", 0, node.start_byte) + 1
                decoded_parts: list[str] = []
                components: list[LiteralComponent] = []
                prefix = ""
                for index, child in enumerate(literal_nodes):
                    child_line = text.count(b"\n", 0, child.start_byte) + 1
                    decoded, child_prefix = _decode_literal(
                        child,
                        text,
                        function,
                        child_line,
                        allow_legacy_nul=allow_legacy_nul,
                    )
                    decoded_parts.append(decoded)
                    components.append(
                        LiteralComponent(
                            child.start_byte,
                            child.end_byte,
                            decoded,
                            child_prefix,
                            "raw" if child.type == "raw_string_literal" else "regular",
                            child_line,
                        )
                    )
                    if index == 0:
                        prefix = child_prefix
                rows.append(
                    Literal(
                        normalized_path,
                        node.start_byte,
                        node.end_byte,
                        "".join(decoded_parts),
                        prefix,
                        function,
                        line,
                        occurrence_index,
                        tuple(components),
                    )
                )
                continue
            line = text.count(b"\n", 0, node.start_byte) + 1
            decoded, prefix = _decode_literal(
                node,
                text,
                function,
                line,
                allow_legacy_nul=allow_legacy_nul,
            )
            rows.append(
                Literal(
                    normalized_path,
                    node.start_byte,
                    node.end_byte,
                    decoded,
                    prefix,
                    function,
                    line,
                    occurrence_index,
                    (
                        LiteralComponent(
                            node.start_byte,
                            node.end_byte,
                            decoded,
                            prefix,
                            "raw" if node.type == "raw_string_literal" else "regular",
                            line,
                        ),
                    ),
                )
            )
        except UnsupportedEscape as error:
            error.occurrence_index = occurrence_index
            raise
    return rows


def _source_files(source_root: Path) -> list[Path]:
    files: set[Path] = set()
    host_root = source_root / "host"
    if host_root.is_dir():
        for path in host_root.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".cpp", ".h"}:
                files.add(path)
    if source_root.is_dir():
        for path in source_root.iterdir():
            if path.is_file() and re.fullmatch(r"ui_.*\.(?:cpp|h)", path.name):
                files.add(path)
    return sorted(files, key=lambda path: path.relative_to(source_root).as_posix())


def _excluded_paths(policy: dict[str, Any]) -> set[str]:
    return {
        str(row.get("path", "")).replace("\\", "/")
        for row in policy.get("excludedPaths", [])
        if isinstance(row, dict) and str(row.get("reason", "")).strip()
    }


def _allowlisted_identities(
    rows: tuple[InternalLiteralEvidence, ...],
) -> set[tuple[str, str]]:
    return {
        (row.path, row.sha256)
        for row in rows
    }


def _issue(code: str, literal: Literal, **extra: Any) -> dict[str, Any]:
    return {
        "code": code,
        "path": literal.path,
        "function": literal.function,
        "occurrenceIndex": literal.occurrence_index,
        "line": literal.line,
        "source": literal.decoded,
        **extra,
    }


def _regular_literal(prefix: str, target: str) -> bytes:
    escaped_parts: list[str] = []
    escapes = {"\\": "\\\\", '"': '\\"', "\r": "\\r", "\n": "\\n", "\t": "\\t"}
    for index, character in enumerate(target):
        if character == "\0":
            if index + 1 < len(target) and target[index + 1] in "01234567":
                raise UnsafeNulEncoding(target[index : index + 2])
            escaped_parts.append("\\0")
        else:
            escaped_parts.append(escapes.get(character, character))
    escaped = "".join(escaped_parts)
    return f'{prefix}"{escaped}"'.encode("utf-8")


def _newline_style(text: bytes) -> str | None:
    if b"\r\n" in text:
        return "\r\n"
    if b"\n" in text:
        return "\n"
    if b"\r" in text:
        return "\r"
    return None


def _raw_literal(prefix: str, target: str, original: bytes, source_text: bytes) -> bytes:
    opening = original.find(b"(")
    quote = original.find(b'"')
    delimiter = original[quote + 1 : opening].decode("ascii") if 0 <= quote < opening else ""
    newline = _newline_style(original) or _newline_style(source_text) or "\n"
    target = target.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
    if f'){delimiter}"' in target:
        raise RawDelimiterCollision(delimiter)
    return f'{prefix}"{delimiter}({target}){delimiter}"'.encode("utf-8")


def _replacement_bytes(
    literal: Literal | LiteralComponent,
    target: str,
    original: bytes,
    source_text: bytes,
) -> bytes:
    if literal.prefix.endswith("R"):
        return _raw_literal(literal.prefix, target, original, source_text)
    return _regular_literal(literal.prefix, target)


def _is_concatenated_literal(original: bytes) -> bool:
    pending = [_PARSER.parse(original).root_node]
    while pending:
        node = pending.pop()
        if node.type == "concatenated_string":
            return True
        pending.extend(node.named_children)
    return False


def _resolve_mapping(
    literal: Literal, entries: dict[str, Any], contexts: list[Any]
) -> dict[str, Any] | None:
    for row in contexts:
        if not isinstance(row, dict):
            continue
        if (
            str(row.get("path", "")).replace("\\", "/") == literal.path
            and row.get("function") == literal.function
            and row.get("source") == literal.decoded
            and row.get("occurrenceIndex") == literal.occurrence_index
        ):
            return row
    row = entries.get(literal.decoded)
    return row if isinstance(row, dict) else None


def _validated_component_targets(
    literal: Literal, row: dict[str, Any], target: str
) -> list[str] | None:
    values = row.get("components")
    if values is None:
        return None
    if not isinstance(values, list) or len(values) != len(literal.components):
        return []
    sources = [component.get("source") for component in values]
    targets = [component.get("target") for component in values]
    if (
        any(not isinstance(value, str) for value in [*sources, *targets])
        or sources != [component.decoded for component in literal.components]
        or "".join(sources) != literal.decoded
        or "".join(targets) != target
    ):
        return []
    return targets


def _write_report(report_path: Path, report: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")


def _mapping_row_is_well_formed(row: Any) -> bool:
    base_is_valid = (
        isinstance(row, dict)
        and isinstance(row.get("target"), str)
        and isinstance(row.get("status"), str)
        and isinstance(row.get("provenance"), str)
        and isinstance(row.get("formatSignature"), list)
        and all(isinstance(token, str) for token in row["formatSignature"])
    )
    if not base_is_valid or "components" not in row:
        return base_is_valid
    components = row["components"]
    return isinstance(components, list) and all(
        isinstance(component, dict)
        and set(component) == {"source", "target"}
        and isinstance(component["source"], str)
        and isinstance(component["target"], str)
        for component in components
    )


def _strings_are_utf8_encodable(values: list[str]) -> bool:
    try:
        for value in values:
            value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _mapping_row_strings(row: dict[str, Any]) -> list[str]:
    values = [
        row["target"],
        row["status"],
        row["provenance"],
        *row["formatSignature"],
    ]
    for component in row.get("components", []):
        values.extend((component["source"], component["target"]))
    return values


def _safe_report_text(value: Any) -> str:
    return str(value).encode("utf-8", errors="backslashreplace").decode("utf-8")


def _new_report(files: list[Path]) -> dict[str, Any]:
    return {
        "filesScanned": len(files),
        "displayLiterals": 0,
        "reused": 0,
        "official": 0,
        "reviewed": 0,
        "intentional": 0,
        "parseRecoveryEvidence": {"useCount": 0, "identities": []},
        "issues": [],
    }


def _run_overlay(
    source_root: Path,
    mapping_path: Path,
    policy_path: Path,
    report_path: Path,
    *,
    write_sources: bool,
) -> dict[str, Any]:
    files = _source_files(source_root)
    report = _new_report(files)
    try:
        mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        report["issues"].append({"code": "INVALID_MAPPING_DOCUMENT", "detail": str(error)})
        _write_report(report_path, report)
        return report
    if not isinstance(mapping, dict):
        report["issues"].append(
            {"code": "INVALID_MAPPING_DOCUMENT", "detail": "root must be an object"}
        )
        _write_report(report_path, report)
        return report
    if type(mapping.get("schemaVersion")) is not int or mapping["schemaVersion"] != 2:
        report["issues"].append(
            {
                "code": "INVALID_MAPPING_DOCUMENT",
                "field": "schemaVersion",
                "detail": "schemaVersion must equal 2",
            }
        )
    for field in ("entries", "contexts"):
        if field not in mapping:
            report["issues"].append(
                {
                    "code": "INVALID_MAPPING_DOCUMENT",
                    "field": field,
                    "detail": f"{field} is required",
                }
            )
    if report["issues"]:
        _write_report(report_path, report)
        return report
    entries = mapping["entries"]
    contexts = mapping["contexts"]
    if not isinstance(entries, dict) or not isinstance(contexts, list):
        report["issues"].append(
            {
                "code": "INVALID_MAPPING_DOCUMENT",
                "detail": "entries must be an object and contexts must be an array",
            }
        )
        _write_report(report_path, report)
        return report
    for source, row in sorted(entries.items(), key=lambda item: str(item[0])):
        if not isinstance(source, str) or not _mapping_row_is_well_formed(row):
            report["issues"].append(
                {"code": "INVALID_MAPPING_ENTRY", "source": _safe_report_text(source)}
            )
        elif not _strings_are_utf8_encodable([source, *_mapping_row_strings(row)]):
            report["issues"].append(
                {"code": "INVALID_MAPPING_ENCODING", "location": f"entries[{source!r}]"}
            )
        elif row["status"] not in ACCEPTED_STATUSES:
            code = "SUGGESTION_ONLY" if row["status"] == "suggested" else "STATUS_REJECTED"
            report["issues"].append(
                {"code": code, "location": f"entries[{source!r}]"}
            )
    context_fields = ("path", "function", "source")
    context_keys: dict[tuple[str, str, str, int], list[int]] = {}
    for index, row in enumerate(contexts):
        if (
            not _mapping_row_is_well_formed(row)
            or any(not isinstance(row.get(field), str) for field in context_fields)
            or type(row.get("occurrenceIndex")) is not int
            or row["occurrenceIndex"] < 0
        ):
            report["issues"].append({"code": "INVALID_CONTEXT_ENTRY", "index": index})
        elif not _strings_are_utf8_encodable(
            [*(row[field] for field in context_fields), *_mapping_row_strings(row)]
        ):
            report["issues"].append(
                {"code": "INVALID_MAPPING_ENCODING", "location": f"contexts[{index}]"}
            )
        elif row["status"] not in ACCEPTED_STATUSES:
            code = "SUGGESTION_ONLY" if row["status"] == "suggested" else "STATUS_REJECTED"
            report["issues"].append(
                {"code": code, "location": f"contexts[{index}]"}
            )
        else:
            key = (
                row["path"].replace("\\", "/"),
                row["function"],
                row["source"],
                row["occurrenceIndex"],
            )
            context_keys.setdefault(key, []).append(index)
    for indexes in context_keys.values():
        if len(indexes) > 1:
            for index in indexes:
                report["issues"].append(
                    {
                        "code": "INVALID_CONTEXT_ENTRY",
                        "index": index,
                        "detail": "duplicate context consumer key",
                    }
                )
    if report["issues"]:
        _write_report(report_path, report)
        return report

    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        report["issues"].append(
            {"code": "INVALID_POLICY_DOCUMENT", "detail": str(error)}
        )
        _write_report(report_path, report)
        return report
    if not isinstance(policy, dict):
        report["issues"].append(
            {"code": "INVALID_POLICY_DOCUMENT", "detail": "root must be an object"}
        )
        _write_report(report_path, report)
        return report
    try:
        parse_recovery_allowlist = validate_parse_recovery_allowlist(
            policy.get("parseRecoveryAllowlist")
        )
        internal_literal_allowlist = validate_internal_literal_allowlist(
            policy.get("internalLiteralAllowlist")
        )
    except PolicyValidationError as error:
        report["issues"].extend(
            {"code": "INVALID_POLICY_DOCUMENT", "detail": detail}
            for detail in error.details
        )
        _write_report(report_path, report)
        return report
    excluded = _excluded_paths(policy)
    allowed = _allowlisted_identities(internal_literal_allowlist)
    originals: dict[Path, bytes] = {}
    plans: dict[Path, list[tuple[int, int, bytes]]] = {}
    used_recovery_evidence: set[ParseRecoveryEvidence] = set()

    for path in files:
        relative = path.relative_to(source_root).as_posix()
        if relative in excluded:
            continue
        text = path.read_bytes()
        originals[path] = text
        try:
            literals = scan_cpp_literals(
                Path(relative),
                text,
                parse_recovery_allowlist=parse_recovery_allowlist,
                source_role="upstream",
                source_commit=PINNED_SOURCE_COMMITS["upstream"],
                used_recovery_evidence=used_recovery_evidence,
            )
        except CppParseError as error:
            for problem in error.problems:
                report["issues"].append(
                    {
                        "code": "CPP_PARSE_ERROR",
                        "path": relative,
                        **problem,
                    }
                )
            continue
        except UnsupportedEscape as error:
            report["issues"].append(
                {
                    "code": "UNSUPPORTED_ESCAPE",
                    "path": relative,
                    "function": error.function,
                    "occurrenceIndex": error.occurrence_index,
                    "line": error.line,
                    "source": text[error.start : error.end].decode("utf-8", errors="replace"),
                    "escape": error.escape,
                }
            )
            continue
        report["displayLiterals"] += len(literals)
        for literal in literals:
            digest = hashlib.sha256(literal.decoded.encode("utf-8")).hexdigest().upper()
            if (literal.path, digest) in allowed:
                report["intentional"] += 1
                continue
            if not _HAN.search(literal.decoded):
                continue
            row = _resolve_mapping(literal, entries, contexts)
            if row is None:
                report["issues"].append(_issue("MISSING_MAPPING", literal))
                continue
            status = str(row.get("status", ""))
            if status not in ACCEPTED_STATUSES:
                code = "SUGGESTION_ONLY" if status == "suggested" else "STATUS_REJECTED"
                report["issues"].append(_issue(code, literal, status=status))
                continue
            target = row.get("target")
            declared_signature = row.get("formatSignature")
            if not isinstance(target, str) or not isinstance(declared_signature, list):
                report["issues"].append(_issue("INVALID_MAPPING", literal))
                continue
            source_signature = format_signature(literal.decoded)
            target_signature = format_signature(target)
            recorded_signature = tuple(sorted(str(token) for token in declared_signature))
            if recorded_signature != source_signature or target_signature != source_signature:
                report["issues"].append(
                    _issue(
                        "FORMAT_SIGNATURE_MISMATCH",
                        literal,
                        sourceSignature=list(source_signature),
                        targetSignature=list(target_signature),
                    )
                )
                continue
            component_targets = _validated_component_targets(literal, row, target)
            if len(literal.components) > 1 and component_targets is None:
                report["issues"].append(_issue("INVALID_COMPONENT_PLAN", literal))
                continue
            if component_targets == []:
                report["issues"].append(_issue("INVALID_COMPONENT_PLAN", literal))
                continue
            try:
                if component_targets is None:
                    original = text[literal.start : literal.end]
                    replacements = [
                        (
                            literal.start,
                            literal.end,
                            _replacement_bytes(literal, target, original, text),
                        )
                    ]
                else:
                    replacements = []
                    for component, component_target in zip(
                        literal.components, component_targets, strict=True
                    ):
                        original = text[component.start : component.end]
                        replacements.append(
                            (
                                component.start,
                                component.end,
                                _replacement_bytes(
                                    component, component_target, original, text
                                ),
                            )
                        )
            except RawDelimiterCollision as error:
                report["issues"].append(
                    _issue("RAW_DELIMITER_COLLISION", literal, delimiter=str(error))
                )
                continue
            except UnsafeNulEncoding as error:
                report["issues"].append(
                    _issue("UNSAFE_NUL_ENCODING", literal, sequence=str(error))
                )
                continue
            plans.setdefault(path, []).extend(replacements)
            report["reused"] += 1
            report[status] += 1

    report["parseRecoveryEvidence"] = recovery_evidence_report(
        used_recovery_evidence
    )
    if not report["issues"] and write_sources:
        for path, replacements in plans.items():
            output = originals[path]
            for start, end, replacement in sorted(replacements, reverse=True):
                output = output[:start] + replacement + output[end:]
            path.write_bytes(output)

    _write_report(report_path, report)
    return report


def apply_overlay(
    source_root: Path, mapping_path: Path, policy_path: Path, report_path: Path
) -> dict[str, Any]:
    return _run_overlay(source_root, mapping_path, policy_path, report_path, write_sources=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("audit", "apply"))
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    arguments = parser.parse_args(argv)
    report = _run_overlay(
        arguments.source_root.resolve(),
        arguments.mapping.resolve(),
        arguments.policy.resolve(),
        arguments.report.resolve(),
        write_sources=arguments.mode == "apply",
    )
    print(
        f"source overlay: {report['filesScanned']} files; "
        f"{report['displayLiterals']} literals; {len(report['issues'])} issues"
    )
    return 1 if report["issues"] else 0


if __name__ == "__main__":
    sys.exit(main())
