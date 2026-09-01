#include "filter_i18n.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <json.hpp> // nlohmann::ordered_json (deps/nlohmann)

using nlohmann::ordered_json;

// Read a whole file (wide path; the exe may live in a non-ASCII directory).
static bool read_file_utf8(const std::wstring& path, std::string& out)
{
	HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
	if (h == INVALID_HANDLE_VALUE) return false;
	LARGE_INTEGER size{};
	bool ok = false;
	if (GetFileSizeEx(h, &size) && size.QuadPart >= 0 && size.QuadPart < (1ll << 30)) {
		out.resize((size_t)size.QuadPart);
		DWORD read = 0;
		ok = out.empty() || (ReadFile(h, &out[0], (DWORD)out.size(), &read, nullptr) && read == out.size());
		if (!ok) out.clear();
	}
	CloseHandle(h);
	return ok;
}

static std::wstring widen(const std::string& s)
{
	if (s.empty()) return std::wstring();
	int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
	std::wstring w(n, L'\0');
	MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), &w[0], n);
	return w;
}

// Merge an "entries" dictionary file (key=English, value=Chinese string) into dst.
static void load_entries(const std::wstring& path, std::unordered_map<std::string, std::string>& dst)
{
	std::string content;
	if (!read_file_utf8(path, content)) return;
	ordered_json doc;
	try { doc = ordered_json::parse(content); } catch (...) { return; }
	if (!doc.contains("entries") || !doc["entries"].is_object()) return;
	for (auto& [key, val] : doc["entries"].items()) {
		if (val.is_string()) {
			// Don't overwrite an existing translation (earlier dicts win).
			dst.emplace(key, val.get<std::string>());
		} else if (val.is_object() && val.contains("\xe7\xbf\xbb\xe8\xad\xaf") &&
		           val["\xe7\xbf\xbb\xe8\xad\xaf"].is_string()) {
			dst.emplace(key, val["\xe7\xbf\xbb\xe8\xad\xaf"].get<std::string>());
		}
	}
}

// Merge a flat { "English": "中文" } object into dst (first value wins).
static void load_flat(const std::wstring& path, std::unordered_map<std::string, std::string>& dst)
{
	std::string content;
	if (!read_file_utf8(path, content)) return;
	ordered_json doc;
	try { doc = ordered_json::parse(content); } catch (...) { return; }
	if (!doc.is_object()) return;
	for (auto& [key, val] : doc.items())
		if (val.is_string()) dst.emplace(key, val.get<std::string>());
}

void FilterI18n::Load(const std::wstring& exeDir, const std::string& locale)
{
	const bool koreanLocale = locale == "ko-KR";
	// 1. Complete bundled TC item names (repoe-fork derived) — primary source.
	if (!koreanLocale) load_flat(exeDir + L"Data\\filter_items_zh.json", names_);

	// 2. Engine dictionaries fill anything the bundled set lacks (first value wins).
	std::wstring dir = exeDir + L"Data\\poe1\\" + widen(locale) + L"\\";
	for (const wchar_t* f : { L"items.json", L"uniques.json", L"gems.json", L"ui.json" })
		load_entries(dir + f, names_);

	// 3. Per-item class + tags (repoe-fork) for ALL items.
	{
		std::string content;
		if (read_file_utf8(exeDir + L"Data\\item_meta.json", content)) {
			try {
				ordered_json doc = ordered_json::parse(content);
				if (doc.is_object())
					for (auto& [name, v] : doc.items()) {
						if (!v.is_object()) continue;
						Meta m;
						if (v.contains("class") && v["class"].is_string()) m.cls = v["class"].get<std::string>();
						if (v.contains("tags") && v["tags"].is_array())
							for (auto& t : v["tags"]) if (t.is_string()) m.tags.push_back(t.get<std::string>());
						// Filter-relevant base metadata (absent for uniques and
						// GGPK-patched entries — the defaults mean "unknown").
						if (v.contains("drop") && v["drop"].is_number_integer()) m.drop = v["drop"].get<int>();
						if (v.contains("w") && v["w"].is_number_integer()) m.w = v["w"].get<int>();
						if (v.contains("h") && v["h"].is_number_integer()) m.h = v["h"].get<int>();
						meta_.emplace(name, std::move(m));
					}
			} catch (...) {}
		}
	}

	// 4. Legacy base type -> item class (gear; kept for the base-class sub-filter).
	{
		std::string content;
		if (read_file_utf8(exeDir + L"Data\\base_classes.json", content)) {
			try {
				ordered_json doc = ordered_json::parse(content);
				if (doc.is_object())
					for (auto& [k, v] : doc.items())
						if (v.is_string()) baseClass_.emplace(k, v.get<std::string>());
			} catch (...) {}
		}
	}

	// 5. Item-class Chinese labels: bundled repoe-fork map (complete) first, then
	// the engine's item_metadata.json as a fallback.
	if (!koreanLocale) load_flat(exeDir + L"Data\\item_classes_zh.json", classZh_);
	// 5b. class id -> in-game English class name (what the Class condition matches).
	load_flat(exeDir + L"Data\\item_classes_en.json", classEn_);
	{
		std::string content;
		if (read_file_utf8(dir + L"item_metadata.json", content)) {
			try {
				ordered_json doc = ordered_json::parse(content);
				if (doc.contains("item_classes") && doc["item_classes"].is_array())
					for (auto& e : doc["item_classes"])
						if (e.contains("en") && e.contains("zh") && e["en"].is_string() && e["zh"].is_string())
							classZh_.emplace(e["en"].get<std::string>(), e["zh"].get<std::string>());

				// zh -> en parse tables for pasted game item text. Same file the
				// paste path's classify_lines uses; read-only here.
				auto zhToEn = [&doc](const char* section,
				                     std::unordered_map<std::string, std::string>& dst) {
					if (!doc.contains(section) || !doc[section].is_array()) return;
					for (auto& e : doc[section])
						if (e.contains("en") && e.contains("zh") && e["en"].is_string() && e["zh"].is_string())
							dst.emplace(e["zh"].get<std::string>(), e["en"].get<std::string>());
				};
				zhToEn("headers", zh_.header);
				zhToEn("rarity_values", zh_.rarity);
				zhToEn("status_lines", zh_.status);
				zhToEn("influence_tags", zh_.influence);
				zhToEn("item_classes", zh_.itemClass);
			} catch (...) {}
		}
		// Supplements for known gaps in item_metadata.json. Keep both locale paths:
		// the Korean public build uses the official Korean labels, while the legacy
		// zh-rTW mode retains its original parser aliases as UTF-8 byte escapes.
		if (koreanLocale) {
			zh_.header.emplace(u8"지도 등급", "Map Tier");
			zh_.header.emplace(u8"중첩 개수", "Stack Size");
			zh_.itemClass.emplace(u8"심연 주얼", "Abyss Jewels");
		} else {
			zh_.header.emplace("\xe5\x9c\xb0\xe5\x9c\x96\xe9\x9a\x8e\xe7\xb4\x9a", "Map Tier");
			zh_.header.emplace("\xe5\xa0\x86\xe7\x96\x8a\xe6\x95\xb8\xe9\x87\x8f", "Stack Size");
			zh_.itemClass.emplace("\xe6\xb7\xb1\xe6\xb7\xb5\xe7\x8f\xa0\xe5\xaf\xb6", "Abyss Jewels");
		}
	}

	loaded_ = !names_.empty() || !baseClass_.empty();
}

std::string FilterI18n::DisplayName(const std::string& en) const
{
	auto it = names_.find(en);
	return it != names_.end() ? it->second : en;
}

std::string FilterI18n::BaseClass(const std::string& en) const
{
	auto it = baseClass_.find(en);
	return it != baseClass_.end() ? it->second : std::string();
}

std::string FilterI18n::ItemClass(const std::string& en) const
{
	auto it = meta_.find(en);
	return it != meta_.end() ? it->second.cls : std::string();
}

const std::vector<std::string>& FilterI18n::Tags(const std::string& en) const
{
	static const std::vector<std::string> kEmpty;
	auto it = meta_.find(en);
	return it != meta_.end() ? it->second.tags : kEmpty;
}

int FilterI18n::DropLevelOf(const std::string& en) const
{
	auto it = meta_.find(en);
	return it != meta_.end() ? it->second.drop : -1;
}

bool FilterI18n::SizeOf(const std::string& en, int* w, int* h) const
{
	auto it = meta_.find(en);
	if (it == meta_.end() || it->second.w <= 0 || it->second.h <= 0) return false;
	if (w) *w = it->second.w;
	if (h) *h = it->second.h;
	return true;
}

std::string FilterI18n::ClassNameZh(const std::string& enClass) const
{
	// POB's Data/Bases uses singular class names ("Bow", "One Handed Sword") that
	// differ from item_metadata.json ("Bows", "One Hand Swords"), so use a built-in
	// table covering exactly the 26 classes that appear in base_classes.json.
	static const std::unordered_map<std::string, std::string> kZh = {
		{ "Amulet", u8"목걸이" }, { "Belt", u8"허리띠" }, { "Body Armour", u8"갑옷" },
		{ "Boots", u8"장화" }, { "Bow", u8"활" }, { "Claw", u8"클로" }, { "Dagger", u8"단검" },
		{ "Fishing Rod", u8"낚싯대" }, { "Flask", u8"플라스크" }, { "Gloves", u8"장갑" },
		{ "Graft", u8"접목물" }, { "Helmet", u8"투구" }, { "Jewel", u8"주얼" },
		{ "One Handed Axe", u8"한손 도끼" }, { "One Handed Mace", u8"한손 철퇴" },
		{ "One Handed Sword", u8"한손 검" }, { "Quiver", u8"화살통" }, { "Ring", u8"반지" },
		{ "Sceptre", u8"셉터" }, { "Shield", u8"방패" }, { "Staff", u8"지팡이" },
		{ "Tincture", u8"팅크" }, { "Two Handed Axe", u8"양손 도끼" },
		{ "Two Handed Mace", u8"양손 철퇴" }, { "Two Handed Sword", u8"양손 검" }, { "Wand", u8"마법봉" },
	};
	auto it = kZh.find(enClass);
	if (it != kZh.end()) return it->second;
	auto m = classZh_.find(enClass);
	return m != classZh_.end() ? m->second : enClass;
}

// ---------------------------------------------------------------------------
// NeverSink 標記標題中文化（display only）。
// 節段表對齊 Garena 台服譯名（精髓/培育器/聖甲蟲/魔符/魔偶/萃取物…），
// 覆蓋 NeverSink 8.x $type-> 全部節段;未知節段保留英文。
// $tier-> 細分規格（六百餘種裝備規格）只翻通用字,其餘保留英文。

static const char* ns_type_seg_zh(const std::string& seg)
{
	static const std::unordered_map<std::string, const char*> k = {
		{ "3l", u8"3링크" }, { "4l", u8"4링크" }, { "6l", u8"6링크" },
		{ "abyss", u8"심연" },
		{ "act1", u8"1장" }, { "act2", u8"2장" }, { "otheracts", u8"기타 장" },
		{ "all", u8"모두" },
		{ "amuring", u8"목걸이·반지" }, { "belts", u8"허리띠" },
		{ "animatedweapons", u8"기동된 무기" },
		{ "anyremaining", u8"나머지 모두" }, { "remaining", u8"나머지" },
		{ "archer", u8"활" }, { "caster", u8"시전자" },
		{ "melee1h", u8"한손 근접" }, { "melee2h", u8"양손 근접" },
		{ "minion", u8"소환수" }, { "universal", u8"공통" },
		{ "armours", u8"방어구" },
		{ "artefact", u8"유물" }, { "sanctifiedrelics", u8"성역 유물" },
		{ "blighted", u8"역병 걸린" },
		{ "breachrings", u8"균열 반지" },
		{ "chancing", u8"기회의 오브 베이스" },
		{ "cluster", u8"스킬 군 주얼" }, { "clustereco", u8"고가 스킬 군 주얼" },
		{ "corpses", u8"시신" },
		{ "corruptedid", u8"감정된 타락 아이템" }, { "corruptedimplicit", u8"타락 고정 속성" },
		{ "corruptedspecial", u8"특수 타락" }, { "corruptions", u8"타락" },
		{ "crafting", u8"제작" }, { "normalcraft", u8"일반 제작" },
		{ "qualityperfection", u8"고퀄리티" }, { "expensive", u8"고가" },
		{ "crucible", u8"시련" },
		{ "currency", u8"화폐" },
		{ "decorators", u8"구분선" },
		{ "deliriumorbs", u8"환영의 오브" },
		{ "divination", u8"점술 카드" },
		{ "droppeditems", u8"드롭 장비" },
		{ "eater", u8"세계 포식자" }, { "exarch", u8"작열의 총주교" },
		{ "enchanted", u8"인챈트" },
		{ "endgameflasks", u8"엔드게임 플라스크" }, { "endgamergb", u8"엔드게임 3색 링크" },
		{ "endgametinctures", u8"엔드게임 팅크" },
		{ "essence", u8"에센스" },
		{ "event", u8"이벤트" }, { "idols", u8"우상" },
		{ "exceptional", u8"특출난" },
		{ "exotic", u8"특이" }, { "exotics", u8"특이 아이템" },
		{ "exoticbases", u8"특이 베이스" }, { "exoticbaseslower", u8"저가 특이 베이스" },
		{ "exoticmap", u8"특이 지도" }, { "exoticmods", u8"특이 속성" },
		{ "expedition", u8"탐험" }, { "logbook", u8"탐험 일지" },
		{ "extra", u8"추가" },
		{ "firstlevels", u8"초반 레벨링" },
		{ "flasks", u8"플라스크" }, { "life", u8"생명력" }, { "mana", u8"마나" },
		{ "hybrid", u8"하이브리드" }, { "utility", u8"보조" }, { "quality", u8"퀄리티" },
		{ "fossil", u8"화석" },
		{ "foulborn", u8"사악한 탄생" },
		{ "fractured", u8"분열" },
		{ "fragments", u8"조각" }, { "scarabs", u8"갑충석" },
		{ "gear", u8"장비" }, { "generalgear", u8"일반 장비" },
		{ "gems", u8"젬" }, { "generic", u8"일반" }, { "special", u8"특별" },
		{ "gold", u8"골드" },
		{ "harvest", u8"수확" },
		{ "heist", u8"강탈" }, { "heisttarget", u8"강탈 대상" },
		{ "cloak", u8"망토" }, { "brooch", u8"브로치" }, { "tool", u8"도구" },
		{ "contract", u8"계약" }, { "blueprint", u8"도면" },
		{ "hidelayer", u8"레이어 숨기기" }, { "maphiders", u8"지도 숨기기" },
		{ "implicitmod", u8"고정 속성" },
		{ "incubators", u8"인큐베이터" },
		{ "influenced", u8"영향받은 장비" },
		{ "jewels", u8"주얼" },
		{ "leagueexclusive", u8"리그 전용" },
		{ "leveling", u8"레벨링" }, { "levelingstacked", u8"레벨링 묶음" },
		{ "magic", u8"마법" }, { "magicid", u8"감정된 마법" },
		{ "rare", u8"희귀" }, { "rareid", u8"감정된 희귀" },
		{ "rareblendid", u8"감정된 혼합 희귀" }, { "rareeg", u8"엔드게임 희귀" },
		{ "rareoptional", u8"선택 희귀" },
		{ "rr", u8"엔드게임 희귀 장비" },
		{ "memorystrand", u8"기억 가닥" },
		{ "normalmagic", u8"일반·마법" },
		{ "maps", u8"지도" }, { "nightmare", u8"악몽" }, { "vaaltemple", u8"바알 사원" },
		{ "misc", u8"기타" }, { "miscendgamerules", u8"엔드게임 기타 규칙" },
		{ "miscmapitems", u8"기타 지도 아이템" }, { "miscmapitemsextra", u8"추가 지도 아이템" },
		{ "oil", u8"오일" },
		{ "omen", u8"징조" }, { "trial", u8"시련" }, { "tattoo", u8"문신" },
		{ "others", u8"기타" },
		{ "questlike", u8"퀘스트 아이템" }, { "questlikeexception", u8"퀘스트 아이템 예외" },
		{ "replicas", u8"모조품" },
		{ "rgb", u8"3색 링크" },
		{ "runesgrafts", u8"룬·접목물" },
		{ "sanctum", u8"성역" },
		{ "simulacrum", u8"복제된 영토" },
		{ "sockets", u8"홈" }, { "socketslinks", u8"홈·연결" },
		{ "splinter", u8"조각" },
		{ "stacked", u8"묶음" }, { "stackedsix", u8"6장 묶음" }, { "stackedthree", u8"3장 묶음" },
		{ "stackedsplintershigh", u8"고가 조각 묶음" }, { "stackedsplinterslow", u8"저가 조각 묶음" },
		{ "stackedsupplieshigh", u8"고가 보급품 묶음" }, { "stackedsupplieslow", u8"저가 보급품 묶음" },
		{ "stackedsuppliesportal", u8"포탈 주문서 묶음" }, { "stackedsupplieswisdom", u8"감정 주문서 묶음" },
		{ "synthesised", u8"결합" },
		{ "talisman", u8"부적" },
		{ "tincture", u8"팅크" },
		{ "uniques", u8"고유" },
		{ "veiled", u8"장막" },
		{ "vials", u8"약병" },
		{ "wandprogression", u8"마법봉 성장" }, { "weaponprogression", u8"무기 성장" },
		{ "wombgifts", u8"태생의 선물" },
	};
	auto it = k.find(seg);
	return it == k.end() ? nullptr : it->second;
}

static std::string ns_tier_seg_zh(const std::string& seg)
{
	static const std::unordered_map<std::string, const char*> k = {
		{ "any", u8"모든" }, { "restex", u8"나머지" }, { "general", u8"일반" },
		{ "final", u8"최종" }, { "anyhigh", u8"고등급" },
	};
	auto it = k.find(seg);
	if (it != k.end()) return it->second;
	// "t1".."t17" -> "T1"（純數字階級代碼統一大寫）
	if (seg.size() >= 2 && seg[0] == 't' &&
	    seg.find_first_not_of("0123456789", 1) == std::string::npos)
		return "T" + seg.substr(1);
	return seg;
}

// "a->b->c" -> 各節段翻譯後以「·」相接;未知節段原樣保留。
static std::string ns_join_path(const std::string& path, bool tierPath)
{
	std::string out;
	size_t p = 0;
	for (;;) {
		size_t q = path.find("->", p);
		std::string seg = (q == std::string::npos) ? path.substr(p) : path.substr(p, q - p);
		std::string zh;
		if (tierPath) {
			zh = ns_tier_seg_zh(seg);
		} else if (const char* t = ns_type_seg_zh(seg)) {
			zh = t;
		}
		if (zh.empty()) zh = seg;
		if (!out.empty()) out += u8"·";
		out += zh;
		if (q == std::string::npos) break;
		p = q + 2;
	}
	return out;
}

std::string NeverSinkHeaderZh(const std::string& header)
{
	if (header.find("$type->") == std::string::npos) return header;
	std::string out;
	size_t p = 0;
	bool lastWasType = false;
	while (p < header.size()) {
		size_t sp = header.find_first_not_of(" \t", p);
		if (sp == std::string::npos) break;
		size_t e = header.find_first_of(" \t", sp);
		if (e == std::string::npos) e = header.size();
		std::string tok = header.substr(sp, e - sp);
		std::string piece;
		bool isType = tok.rfind("$type->", 0) == 0;
		bool isTier = tok.rfind("$tier->", 0) == 0;
		if (isType)
			piece = u8"【" + ns_join_path(tok.substr(7), false) + u8"】";
		else if (isTier)
			piece = ns_join_path(tok.substr(7), true);
		else
			piece = tok;
		// 「【…】T2」— tier 緊貼 type 區塊,不留空格。
		if (!out.empty() && !(isTier && lastWasType)) out += ' ';
		out += piece;
		lastWasType = isType;
		p = e;
	}
	return out;
}

std::string FilterI18n::ClassNameEn(const std::string& classId) const
{
	auto it = classEn_.find(classId);
	return it != classEn_.end() ? it->second : classId;
}
