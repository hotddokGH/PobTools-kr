import re


PROTECTED_SYNTAX = re.compile(
    r"(?:https?|file)://[^\s]+|##[^\s]*|<[^>\r\n]+>|\r\n|\r|\n|"
    r"%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z](?![A-Za-z])|\{\d*(?::[^{}\s]+)?\}|"
    r"\^(?:x[0-9A-Fa-f]{6}|\d)"
)
RESTORE_MARKER = re.compile(r"ZXQPH\s*(\d+)\s*QXZ", re.IGNORECASE)
PRINTF = re.compile(r"%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z](?![A-Za-z])")
SLOT = re.compile(r"\{\d*(?::[^{}\s]+)?\}")
TAG = re.compile(r"\^(?:x[0-9A-Fa-f]{6}|\d)")
NUMERIC_MARKER_BASE = 918_273_640


def apply_source_glossary(text: str, glossary: dict[str, str]) -> str:
    if not glossary:
        return text
    lookup = {source.casefold(): target for source, target in glossary.items()}
    term_pattern = re.compile(
        r"(?<![A-Za-z])(" + "|".join(
            re.escape(source) for source in sorted(glossary, key=len, reverse=True)
        ) + r")(?![A-Za-z])",
        re.IGNORECASE,
    )
    return term_pattern.sub(lambda match: lookup[match.group(0).casefold()], text)


def apply_source_scoped_replacements(
    source: str,
    text: str,
    rules: list[tuple[str, str, str]] | tuple[tuple[str, str, str], ...],
) -> str:
    folded_source = source.casefold()
    for source_term, forbidden, official in rules:
        if source_term.casefold() in folded_source:
            text = text.replace(forbidden, official)
    return text


def protect_syntax(text: str) -> tuple[str, list[str]]:
    tokens: list[str] = []

    def replace(match: re.Match[str]) -> str:
        index = len(tokens)
        tokens.append(match.group(0))
        return f" ZXQPH{index}QXZ "

    return PROTECTED_SYNTAX.sub(replace, text), tokens


def restore(text: str, tokens: list[str]) -> str:
    used: set[int] = set()

    def replace(match: re.Match[str]) -> str:
        index = int(match.group(1))
        if index >= len(tokens):
            raise ValueError(f"unknown protected marker {index}")
        used.add(index)
        return tokens[index]

    restored = RESTORE_MARKER.sub(replace, text)
    if used != set(range(len(tokens))):
        raise ValueError(f"protected markers missing: {sorted(set(range(len(tokens))) - used)}")
    return restored.strip()


def protect_with_numeric_markers(
    text: str,
    *,
    glossary: dict[str, str] | None = None,
) -> tuple[str, list[str]]:
    tokens: list[str] = []

    def replace(match: re.Match[str]) -> str:
        index = len(tokens)
        tokens.append(match.group(0))
        return f" {NUMERIC_MARKER_BASE + index} "

    masked = PROTECTED_SYNTAX.sub(replace, text)
    if glossary:
        lookup = {source.casefold(): target for source, target in glossary.items()}
        term_pattern = re.compile(
            r"(?<![A-Za-z])(" + "|".join(
                re.escape(source) for source in sorted(glossary, key=len, reverse=True)
            ) + r")(?![A-Za-z])",
            re.IGNORECASE,
        )

        def replace_term(match: re.Match[str]) -> str:
            index = len(tokens)
            tokens.append(lookup[match.group(0).casefold()])
            return f" {NUMERIC_MARKER_BASE + index} "

        masked = term_pattern.sub(replace_term, masked)
    return masked, tokens


def restore_numeric_markers(text: str, tokens: list[str]) -> str:
    restored = text
    for index, token in enumerate(tokens):
        marker = str(NUMERIC_MARKER_BASE + index)
        if restored.count(marker) != 1:
            raise ValueError(f"numeric marker missing or repeated: {index}")
        restored = restored.replace(marker, token)
    return restored.strip()


def format_signature(text: str) -> list[str]:
    tokens = [f"PRINTF:{match.group(0)}" for match in PRINTF.finditer(text)]
    tokens += [f"SLOT:{match.group(0)}" for match in SLOT.finditer(text)]
    tokens += [f"TAG:{match.group(0)}" for match in TAG.finditer(text)]
    tokens += ["LF"] * text.count("\n")
    return sorted(tokens)
