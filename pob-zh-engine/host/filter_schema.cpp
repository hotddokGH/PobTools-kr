#include "filter_schema.h"

#include <unordered_map>

namespace {

// Shared op sets. "" means "no operator written" (the game treats it as equals).
const std::vector<const char*> kOpsAll  = { "", ">=", "<=", "==", "=", "!=", "<", ">" };
const std::vector<const char*> kOpsEq   = { "", "==", "=" };
const std::vector<const char*> kOpsNone = {};

const std::vector<SchemaEnumValue> kRarity = {
	{ "Normal", u8"일반" }, { "Magic", u8"마법" }, { "Rare", u8"희귀" }, { "Unique", u8"고유" },
};
const std::vector<SchemaEnumValue> kInfluence = {
	{ "Shaper", u8"쉐이퍼" }, { "Elder", u8"엘더" }, { "Crusader", u8"성전사" },
	{ "Hunter", u8"사냥꾼" }, { "Redeemer", u8"대속자" }, { "Warlord", u8"전쟁군주" },
	{ "None", u8"없음" },
};
const std::vector<SchemaEnumValue> kGemQuality = {
	{ "Superior", u8"상급" }, { "Divergent", u8"상이한" },
	{ "Anomalous", u8"기묘한" }, { "Phantasmal", u8"환상적인" },
};
const std::vector<SchemaEnumValue> kBool = {
	{ "True", u8"예" }, { "False", u8"아니요" },
};

const char* const kGrpCommon = u8"아이템 관련";
const char* const kGrpAdv    = u8"고급 조건";
const char* const kGrpMods   = u8"속성 관련";
const char* const kGrpLook   = u8"색상·아이콘";
const char* const kGrpSound  = u8"사운드";
const char* const kGrpVisual = u8"시각 효과";

std::vector<CardSchema> build_table()
{
	std::vector<CardSchema> t;
	auto add = [&t](CardSchema c) { t.push_back(std::move(c)); };

	// ---- 物品相關 (conditions) ------------------------------------------
	add({ "Class", u8"아이템 종류", false, CardKind::StringList, kGrpCommon, kOpsEq, {}, 0, 0,
	      "Class \"Stackable Currency\"", 0, nullptr,
	      u8"아이템 대분류(영어 내부 이름, 부분 일치 가능, ==는 정확히 일치)" });
	add({ "BaseType", u8"아이템 이름", false, CardKind::StringList, kGrpCommon, kOpsEq, {}, 0, 0,
	      "BaseType \"Divine Orb\"", 0, nullptr,
	      u8"구체적인 베이스 이름(영어, 한국어 입력은 자동 변환, 부분 일치 가능)" });
	add({ "Rarity", u8"아이템 희귀도", false, CardKind::EnumOp, kGrpCommon, kOpsAll, kRarity, 0, 0,
	      "Rarity Normal", 0, nullptr, u8"일반 < 마법 < 희귀 < 고유" });
	add({ "ItemLevel", u8"아이템 레벨", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 0, 100,
	      "ItemLevel >= 84", 0, nullptr, u8"아이템 레벨(드롭 지역 레벨로 결정)" });
	add({ "DropLevel", u8"드롭 레벨", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 0, 100,
	      "DropLevel >= 65", 0, nullptr, u8"해당 베이스가 드롭되기 시작하는 레벨" });
	add({ "Quality", u8"퀄리티", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 0, 30,
	      "Quality >= 20", 0, nullptr, nullptr });
	add({ "StackSize", u8"중첩 개수", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 1, 50000,
	      "StackSize >= 10", 0, nullptr, u8"중첩 가능한 아이템의 현재 수량" });
	add({ "AreaLevel", u8"지역 레벨", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 0, 100,
	      "AreaLevel < 68", 0, nullptr, u8"현재 지역 레벨(캠페인 또는 엔드게임)" });
	add({ "LinkedSockets", u8"연결된 홈 수", false, CardKind::IntOp, kGrpCommon, kOpsAll, {}, 0, 6,
	      "LinkedSockets 6", 0, nullptr, u8"가장 큰 연결의 홈 수(6 = 6링크)" });
	add({ "Sockets", u8"홈", false, CardKind::SocketSpec, kGrpCommon, kOpsAll, {}, 0, 6,
	      "Sockets >= 6", 0, nullptr, u8"홈 개수와 색상(예: 5GGG, R 빨강 G 초록 B 파랑 W 흰색 A 심연 D 탐광)" });
	add({ "SocketGroup", u8"연결", false, CardKind::SocketSpec, kGrpCommon, kOpsAll, {}, 0, 6,
	      "SocketGroup >= 5GGG", 0, nullptr, u8"서로 연결된 홈의 개수와 색상" });

	// ---- 進階條件 --------------------------------------------------------
	add({ "MapTier", u8"지도 등급", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 1, 17,
	      "MapTier >= 15", 0, nullptr, nullptr });
	add({ "GemLevel", u8"젬 레벨", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 1, 21,
	      "GemLevel >= 20", 0, nullptr, nullptr });
	add({ "Height", u8"아이템 높이", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 1, 4,
	      "Height <= 3", 0, nullptr, nullptr });
	add({ "Width", u8"아이템 너비", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 1, 2,
	      "Width <= 1", 0, nullptr, nullptr });
	add({ "BaseDefencePercentile", u8"기본 방어 수치 백분위", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 100,
	      "BaseDefencePercentile >= 90", 0, nullptr, u8">= 90은 기본 방어 수치 상위 10%" });
	add({ "BaseArmour", u8"기본 방어도", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 5000,
	      "BaseArmour >= 500", 0, nullptr, nullptr });
	add({ "BaseEvasion", u8"기본 회피", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 5000,
	      "BaseEvasion >= 500", 0, nullptr, nullptr });
	add({ "BaseEnergyShield", u8"기본 에너지 보호막", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 1000,
	      "BaseEnergyShield >= 100", 0, nullptr, nullptr });
	add({ "BaseWard", u8"기본 수호", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 500,
	      "BaseWard >= 50", 0, nullptr, nullptr });
	add({ "Corrupted", u8"타락", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "Corrupted True", 0, nullptr, nullptr });
	add({ "CorruptedMods", u8"타락 고정 속성 수", false, CardKind::IntOp, kGrpAdv, kOpsAll, {}, 0, 2,
	      "CorruptedMods >= 1", 0, nullptr, nullptr });
	add({ "Mirrored", u8"복제", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "Mirrored True", 0, nullptr, nullptr });
	add({ "Identified", u8"감정됨", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "Identified True", 0, nullptr, nullptr });
	add({ "FracturedItem", u8"분열된 아이템", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "FracturedItem True", 0, nullptr, nullptr });
	add({ "SynthesisedItem", u8"결합된 아이템", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "SynthesisedItem True", 0, nullptr, nullptr });
	add({ "Replica", u8"모조품", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "Replica True", 0, nullptr, nullptr });
	add({ "Scourged", u8"스컬지", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "Scourged True", 0, nullptr, nullptr });
	add({ "HasInfluence", u8"영향", false, CardKind::EnumMulti, kGrpAdv, kOpsNone, kInfluence, 0, 0,
	      "HasInfluence Shaper", 0, nullptr, u8"쉐이퍼, 엘더, 정복자 등의 영향" });
	add({ "ShaperItem", u8"쉐이퍼 아이템", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "ShaperItem True", 0, nullptr, nullptr });
	add({ "ElderItem", u8"엘더 아이템", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "ElderItem True", 0, nullptr, nullptr });
	add({ "BlightedMap", u8"역병 걸린 지도", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "BlightedMap True", 0, nullptr, nullptr });
	add({ "UberBlightedMap", u8"역병에 유린당한 지도", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "UberBlightedMap True", 0, nullptr, nullptr });
	add({ "ShapedMap", u8"쉐이퍼 지도", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "ShapedMap True", 0, nullptr, nullptr });
	add({ "ElderMap", u8"엘더 지도", false, CardKind::Bool, kGrpAdv, kOpsNone, kBool, 0, 0,
	      "ElderMap True", 0, nullptr, nullptr });
	add({ "Continue", u8"계속", false, CardKind::Toggle, kGrpAdv, kOpsNone, {}, 0, 0,
	      "Continue", 0, nullptr, u8"이 블록이 일치해도 아래 블록을 계속 평가(스타일 추가 적용)" });

	// ---- 詞綴相關 --------------------------------------------------------
	add({ "GemQualityType", u8"대체 퀄리티", false, CardKind::EnumMulti, kGrpMods, kOpsNone, kGemQuality, 0, 0,
	      "GemQualityType Divergent", 0, nullptr, u8"젬 퀄리티 유형(상이한, 기묘한, 환상적인)" });
	add({ "TransfiguredGem", u8"변형 젬", false, CardKind::Bool, kGrpMods, kOpsNone, kBool, 0, 0,
	      "TransfiguredGem True", 0, nullptr, u8"변형된 스킬 젬" });
	add({ "ArchnemesisMod", u8"아틀라스 속성", false, CardKind::StringList, kGrpMods, kOpsNone, {}, 0, 0,
	      "ArchnemesisMod \"Toxic\"", 0, nullptr, u8"아틀라스 몬스터 속성" });
	add({ "EnchantmentPassiveNode", u8"스킬 군 주얼 유형", false, CardKind::StringList, kGrpMods, kOpsNone, {}, 0, 0,
	      "EnchantmentPassiveNode \"Damage\"", 0, nullptr, u8"스킬 군 주얼이 부여하는 패시브 유형" });
	add({ "EnchantmentPassiveNum", u8"스킬 군 주얼 패시브 수", false, CardKind::IntOp, kGrpMods, kOpsAll, {}, 0, 12,
	      "EnchantmentPassiveNum >= 8", 0, nullptr, u8"패시브 스킬 X개가 추가된 스킬 군 주얼" });
	add({ "HasEnchantment", u8"인챈트 속성", false, CardKind::StringList, kGrpMods, kOpsNone, {}, 0, 0,
	      "HasEnchantment \"Enchantment\"", 0, nullptr, u8"인챈트 이름 지정(부분 일치)" });
	add({ "AnyEnchantment", u8"인챈트 있음", false, CardKind::Bool, kGrpMods, kOpsNone, kBool, 0, 0,
	      "AnyEnchantment True", 0, nullptr, nullptr });
	add({ "HasImplicitMod", u8"고정 속성 부여", false, CardKind::Bool, kGrpMods, kOpsNone, kBool, 0, 0,
	      "HasImplicitMod True", 0, nullptr, nullptr });
	add({ "HasExplicitMod", u8"명시 속성", false, CardKind::ModList, kGrpMods, kOpsAll, {}, 0, 6,
	      "HasExplicitMod \"of Haast\"", 0, nullptr,
	      u8"속성 문구로 필터링. 비교 연산자와 숫자를 쓰면 일치 개수도 지정 가능" });

	// ---- 顏色圖標 (actions) ----------------------------------------------
	add({ "SetBackgroundColor", u8"배경색", true, CardKind::Color, kGrpLook, kOpsNone, {}, 0, 255,
	      "SetBackgroundColor 0 0 0 255", 0, nullptr, nullptr });
	add({ "SetBorderColor", u8"테두리 색상", true, CardKind::Color, kGrpLook, kOpsNone, {}, 0, 255,
	      "SetBorderColor 255 255 255 255", 0, nullptr, nullptr });
	add({ "SetTextColor", u8"텍스트 색상", true, CardKind::Color, kGrpLook, kOpsNone, {}, 0, 255,
	      "SetTextColor 255 255 255 255", 0, nullptr, nullptr });
	add({ "SetFontSize", u8"글꼴 크기", true, CardKind::IntRange, kGrpLook, kOpsNone, {}, 1, 45,
	      "SetFontSize 40", 0, nullptr, u8"1~45. 중요 아이템은 크게, 불필요한 아이템은 작게 표시" });

	// ---- 音效 (exclusive group 1) ----------------------------------------
	add({ "PlayAlertSound", u8"내장 사운드", true, CardKind::SoundBuiltin, kGrpSound, kOpsNone, {}, 1, 16,
	      "PlayAlertSound 1 300", 1, "PlayAlertSoundPositional",
	      u8"내장 소리 번호 1~16, 음량 0~300" });
	add({ "CustomAlertSound", u8"사용자 정의 오디오", true, CardKind::SoundCustom, kGrpSound, kOpsNone, {}, 0, 300,
	      "CustomAlertSound \"alert.mp3\" 300", 1, "CustomAlertSoundOptional",
	      u8"사용자 지정 소리 파일(필터와 같은 폴더)" });
	add({ "DisableDropSound", u8"드롭 소리 끄기", true, CardKind::Toggle, kGrpSound, kOpsNone, {}, 0, 0,
	      "DisableDropSound", 0, nullptr, u8"아이템의 기본 드롭 소리 끄기" });

	// ---- 視覺提示 --------------------------------------------------------
	add({ "MinimapIcon", u8"미니맵 아이콘", true, CardKind::MinimapIcon, kGrpVisual, kOpsNone, {}, 0, 2,
	      "MinimapIcon 1 White Circle", 0, nullptr, u8"미니맵 아이콘: 크기(0이 가장 큼), 색상, 모양" });
	add({ "PlayEffect", u8"아이템 광선", true, CardKind::PlayEffect, kGrpVisual, kOpsNone, {}, 0, 0,
	      "PlayEffect White", 0, nullptr, u8"드롭 광선 색상. Temp를 쓰면 일시적으로 표시" });

	return t;
}

} // namespace

const std::vector<CardSchema>& FilterSchemaAll()
{
	static const std::vector<CardSchema> t = build_table();
	return t;
}

const CardSchema* FilterSchemaFind(const std::string& keyword)
{
	static const std::unordered_map<std::string, const CardSchema*> idx = [] {
		std::unordered_map<std::string, const CardSchema*> m;
		for (const CardSchema& c : FilterSchemaAll()) {
			m[c.keyword] = &c;
			if (c.alias) m[c.alias] = &c;
		}
		return m;
	}();
	auto it = idx.find(keyword);
	return it != idx.end() ? it->second : nullptr;
}

std::string FilterSchemaKeywordZh(const std::string& keyword)
{
	const CardSchema* c = FilterSchemaFind(keyword);
	return c ? c->zh : keyword;
}

std::string FilterSchemaValueZh(const std::string& keyword, const std::string& value)
{
	if (value == "True") return u8"예";
	if (value == "False") return u8"아니요";
	const CardSchema* c = FilterSchemaFind(keyword);
	if (c)
		for (const SchemaEnumValue& e : c->enums)
			if (value == e.token) return e.zh;
	return value;
}

const std::vector<const char*>& FilterSchemaGroups()
{
	static const std::vector<const char*> g = {
		kGrpCommon, kGrpAdv, kGrpMods, kGrpLook, kGrpSound, kGrpVisual,
	};
	return g;
}
