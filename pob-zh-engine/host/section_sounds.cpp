#include "editor_shell.h"
#include "editor_util.h"
#include "sound_library_service.h"
#include "sound_manager.h"
#include "audio_player.h"

#define IMGUI_DEFINE_MATH_OPERATORS
#include <imgui.h>
#include <misc/cpp/imgui_stdlib.h>

#include <string>
#include <unordered_map>
#include <vector>

// 音效管理 — reference: POE-Filter-Audio-Manager. Left: naming rules (add /
// edit / delete, saved to Data\sound_rules.json). Right: the sound folder's
// files with preview, per-file rename and reference counts against the open
// filter. Batch rename runs through a dry-run plan modal; conflicts must be
// resolved explicitly, and CustomAlertSound references update only after the
// user confirms (model marked dirty, never auto-saved).

namespace {

// name(lower) -> CustomAlertSound reference count in the open filter. Rebuilt
// when the doc's structure version changes (good enough: value-only edits to
// sound paths are rare and the 重新整理 button forces it).
std::unordered_map<std::wstring, int>& RefCounts(EditorShell& s, bool force = false)
{
	static std::unordered_map<std::wstring, int> counts;
	static unsigned ver = ~0u;
	static const void* modelPtr = nullptr;
	if (force || ver != s.doc.structureVersion() || modelPtr != (const void*)&s.model) {
		counts.clear();
		if (s.loaded) {
			for (const FilterLine& ln : s.model.lines) {
				if (ln.kind != FilterLineKind::Action) continue;
				if (ln.keyword != "CustomAlertSound" && ln.keyword != "CustomAlertSoundOptional") continue;
				if (ln.values.empty()) continue;
				std::wstring v = EdWiden(ln.values[0].text);
				size_t slash = v.find_last_of(L"\\/");
				std::wstring base = (slash == std::wstring::npos) ? v : v.substr(slash + 1);
				for (wchar_t& c : base) c = towlower(c);
				counts[base]++;
			}
		}
		ver = s.doc.structureVersion();
		modelPtr = &s.model;
	}
	return counts;
}

int RefCountOf(EditorShell& s, const std::wstring& name)
{
	std::wstring key = name;
	for (wchar_t& c : key) c = towlower(c);
	auto& m = RefCounts(s);
	auto it = m.find(key);
	return it == m.end() ? 0 : it->second;
}

const char* StateZh(RenamePlanEntry::State st)
{
	switch (st) {
		case RenamePlanEntry::State::Rename: return u8"이름 변경";
		case RenamePlanEntry::State::Unchanged: return u8"변함 없음";
		default: return u8"충돌";
	}
}

// ---- rule editor popup ------------------------------------------------------

void DrawRuleEditor(EditorShell& s, int& editIdx, NamingRule& buf)
{
	if (!ImGui::BeginPopupModal(u8"수정 규칙###ruleedit", nullptr, ImGuiWindowFlags_AlwaysAutoResize))
		return;
	ImGui::SetNextItemWidth(260 * s.scale);
	ImGui::InputText(u8"규칙명", &buf.name);
	ImGui::SetNextItemWidth(260 * s.scale);
	ImGui::InputText(u8"일치 키워드", &buf.match);
	if (ImGui::IsItemHovered())
		ImGui::SetTooltip(u8"파일 이름에 이 문자열이 포함되면 규칙이 적용됩니다. 비워 두면 수동 적용에만 사용됩니다.");
	ImGui::SetNextItemWidth(260 * s.scale);
	ImGui::InputText(u8"새 이름 형식", &buf.rename);
	if (ImGui::IsItemHovered())
		ImGui::SetTooltip(u8"대상 파일 이름 형식: {n} = 일련번호, {ext} = 원래 확장자\n예: divine{n}.{ext}");
	ImGui::Checkbox(u8"활성화(일괄 이름 변경에 사용)", &buf.enabled);
	ImGui::Spacing();

	ImGui::BeginDisabled(buf.name.empty() && buf.rename.empty());
	if (ImGui::Button(u8"저장", ImVec2(110 * s.scale, 0))) {
		if (editIdx >= 0 && editIdx < (int)s.sounds.rules().size())
			s.sounds.rules()[editIdx] = buf;
		else
			s.sounds.rules().push_back(buf);
		std::string err;
		s.status = s.sounds.SaveRules(&err) ? u8"규칙을 저장했습니다." : (u8"규칙 저장 실패: " + err);
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndDisabled();
	ImGui::SameLine();
	if (ImGui::Button(u8"취소", ImVec2(110 * s.scale, 0))) ImGui::CloseCurrentPopup();
	ImGui::EndPopup();
}

// ---- batch-rename plan modal ------------------------------------------------

void DrawPlanModal(EditorShell& s, std::vector<RenamePlanEntry>& plan, bool& syncRefs)
{
	ImGui::SetNextWindowSize(ImVec2(720 * s.scale, 0));
	if (!ImGui::BeginPopupModal(u8"일괄 이름 변경 미리보기###renameplan", nullptr, ImGuiWindowFlags_AlwaysAutoResize))
		return;

	int nRef = 0, nConflict = 0, nUnresolved = 0;
	for (const RenamePlanEntry& e : plan) {
		nRef += (int)e.refLines.size();
		if (e.state == RenamePlanEntry::State::Conflict) {
			nConflict++;
			if (e.resolution == RenamePlanEntry::Resolution::Unset) nUnresolved++;
		}
	}
	ImGui::TextDisabled(u8"총 %d개 · 충돌 %d개(미해결 %d개) · 현재 필터의 CustomAlertSound 참조 %d줄에 영향",
		(int)plan.size(), nConflict, nUnresolved, nRef);
	ImGui::Separator();

	if (ImGui::BeginTable("##plan", 5,
			ImGuiTableFlags_Borders | ImGuiTableFlags_RowBg | ImGuiTableFlags_ScrollY,
			ImVec2(0, 320 * s.scale))) {
		ImGui::TableSetupColumn(u8"원래 파일 이름");
		ImGui::TableSetupColumn(u8"새 파일 이름");
		ImGui::TableSetupColumn(u8"상태", ImGuiTableColumnFlags_WidthFixed, 60 * s.scale);
		ImGui::TableSetupColumn(u8"충돌 처리", ImGuiTableColumnFlags_WidthFixed, 120 * s.scale);
		ImGui::TableSetupColumn(u8"참조", ImGuiTableColumnFlags_WidthFixed, 50 * s.scale);
		ImGui::TableHeadersRow();
		for (int i = 0; i < (int)plan.size(); i++) {
			RenamePlanEntry& e = plan[i];
			ImGui::TableNextRow();
			ImGui::PushID(i);
			ImGui::TableSetColumnIndex(0);
			ImGui::TextUnformatted(EdNarrow(e.oldName).c_str());
			ImGui::TableSetColumnIndex(1);
			ImGui::TextUnformatted(EdNarrow(e.newName).c_str());
			ImGui::TableSetColumnIndex(2);
			if (e.state == RenamePlanEntry::State::Conflict)
				ImGui::TextColored(ImVec4(0.95f, 0.55f, 0.15f, 1), "%s", StateZh(e.state));
			else
				ImGui::TextUnformatted(StateZh(e.state));
			ImGui::TableSetColumnIndex(3);
			if (e.state == RenamePlanEntry::State::Conflict) {
				static const char* kRes[4] = { u8"선택하세요...", u8"건너뛰기", u8"접미사 추가", u8"서로 바꾸기" };
				int r = (int)e.resolution;
				ImGui::SetNextItemWidth(-1);
				if (ImGui::Combo("##res", &r, kRes, 4))
					e.resolution = (RenamePlanEntry::Resolution)r;
			} else {
				ImGui::TextDisabled("-");
			}
			ImGui::TableSetColumnIndex(4);
			ImGui::Text("%d", (int)e.refLines.size());
			ImGui::PopID();
		}
		ImGui::EndTable();
	}

	ImGui::BeginDisabled(!s.loaded || nRef == 0);
	ImGui::Checkbox(u8"참조 동기화: 필터의 파일 이름도 변경(변경 후 필터 저장 필요)", &syncRefs);
	ImGui::EndDisabled();
	ImGui::Spacing();

	ImGui::BeginDisabled(nUnresolved > 0 || plan.empty());
	if (ImGui::Button(u8"이름 변경 실행", ImVec2(130 * s.scale, 0))) {
		SoundLibraryService::ApplyResult r =
			s.sounds.ApplyRenamePlan(plan, (syncRefs && s.loaded) ? &s.doc : nullptr);
		s.status = u8"이름 변경 " + std::to_string(r.renamed) + u8"개 · 건너뜀 " + std::to_string(r.skipped) +
		           u8"개 · 서로 바꿈 " + std::to_string(r.swapped) +
		           u8"개 · 참조 업데이트 " + std::to_string(r.refsUpdated) + u8"줄" +
		           (r.refsUpdated ? u8"(필터 저장 필요)" : u8"") +
		           (r.err.empty() ? u8"" : (u8" ※ " + r.err));
		RefCounts(s, true);
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndDisabled();
	if (nUnresolved > 0 && ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
		ImGui::SetTooltip(u8"모든 충돌은 우선 처리 방법을 선택하세요.");
	ImGui::SameLine();
	if (ImGui::Button(u8"취소", ImVec2(130 * s.scale, 0))) ImGui::CloseCurrentPopup();
	ImGui::EndPopup();
}

// ---- single-file rename popup -----------------------------------------------

void DrawRenameOne(EditorShell& s, std::wstring& target, std::string& newName, bool& syncRefs)
{
	if (!ImGui::BeginPopupModal(u8"파일 이름 변경###renameone", nullptr, ImGuiWindowFlags_AlwaysAutoResize))
		return;
	ImGui::TextDisabled(u8"원래 파일: %s", EdNarrow(target).c_str());
	ImGui::SetNextItemWidth(300 * s.scale);
	ImGui::InputText(u8"새 파일 이름", &newName);

	// Quick-fill from a rule (expands {ext}; {n} becomes 1 — adjust as needed).
	if (!s.sounds.rules().empty()) {
		ImGui::SetNextItemWidth(300 * s.scale);
		if (ImGui::BeginCombo("##rulefill", u8"사용 규칙...")) {
			for (const NamingRule& r : s.sounds.rules()) {
				if (r.rename.empty()) continue;
				if (ImGui::Selectable((r.name + "  (" + r.rename + ")").c_str())) {
					std::string t = r.rename;
					size_t dot = EdNarrow(target).find_last_of('.');
					std::string ext = dot == std::string::npos ? "" : EdNarrow(target).substr(dot + 1);
					size_t p;
					while ((p = t.find("{ext}")) != std::string::npos) t.replace(p, 5, ext);
					while ((p = t.find("{n}")) != std::string::npos) t.replace(p, 3, "1");
					newName = t;
				}
			}
			ImGui::EndCombo();
		}
	}

	int refs = RefCountOf(s, target);
	if (refs > 0) {
		ImGui::TextColored(ImVec4(0.95f, 0.75f, 0.25f, 1),
			u8"현재 필터의 %d줄이 이 파일을 참조합니다.", refs);
		ImGui::Checkbox(u8"참조 동기화(변경 후 필터 저장 필요)", &syncRefs);
	}
	ImGui::Spacing();

	ImGui::BeginDisabled(newName.empty());
	if (ImGui::Button(u8"확인", ImVec2(110 * s.scale, 0))) {
		RenamePlanEntry e = s.sounds.BuildSingleRename(target, EdWiden(newName),
			s.loaded ? &s.model : nullptr);
		if (e.state == RenamePlanEntry::State::Conflict) {
			s.status = u8"이름 변경 실패: 같은 이름의 파일이 이미 있습니다(" + newName + u8")";
		} else if (e.state == RenamePlanEntry::State::Rename) {
			std::vector<RenamePlanEntry> plan{ e };
			SoundLibraryService::ApplyResult r =
				s.sounds.ApplyRenamePlan(plan, (syncRefs && s.loaded) ? &s.doc : nullptr);
			s.status = r.err.empty()
				? (u8"이름 변경: " + newName +
				   (r.refsUpdated ? (u8", 참조 " + std::to_string(r.refsUpdated) + u8"줄 업데이트(필터 저장 필요)") : u8""))
				: (u8"이름 변경 실패: " + r.err);
			RefCounts(s, true);
		}
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndDisabled();
	ImGui::SameLine();
	if (ImGui::Button(u8"취소", ImVec2(110 * s.scale, 0))) ImGui::CloseCurrentPopup();
	ImGui::EndPopup();
}

// 替換引用 modal:把過濾器中所有引用 target 的 CustomAlertSound 行改為另一個
// 已存在的音效檔(檔案本身不動;音量與路徑前綴保留;標 dirty 不自動存)。
void DrawReplaceRefs(EditorShell& s, const std::wstring& target, int& choice)
{
	if (!ImGui::BeginPopupModal(u8"참조 변경###replrefs", nullptr, ImGuiWindowFlags_AlwaysAutoResize))
		return;
	const std::vector<SoundFileInfo>& files = s.sounds.files();
	int refs = RefCountOf(s, target);
	ImGui::Text(u8"%s를 참조하는 %d줄을 다음 파일로 변경합니다:", EdNarrow(target).c_str(), refs);

	std::string cur = (choice >= 0 && choice < (int)files.size())
		? EdNarrow(files[choice].name) : u8"사운드 파일을 선택하세요...";
	ImGui::SetNextItemWidth(300 * s.scale);
	if (ImGui::BeginCombo("##replto", cur.c_str())) {
		for (int i = 0; i < (int)files.size(); i++) {
			if (files[i].name == target) continue;   // 不列自己
			if (ImGui::Selectable(EdNarrow(files[i].name).c_str(), i == choice)) choice = i;
		}
		ImGui::EndCombo();
	}
	ImGui::SameLine();
	ImGui::BeginDisabled(choice < 0 || choice >= (int)files.size());
	if (ImGui::Button(u8"미리 듣기"))
		PlayAudioFile(s.sounds.folder() + L"\\" + files[choice].name);
	ImGui::EndDisabled();

	ImGui::TextDisabled(u8"사운드 파일 자체는 바뀌지 않으며 각 줄의 음량과 경로 접두사는 유지됩니다.");
	ImGui::Spacing();

	bool can = choice >= 0 && choice < (int)files.size();
	ImGui::BeginDisabled(!can);
	if (ImGui::Button(u8"모두 교체", ImVec2(120 * s.scale, 0))) {
		StopAudio();
		int n = ReplaceSoundRefs(&s.doc, target, files[choice].name);
		RefCounts(s, true);
		s.status = std::to_string(n) + u8"개 참조를 " + EdNarrow(files[choice].name) +
		           u8"(으)로 변경했습니다. 적용하려면 필터를 저장하세요.";
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndDisabled();
	ImGui::SameLine();
	if (ImGui::Button(u8"취소", ImVec2(120 * s.scale, 0))) ImGui::CloseCurrentPopup();
	ImGui::EndPopup();
}

} // namespace

void DrawSoundsSection(EditorShell& s)
{
	if (!s.soundsInit) {
		s.sounds.Init(s.exeDir);
		s.soundsInit = true;
	}

	static int editIdx = -1;
	static NamingRule editBuf;
	static std::vector<RenamePlanEntry> plan;
	static bool planSync = true;
	static std::wstring renameTarget;
	static std::string renameNew;
	static bool renameSync = true;
	static std::wstring replTarget;
	static int replChoice = -1;

	// --- folder row ---
	std::string folderU = EdNarrow(s.sounds.folder());
	ImGui::SetNextItemWidth(420 * s.scale);
	if (ImGui::InputText(u8"사운드 파일 폴더", &folderU, ImGuiInputTextFlags_EnterReturnsTrue))
		s.sounds.SetFolder(EdWiden(folderU));
	ImGui::SameLine();
	if (ImGui::Button(u8"탐색...")) s.pendingDialog = EdDialog::SoundFolder;
	ImGui::SameLine();
	if (ImGui::Button(u8"새로고침")) { s.sounds.Rescan(); RefCounts(s, true); }
	ImGui::SameLine();
	if (ImGui::Button(u8"재생 중단")) StopAudio();
	ImGui::Separator();

	// --- left: naming rules ---
	ImGui::BeginChild("##rules", ImVec2(330 * s.scale, 0), true);
	ImGui::TextUnformatted(u8"이름 변경 규칙");
	ImGui::SameLine();
	if (ImGui::SmallButton(u8"+추가")) {
		editIdx = -1;
		editBuf = NamingRule{};
		ImGui::OpenPopup(u8"수정 규칙###ruleedit");
	}
	ImGui::TextDisabled(u8"파일 이름이 일치 키워드를 포함하면 지정한 형식에 따라 이름을 바꿉니다.");
	ImGui::Separator();

	int delIdx = -1;
	bool wantRuleEdit = false;   // OpenPopup must run outside the PushID scope
	for (int i = 0; i < (int)s.sounds.rules().size(); i++) {
		NamingRule& r = s.sounds.rules()[i];
		ImGui::PushID(i);
		bool en = r.enabled;
		if (ImGui::Checkbox("##en", &en)) { r.enabled = en; s.sounds.SaveRules(); }
		if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"이 규칙을 일괄 이름 변경에 사용할지 설정합니다.");
		ImGui::SameLine();
		ImGui::TextUnformatted(r.name.empty() ? u8"(이름 없음)" : r.name.c_str());
		ImGui::SameLine();
		ImGui::TextDisabled("%s → %s", r.match.empty() ? u8"(수동 적용)" : r.match.c_str(), r.rename.c_str());
		ImGui::SameLine(ImGui::GetContentRegionMax().x - 96 * s.scale);
		if (ImGui::SmallButton(u8"편집")) {
			editIdx = i;
			editBuf = r;
			wantRuleEdit = true;
		}
		ImGui::SameLine();
		if (ImGui::SmallButton(u8"삭제")) delIdx = i;
		ImGui::PopID();
	}
	if (wantRuleEdit) ImGui::OpenPopup(u8"수정 규칙###ruleedit");
	if (delIdx >= 0) {
		s.sounds.rules().erase(s.sounds.rules().begin() + delIdx);
		s.sounds.SaveRules();
		s.status = u8"규칙을 삭제했습니다.";
	}
	if (s.sounds.rules().empty())
		ImGui::TextDisabled(u8"아직 규칙이 없습니다. 예: 키워드 'divine'→ divine{n}.{ext}");

	ImGui::Spacing();
	ImGui::Separator();
	ImGui::BeginDisabled(s.sounds.files().empty());
	if (ImGui::Button(u8"규칙에 따라 일괄 이름 변경...", ImVec2(-1, 0))) {
		plan = s.sounds.BuildRenamePlan(s.loaded ? &s.model : nullptr);
		planSync = true;
		if (plan.empty())
			s.status = u8"활성화된 규칙과 일치하는 파일이 없습니다.";
		else
			ImGui::OpenPopup(u8"일괄 이름 변경 미리보기###renameplan");
	}
	ImGui::EndDisabled();

	DrawRuleEditor(s, editIdx, editBuf);
	DrawPlanModal(s, plan, planSync);
	ImGui::EndChild();

	ImGui::SameLine();

	// --- right: files ---
	ImGui::BeginChild("##files", ImVec2(0, 0), true);
	ImGui::TextUnformatted((u8"사운드 파일 (" + std::to_string((int)s.sounds.files().size()) + u8")").c_str());
	if (!s.loaded) {
		ImGui::SameLine();
		ImGui::TextDisabled(u8"(필터가 열려 있지 않아 참조 수를 표시할 수 없습니다.)");
	}
	ImGui::Separator();
	if (s.sounds.files().empty())
		ImGui::TextDisabled(u8"지정한 폴더에 지원되는 사운드 파일(wav / mp3 / ogg / flac / m4a / aac)이 없습니다.");

	bool wantRename = false;   // OpenPopup must run outside the PushID scope
	bool wantReplace = false;
	for (int i = 0; i < (int)s.sounds.files().size(); i++) {
		const SoundFileInfo& fi = s.sounds.files()[i];
		ImGui::PushID(i);
		if (ImGui::Button(u8"미리 듣기")) PlayAudioFile(s.sounds.folder() + L"\\" + fi.name);
		ImGui::SameLine();
		ImGui::AlignTextToFramePadding();
		ImGui::TextUnformatted(EdNarrow(fi.name).c_str());
		int refs = RefCountOf(s, fi.name);
		if (refs > 0) {
			ImGui::SameLine();
			ImGui::TextColored(ImVec4(0.35f, 0.75f, 0.95f, 1), u8"(참조 %d개)", refs);
		}
		ImGui::SameLine(ImGui::GetContentRegionMax().x - 170 * s.scale);
		ImGui::BeginDisabled(refs <= 0);
		if (ImGui::SmallButton(u8"참조 교체...")) {
			replTarget = fi.name;
			replChoice = -1;
			wantReplace = true;
		}
		ImGui::EndDisabled();
		if (refs > 0 && ImGui::IsItemHovered())
			ImGui::SetTooltip(u8"필터에서 이 파일을 참조하는 모든 규칙을 다른 파일로 바꿉니다. 파일 자체는 이동하지 않습니다.");
		ImGui::SameLine(ImGui::GetContentRegionMax().x - 70 * s.scale);
		if (ImGui::SmallButton(u8"이름 변경...")) {
			renameTarget = fi.name;
			renameNew = EdNarrow(fi.name);
			renameSync = true;
			wantRename = true;
		}
		ImGui::PopID();
	}
	if (wantRename) ImGui::OpenPopup(u8"파일 이름 변경###renameone");
	if (wantReplace) ImGui::OpenPopup(u8"참조 변경###replrefs");
	DrawRenameOne(s, renameTarget, renameNew, renameSync);
	DrawReplaceRefs(s, replTarget, replChoice);
	ImGui::EndChild();
}
