#include "editor_shell.h"
#include "editor_util.h"
#include "filter_parser.h"
#include "custom_rules_io.h"
#include "sound_manager.h"   // BrowseSoundFolder
#include "ui_theme.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define IMGUI_DEFINE_MATH_OPERATORS
#include <imgui.h>
#include <misc/cpp/imgui_stdlib.h>

#include <string>

// ---- deferred dialogs --------------------------------------------------------
//
// Every Win32 common dialog this editor opens goes through here, and here is only
// ever reached after a frame has been presented. See EdDialog in the header for
// why: a common dialog runs its own modal message loop, so opening one from inside
// a frame leaves that frame half-drawn -- and as a launcher tab it stops the
// launcher's loop, which is what keeps docked POB windows hidden and positioned.

void EdRunDeferredDialogs(EditorShell& s)
{
	const EdDialog want = s.pendingDialog;
	if (want == EdDialog::None) return;
	// Cleared FIRST. If the dialog itself somehow left the intent set, the next
	// frame would reopen it, and the user could not get out of it.
	s.pendingDialog = EdDialog::None;

	switch (want) {
		case EdDialog::OpenFilter: {
			std::wstring p = EdFilterDialog(s.initialDir, false, s.hostHwnd);
			if (!p.empty()) s.OpenByPath(p, false);
			break;
		}
		case EdDialog::SaveFilterAs: {
			std::wstring p = EdFilterDialog(s.initialDir, true, s.hostHwnd);
			if (!p.empty()) {
				s.model.path = p;
				size_t slash = p.find_last_of(L"\\/");
				s.model.name = EdNarrow(slash == std::wstring::npos ? p : p.substr(slash + 1));
				std::string err;
				s.status = SaveFilter(s.model, &err)
					? (u8"저장됨: " + s.model.name + u8"  ※ 게임 내 옵션 > 게임 > UI에서 필터를 다시 선택해야 적용됩니다.")
					: (u8"저장 실패: " + err);
			}
			break;
		}
		case EdDialog::ExportCustom: {
			std::vector<int> sel;
			sel.swap(s.pendingExportSel);   // consumed, whatever the user answers
			if (sel.empty()) break;
			std::wstring p = EdFilterDialog(s.initialDir, true, s.hostHwnd);
			if (!p.empty()) {
				std::string frag = ExportCustomRules(s.model, sel, u8"사용자 지정 규칙");
				std::string err;
				s.status = SaveCustomRulesFile(p, frag, &err)
					? (u8"사용자 지정 규칙 " + std::to_string((int)sel.size()) + u8"개를 저장했습니다.")
					: (u8"저장 실패:" + err);
			}
			break;
		}
		case EdDialog::ImportCustom: {
			std::wstring p = EdFilterDialog(s.initialDir, false, s.hostHwnd);
			if (!p.empty()) {
				std::vector<unsigned char> data = EdReadFile(p);
				std::string frag(data.begin(), data.end());
				std::string err;
				int n = ImportCustomRules(s.doc, frag, &err);
				s.status = (n < 0) ? (u8"가져오기 실패: " + err)
				         : (u8"사용자 지정 영역으로 규칙 " + std::to_string(n) + u8"개를 가져왔습니다(저장되지 않음)." );
			}
			break;
		}
		case EdDialog::SoundFolder: {
			std::wstring f = BrowseSoundFolder(s.hostHwnd);
			if (!f.empty()) s.sounds.SetFolder(f);
			break;
		}
		case EdDialog::None: break;
	}
}

// ---- EditorShell methods -----------------------------------------------------

void EditorShell::OpenByPath(const std::wstring& path, bool force)
{
	if (model.dirty && !force) {
		status = u8"※ 저장되지 않은 변경 사항이 있습니다. 전환하기 전에 저장하거나 다시 불러와 변경을 버리세요.";
		return;
	}
	bool ok = false;
	FilterFile f = LoadFilter(path, &ok);
	if (!ok) { status = u8"읽기 실패: " + EdNarrow(path); return; }
	model = std::move(f);
	loaded = true;
	selectedBlock = model.blocks.empty() ? -1 : 0;
	doc.Attach(&model);              // bumps structureVersion -> row caches rebuild
	selAnchor = BlockAnchor{};
	batchMode = false;
	batchSel.clear();
	status = std::to_string(model.blocks.size()) + u8"개 규칙 블록 · " + model.name;
}

// ---- settings persistence (pob-zh.ini [PobTools]) ---------------------------

void LoadEditorSettings(EditorShell& s)
{
	std::wstring ini = s.exeDir + L"pob-zh.ini";
	wchar_t buf[128] = L"";
	GetPrivateProfileStringW(L"PobTools", L"League", L"Mirage", buf, 128, ini.c_str());
	s.league = EdNarrow(buf);
	if (s.league.empty()) s.league = "Mirage";
	s.economyEnabled = GetPrivateProfileIntW(L"PobTools", L"EconomyEnabled", 0, ini.c_str()) != 0;
}

void SaveEditorSettings(EditorShell& s)
{
	std::wstring ini = s.exeDir + L"pob-zh.ini";
	WritePrivateProfileStringW(L"PobTools", L"League", EdWiden(s.league).c_str(), ini.c_str());
	WritePrivateProfileStringW(L"PobTools", L"EconomyEnabled", s.economyEnabled ? L"1" : L"0", ini.c_str());
}

// ---- top toolbar ------------------------------------------------------------

void DrawTopToolbar(EditorShell& s)
{
	const float scale = s.scale;

	ImGui::AlignTextToFramePadding();
	ImGui::TextColored(PobUi::Accent(), u8"필터 작업대");
	ImGui::SameLine(0, 18 * scale);
	ImGui::SetNextItemWidth(300 * scale);
	{
		std::string preview = s.loaded ? s.model.name : u8"필터를 선택하세요...";
		if (ImGui::BeginCombo("##file", preview.c_str())) {
			if (s.fileList.empty())
				ImGui::TextDisabled(u8"Documents\\My Games\\Path of Exile\\에서 .filter 파일을 찾을 수 없습니다.");
			for (const FilterListEntry& e : s.fileList) {
				std::string label = e.name + (e.inItemFilters ? u8"  (ItemFilters)" : "");
				bool sel = s.loaded && e.path == s.model.path;
				if (ImGui::Selectable(label.c_str(), sel)) s.OpenByPath(e.path, false);
			}
			ImGui::EndCombo();
		}
	}
	ImGui::SameLine();
	if (ImGui::Button(u8"파일 열기...")) s.pendingDialog = EdDialog::OpenFilter;
	ImGui::SameLine();
	if (ImGui::Button(u8"목록 재구성")) { s.fileList = ListFilters(); }

	ImGui::SameLine(0, 20 * scale);
	ImGui::BeginDisabled(!s.loaded || !s.model.dirty);
	PobUi::PushPrimaryButton();
	if (ImGui::Button(s.model.dirty ? u8"저장 *" : u8"저장")) {
		std::string err;
		s.status = SaveFilter(s.model, &err)
			? (u8"저장됨: " + s.model.name + u8"  ※ 게임 내 옵션 > 게임 > UI에서 필터를 다시 선택해야 적용됩니다.")
			: (u8"저장 실패: " + err);
	}
	PobUi::PopButtonStyle();
	ImGui::EndDisabled();
	ImGui::SameLine();
	ImGui::BeginDisabled(!s.loaded);
	if (ImGui::Button(u8"다른 이름으로 저장...")) s.pendingDialog = EdDialog::SaveFilterAs;
	ImGui::SameLine();
	if (ImGui::Button(u8"다시 불러오기")) { if (!s.model.path.empty()) s.OpenByPath(s.model.path, true); }

	// --- 批量修改 / 自訂規則匯出入 ---
	ImGui::Spacing();
	ImGui::TextDisabled(u8"규칙 도구");
	ImGui::SameLine(0, 14 * scale);
	bool batchOn = s.batchMode;
	if (batchOn) ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.39f, 0.40f, 0.95f, 0.70f));
	if (ImGui::Button(u8"대량 변경")) s.batchMode = !s.batchMode;
	if (batchOn) ImGui::PopStyleColor();
	if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"왼쪽 목록에서 여러 규칙을 선택해 스타일을 한 번에 적용합니다.");

	ImGui::SameLine();
	if (ImGui::Button(u8"사용자 지정 저장")) {
		std::vector<int> sel;
		if (s.batchMode)
			for (int i = 0; i < (int)s.batchSel.size(); i++) { if (s.batchSel[i]) sel.push_back(i); }
		if (sel.empty() && s.selectedBlock >= 0) sel.push_back(s.selectedBlock);
		if (sel.empty()) {
			s.status = u8"저장할 규칙을 선택하세요.";
		} else {
			// Carried to the deferred step: the selection can change between the
			// click and the dialog closing, and what was exported has to be what was
			// selected when the button was pressed.
			s.pendingExportSel = sel;
			s.pendingDialog = EdDialog::ExportCustom;
		}
	}
	if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"선택한 규칙을 별도 파일로 내보내 다른 필터에서 가져올 수 있습니다.");

	ImGui::SameLine();
	if (ImGui::Button(u8"사용자 지정 가져오기")) s.pendingDialog = EdDialog::ImportCustom;
	if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"내보낸 사용자 지정 규칙 파일을 이 필터의 최상단 사용자 지정 영역에 추가합니다.");
	ImGui::EndDisabled();
}

// ---- left navigation --------------------------------------------------------

void DrawLeftNav(EditorShell& s)
{
	struct NavItem { Section sec; const char* label; };
	static const NavItem items[] = {
		{ Section::FilterEdit,  u8"필터 편집" },
		{ Section::DropPreview, u8"드롭 미리보기" },
		{ Section::Sounds,      u8"사운드 관리" },
	};
	for (const NavItem& it : items) {
		if (ImGui::Selectable(it.label, s.section == it.sec, 0, ImVec2(0, 30 * s.scale)))
			s.section = it.sec;
	}
}

// ---- bottom status bar ------------------------------------------------------

void DrawStatusBar(EditorShell& s)
{
	ImGui::Separator();
	if (!s.loaded) {
		ImGui::TextDisabled(u8"위에서 POE1 .filter 파일을 선택하거나 여세요(Documents\\My Games\\Path of Exile\\)." );
		return;
	}
	int nShow = 0, nHide = 0;
	for (const FilterBlock& b : s.model.blocks) (b.hide ? nHide : nShow)++;
	const std::string& msg = s.status;
	ImGui::TextDisabled(u8"%zu 규칙 · %d 표시 · %d 숨기기 %s%s",
		s.model.blocks.size(), nShow, nHide,
		msg.empty() ? "" : u8"  ·  ", msg.c_str());
}

void SetBlockHide(EditorShell& s, FilterBlock& b, bool hide)
{
	if (b.hide == hide) return;
	FilterLine& hdr = s.model.lines[b.headerLineIdx];
	hdr.keyword = hide ? "Hide" : "Show";
	hdr.dirty = true;
	b.hide = hide;
	s.model.dirty = true;
}
