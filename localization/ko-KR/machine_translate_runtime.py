import argparse
import json
import re
from pathlib import Path

import torch
import sentencepiece as spm
from huggingface_hub import snapshot_download
from transformers import AutoModelForSeq2SeqLM

from runtime_machine_state import has_unrestored_marker, resume_machine_fallback
from runtime_machine_syntax import (
    apply_source_glossary,
    apply_source_scoped_replacements,
    format_signature,
    protect_syntax,
    protect_with_numeric_markers,
    restore,
    restore_numeric_markers,
)


MODEL_ID = "Helsinki-NLP/opus-mt-tc-big-en-ko"
MODEL_REVISION = "main"
HAN = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
GLOSSARY_REPLACEMENTS = (
    ("크리티컬", "치명타"),
    ("하수인", "소환수"),
    ("미니언", "소환수"),
    ("스펙터", "망령"),
    ("생명 포인트", "생명력"),
    ("마나 포인트", "마나"),
    ("카오스 저항력", "카오스 저항"),
    ("냉기 저항력", "냉기 저항"),
    ("화염 저항력", "화염 저항"),
    ("번개 저항력", "번개 저항"),
    ("데미지", "피해"),
)
SOURCE_SCOPED_REPLACEMENTS = (
    ("Ailment", "질병", "상태 이상"),
    ("Unique Enemy", "독특한 적", "고유 적"),
    ("Unique Enemies", "독특한 적", "고유 적"),
)
SOURCE_GLOSSARY = {
    "Critical Strike Multiplier": "치명타 피해 배율",
    "Critical Strike Chance": "치명타 확률",
    "Critical Strike": "치명타",
    "Damage over Time": "지속 피해",
    "Unique Enemies": "고유 적",
    "Unique Enemy": "고유 적",
    "Physical Damage": "물리 피해",
    "Lightning Damage": "번개 피해",
    "Elemental Damage": "원소 피해",
    "Attack Damage": "공격 피해",
    "Spell Damage": "주문 피해",
    "Chaos Damage": "카오스 피해",
    "Cold Damage": "냉기 피해",
    "Fire Damage": "화염 피해",
    "Accuracy Rating": "정확도",
    "Spell Suppression": "주문 피해 억제",
    "Life Regeneration": "생명력 재생",
    "Mana Regeneration": "마나 재생",
    "Endurance Charges": "인내 충전",
    "Endurance Charge": "인내 충전",
    "Frenzy Charges": "격분 충전",
    "Frenzy Charge": "격분 충전",
    "Power Charges": "권능 충전",
    "Power Charge": "권능 충전",
    "Area of Effect": "효과 범위",
    "Raise Spectre": "망령 소환",
    "Attack Speed": "공격 속도",
    "Cast Speed": "시전 속도",
    "Movement Speed": "이동 속도",
    "Energy Shield": "에너지 보호막",
    "Maximum Life": "최대 생명력",
    "Full Life": "최대 생명력 상태",
    "Low Life": "낮은 생명력 상태",
    "Configuration": "설정",
    "Fortification": "방어 상승",
    "Projectiles": "투사체",
    "Projectile": "투사체",
    "Regeneration": "재생",
    "Reservation": "점유",
    "Recovery": "회복",
    "Cooldown": "재사용 대기시간",
    "Duration": "지속시간",
    "Onslaught": "맹공",
    "Adrenaline": "아드레날린",
    "Ailments": "상태 이상",
    "Ailment": "상태 이상",
    "Bleeding": "출혈",
    "Ignite": "점화",
    "Scorch": "그을림",
    "Brittle": "허약",
    "Poison": "중독",
    "Freeze": "동결",
    "Chill": "냉각",
    "Shock": "감전",
    "Leech": "흡수",
    "Totems": "토템",
    "Totem": "토템",
    "Traps": "덫",
    "Trap": "덫",
    "Mines": "지뢰",
    "Mine": "지뢰",
    "Brands": "낙인",
    "Brand": "낙인",
    "Curses": "저주",
    "Curse": "저주",
    "Enemies": "적",
    "Enemy": "적",
    "Allies": "동료",
    "Ally": "동료",
    "Modifiers": "속성 부여",
    "Modifier": "속성 부여",
    "Resistance": "저항",
    "Spectres": "망령",
    "Spectre": "망령",
    "Minions": "소환수",
    "Minion": "소환수",
    "Armour": "방어도",
    "Evasion": "회피",
    "Melee": "근접",
    "Weapon": "무기",
    "Shields": "방패",
    "Shield": "방패",
    "Swords": "검",
    "Sword": "검",
    "Axes": "도끼",
    "Axe": "도끼",
    "Bows": "활",
    "Bow": "활",
    "Wands": "마법봉",
    "Wand": "마법봉",
    "Staves": "지팡이",
    "Staff": "지팡이",
    "Daggers": "단검",
    "Dagger": "단검",
    "Claws": "클로",
    "Claw": "클로",
    "Maces": "철퇴",
    "Mace": "철퇴",
    "Damage": "피해",
    "Skills": "스킬",
    "Skill": "스킬",
    "Jewels": "주얼",
    "Jewel": "주얼",
    "Items": "아이템",
    "Item": "아이템",
    "Gems": "젬",
    "Gem": "젬",
    "Mana": "마나",
    "Life": "생명력",
    "crit chance": "치명타 확률",
    "crit": "치명타",
}
SOURCE_GLOSSARY_PATTERN = re.compile(
    r"(?<![A-Za-z])(" + "|".join(
        re.escape(key) for key in sorted(SOURCE_GLOSSARY, key=len, reverse=True)
    ) + r")(?![A-Za-z])",
    re.IGNORECASE,
)


def protect(text: str, *, include_glossary: bool = True) -> tuple[str, list[str]]:
    masked, tokens = protect_syntax(text)

    def replace_term(match: re.Match[str]) -> str:
        index = len(tokens)
        matched = match.group(0)
        target = next(value for key, value in SOURCE_GLOSSARY.items() if key.casefold() == matched.casefold())
        tokens.append(target)
        return f" ZXQPH{index}QXZ "

    if not include_glossary:
        return masked, tokens
    return SOURCE_GLOSSARY_PATTERN.sub(replace_term, masked), tokens


def apply_glossary(source: str, text: str) -> str:
    for replacement_source, replacement_target in GLOSSARY_REPLACEMENTS:
        text = text.replace(replacement_source, replacement_target)
    text = apply_source_scoped_replacements(source, text, SOURCE_SCOPED_REPLACEMENTS)
    return apply_source_glossary(text, SOURCE_GLOSSARY)


def save_output(path: Path, inventory: dict, entries: dict[str, str], rejected: dict[str, str]) -> None:
    document = {
        "source": "offline Marian machine-assisted PoB-only fallback",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "license": "CC-BY-4.0",
        "inventorySha256": inventory["sha256"],
        "entries": dict(sorted(entries.items())),
        "rejected": dict(sorted(rejected.items())),
    }
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument(
        "--syntax-only",
        action="store_true",
        help="protect only executable display syntax; useful when retrying rows where many glossary markers were dropped",
    )
    parser.add_argument(
        "--numeric-markers",
        action="store_true",
        help="retry pending rows with copy-friendly numeric markers for placeholders and line breaks",
    )
    args = parser.parse_args()

    locale_root = Path(__file__).resolve().parent
    inventory = json.loads((locale_root / "runtime-inventory.json").read_text(encoding="utf-8"))
    output_path = locale_root / "manual" / "machine-fallback.json"
    if args.resume and output_path.exists():
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        entries, rejected, pending = resume_machine_fallback(inventory, existing)
    else:
        entries = {}
        rejected = {}
        pending = list(inventory["entries"])
    if args.limit is not None:
        pending = pending[: args.limit]

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the offline translation pass")
    print(f"loading {MODEL_ID} on {torch.cuda.get_device_name(0)}", flush=True)
    snapshot = Path(snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        allow_patterns=[
            "config.json",
            "generation_config.json",
            "model.safetensors",
            "source.spm",
            "target.spm",
        ],
    ))
    source_spm = spm.SentencePieceProcessor(model_file=str(snapshot / "source.spm"))
    target_spm = spm.SentencePieceProcessor(model_file=str(snapshot / "target.spm"))
    model = AutoModelForSeq2SeqLM.from_pretrained(
        snapshot,
        dtype=torch.float16,
    ).to("cuda")
    model.eval()

    total_batches = (len(pending) + args.batch_size - 1) // args.batch_size
    print(f"offline fallback: {len(entries)} cached; {len(pending)} pending in {total_batches} batches", flush=True)
    for batch_index in range(total_batches):
        sources = pending[batch_index * args.batch_size : (batch_index + 1) * args.batch_size]
        protected = [
            protect_with_numeric_markers(source, glossary=SOURCE_GLOSSARY)
            if args.numeric_markers
            else protect(source, include_glossary=not args.syntax_only)
            for source in sources
        ]
        rows = [source_spm.encode(text)[:511] + [2] for text, _ in protected]
        maximum_length = max(len(row) for row in rows)
        input_ids = torch.tensor(
            [row + [32000] * (maximum_length - len(row)) for row in rows],
            device="cuda",
        )
        attention_mask = (input_ids != 32000).long()
        with torch.inference_mode():
            generated = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                max_new_tokens=512,
                num_beams=1,
            )
        translations = [
            target_spm.decode([token for token in row.tolist() if token not in (2, 32000)])
            for row in generated
        ]

        for source, translated, (_, protected_tokens) in zip(sources, translations, protected, strict=True):
            try:
                restored = (
                    restore_numeric_markers(translated, protected_tokens)
                    if args.numeric_markers
                    else restore(translated, protected_tokens)
                )
                target = apply_glossary(source, restored)
                if HAN.search(target):
                    raise ValueError("target contains Han characters")
                if has_unrestored_marker(target):
                    raise ValueError("target contains unrestored machine marker")
                if format_signature(source) != format_signature(target):
                    raise ValueError("format signature mismatch")
                if not target:
                    raise ValueError("empty target")
                entries[source] = target
                rejected.pop(source, None)
            except ValueError as error:
                rejected[source] = str(error)

        if (batch_index + 1) % 25 == 0 or batch_index + 1 == total_batches:
            save_output(output_path, inventory, entries, rejected)
            print(
                f"offline fallback progress: {batch_index + 1}/{total_batches}; "
                f"translated={len(entries)}; rejected={len(rejected)}",
                flush=True,
            )

    save_output(output_path, inventory, entries, rejected)


if __name__ == "__main__":
    main()
