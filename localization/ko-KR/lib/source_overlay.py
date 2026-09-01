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
_HAN = re.compile(
    r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF"
    r"\U00020000-\U0002FA1F\U00030000-\U000323AF]"
)
_PARSER = Parser(Language(tree_sitter_cpp.language()))
_REGULAR_OPEN = re.compile(rb'(?P<prefix>u8|u|U|L)?"')
_RAW_OPEN = re.compile(rb'(?P<prefix>u8R|uR|UR|LR|R)"(?P<delimiter>[^ ()\\\t\r\n]{0,16})\(')


@dataclass(frozen=True)
class Literal:
    path: str
    start: int
    end: int
    decoded: str
    prefix: str
    function: str
    line: int


class UnsupportedEscape(ValueError):
    def __init__(self, escape: str, start: int, line: int, function: str):
        super().__init__(f"unsupported C++ escape: {escape}")
        self.escape = escape
        self.start = start
        self.line = line
        self.function = function


def format_signature(value: str) -> tuple[str, ...]:
    tokens = re.findall(
        r"%(?:[-+0 #]*\d*(?:\.\d+)?[hlLzjt]*[diuoxXfFeEgGaAcspn%])|\{\d+\}|\^x[0-9A-Fa-f]{6}",
        value,
    )
    tokens.extend("<NL>" for _ in range(value.count("\n")))
    return tuple(sorted(tokens))


def _decode_escape_text(value: str, *, start: int, line: int, function: str) -> str:
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
            raise UnsupportedEscape("\\<EOF>", start, line, function)
        marker = value[cursor + 1]
        if marker in simple:
            output.append(simple[marker])
            cursor += 2
            continue
        widths = {"x": 2, "u": 4, "U": 8}
        width = widths.get(marker)
        digits = value[cursor + 2 : cursor + 2 + width] if width is not None else ""
        if width is not None and len(digits) == width and re.fullmatch(r"[0-9A-Fa-f]+", digits):
            try:
                output.append(chr(int(digits, 16)))
            except ValueError as error:
                raise UnsupportedEscape(f"\\{marker}{digits}", start, line, function) from error
            cursor += 2 + width
            continue
        end = min(len(value), cursor + 2 + (width or 0))
        raise UnsupportedEscape(value[cursor:end], start, line, function)
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


def _decode_literal(node: Node, text: bytes, function: str, line: int) -> tuple[str, str]:
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
        _decode_escape_text(encoded, start=node.start_byte, line=line, function=function),
        (match.group("prefix") or b"").decode("ascii"),
    )


def scan_cpp_literals(path: Path, text: bytes) -> list[Literal]:
    """Return semantic C++ string values with byte offsets into *text*."""
    tree = _PARSER.parse(text)
    normalized_path = path.as_posix()
    rows: list[Literal] = []

    def visit(node: Node, function: str) -> None:
        if node.type == "function_definition":
            function = _function_name(node, text)
        if node.type == "concatenated_string":
            literal_nodes = [
                child for child in node.named_children if child.type in {"string_literal", "raw_string_literal"}
            ]
            if not literal_nodes:
                return
            line = text.count(b"\n", 0, node.start_byte) + 1
            decoded_parts: list[str] = []
            prefix = ""
            for index, child in enumerate(literal_nodes):
                child_line = text.count(b"\n", 0, child.start_byte) + 1
                decoded, child_prefix = _decode_literal(child, text, function, child_line)
                decoded_parts.append(decoded)
                if index == 0:
                    prefix = child_prefix
            rows.append(
                Literal(normalized_path, node.start_byte, node.end_byte, "".join(decoded_parts), prefix, function, line)
            )
            return
        if node.type in {"string_literal", "raw_string_literal"}:
            line = text.count(b"\n", 0, node.start_byte) + 1
            decoded, prefix = _decode_literal(node, text, function, line)
            rows.append(Literal(normalized_path, node.start_byte, node.end_byte, decoded, prefix, function, line))
            return
        for child in node.named_children:
            visit(child, function)

    visit(tree.root_node, "")
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


def _allowlisted_hashes(policy: dict[str, Any]) -> set[str]:
    return {
        str(row.get("sha256", "")).upper()
        for row in policy.get("internalLiteralAllowlist", [])
        if isinstance(row, dict) and str(row.get("reason", "")).strip()
    }


def _issue(code: str, literal: Literal, **extra: Any) -> dict[str, Any]:
    return {
        "code": code,
        "path": literal.path,
        "function": literal.function,
        "line": literal.line,
        "source": literal.decoded,
        **extra,
    }


def _regular_literal(prefix: str, target: str) -> bytes:
    escaped = (
        target.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )
    return f'{prefix}"{escaped}"'.encode("utf-8")


def _raw_literal(prefix: str, target: str, original: bytes) -> bytes:
    opening = original.find(b"(")
    quote = original.find(b'"')
    delimiter = original[quote + 1 : opening].decode("ascii") if 0 <= quote < opening else ""
    if f'){delimiter}"' in target:
        delimiter = "ko"
        suffix = 1
        while f'){delimiter}"' in target:
            delimiter = f"ko{suffix}"
            suffix += 1
    return f'{prefix}"{delimiter}({target}){delimiter}"'.encode("utf-8")


def _replacement_bytes(literal: Literal, target: str, original: bytes) -> bytes:
    if literal.prefix.endswith("R"):
        return _raw_literal(literal.prefix, target, original)
    return _regular_literal(literal.prefix, target)


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
        ):
            return row
    row = entries.get(literal.decoded)
    return row if isinstance(row, dict) else None


def _write_report(report_path: Path, report: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="")


def _run_overlay(
    source_root: Path,
    mapping_path: Path,
    policy_path: Path,
    report_path: Path,
    *,
    write_sources: bool,
) -> dict[str, Any]:
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    entries = mapping.get("entries", {})
    contexts = mapping.get("contexts", [])
    if not isinstance(entries, dict) or not isinstance(contexts, list):
        raise ValueError("mapping must contain an entries object and contexts array")

    files = _source_files(source_root)
    report: dict[str, Any] = {
        "filesScanned": len(files),
        "displayLiterals": 0,
        "reused": 0,
        "official": 0,
        "reviewed": 0,
        "intentional": 0,
        "issues": [],
    }
    excluded = _excluded_paths(policy)
    allowed = _allowlisted_hashes(policy)
    originals: dict[Path, bytes] = {}
    plans: dict[Path, list[tuple[int, int, bytes]]] = {}

    for path in files:
        relative = path.relative_to(source_root).as_posix()
        if relative in excluded:
            continue
        text = path.read_bytes()
        originals[path] = text
        try:
            literals = scan_cpp_literals(Path(relative), text)
        except UnsupportedEscape as error:
            report["issues"].append(
                {
                    "code": "UNSUPPORTED_ESCAPE",
                    "path": relative,
                    "function": error.function,
                    "line": error.line,
                    "source": text[error.start :].split(b'"', 2)[0].decode("utf-8", errors="replace"),
                    "escape": error.escape,
                }
            )
            continue
        report["displayLiterals"] += len(literals)
        for literal in literals:
            digest = hashlib.sha256(literal.decoded.encode("utf-8")).hexdigest().upper()
            if digest in allowed or not _HAN.search(literal.decoded):
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
            original = text[literal.start : literal.end]
            replacement = _replacement_bytes(literal, target, original)
            plans.setdefault(path, []).append((literal.start, literal.end, replacement))
            report["reused"] += 1
            report[status] += 1

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
