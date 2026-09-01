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


class InvalidSourceEncoding(ValueError):
    def __init__(self, start: int, end: int, line: int):
        super().__init__(f"source is not valid UTF-8 at bytes {start}:{end}")
        self.start = start
        self.end = end
        self.line = line


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
            codepoint = int(digits, 16)
            if 0xD800 <= codepoint <= 0xDFFF:
                raise UnsupportedEscape(
                    f"\\{marker}{digits}", start, end, line, function
                )
            try:
                output.append(chr(codepoint))
            except ValueError as error:
                raise UnsupportedEscape(f"\\{marker}{digits}", start, end, line, function) from error
            cursor += 2 + width
            continue
        if marker == "\n":
            cursor += 2
            continue
        if marker == "\r" and cursor + 2 < len(value) and value[cursor + 2] == "\n":
            cursor += 3
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
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return None
    if (
        not value
        or value != value.replace("\\", "/")
        or value.startswith("/")
        or re.match(r"^[A-Za-z]:", value)
        or any(ord(character) <= 0x1F or ord(character) == 0x7F for character in value)
    ):
        return None
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return value


def _is_policy_blank_character(character: str) -> bool:
    """Use the same explicit policy-blank set as source-display-audit.mjs.

    The set is C0 (U+0000..U+001F), C1 (U+007F..U+009F), Unicode
    White_Space (U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028,
    U+2029, U+202F, U+205F, U+3000), and BOM (U+FEFF).
    """
    codepoint = ord(character)
    return (
        codepoint <= 0x1F
        or 0x7F <= codepoint <= 0x9F
        or codepoint in {0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF}
        or 0x2000 <= codepoint <= 0x200A
    )


def _normalized_policy_reason(value: str) -> str:
    start = 0
    end = len(value)
    while start < end and _is_policy_blank_character(value[start]):
        start += 1
    while start < end and _is_policy_blank_character(value[end - 1]):
        end -= 1
    return value[start:end]


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
        if not isinstance(reason, str) or not _normalized_policy_reason(reason):
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
        if not isinstance(reason, str) or not _normalized_policy_reason(reason):
            details.append(f"{label}.reason must be nonblank")
            continue
        identities.setdefault((path, sha256), []).append(index)
        rows.append(InternalLiteralEvidence(path, sha256, _normalized_policy_reason(reason)))
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


def _raw_opening_at(
    text: bytes, start: int, previous_lexical_byte: int | None
) -> tuple[int, bytes] | None:
    if previous_lexical_byte is not None and (
        previous_lexical_byte >= 0x80
        or chr(previous_lexical_byte).isalnum()
        or previous_lexical_byte in b"_$"
    ):
        return None
    candidate = bytearray()
    cursor = start
    while cursor < len(text) and len(candidate) <= 21:
        if text.startswith(b"\\\r\n", cursor):
            cursor += 3
            continue
        if text.startswith(b"\\\n", cursor):
            cursor += 2
            continue
        byte = text[cursor]
        candidate.append(byte)
        cursor += 1
        if byte == ord("("):
            opening = _RAW_OPEN.fullmatch(bytes(candidate))
            if opening is None:
                return None
            return cursor, opening.group("delimiter")
        if byte in b"\r\n":
            return None
    return None


def _phase2_lexical_view(text: bytes) -> tuple[bytes, list[int], list[int]]:
    output = bytearray()
    left_boundaries = [0]
    right_boundaries = [0]
    cursor = 0
    state = "code"
    escaped = False
    while cursor < len(text):
        if state == "code":
            opening = _raw_opening_at(
                text, cursor, output[-1] if output else None
            )
            if opening is not None:
                opening_end, delimiter = opening
                while cursor < opening_end:
                    if text.startswith(b"\\\r\n", cursor):
                        cursor += 3
                        right_boundaries[-1] = cursor
                    elif text.startswith(b"\\\n", cursor):
                        cursor += 2
                        right_boundaries[-1] = cursor
                    else:
                        output.append(text[cursor])
                        cursor += 1
                        left_boundaries.append(cursor)
                        right_boundaries.append(cursor)
                terminator = b")" + delimiter + b'"'
                close = text.find(terminator, cursor)
                raw_end = len(text) if close < 0 else close + len(terminator)
                while cursor < raw_end:
                    output.append(text[cursor])
                    cursor += 1
                    left_boundaries.append(cursor)
                    right_boundaries.append(cursor)
                continue
        if text.startswith(b"\\\r\n", cursor):
            cursor += 3
            right_boundaries[-1] = cursor
            continue
        if text.startswith(b"\\\n", cursor):
            cursor += 2
            right_boundaries[-1] = cursor
            continue
        byte = text[cursor]
        previous = output[-1] if output else None
        output.append(byte)
        cursor += 1
        left_boundaries.append(cursor)
        right_boundaries.append(cursor)
        if state == "code":
            if previous == ord("/") and byte == ord("/"):
                state = "line-comment"
            elif previous == ord("/") and byte == ord("*"):
                state = "block-comment"
            elif byte == ord('"'):
                state = "string"
                escaped = False
            elif byte == ord("'"):
                state = "character"
                escaped = False
        elif state == "line-comment":
            if byte == ord("\n"):
                state = "code"
        elif state == "block-comment":
            if previous == ord("*") and byte == ord("/"):
                state = "code"
        elif state == "string":
            if escaped:
                escaped = False
            elif byte == ord("\\"):
                escaped = True
            elif byte == ord('"'):
                state = "code"
        elif state == "character":
            if escaped:
                escaped = False
            elif byte == ord("\\"):
                escaped = True
            elif byte == ord("'"):
                state = "code"
    return bytes(output), left_boundaries, right_boundaries


def _decode_literal_from_views(
    node: Node,
    lexical_text: bytes,
    original_text: bytes,
    left_boundaries: list[int],
    right_boundaries: list[int],
    function: str,
    line: int,
    *,
    allow_legacy_nul: bool,
) -> tuple[str, str]:
    if node.type != "raw_string_literal":
        return _decode_literal(
            node,
            lexical_text,
            function,
            line,
            allow_legacy_nul=allow_legacy_nul,
        )
    token = lexical_text[node.start_byte : node.end_byte]
    opening = _RAW_OPEN.match(token)
    if opening is None:
        return "", ""
    delimiter = opening.group("delimiter")
    terminator = b")" + delimiter + b'"'
    content_start = node.start_byte + opening.end()
    content_end = node.end_byte - len(terminator)
    decoded = original_text[
        left_boundaries[content_start] : right_boundaries[content_end]
    ].decode("utf-8")
    return decoded, opening.group("prefix").decode("ascii")


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
    try:
        text.decode("utf-8")
    except UnicodeDecodeError as error:
        raise InvalidSourceEncoding(
            error.start,
            error.end,
            text.count(b"\n", 0, error.start) + 1,
        ) from error
    recovery_parser_text = text.replace(b"\\\r\n", b" \\\n")
    recovery_tree = _PARSER.parse(recovery_parser_text)
    lexical_text, original_left_boundaries, original_boundaries = (
        _phase2_lexical_view(text)
    )
    tree = _PARSER.parse(lexical_text)
    normalized_path = path.as_posix()
    candidates: list[tuple[Node, str, int]] = []

    def collect(node: Node, function: str, function_scope: int) -> None:
        if node.type == "function_definition":
            function = _function_name(node, lexical_text)
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

    raw_recovery_nodes = _ordered_recovery_nodes(recovery_tree)
    lexical_recovery_nodes = _ordered_recovery_nodes(tree)
    # tree-sitter sees escaped newlines inside prefixes as recovery in the raw
    # byte stream.  They are not parser recovery after C++ translation phase 2.
    # A clean splice-removed tree is therefore authoritative; otherwise retain
    # the raw recovery fingerprint used by the exact Task 1 evidence contract.
    recovery_nodes = raw_recovery_nodes if lexical_recovery_nodes else []
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
            problem_nodes = recovery_nodes or [recovery_tree.root_node]
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
                    original_boundaries[node.start_byte] < problem.end_byte
                    and original_boundaries[node.end_byte] > problem.start_byte
                )
                or (
                    problem.start_byte == problem.end_byte
                    and original_boundaries[node.start_byte]
                    <= problem.start_byte
                    <= original_boundaries[node.end_byte]
                )
                or (
                    problem.parent is not None
                    and problem.parent.type != "translation_unit"
                    and original_boundaries[node.start_byte] >= problem.parent.start_byte
                    and original_boundaries[node.end_byte] <= problem.parent.end_byte
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
                        function = _function_name(ancestor, recovery_parser_text)
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

    if lexical_recovery_nodes and not raw_recovery_nodes:
        raise CppParseError(
            [
                {
                    "function": "",
                    "line": text.count(
                        b"\n", 0, original_boundaries[node.start_byte]
                    )
                    + 1,
                    "startByte": original_boundaries[node.start_byte],
                    "endByte": original_boundaries[node.end_byte],
                    "fileSha256": file_sha256,
                    "recoverySha256": _recovery_sha256(lexical_recovery_nodes),
                }
                for node in lexical_recovery_nodes
            ]
        )

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
                line = text.count(b"\n", 0, original_boundaries[node.start_byte]) + 1
                decoded_parts: list[str] = []
                components: list[LiteralComponent] = []
                prefix = ""
                for index, child in enumerate(literal_nodes):
                    child_line = text.count(
                        b"\n", 0, original_boundaries[child.start_byte]
                    ) + 1
                    decoded, child_prefix = _decode_literal_from_views(
                        child,
                        lexical_text,
                        text,
                        original_left_boundaries,
                        original_boundaries,
                        function,
                        child_line,
                        allow_legacy_nul=allow_legacy_nul,
                    )
                    decoded_parts.append(decoded)
                    components.append(
                        LiteralComponent(
                            original_boundaries[child.start_byte],
                            original_boundaries[child.end_byte],
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
                        original_boundaries[node.start_byte],
                        original_boundaries[node.end_byte],
                        "".join(decoded_parts),
                        prefix,
                        function,
                        line,
                        occurrence_index,
                        tuple(components),
                    )
                )
                continue
            line = text.count(b"\n", 0, original_boundaries[node.start_byte]) + 1
            decoded, prefix = _decode_literal_from_views(
                node,
                lexical_text,
                text,
                original_left_boundaries,
                original_boundaries,
                function,
                line,
                allow_legacy_nul=allow_legacy_nul,
            )
            rows.append(
                Literal(
                    normalized_path,
                    original_boundaries[node.start_byte],
                    original_boundaries[node.end_byte],
                    decoded,
                    prefix,
                    function,
                    line,
                    occurrence_index,
                    (
                        LiteralComponent(
                            original_boundaries[node.start_byte],
                            original_boundaries[node.end_byte],
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
        if isinstance(row, dict) and _normalized_policy_reason(str(row.get("reason", "")))
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
    # Translation phase 2 removes escaped newlines before tokenization.  Match
    # that lexical token, but use its boundary map to replace only the payload
    # in the original bytes.  Prefix characters, escaped newlines, quotes and
    # raw delimiters therefore remain byte-for-byte identical.
    token, left_boundaries, boundaries = _phase2_lexical_view(original)
    raw = _RAW_OPEN.match(token)
    if raw is not None:
        delimiter = raw.group("delimiter").decode("ascii")
        terminator = f'){delimiter}"'.encode("ascii")
        if not token.endswith(terminator):
            return _raw_literal(literal.prefix, target, original, source_text)
        content_start = raw.end()
        content_end = len(token) - len(terminator)
        original_payload = original[
            left_boundaries[content_start] : boundaries[content_end]
        ]
        newline = (
            _newline_style(original_payload) or _newline_style(source_text) or "\n"
        )
        payload = target.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
        if f'){delimiter}"' in payload:
            raise RawDelimiterCollision(delimiter)
        return (
            original[: left_boundaries[content_start]]
            + payload.encode("utf-8")
            + original[boundaries[content_end] :]
        )
    regular = _REGULAR_OPEN.match(token)
    if regular is not None and token.endswith(b'"'):
        encoded = _regular_literal("", target)[1:-1]
        return (
            original[: boundaries[regular.end()]]
            + encoded
            + original[boundaries[len(token) - 1] :]
        )
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
) -> tuple[list[str] | None, dict[str, Any] | None]:
    values = row.get("components")
    if values is None:
        return None, None
    if not isinstance(values, list):
        return None, {
            "componentIndex": -1,
            "componentSource": literal.decoded,
            "detail": "components must be an array",
        }
    if len(values) != len(literal.components):
        index = min(len(values), len(literal.components))
        return None, {
            "componentIndex": index,
            "componentSource": (
                literal.components[index].decoded
                if index < len(literal.components)
                else ""
            ),
            "detail": "component count does not match the literal expression",
        }
    for index, value in enumerate(values):
        if not isinstance(value, dict) or set(value) != {"source", "target"}:
            return None, {
                "componentIndex": index,
                "componentSource": literal.components[index].decoded,
                "detail": "component must contain exactly source and target",
            }
    sources = [component.get("source") for component in values]
    targets = [component.get("target") for component in values]
    for index, (source, component) in enumerate(
        zip(sources, literal.components, strict=True)
    ):
        if not isinstance(source, str) or source != component.decoded:
            return None, {
                "componentIndex": index,
                "componentSource": component.decoded,
                "mappedSource": _safe_report_text(source),
                "detail": "component source does not match the literal component",
            }
    if any(not isinstance(value, str) for value in targets):
        index = next(
            index for index, value in enumerate(targets) if not isinstance(value, str)
        )
        return None, {
            "componentIndex": index,
            "componentSource": literal.components[index].decoded,
            "detail": "component target must be a string",
        }
    if "".join(sources) != literal.decoded:
        return None, {
            "componentIndex": 0,
            "componentSource": literal.components[0].decoded,
            "detail": "joined component sources do not match the literal expression",
        }
    if "".join(targets) != target:
        joined = ""
        mismatch_index = len(targets) - 1
        for index, component_target in enumerate(targets):
            joined += component_target
            if not target.startswith(joined):
                mismatch_index = index
                break
        return None, {
            "componentIndex": mismatch_index,
            "componentSource": literal.components[mismatch_index].decoded,
            "detail": "joined component targets do not match the mapping target",
        }
    return targets, None


def _write_report(report_path: Path, report: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")


def _mapping_row_is_well_formed(row: Any) -> bool:
    return (
        isinstance(row, dict)
        and isinstance(row.get("target"), str)
        and isinstance(row.get("status"), str)
        and isinstance(row.get("provenance"), str)
        and isinstance(row.get("formatSignature"), list)
        and all(isinstance(token, str) for token in row["formatSignature"])
    )


def _component_document_shape_error(
    row: dict[str, Any], source: str
) -> dict[str, Any] | None:
    if "components" not in row:
        return None
    components = row["components"]
    if not isinstance(components, list):
        return {
            "code": "INVALID_COMPONENT_MAPPING",
            "componentIndex": -1,
            "componentSource": source,
            "detail": "components must be an array",
        }
    for index, component in enumerate(components):
        if not isinstance(component, dict) or set(component) != {"source", "target"}:
            return {
                "code": "INVALID_COMPONENT_MAPPING",
                "componentIndex": index,
                "componentSource": source,
                "detail": "component must contain exactly source and target",
            }
        if not isinstance(component["source"], str):
            return {
                "code": "INVALID_COMPONENT_MAPPING",
                "componentIndex": index,
                "componentSource": source,
                "detail": "component source must be a string",
            }
        if not isinstance(component["target"], str):
            return {
                "code": "INVALID_COMPONENT_MAPPING",
                "componentIndex": index,
                "componentSource": component["source"],
                "detail": "component target must be a string",
            }
    return None


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
    components = row.get("components")
    if isinstance(components, list):
        for component in components:
            if not isinstance(component, dict):
                continue
            values.extend(
                value
                for value in (component.get("source"), component.get("target"))
                if isinstance(value, str)
            )
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
    invalid_component_rows: list[tuple[int, dict[str, Any]]] = []
    for entry_index, (source, row) in enumerate(
        sorted(entries.items(), key=lambda item: str(item[0]))
    ):
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
        else:
            component_error = _component_document_shape_error(row, source)
            if component_error is not None:
                invalid_component_rows.append(
                    (
                        id(row),
                        {
                            **component_error,
                            "entryIndex": entry_index,
                            "source": source,
                        },
                    )
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
            component_error = _component_document_shape_error(row, row["source"])
            if component_error is not None:
                invalid_component_rows.append(
                    (
                        id(row),
                        {
                            **component_error,
                            "contextIndex": index,
                            "path": key[0],
                            "function": row["function"],
                            "occurrenceIndex": row["occurrenceIndex"],
                            "source": row["source"],
                        },
                    )
                )
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
    consumed_component_rows: set[int] = set()

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
        except InvalidSourceEncoding as error:
            report["issues"].append(
                {
                    "code": "INVALID_SOURCE_ENCODING",
                    "path": relative,
                    "line": error.line,
                    "startByte": error.start,
                    "endByte": error.end,
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
            consumed_component_rows.add(id(row))
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
            component_targets, component_error = _validated_component_targets(
                literal, row, target
            )
            if len(literal.components) > 1 and component_targets is None:
                if component_error is None:
                    report["issues"].append(
                        _issue("MISSING_COMPONENT_MAPPING", literal)
                    )
                else:
                    report["issues"].append(
                        _issue("INVALID_COMPONENT_MAPPING", literal, **component_error)
                    )
                continue
            if component_error is not None:
                report["issues"].append(
                    _issue("INVALID_COMPONENT_MAPPING", literal, **component_error)
                )
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

    report["issues"].extend(
        issue
        for identity, issue in invalid_component_rows
        if identity not in consumed_component_rows
    )

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
