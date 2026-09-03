import re


UNRESTORED_MARKER = re.compile(r"ZXQPH|QXZ", re.IGNORECASE)


def has_unrestored_marker(value: str) -> bool:
    return UNRESTORED_MARKER.search(value) is not None


def resume_machine_fallback(inventory: dict, existing: dict) -> tuple[dict, dict, list[str]]:
    wanted = set(inventory["entries"])
    entries = {
        source: target
        for source, target in existing.get("entries", {}).items()
        if source in wanted and not has_unrestored_marker(target)
    }
    rejected = {
        source: reason
        for source, reason in existing.get("rejected", {}).items()
        if source in wanted and source not in entries
    }
    pending = [source for source in inventory["entries"] if source not in entries]
    return entries, rejected, pending
