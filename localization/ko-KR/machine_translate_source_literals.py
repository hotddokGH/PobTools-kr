import argparse
import json
import re
from pathlib import Path

ZH_EN_MODEL = "Helsinki-NLP/opus-mt-zh-en"
EN_KO_MODEL = "Helsinki-NLP/opus-mt-tc-big-en-ko"
DIRECT_MODEL = "SimpleJerry/longtu-nllb-zh2ko"
DIRECT_MODEL_REVISION = "earlystop-v1-ckpt48000"
SOURCE_GLOSSARY: dict[str, str] = {}


def load_ml_dependencies() -> None:
    """Load optional heavyweight dependencies only for generation or retry."""
    global AutoModelForSeq2SeqLM, AutoTokenizer, NllbTokenizerFast
    global OpenCC, SOURCE_GLOSSARY, apply_glossary, protect_english, restore
    global snapshot_download, spm, torch

    import sentencepiece as spm_module
    import torch as torch_module
    from huggingface_hub import snapshot_download as snapshot_download_function
    from opencc import OpenCC as OpenCC_class
    from transformers import AutoModelForSeq2SeqLM as model_class
    from transformers import AutoTokenizer as tokenizer_class
    from transformers import NllbTokenizerFast as nllb_tokenizer_class

    from machine_translate_runtime import SOURCE_GLOSSARY as glossary
    from machine_translate_runtime import apply_glossary as apply_glossary_function
    from machine_translate_runtime import protect as protect_function
    from machine_translate_runtime import restore as restore_function

    spm = spm_module
    torch = torch_module
    snapshot_download = snapshot_download_function
    OpenCC = OpenCC_class
    AutoModelForSeq2SeqLM = model_class
    AutoTokenizer = tokenizer_class
    NllbTokenizerFast = nllb_tokenizer_class
    SOURCE_GLOSSARY = glossary
    apply_glossary = apply_glossary_function
    protect_english = protect_function
    restore = restore_function
HAN = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
HANGUL = re.compile(r"[가-힣]")
PROTECTED_SOURCE = re.compile(
    r"(?:https?|file)://[^\s]+|##[^\s\\\"]*|\*\.\*|"
    r"%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z%](?![A-Za-z])|\{\d+\}|"
    r"\\(?:[\\\"'nrt0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})"
)
RESTORE_MARKER = re.compile(r"ZXQPH\s*(\d+)\s*QXZ", re.IGNORECASE)
SIGNATURE = re.compile(
    r"(?:https?|file)://[^\s]+|##[^\s\\\"]*|\*\.\*|"
    r"%(?:[-+0 #]*\d*(?:\.\d+)?)?[A-Za-z%](?![A-Za-z])|\{\d+\}|"
    r"\\(?:[\\\"'nrt0]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})"
)

# These files contain parser inputs and diagnostic fixtures, not strings shown by
# the normal application UI. Translating them would invalidate the tests they
# carry, so the source-display audit documents and excludes them explicitly.
EXCLUDED_SOURCE_PATHS = {
    "host/editor_selftest.cpp",
    "host/error_log_selftest.cpp",
    "host/filter_selftest.cpp",
    "host/item_name_selftest.cpp",
    "host/paste_fixtures.h",
    "host/paste_selftest.cpp",
    "host/placeholder_selftest.cpp",
    "host/regex_selftest.cpp",
    "host/launcher_strings.h",
    "host/filter_tierlist.cpp",
    "host/filter_tierlist_ui.cpp",
    "host/section_appearance.cpp",
    "host/section_customrules.cpp",
    "host/section_presets.cpp",
    "host/section_preview.cpp",
    "host/section_quickfilter.cpp",
    "host/section_settings.cpp",
}

MANUALLY_LOCALIZED_PATHS = {
    "host/app_update.h",
    "host/filter_i18n.cpp",
    "host/filter_schema.cpp",
}

ENGLISH_TERM_ALIASES = {
    "normal": "일반",
    "magic": "마법",
    "rare": "희귀",
    "very rare": "희귀",
    "unique": "고유",
    "legends": "고유",
    "jewelry": "주얼",
    "production": "제작",
    "true": "참",
    "false": "거짓",
    "none": "없음",
}

# Compact UI labels are especially error-prone when they are routed through a
# Chinese -> English -> Korean model chain.  Keep common application labels and
# PoE nouns deterministic; official runtime dictionaries still take precedence
# whenever they contain the same Traditional Chinese source text.
SOURCE_EXACT_TERMS = {
    "載入": "불러오기",
    "重新載入": "다시 불러오기",
    "儲存": "저장",
    "另存新檔": "다른 이름으로 저장",
    "開啟": "열기",
    "關閉": "닫기",
    "取消": "취소",
    "確認": "확인",
    "確定": "확인",
    "刪除": "삭제",
    "新增": "추가",
    "編輯": "편집",
    "複製": "복사",
    "貼上": "붙여넣기",
    "搜尋": "검색",
    "重新整理": "새로 고침",
    "刷新": "새로 고침",
    "重設": "초기화",
    "清除": "지우기",
    "選擇": "선택",
    "名稱": "이름",
    "版本": "버전",
    "設定": "설정",
    "語言": "언어",
    "更新": "업데이트",
    "下載": "다운로드",
    "匯入": "가져오기",
    "匯出": "내보내기",
    "啟動器": "런처",
    "過濾器": "필터",
    "技能寶石": "젬",
    "寶石": "젬",
    "星團珠寶": "스킬 군 주얼",
    "珠寶": "주얼",
    "塑界者": "쉐이퍼",
    "異界尊師": "엘더",
    "尊師": "엘더",
    "征服者": "정복자",
    "聖戰士": "성전사",
    "救贖者": "대속자",
    "狩獵者": "사냥꾼",
    "總督軍": "전쟁군주",
    "輿圖": "아틀라스",
    "圖譜": "아틀라스",
    "地圖": "지도",
    "天賦樹": "패시브 트리",
    "天賦": "패시브",
    "技能": "스킬",
    "物品": "아이템",
    "稀有度": "희귀도",
    "普通": "일반",
    "魔法": "마법",
    "稀有": "희귀",
    "傳奇": "고유",
    "通貨": "화폐",
    "藥劑": "플라스크",
    "插槽": "홈",
    "連線": "연결",
    "等級": "레벨",
    "品質": "퀄리티",
    "前綴": "접두어",
    "後綴": "접미어",
    "護甲": "방어구",
    "武器": "무기",
    "法術": "주문",
    "攻擊": "공격",
    "生命": "생명력",
    "魔力": "마나",
    "能量護盾": "에너지 보호막",
    "抗性": "저항",
    "暴擊": "치명타",
    "傷害": "피해",
    "速度": "속도",
    "範圍": "범위",
    "數量": "수량",
    "製作": "제작",
    "預覽": "미리 보기",
    "音效": "사운드",
    "聲音": "소리",
    "自訂": "사용자 지정",
    "規則": "규칙",
    "條件": "조건",
    "顯示": "표시",
    "隱藏": "숨기기",
    "啟用": "활성화",
    "停用": "비활성화",
    "成功": "성공",
    "失敗": "실패",
    "錯誤": "오류",
    "警告": "경고",
    "資訊": "정보",
    "檔案": "파일",
    "資料夾": "폴더",
    "路徑": "경로",
    "狀態": "상태",
    "目前": "현재",
    "預設": "기본값",
    "套用": "적용",
    "還原": "복원",
    "上一頁": "이전",
    "下一頁": "다음",
    "上一個": "이전",
    "下一個": "다음",
    "全部": "전체",
    "無": "없음",
    "是": "예",
    "否": "아니요",
    "自動": "자동",
    "手動": "수동",
    "說明": "설명",
    "詳情": "세부 정보",
    "關於": "정보",
    "退出": "종료",
    "啟動": "시작",
    "停止": "중지",
    "暫停": "일시 중지",
    "繼續": "계속",
    "重試": "다시 시도",
    "覆蓋": "덮어쓰기",
    "備份": "백업",
    "恢復": "복원",
    "忽略": "무시",
    "跳過": "건너뛰기",
    "完成": "완료",
    "處理中": "처리 중",
    "等待": "대기 중",
    "可用": "사용 가능",
    "不可用": "사용할 수 없음",
    "線上": "온라인",
    "離線": "오프라인",
    "核心天賦": "키스톤",
    "蟲洞": "웜홀",
    "大點": "주요 노드",
    "小點": "소형 노드",
    "中英": "한/영",
    "中": "한",
}

# The game-localisation model understands semantic English anchors reliably.
# Replacing ambiguous Traditional Chinese nouns before inference keeps PoE
# terminology deterministic without asking the model to invent Korean names.
SOURCE_MODEL_TERMS = {
    "核心天賦": ("KEYSTONE", "키스톤"),
    "能量護盾": ("ENERGY_SHIELD", "에너지 보호막"),
    "異界尊師": ("ELDER", "엘더"),
    "星團珠寶": ("CLUSTER_JEWEL", "스킬 군 주얼"),
    "技能寶石": ("SKILL_GEM", "젬"),
    "天賦樹": ("PASSIVE_TREE", "패시브 트리"),
    "重新載入": ("RELOAD", "다시 불러오기"),
    "所有檔案": ("ALL_FILES", "모든 파일"),
    "資料夾": ("FOLDER", "폴더"),
    "聖甲蟲": ("SCARAB", "갑충석"),
    "配點": ("POINT_ALLOCATION", "포인트 할당"),
    "點數": ("POINTS", "포인트"),
    "近似解": ("APPROXIMATE_SOLUTION", "근사해"),
    "總督軍": ("WARLORD", "전쟁군주"),
    "塑界者": ("SHAPER", "쉐이퍼"),
    "救贖者": ("REDEEMER", "대속자"),
    "聖戰士": ("CRUSADER", "성전사"),
    "狩獵者": ("HUNTER", "사냥꾼"),
    "征服者": ("CONQUEROR", "정복자"),
    "過濾器": ("FILTER", "필터"),
    "啟動器": ("LAUNCHER", "런처"),
    "專案": ("PROJECT", "프로젝트"),
    "輿圖": ("ATLAS", "아틀라스"),
    "圖譜": ("ATLAS", "아틀라스"),
    "天賦": ("PASSIVE", "패시브"),
    "節點": ("NODE", "노드"),
    "星盤": ("ASTROLABE", "아스트롤라베"),
    "蟲洞": ("WORMHOLE", "웜홀"),
    "大點": ("MAJOR_NODE", "주요 노드"),
    "小點": ("MINOR_NODE", "소형 노드"),
    "終點": ("END_NODE", "종점 노드"),
    "起點": ("START_NODE", "시작 노드"),
    "珠寶": ("JEWEL", "주얼"),
    "寶石": ("GEM", "젬"),
    "地圖": ("MAP", "지도"),
    "技能": ("SKILL", "스킬"),
    "物品": ("ITEM", "아이템"),
    "稀有度": ("RARITY", "희귀도"),
    "傳奇": ("UNIQUE", "고유"),
    "通貨": ("CURRENCY", "화폐"),
    "藥劑": ("FLASK", "플라스크"),
    "插槽": ("SOCKET", "홈"),
    "詞綴": ("MODIFIER", "속성 부여"),
    "前綴": ("PREFIX", "접두어"),
    "後綴": ("SUFFIX", "접미어"),
    "護甲": ("ARMOUR", "방어도"),
    "閃避": ("EVASION", "회피"),
    "法術": ("SPELL", "주문"),
    "攻擊": ("ATTACK", "공격"),
    "生命": ("LIFE", "생명력"),
    "魔力": ("MANA", "마나"),
    "抗性": ("RESISTANCE", "저항"),
    "暴擊": ("CRITICAL", "치명타"),
    "傷害": ("DAMAGE", "피해"),
    "等級": ("LEVEL", "레벨"),
    "品質": ("QUALITY", "퀄리티"),
    "載入": ("LOAD", "불러오기"),
    "存檔": ("SAVE", "저장"),
    "儲存": ("SAVE", "저장"),
    "匯入": ("IMPORT", "가져오기"),
    "匯出": ("EXPORT", "내보내기"),
    "搜尋": ("SEARCH", "검색"),
    "刪除": ("DELETE", "삭제"),
    "新增": ("ADD", "추가"),
    "重新命名": ("RENAME", "이름 바꾸기"),
    "設定": ("SETTINGS", "설정"),
    "更新": ("UPDATE", "업데이트"),
    "下載": ("DOWNLOAD", "다운로드"),
    "檔案": ("FILE", "파일"),
    "資料": ("DATA", "데이터"),
    "賽季": ("SEASON", "시즌"),
    "版本": ("VERSION", "버전"),
    "規劃": ("PLANNING", "계획"),
    "加成": ("BONUS", "보너스"),
    "統計": ("STATISTICS", "통계"),
    "清單": ("LIST", "목록"),
    "比較": ("COMPARE", "비교"),
    "交易站": ("TRADE_SITE", "거래소"),
    "機制": ("MECHANIC", "메커니즘"),
    "中英": ("KOREAN_ENGLISH", "한/영"),
    "點擊": ("CLICK", "클릭"),
    "拖曳": ("DRAG", "드래그"),
    "滾輪": ("MOUSE_WHEEL", "마우스 휠"),
}


def all_source_files(engine_root: Path) -> list[Path]:
    files = sorted((engine_root / "host").rglob("*.cpp"))
    files += sorted((engine_root / "host").rglob("*.h"))
    files += sorted(engine_root.glob("ui_*.cpp"))
    files += sorted(engine_root.glob("ui_*.h"))
    return sorted(set(files))


def source_files(engine_root: Path) -> list[Path]:
    return sorted({
        path for path in all_source_files(engine_root)
        if path.relative_to(engine_root).as_posix() not in EXCLUDED_SOURCE_PATHS | MANUALLY_LOCALIZED_PATHS
    })


def scan_literals(text: str) -> list[tuple[int, int, str]]:
    literals: list[tuple[int, int, str]] = []
    index = 0
    while index < len(text):
        if text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline < 0 else newline + 1
            continue
        if text.startswith("/*", index):
            close = text.find("*/", index + 2)
            index = len(text) if close < 0 else close + 2
            continue
        if text.startswith('R"', index):
            opening = text.find("(", index + 2)
            if opening < 0:
                break
            delimiter = text[index + 2 : opening]
            terminator = f'){delimiter}"'
            close = text.find(terminator, opening + 1)
            if close < 0:
                break
            literals.append((opening + 1, close, text[opening + 1 : close]))
            index = close + len(terminator)
            continue
        if text[index] == "'":
            index += 1
            while index < len(text):
                if text[index] == "\\" and index + 1 < len(text):
                    index += 2
                elif text[index] == "'":
                    index += 1
                    break
                else:
                    index += 1
            continue
        if text[index] != '"':
            index += 1
            continue
        opening = index
        index += 1
        start = index
        while index < len(text):
            if text[index] == "\\" and index + 1 < len(text):
                index += 2
            elif text[index] == '"':
                literals.append((start, index, text[start:index]))
                index += 1
                break
            else:
                index += 1
        else:
            raise RuntimeError(f"unterminated C++ string at offset {opening}")
    return literals


def protect_chinese(text: str) -> tuple[str, list[str]]:
    tokens: list[str] = []

    def replace(match: re.Match[str]) -> str:
        tokens.append(match.group(0))
        return f" ZXQPH{len(tokens) - 1}QXZ "

    return PROTECTED_SOURCE.sub(replace, text), tokens


def restore_chinese(text: str, tokens: list[str]) -> str:
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


def signature(text: str) -> list[str]:
    return sorted(SIGNATURE.findall(text))


def official_exact_map(repository_root: Path) -> dict[str, str]:
    provenance = json.loads((repository_root / "reports/display-closure/provenance.json").read_text(encoding="utf-8"))
    locale_root = repository_root / "pob-zh-engine/dist/Data/poe1"
    candidates: dict[str, set[str]] = {}
    for dictionary in ("tags", "items", "gems", "ui", "stats", "passives", "uniques", "monsters"):
        zh = json.loads((locale_root / "zh-rTW" / f"{dictionary}.json").read_text(encoding="utf-8"))["entries"]
        ko = json.loads((locale_root / "ko-KR" / f"{dictionary}.json").read_text(encoding="utf-8"))["entries"]
        dictionary_provenance = provenance["dictionaries"][dictionary]
        for english, korean in ko.items():
            if dictionary_provenance.get(english, {}).get("layer") not in ("official-exact", "official-structural-pattern"):
                continue
            chinese = zh.get(english)
            if isinstance(chinese, str) and isinstance(korean, str):
                candidates.setdefault(chinese, set()).add(korean)
    return {source: next(iter(values)) for source, values in candidates.items() if len(values) == 1}


def runtime_exact_map(repository_root: Path) -> dict[str, str]:
    """Reuse deterministic zh-rTW -> ko-KR pairs already built by English key."""
    locale_root = repository_root / "pob-zh-engine/dist/Data/poe1"
    candidates: dict[str, set[str]] = {}
    for dictionary in ("tags", "items", "gems", "ui", "stats", "passives", "uniques", "monsters"):
        zh = json.loads((locale_root / "zh-rTW" / f"{dictionary}.json").read_text(encoding="utf-8"))["entries"]
        ko = json.loads((locale_root / "ko-KR" / f"{dictionary}.json").read_text(encoding="utf-8"))["entries"]
        for english, chinese in zh.items():
            korean = ko.get(english)
            if isinstance(chinese, str) and isinstance(korean, str):
                candidates.setdefault(chinese, set()).add(korean)
    return {source: next(iter(values)) for source, values in candidates.items() if len(values) == 1}


def official_english_map(repository_root: Path) -> dict[str, str]:
    provenance = json.loads((repository_root / "reports/display-closure/provenance.json").read_text(encoding="utf-8"))
    locale_root = repository_root / "pob-zh-engine/dist/Data/poe1/ko-KR"
    candidates: dict[str, set[str]] = {}
    for dictionary in ("tags", "items", "gems", "ui", "stats", "passives", "uniques", "monsters"):
        korean = json.loads((locale_root / f"{dictionary}.json").read_text(encoding="utf-8"))["entries"]
        dictionary_provenance = provenance["dictionaries"][dictionary]
        for english, target in korean.items():
            if dictionary_provenance.get(english, {}).get("layer") not in ("official-exact", "official-structural-pattern"):
                continue
            if isinstance(target, str):
                candidates.setdefault(english.casefold(), set()).add(target)
    for english, target in SOURCE_GLOSSARY.items():
        candidates.setdefault(english.casefold(), set()).add(target)
    for english, target in ENGLISH_TERM_ALIASES.items():
        candidates.setdefault(english.casefold(), set()).add(target)
    return {source: next(iter(values)) for source, values in candidates.items() if len(values) == 1}


def exact_english_term(text: str, english_map: dict[str, str]) -> str | None:
    normalized = text.strip().rstrip(".:").strip().casefold()
    return english_map.get(normalized)


def contextual_exact_map(repository_root: Path, english_map: dict[str, str]) -> dict[str, str]:
    """Resolve compact { English-key, Chinese-label } tables through official Korean."""
    candidates: dict[str, set[str]] = {}
    engine_root = repository_root / "pob-zh-engine"
    for path in source_files(engine_root):
        for line in path.read_text(encoding="utf-8").splitlines():
            if "{" not in line or not HAN.search(line):
                continue
            literals = [value for _, _, value in scan_literals(line)]
            for index, source in enumerate(literals):
                if not HAN.search(source):
                    continue
                for possible_key in reversed(literals[:index]):
                    if HAN.search(possible_key) or not re.search(r"[A-Za-z]", possible_key):
                        continue
                    target = exact_english_term(possible_key, english_map)
                    if target:
                        candidates.setdefault(source, set()).add(target)
                    break
    return {source: next(iter(values)) for source, values in candidates.items() if len(values) == 1}


def load_en_ko_model():
    snapshot = Path(snapshot_download(
        repo_id=EN_KO_MODEL,
        revision="main",
        allow_patterns=["config.json", "generation_config.json", "model.safetensors", "source.spm", "target.spm"],
    ))
    source_spm = spm.SentencePieceProcessor(model_file=str(snapshot / "source.spm"))
    target_spm = spm.SentencePieceProcessor(model_file=str(snapshot / "target.spm"))
    model = AutoModelForSeq2SeqLM.from_pretrained(snapshot, dtype=torch.float16).to("cuda")
    model.eval()
    return source_spm, target_spm, model


def translate_en_ko(rows: list[str], source_spm, target_spm, model) -> list[str]:
    encoded = [source_spm.encode(text)[:511] + [2] for text in rows]
    maximum = max(len(row) for row in encoded)
    input_ids = torch.tensor([row + [32000] * (maximum - len(row)) for row in encoded], device="cuda")
    attention_mask = (input_ids != 32000).long()
    with torch.inference_mode():
        generated = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_new_tokens=min(256, max(32, maximum * 2)),
            num_beams=1,
        )
    return [target_spm.decode([token for token in row.tolist() if token not in (2, 32000)]) for row in generated]


def load_direct_model():
    tokenizer = NllbTokenizerFast.from_pretrained(
        DIRECT_MODEL,
        revision=DIRECT_MODEL_REVISION,
        src_lang="zho_Hans",
        extra_special_tokens={},
    )
    model = AutoModelForSeq2SeqLM.from_pretrained(
        DIRECT_MODEL,
        revision=DIRECT_MODEL_REVISION,
        dtype=torch.float16,
    ).to("cuda")
    model.eval()
    return tokenizer, model


def translate_zh_ko(rows: list[str], tokenizer, model) -> list[str]:
    inputs = tokenizer(rows, return_tensors="pt", padding=True, truncation=True, max_length=512).to("cuda")
    with torch.inference_mode():
        generated = model.generate(
            **inputs,
            forced_bos_token_id=tokenizer.convert_tokens_to_ids("kor_Hang"),
            max_new_tokens=min(256, max(32, inputs["input_ids"].shape[1] * 2)),
            num_beams=4,
        )
    return tokenizer.batch_decode(generated, skip_special_tokens=True)


def prepare_direct_source(text: str) -> str:
    rows = sorted(SOURCE_MODEL_TERMS.items(), key=lambda row: len(row[0]), reverse=True)
    for index, (source, _) in enumerate(rows):
        text = text.replace(source, f" TT{index:03d}TT ")
    return text


def restore_direct_terms(source_text: str, translated_text: str) -> str:
    rows = sorted(SOURCE_MODEL_TERMS.items(), key=lambda row: len(row[0]), reverse=True)
    text = translated_text
    for index, (source, (_, korean)) in enumerate(rows):
        if source not in source_text:
            continue
        marker = f"TT{index:03d}TT"
        if not re.search(re.escape(marker), text, flags=re.IGNORECASE):
            raise ValueError(f"game-term marker missing: {marker}")
        text = re.sub(re.escape(marker), korean, text, flags=re.IGNORECASE)
    # The model occasionally joins adjacent anchors as
    # TT001TTTT002TT.  Both anchors are restored above; discard only the
    # separator run left at their boundary.
    text = re.sub(r"T{2,}", "", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


def split_protected_source(text: str) -> list[tuple[str, bool]]:
    parts: list[tuple[str, bool]] = []
    cursor = 0
    for match in PROTECTED_SOURCE.finditer(text):
        if match.start() > cursor:
            parts.append((text[cursor : match.start()], False))
        parts.append((match.group(0), True))
        cursor = match.end()
    if cursor < len(text):
        parts.append((text[cursor:], False))
    return parts


def retry_rejected(output_path: Path, batch_size: int) -> None:
    load_ml_dependencies()
    document = json.loads(output_path.read_text(encoding="utf-8"))
    repository_root = output_path.parents[3]
    english_map = official_english_map(repository_root)
    rejected_sources = list(document.get("rejected", {}))
    source_parts = {source: split_protected_source(source) for source in rejected_sources}
    pending: list[tuple[str, int, str]] = []
    for source, parts in source_parts.items():
        for index, (part, protected) in enumerate(parts):
            if not protected and HAN.search(part):
                pending.append((source, index, part))
    pending.sort(key=lambda row: len(row[2]))

    zh_tokenizer = AutoTokenizer.from_pretrained(ZH_EN_MODEL)
    zh_model = AutoModelForSeq2SeqLM.from_pretrained(ZH_EN_MODEL, dtype=torch.float16).to("cuda")
    zh_model.eval()
    source_spm, target_spm, ko_model = load_en_ko_model()
    traditional_to_simplified = OpenCC("t2s")
    translated_parts: dict[tuple[str, int], str] = {}
    part_errors: dict[str, str] = {}
    for offset in range(0, len(pending), batch_size):
        rows = pending[offset : offset + batch_size]
        zh_inputs = zh_tokenizer(
            [traditional_to_simplified.convert(row[2]) for row in rows],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=512,
        ).to("cuda")
        with torch.inference_mode():
            english_ids = zh_model.generate(
                **zh_inputs,
                max_new_tokens=min(256, max(32, zh_inputs["input_ids"].shape[1] * 2)),
                num_beams=1,
            )
        english = zh_tokenizer.batch_decode(english_ids, skip_special_tokens=True)
        direct = [exact_english_term(text, english_map) for text in english]
        model_indices = [index for index, target in enumerate(direct) if target is None]
        korean_model = translate_en_ko([english[index] for index in model_indices], source_spm, target_spm, ko_model)
        korean_by_index = dict(zip(model_indices, korean_model, strict=True))
        for row_index, (source, index, _) in enumerate(rows):
            target = direct[row_index] if direct[row_index] is not None else korean_by_index[row_index]
            target = apply_glossary(target.strip())
            if HAN.search(target) or not HANGUL.search(target):
                part_errors[source] = "split retry did not produce clean Hangul"
            else:
                translated_parts[(source, index)] = target
        print(f"source split retry: {min(offset + batch_size, len(pending))}/{len(pending)}", flush=True)

    for source, parts in source_parts.items():
        if source in part_errors:
            document["rejected"][source] = part_errors[source]
            continue
        target = "".join(
            value if protected or not HAN.search(value) else translated_parts.get((source, index), value)
            for index, (value, protected) in enumerate(parts)
        )
        if HAN.search(target):
            document["rejected"][source] = "split retry left Han characters"
        elif not HANGUL.search(target):
            document["rejected"][source] = "split retry target contains no Hangul"
        elif signature(source) != signature(target):
            document["rejected"][source] = "split retry C++ display signature mismatch"
        else:
            document["entries"][source] = suggestion_entry(source, target)
            document["rejected"].pop(source, None)
    document["entries"] = dict(sorted(document["entries"].items()))
    document["rejected"] = dict(sorted(document["rejected"].items()))
    output_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"source split retry complete: translated={len(document['entries'])}; rejected={len(document['rejected'])}")


def generate(repository_root: Path, output_path: Path, batch_size: int) -> None:
    load_ml_dependencies()
    engine_root = repository_root / "pob-zh-engine"
    literals = sorted({
        value
        for path in source_files(engine_root)
        for _, _, value in scan_literals(path.read_text(encoding="utf-8"))
        if HAN.search(value)
    })
    official = official_exact_map(repository_root)
    english_map = official_english_map(repository_root)
    contextual = contextual_exact_map(repository_root, english_map)
    entries = {source: official[source] for source in literals if source in official}
    entries.update({source: contextual[source] for source in literals if source not in entries and source in contextual})
    entries.update({source: SOURCE_EXACT_TERMS[source] for source in literals if source not in entries and source in SOURCE_EXACT_TERMS})
    pending = [source for source in literals if source not in entries]
    rejected: dict[str, str] = {}

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the source-literal translation pass")
    traditional_to_simplified = OpenCC("t2s")
    direct_tokenizer, direct_model = load_direct_model()
    direct_candidates = list(pending)
    for offset in range(0, len(direct_candidates), min(batch_size, 48)):
        sources = direct_candidates[offset : offset + min(batch_size, 48)]
        translated = translate_zh_ko(
            [traditional_to_simplified.convert(prepare_direct_source(source)) for source in sources],
            direct_tokenizer,
            direct_model,
        )
        for source, target in zip(sources, translated, strict=True):
            try:
                target = apply_glossary(restore_direct_terms(source, target))
            except ValueError:
                continue
            if HAN.search(target) or not HANGUL.search(target) or signature(source) != signature(target):
                continue
            entries[source] = target
        print(
            f"source direct: {min(offset + min(batch_size, 48), len(direct_candidates))}/{len(direct_candidates)}; "
            f"accepted={sum(source in entries for source in direct_candidates)}",
            flush=True,
        )
    del direct_model
    torch.cuda.empty_cache()
    pending = [source for source in pending if source not in entries]

    zh_tokenizer = AutoTokenizer.from_pretrained(ZH_EN_MODEL)
    zh_model = AutoModelForSeq2SeqLM.from_pretrained(ZH_EN_MODEL, dtype=torch.float16).to("cuda")
    zh_model.eval()
    source_spm, target_spm, ko_model = load_en_ko_model()

    for offset in range(0, len(pending), batch_size):
        sources = pending[offset : offset + batch_size]
        protected_zh = [protect_chinese(source) for source in sources]
        zh_inputs = zh_tokenizer(
            [traditional_to_simplified.convert(row[0]) for row in protected_zh],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=512,
        ).to("cuda")
        with torch.inference_mode():
            english_ids = zh_model.generate(**zh_inputs, max_new_tokens=512, num_beams=1)
        english_raw = zh_tokenizer.batch_decode(english_ids, skip_special_tokens=True)
        english_rows: list[str | None] = []
        errors: list[str | None] = []
        for translated, (_, tokens) in zip(english_raw, protected_zh, strict=True):
            try:
                english_rows.append(restore_chinese(translated, tokens))
                errors.append(None)
            except ValueError as error:
                english_rows.append(None)
                errors.append(str(error))

        direct_targets: dict[int, str] = {}
        model_indices: list[int] = []
        protected_en: list[tuple[str, list[str]]] = []
        for index, row in enumerate(english_rows):
            if row is None:
                continue
            direct = exact_english_term(row, english_map)
            if direct is not None and signature(sources[index]) == signature(direct):
                direct_targets[index] = direct
                continue
            model_indices.append(index)
            protected_en.append(protect_english(row, include_glossary=False))
        korean_raw = translate_en_ko([row[0] for row in protected_en], source_spm, target_spm, ko_model) if protected_en else []
        korean_by_index = dict(zip(model_indices, zip(korean_raw, protected_en, strict=True), strict=True))
        for index, source in enumerate(sources):
            if errors[index]:
                rejected[source] = f"zh-en: {errors[index]}"
                continue
            if index in direct_targets:
                entries[source] = direct_targets[index]
                continue
            translated, (_, tokens) = korean_by_index[index]
            try:
                target = apply_glossary(restore(translated, tokens))
                if HAN.search(target):
                    raise ValueError("target contains Han characters")
                if not HANGUL.search(target):
                    raise ValueError("target contains no Hangul")
                if signature(source) != signature(target):
                    raise ValueError("C++ display signature mismatch")
                entries[source] = target
            except ValueError as error:
                rejected[source] = f"en-ko: {error}"
        print(f"source fallback: {min(offset + batch_size, len(pending))}/{len(pending)}; translated={len(entries)}; rejected={len(rejected)}", flush=True)

    document = {
        "schemaVersion": 1,
        "source": "official exact/contextual Korean plus offline t2s direct and zh-en/en-ko machine-assisted source literal fallback",
        "models": [DIRECT_MODEL, ZH_EN_MODEL, EN_KO_MODEL],
        "licenses": {
            f"{DIRECT_MODEL}@{DIRECT_MODEL_REVISION}": "CC-BY-NC-4.0",
            ZH_EN_MODEL: "CC-BY-4.0",
            EN_KO_MODEL: "CC-BY-4.0",
        },
        "entries": {
            source: suggestion_entry(source, target)
            for source, target in sorted(entries.items())
        },
        "contexts": [],
        "rejected": dict(sorted(rejected.items())),
    }
    output_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def suggestion_entry(source: str, target: str) -> dict[str, object]:
    return {
        "target": target,
        "status": "suggested",
        "provenance": "machine-generated-source-literal",
        "formatSignature": signature(source),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("generate", "retry"))
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    locale_root = Path(__file__).resolve().parent
    repository_root = locale_root.parent.parent
    mapping_path = args.output or locale_root / "source-translation-suggestions.json"
    canonical_path = (locale_root / "source-translations.json").resolve()
    if (
        mapping_path.name.casefold() == "source-translations.json"
        or mapping_path.resolve() == canonical_path
    ):
        parser.error(f"refusing canonical accepted-map output: {mapping_path}")
    if args.mode == "generate":
        generate(repository_root, mapping_path, args.batch_size)
    else:
        retry_rejected(mapping_path, args.batch_size)


if __name__ == "__main__":
    main()
