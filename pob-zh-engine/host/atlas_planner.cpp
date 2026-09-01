// must precede every imgui.h include (atlas_view.h pulls it in)
#define IMGUI_DEFINE_MATH_OPERATORS

#include "atlas_planner.h"
#include "tool_panel.h"
#include "tool_window.h"
#include "atlas_diff.h"
#include "atlas_i18n.h"
#include "atlas_import.h"
#include "atlas_optimize.h"
#include "atlas_astrolabes.h"
#include "atlas_maps.h"
#include "atlas_mechanics.h"
#include "atlas_persist.h"
#include "atlas_scarabs.h"
#include "atlas_stat_agg.h"
#include "atlas_tree_data.h"
#include "atlas_update.h"
#include "error_log.h"
#include "atlas_version_index.h"
#include "atlas_view.h"
#include "editor_util.h" // EdReadFile
#include "icon_manager.h" // scarab icons (poecdn + on-disk cache)
#include "launcher_config.h" // ResolveConfiguredFontPath
#include "ui_theme.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commdlg.h>

#pragma comment(lib, "comdlg32.lib")

#include <GLES2/gl2.h>
#include <GLFW/glfw3.h>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <imgui_stdlib.h> // ImGui::InputText(std::string*)

#include <algorithm>
#include <cfloat>
#include <functional>
#include <numeric>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// node-kind palette indexed by panel rank (keystone / wormhole / notable / small);
// same hues the canvas tooltip uses
static const ImVec4 kKindCol[4] = {
	ImVec4(0.85f, 0.45f, 0.85f, 1.0f),
	ImVec4(0.55f, 0.80f, 0.95f, 1.0f),
	ImVec4(0.95f, 0.80f, 0.40f, 1.0f),
	ImVec4(0.72f, 0.76f, 0.82f, 1.0f),
};
static const char* kGroupName[4] = { u8"키스톤", u8"웜홀", u8"주요 노드", u8"소형 노드" };

// Open-file dialog scoped to data.json (new-season atlastree-export import).
static std::wstring OpenDataJsonDialog(HWND owner)
{
	wchar_t buf[MAX_PATH] = L"";
	OPENFILENAMEW ofn{};
	ofn.lStructSize = sizeof(ofn);
	ofn.hwndOwner = owner;
	ofn.lpstrFilter = L"atlastree-export data.json\0data.json;*.json\0모든 파일 (*.*)\0*.*\0\0";
	ofn.lpstrFile = buf;
	ofn.nMaxFile = MAX_PATH;
	ofn.Flags = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;
	return GetOpenFileNameW(&ofn) ? std::wstring(buf) : std::wstring();
}

static const wchar_t* kBuildJsonFilter = L"아틀라스 전략 프로젝트 (*.json)\0*.json\0모든 파일 (*.*)\0*.*\0\0";

// Save-file dialog for exporting one build project; buf pre-filled with the
// project name (filesystem-hostile characters stripped).
static std::wstring SaveBuildJsonDialog(HWND owner, const std::string& suggestedName)
{
	std::wstring name;
	{
		int n = MultiByteToWideChar(CP_UTF8, 0, suggestedName.c_str(), (int)suggestedName.size(), nullptr, 0);
		name.resize(n);
		if (n) MultiByteToWideChar(CP_UTF8, 0, suggestedName.c_str(), (int)suggestedName.size(), &name[0], n);
	}
	std::wstring clean;
	for (wchar_t c : name)
		if (!wcschr(L"\\/:*?\"<>|", c)) clean.push_back(c);

	wchar_t buf[MAX_PATH] = L"";
	wcsncpy_s(buf, clean.c_str(), _TRUNCATE);
	OPENFILENAMEW ofn{};
	ofn.lStructSize = sizeof(ofn);
	ofn.hwndOwner = owner;
	ofn.lpstrFilter = kBuildJsonFilter;
	ofn.lpstrDefExt = L"json";
	ofn.lpstrFile = buf;
	ofn.nMaxFile = MAX_PATH;
	ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
	return GetSaveFileNameW(&ofn) ? std::wstring(buf) : std::wstring();
}

static std::wstring OpenBuildJsonDialog(HWND owner)
{
	wchar_t buf[MAX_PATH] = L"";
	OPENFILENAMEW ofn{};
	ofn.lStructSize = sizeof(ofn);
	ofn.hwndOwner = owner;
	ofn.lpstrFilter = kBuildJsonFilter;
	ofn.lpstrFile = buf;
	ofn.nMaxFile = MAX_PATH;
	ofn.Flags = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;
	return GetOpenFileNameW(&ofn) ? std::wstring(buf) : std::wstring();
}

// tiny file helpers for export/import payloads (same conventions as siblings)
static bool PlannerReadFile(const std::wstring& path, std::string& out)
{
	HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
	if (h == INVALID_HANDLE_VALUE) return false;
	LARGE_INTEGER size{};
	bool ok = false;
	if (GetFileSizeEx(h, &size) && size.QuadPart >= 0 && size.QuadPart < (1ll << 26)) {
		out.resize((size_t)size.QuadPart);
		DWORD read = 0;
		ok = out.empty() || (ReadFile(h, &out[0], (DWORD)out.size(), &read, nullptr) && read == out.size());
		if (!ok) out.clear();
	}
	CloseHandle(h);
	return ok;
}

static bool PlannerWriteFile(const std::wstring& path, const std::string& content)
{
	HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (h == INVALID_HANDLE_VALUE) return false;
	DWORD written = 0;
	bool ok = content.empty() ||
		(WriteFile(h, content.data(), (DWORD)content.size(), &written, nullptr) && written == content.size());
	CloseHandle(h);
	return ok;
}

// The tool's content, independent of where it is drawn: RunToolWindow gives it a
// window of its own, the launcher's tab body draws it as a tab. See tool_panel.h.
//
// Same mechanical move as the other three tools -- every local of
// ShowAtlasPlanner is a member and every captured closure a member function --
// so the bodies below moved across unchanged. The closures are the reason this
// one waited: as locals they captured the enclosing function's frame, and a
// closure that outlives that frame compiles perfectly and is undefined at run
// time. As members there is no frame to outlive.

namespace {
// Single-level undo. Plain clicking never moves anything the user placed, but
// planning mode and the compress button both re-route wiring, which is the
// one thing a user cannot predict, so there has to be a way back. Snapshots
// are taken before a change lands, not after.
struct AtlasUndo {
	bool valid = false;
	std::vector<int> alloc, targets, blocked;
};
struct PanelNode { int idx; std::string searchKey; };

// Which blocking dialog Frame() asked for. A Win32 common dialog runs its own
// modal message loop, so opening one mid-frame stops the host's loop -- and in
// the launcher that loop is what keeps the docked POB windows glued to the
// client area. So Frame() only records the intent and RunDeferred() opens it.
enum class ApDialog { None, ImportSeasonData, ExportBuild, ImportBuild };

} // namespace

class AtlasPlannerPanel : public IToolPanel {
public:
	bool Init(const ToolPanelHost& h) override
	{
		host_ = &h;
		exeDir = h.exeDir;
		scale = h.scale;
		buildFile.Load(exeDir); // legacy single-build files migrate transparently
		if (!scarabDb.Load(exeDir, &scarabErr))
			PobLog::Error("data", "scarabs_poe1.json: " + scarabErr);
		if (!astroDb.Load(exeDir, &astroErr))
			PobLog::Error("data", "astrolabes_poe1.json: " + astroErr);
		if (!mapDb.Load(exeDir, &mapErr))
			PobLog::Error("data", "atlas_maps_poe1.json: " + mapErr);
		for (AtlasBuildEntry& b : buildFile.builds) {
			b.scarabs = scarabDb.Sanitize(b.scarabs, nullptr);
			b.astrolabes = astroDb.Sanitize(b.astrolabes, nullptr);
			b.mapId = mapDb.SanitizeOne(b.mapId);
		}
		icons.Init(exeDir);
		uiState.Load(exeDir);
		verIndex.Load(exeDir);
		if (verIndex.NeedsSave() && !verIndex.Save(exeDir))
			PobLog::Error("save", "atlas_index.json 저장 실패(시즌 목록에는 업데이트 없음)");
		viewTag = (!uiState.season.empty() && verIndex.Has(uiState.season))
			? uiState.season : verIndex.Active();
		updater.Init(exeDir);
		updater.RequestCheck(false);         // throttled to once per day
		loadSeason(viewTag);
		showZh = zhLoaded;                   // default Chinese when a mapping exists
		if (startupDropped > 0)
			importMsg = u8"주의: 해당 설정은 기존 버전의 아틀라스 트리에 저장되어 있습니다." + std::to_string(startupDropped) +
			            u8"존재하지 않는 노드가 자동으로 삭제되었습니다.";
		return true;   // missing data is a screen with an import button, not a failure
	}

	void Frame() override
	{
		// Re-read every frame and never cached: the launcher rebuilds its glyph
		// atlas when the user changes font, and every ImFont* from before that is
		// dangling afterwards.
		fontBig = host_->big;
		cjkOk = host_->cjkOk;

		// updater results land on the worker thread; apply them here (GL thread)
		AtlasUpdater::Status ust = updater.Poll();
		if (ust.reloadPending) {
			hotReload(ust.message);
			updater.AckReload();
			ust = updater.Poll();
		} else if (ust.zhRefreshed) {
			bool zhWas = zhLoaded;
			zhLoaded = i18n.Load(exeDir);
			if (!zhLoaded) showZh = false;
			else if (!zhWas) showZh = true;
			importMsg = ust.message;
			importFailed = false;
			panelDirty = true; // cached dispZh strings must pick up the new mapping
			updater.AckReload();
			ust = updater.Poll();
		}

		icons.Pump(); // GL thread: upload any scarab icons the worker finished

		ImGuiIO& io = ImGui::GetIO();
		// The width this panel has, which used to be io.DisplaySize.x -- the whole
		// viewport. True when the planner owned the window; short by a tab strip
		// and a window border when it is a tab.
		const float dispW = ImGui::GetContentRegionAvail().x;

		if (!ready) {
			ImGui::TextColored(ImVec4(0.94f, 0.27f, 0.27f, 1.0f), u8"아틀라스 데이터 불러오기 실패: %s", loadErr.c_str());
			ImGui::TextDisabled(u8"Data\\atlas_tree_poe1.json과 Data\\atlas\\ 이미지가 있는지 확인하거나 새 시즌 데이터를 가져오세요.");
			if (ImGui::Button(u8"시즌 데이터 가져오기")) importSeason();
			// the auto updater doubles as the recovery path when no data exists
			if (ust.phase == AtlasUpdatePhase::UpdateAvailable) {
				ImGui::SameLine();
				if (ImGui::Button((u8"자동 다운로드" + ust.latestTag).c_str())) updater.StartUpdate();
			} else if (ust.phase == AtlasUpdatePhase::Downloading || ust.phase == AtlasUpdatePhase::Importing ||
			           ust.phase == AtlasUpdatePhase::Checking) {
				ImGui::SameLine();
				ImGui::TextDisabled("%s", ust.message.c_str());
			} else if (ust.phase == AtlasUpdatePhase::Error) {
				ImGui::SameLine();
				ImGui::TextColored(ImVec4(0.94f, 0.27f, 0.27f, 1.0f), u8"업데이트 실패: %s", ust.message.c_str());
				ImGui::SameLine();
				if (ImGui::SmallButton(u8"재시도")) updater.StartUpdate();
			}
			if (!importMsg.empty()) {
				ImGui::SameLine();
				ImGui::TextColored(importFailed ? ImVec4(0.94f, 0.27f, 0.27f, 1.0f)
				                                : ImVec4(0.45f, 0.85f, 0.55f, 1.0f), "%s", importMsg.c_str());
			}
		} else {
			// --- project row: multi-build switching, CRUD, export/import ---
			auto switchTo = [&](int i) {
				saveActive();            // capture the outgoing project first
				buildFile.active = i;
				tree.ApplyAllocIds(buildFile.Active().alloc);
				tree.ApplyTargetIds(buildFile.Active().targets);
				tree.ApplyBlockedIds(buildFile.Active().blocked);
				undo.valid = false;      // undo does not cross projects
				saveActive();            // persist active index + pruned mapping
				panelDirty = true;
			};
			// importEntry is a member: the .json import path runs from
			// RunDeferred(), after this frame is over.

			ImGui::AlignTextToFramePadding();
			ImGui::TextColored(PobUi::Accent(), u8"아틀라스 전략");
			ImGui::SameLine(0, 18.0f * scale);
			ImGui::TextDisabled(u8"프로젝트");
			ImGui::SameLine();
			ImGui::SetNextItemWidth(220.0f * scale);
			if (ImGui::BeginCombo("##buildsel", buildFile.Active().name.c_str())) {
				for (int i = 0; i < (int)buildFile.builds.size(); i++) {
					bool sel = i == buildFile.active;
					ImGui::PushID(i);
					if (ImGui::Selectable(buildFile.builds[i].name.c_str(), sel) && !sel)
						switchTo(i);
					ImGui::PopID();
				}
				ImGui::EndCombo();
			}
			ImGui::SameLine();
			if (ImGui::Button(u8"+ 추가")) {
				nameBuf = u8"신규 프로젝트";
				ImGui::OpenPopup(u8"프로젝트 추가");
			}
			ImGui::SameLine();
			if (ImGui::Button(u8"이름 바꾸기")) {
				nameBuf = buildFile.Active().name;
				ImGui::OpenPopup(u8"프로젝트 이름 바꾸기");
			}
			ImGui::SameLine();
			if (ImGui::Button(u8"복사")) {
				saveActive();
				int idx = buildFile.DuplicateBuild(buildFile.active);
				if (idx >= 0) switchTo(idx);
			}
			ImGui::SameLine();
			bool lastBuild = buildFile.builds.size() <= 1;
			if (lastBuild) ImGui::BeginDisabled();
			PobUi::PushDangerButton();
			if (ImGui::Button(u8"삭제")) ImGui::OpenPopup(u8"프로젝트 삭제 확인");
			PobUi::PopButtonStyle();
			if (lastBuild) ImGui::EndDisabled();
			ImGui::SameLine(0, 24.0f * scale);
			if (ImGui::Button(u8"내보내기")) ImGui::OpenPopup("##exportmenu");
			ImGui::SameLine();
			if (ImGui::Button(u8"가져오기")) ImGui::OpenPopup("##importmenu");

			if (ImGui::BeginPopupModal(u8"프로젝트 추가", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				ImGui::TextUnformatted(u8"프로젝트 이름:");
				ImGui::SetNextItemWidth(260.0f * scale);
				ImGui::InputText("##newname", &nameBuf);
				ImGui::Spacing();
				if (ImGui::Button(u8"만들기(빈 포인트 할당)")) {
					saveActive();
					int idx = buildFile.AddBuild(nameBuf);
					switchTo(idx); // new project starts empty
					ImGui::CloseCurrentPopup();
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"취소")) ImGui::CloseCurrentPopup();
				ImGui::EndPopup();
			}
			if (ImGui::BeginPopupModal(u8"프로젝트 이름 바꾸기", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				ImGui::TextUnformatted(u8"새 이름:");
				ImGui::SetNextItemWidth(260.0f * scale);
				ImGui::InputText("##rename", &nameBuf);
				ImGui::Spacing();
				if (ImGui::Button(u8"확인")) {
					if (!nameBuf.empty() && nameBuf != buildFile.Active().name)
						buildFile.Active().name = buildFile.UniqueName(nameBuf);
					buildFile.Save(exeDir);
					ImGui::CloseCurrentPopup();
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"취소")) ImGui::CloseCurrentPopup();
				ImGui::EndPopup();
			}
			if (ImGui::BeginPopupModal(u8"프로젝트 삭제 확인", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				ImGui::Text(u8"프로젝트 '%s'을(를) 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.", buildFile.Active().name.c_str());
				ImGui::Spacing();
				if (ImGui::Button(u8"삭제")) {
					if (buildFile.RemoveBuild(buildFile.active)) {
						tree.ApplyAllocIds(buildFile.Active().alloc);
						tree.ApplyTargetIds(buildFile.Active().targets);
						tree.ApplyBlockedIds(buildFile.Active().blocked);
						undo.valid = false;
						saveActive();
						panelDirty = true;
					}
					ImGui::CloseCurrentPopup();
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"취소")) ImGui::CloseCurrentPopup();
				ImGui::EndPopup();
			}
			if (ImGui::BeginPopup("##exportmenu")) {
				if (ImGui::MenuItem(u8".json 파일로 저장...")) {
					saveActive();
					pendingExportName_ = buildFile.Active().name;
					pendingDialog_ = ApDialog::ExportBuild;
				}
				if (ImGui::MenuItem(u8"공유 코드 복사")) {
					saveActive();
					std::string code = AtlasBuildShareCode(buildFile.Active(), tree.Version());
					if (!code.empty()) {
						ImGui::SetClipboardText(code.c_str());
						importMsg = u8"공유 코드를 클립보드에 복사했습니다.";
						importFailed = false;
					}
				}
				ImGui::EndPopup();
			}
			if (ImGui::BeginPopup("##importmenu")) {
				if (ImGui::MenuItem(u8".json 파일 열기...")) pendingDialog_ = ApDialog::ImportBuild;
				if (ImGui::MenuItem(u8"클립보드에서 공유 코드 붙여넣기")) {
					const char* clip = ImGui::GetClipboardText();
					std::string perr;
					AtlasBuildEntry e;
					if (clip && AtlasParseShareCode(clip, &e, &perr)) {
						importEntry(e);
					} else {
						importMsg = perr.empty() ? u8"클립보드에 텍스트가 없습니다." : perr;
						importFailed = true;
					}
				}
				ImGui::EndPopup();
			}

			// --- allocation toolbar ---
			ImGui::Spacing();
			ImGui::Separator();
			ImGui::Spacing();
			int used = tree.UsedPoints(), total = tree.TotalPoints();
			ImGui::AlignTextToFramePadding();
			ImGui::TextDisabled(u8"사용된 포인트");
			ImGui::SameLine();
			ImVec4 cnt = PobUi::StatusColor(used >= total ? PobUi::StatusTone::Warning : PobUi::StatusTone::Success);
			ImGui::TextColored(cnt, "%d / %d", used, total);
			ImGui::SameLine(0, 24.0f * scale);
			if (ImGui::Button(u8"초기화")) ImGui::OpenPopup(u8"포인트 할당 초기화");
			ImGui::SameLine();
			// Minimum-point compression on demand. Clicking never re-routes any
			// more (see atlas_view.cpp), so this is the only thing that moves
			// wiring, and only when asked.
			{
				const bool canCompress = ready && !planningMode && !compareMode &&
				                         onCanonicalSeason() && tree.UsedPoints() > 0;
				if (!canCompress) ImGui::BeginDisabled();
				if (ImGui::Button(u8"최소까지 압축")) {
					std::string msg;
					importFailed = !applyCompress(msg);
					importMsg = msg;
					panelDirty = true;
				}
				if (!canCompress) ImGui::EndDisabled();
				if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
					ImGui::SetTooltip(u8"현재 노드를 최소 패시브 포인트 경로로 한 번 다시 연결합니다.\n"
					                  u8"주요 노드, 키스톤, 종점 노드는 유지하며 중간 소형 노드만 경로가 바뀔 수 있습니다.\n"
					                  u8"일반 클릭으로는 자동 재계산하지 않습니다. 이 버튼을 눌렀을 때만 이동하며 Ctrl+Z로 되돌릴 수 있습니다.");
			}
			ImGui::SameLine();
			bool updaterBusy = ust.phase == AtlasUpdatePhase::Downloading ||
			                   ust.phase == AtlasUpdatePhase::Importing;
			if (updaterBusy) ImGui::BeginDisabled(); // both paths overwrite the same tree json
			if (ImGui::Button(u8"시즌 데이터 가져오기")) ImGui::OpenPopup(u8"시즌 데이터 가져오기 확인");
			if (updaterBusy) ImGui::EndDisabled();

			// zh/en display toggle (only when a mapping is available); F2 mirrors it
			if (zhLoaded) {
				ImGui::SameLine();
				if (ImGui::Button(showZh ? "EN" : u8"한")) showZh = !showZh;
				if (ImGui::IsItemHovered())
					ImGui::SetTooltip(u8"노드의 한국어/영어 표시 전환(F2) · %s", i18n.VersionNote().c_str());
			}
			if (zhLoaded && ImGui::IsKeyPressed(ImGuiKey_F2, false)) showZh = !showZh;

			// season switcher: which league's atlas tree is drawn on the canvas
			if (verIndex.Versions().size() >= 2 && !viewTag.empty()) {
				ImGui::SameLine(0, 18.0f * scale);
				ImGui::TextDisabled(u8"시즌");
				ImGui::SameLine();
				ImGui::SetNextItemWidth(96.0f * scale);
				if (ImGui::BeginCombo("##seasonsel", viewTag.c_str())) {
					for (const std::string& t : verIndex.TagsNewestFirst()) {
						bool sel = t == viewTag;
						if (ImGui::Selectable(t.c_str(), sel) && !sel) {
							saveActive();                 // capture edits on the outgoing canonical season
							loadSeason(t);
							uiState.season = t;
							uiState.Save(exeDir);
							panelDirty = true;
							if (compareMode) refreshCompare(); // rebuild overlay/index for the new tree
						}
					}
					ImGui::EndCombo();
				}
				if (ImGui::IsItemHovered())
					ImGui::SetTooltip(u8"화면에 표시할 시즌의 아틀라스 트리를 변경합니다. 포인트 할당은 노드 ID를 기준으로 시즌 간 공유됩니다.");
				if (!onCanonicalSeason()) {
					ImGui::SameLine();
					ImGui::TextColored(ImVec4(0.90f, 0.65f, 0.25f, 1.0f), u8"이전 시즌 보기(읽기 전용)");
				}
			}

			// sandbox planning toggle (not available while comparing seasons:
			// that view is a read-only preview of a different tree)
			{
				ImGui::SameLine(0, 18.0f * scale);
				if (compareMode) ImGui::BeginDisabled();
				// Latch the flag BEFORE the button: the click handler flips the
				// very flag the Push/Pop is keyed on (enterPlanning sets
				// planningMode), so testing it again afterwards pops a style that
				// was never pushed on one edge, and leaks a pushed style on the
				// other — which then tints every later button on the toolbar.
				const bool wasPlanning = planningMode;
				if (wasPlanning) PobUi::PushDangerButton();
				if (ImGui::Button(wasPlanning ? u8"계획 종료" : u8"계획 모드")) {
					if (planningMode) planningAskExit = true;   // ask before deciding
					else { enterPlanning(); panelDirty = true; }
				}
				if (wasPlanning) PobUi::PopButtonStyle();
				if (compareMode) ImGui::EndDisabled();
				if (ImGui::IsItemHovered())
					ImGui::SetTooltip(planningMode
						? u8"종료한 뒤 이번 계획을 유지할지 선택합니다."
						: u8"샌드박스: 빈 트리에서 원하는 노드와 제외할 노드를 빠르게 표시합니다. "
						  u8"계획 중에는 저장하지 않으며 종료할 때 저장 여부를 묻습니다.");
			}

			// version-compare toggle (needs two installed seasons)
			{
				bool canCompare = verIndex.Versions().size() >= 2 && !verIndex.CompareBase().empty() &&
				                  !planningMode;
				ImGui::SameLine(0, 18.0f * scale);
				if (!canCompare) ImGui::BeginDisabled();
				// Same latching rule as the planning button above — this one is
				// what actually leaked: leaving compare mode pushed the danger
				// style and never popped it, so every button drawn afterwards
				// stayed red until the window was reopened.
				const bool wasCompare = compareMode;
				if (wasCompare) PobUi::PushDangerButton();
				if (ImGui::Button(wasCompare ? u8"비교 종료" : u8"버전 비교")) {
					compareMode = !compareMode;
					if (compareMode) refreshCompare();
					else view.ClearDiffOverlay();
				}
				if (wasCompare) PobUi::PopButtonStyle();
				if (!canCompare) ImGui::EndDisabled();
				if (ImGui::IsItemHovered())
					ImGui::SetTooltip(canCompare
						? u8"설치된 두 버전을 선택해 노드 추가·삭제와 수치 변경을 비교합니다."
						  u8"(초록=추가, 빨강=삭제, 노랑=변경)\n"
						  u8"%s처럼 같은 시즌의 소규모 버전과 공식 조정도 비교할 수 있습니다.\n"
						  u8"현재 설치된 버전: %d개"
						: u8"비교를 위해서는 두 가지 버전의 데이터가 필요합니다.",
						(verIndex.Versions().size() >= 2 ? u8"3.29.0 -> 3.29.1" : ""),
						(int)verIndex.Versions().size());
			}

			// background auto-update status / prompt
			if (ust.phase == AtlasUpdatePhase::UpdateAvailable) {
				ImGui::SameLine(0, 24.0f * scale);
				ImGui::PushStyleColor(ImGuiCol_Button, ImVec4(0.85f, 0.60f, 0.20f, 0.45f));
				ImGui::PushStyleColor(ImGuiCol_ButtonHovered, ImVec4(0.85f, 0.60f, 0.20f, 0.65f));
				ImGui::PushStyleColor(ImGuiCol_ButtonActive, ImVec4(0.85f, 0.60f, 0.20f, 0.85f));
				if (ImGui::Button((u8"새 버전 " + ust.latestTag + u8" 발견 · 클릭하여 업데이트").c_str()))
					updater.StartUpdate();
				ImGui::PopStyleColor(3);
			} else if (updaterBusy || ust.phase == AtlasUpdatePhase::Checking) {
				ImGui::SameLine(0, 24.0f * scale);
				ImGui::TextDisabled("%s", ust.message.c_str());
			} else if (ust.phase == AtlasUpdatePhase::Error) {
				ImGui::SameLine(0, 24.0f * scale);
				ImGui::TextColored(ImVec4(0.94f, 0.27f, 0.27f, 1.0f), u8"업데이트 실패: %s", ust.message.c_str());
				ImGui::SameLine();
				if (ImGui::SmallButton(u8"재시도")) updater.StartUpdate();
			}

			ImGui::Spacing();
			ImGui::TextDisabled(u8"마우스 휠 확대/축소 · 드래그로 이동 · 왼쪽 클릭으로 할당/해제 "
			                    u8"· '중심'을 클릭하면 같은 메커니즘 위치를 모두 표시합니다.");
			// Which mechanic is lit up right now, and how to turn it off. Without
			// this the rings look like part of the tree.
			if (!mechSel.empty()) {
				const AtlasMechanicDef* d = AtlasMechanicById(mechSel);
				const std::vector<int>* nn = mechFind(mechNodeIdx, mechSel);
				const std::vector<int>* mm = mechFind(mechMastIdx, mechSel);
				ImGui::SameLine(0, 18.0f * scale);
				ImGui::TextColored(ImVec4(1.0f, 0.89f, 0.43f, 1.0f), u8"메커니즘: %s(%d개 노드 · %d개 군집)",
					d ? (showZh && zhLoaded ? d->zh.c_str() : d->en.c_str()) : mechSel.c_str(),
					nn ? (int)nn->size() : 0, mm ? (int)mm->size() : 0);
				ImGui::SameLine();
				if (ImGui::SmallButton(u8"##mech 삭제")) { mechSel.clear(); applyMechHighlight(); }
			}
			if (!importMsg.empty()) {
				ImGui::SameLine(0, 18.0f * scale);
				ImGui::TextColored(PobUi::StatusColor(importFailed ? PobUi::StatusTone::Error : PobUi::StatusTone::Success),
					"%s", importMsg.c_str());
			} else if (!view.StatusLine().empty()) {
				ImGui::SameLine(0, 18.0f * scale);
				ImGui::TextDisabled("%s", view.StatusLine().c_str());
			}

			if (ImGui::BeginPopupModal(u8"시즌 데이터 가져오기 확인", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				ImGui::TextUnformatted(u8"GGG 공식 atlastree-export에서 새 시즌 아틀라스 트리를 가져옵니다.");
				ImGui::TextDisabled(u8"1. github.com/grindinggear/atlastree-export에서 Code → Download ZIP을 선택하고 압축을 풉니다.");
				ImGui::TextDisabled(u8"2. 압축을 푼 폴더의 data.json을 선택합니다(옆에 이미지 폴더가 있어야 합니다).");
				ImGui::TextDisabled(u8"가져오면 현재 트리 데이터를 덮어씁니다. 할당된 노드는 ID로 대응하며 사라진 노드는 자동 제거됩니다.");
				ImGui::Spacing();
				if (ImGui::Button(u8"data.json 선택")) {
					ImGui::CloseCurrentPopup();
					importSeason();
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"즉시 업데이트 확인")) {
					ImGui::CloseCurrentPopup();
					updater.RequestCheck(true); // manual entry: skip the daily throttle
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"취소")) ImGui::CloseCurrentPopup();
				ImGui::EndPopup();
			}
			if (!cjkOk) {
				ImGui::SameLine(0, 24.0f * scale);
				ImGui::TextColored(ImVec4(0.94f, 0.27f, 0.27f, 1.0f),
					"[!] CJK font atlas not loaded (Fonts\\FZ_ZY.ttf).");
			}

			// Leaving the sandbox: the ONLY place a planning session can reach
			// the build file. Both outcomes are explicit -- there is no default
			// action on a stray click, and no path that writes without asking.
			if (planningAskExit) { ImGui::OpenPopup(u8"계획 종료"); planningAskExit = false; }
			if (ImGui::BeginPopupModal(u8"계획 종료", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				int want = (int)tree.TargetIdx().size();
				int avoid = (int)tree.BlockedIdx().size();
				ImGui::TextUnformatted(u8"이번 계획을 유지하시겠습니까?");
				ImGui::Spacing();
				ImGui::Text(u8"현재 %d포인트 · 목표 %d개 · 제외 %d개", tree.UsedPoints(), want, avoid);
				ImGui::TextDisabled(u8"유지하면 이 프로젝트의 기존 %d포인트 할당을 덮어씁니다.", (int)planSnapshot.alloc.size());
				ImGui::Spacing();
				if (ImGui::Button(u8"유지하고 저장")) { keepPlanning(); panelDirty = true; finishPlanningPrompt(true); ImGui::CloseCurrentPopup(); }
				ImGui::SameLine();
				if (ImGui::Button(u8"변경 버리기")) { restorePlanning(); panelDirty = true; finishPlanningPrompt(true); ImGui::CloseCurrentPopup(); }
				ImGui::SameLine();
				if (ImGui::Button(u8"계속 계획")) { finishPlanningPrompt(false); ImGui::CloseCurrentPopup(); }
				ImGui::EndPopup();
			}

			if (ImGui::BeginPopupModal(u8"포인트 할당 초기화", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
				ImGui::TextUnformatted(u8"할당된 모든 노드를 지우시겠습니까?");
				ImGui::Spacing();
				if (ImGui::Button(u8"모두 삭제")) {
					tree.Reset();
					saveActive();
					panelDirty = true;
					ImGui::CloseCurrentPopup();
				}
				ImGui::SameLine();
				if (ImGui::Button(u8"취소")) ImGui::CloseCurrentPopup();
				ImGui::EndPopup();
			}

			ImGui::Separator();

			// Ctrl+Z: planning mode and the compress button both move wiring the
			// user did not place, so there is always exactly one step back.
			if (undo.valid && io.KeyCtrl && ImGui::IsKeyPressed(ImGuiKey_Z, false)) {
				tree.ApplyAllocIds(undo.alloc);
				tree.ApplyTargetIds(undo.targets);
				tree.ApplyBlockedIds(undo.blocked);
				undo.valid = false;
				saveActive();
				panelDirty = true;
			}

			// --- canvas + splitter + right summary panel ---
			// default: 35% of the window; the splitter drag below overrides it
			// and the chosen width persists in PobTools/atlas_ui.json
			if (panelW < 0.0f)
				panelW = uiState.panelW > 0.0f ? uiState.panelW * scale
				                               : std::clamp(dispW * 0.35f, 380.0f * scale, 700.0f * scale);
			// The upper bound can fall BELOW the lower one in a narrow window, and
			// std::clamp with lo > hi is undefined -- not merely odd. Reachable since
			// dispW became this panel's width rather than the whole screen's: neither
			// the launcher nor the standalone window has a minimum size, so anything
			// under about 533px of content gets there.
			const float panelMin = 320.0f * scale;
			const float panelMax = (std::max)(panelMin, dispW * 0.6f);
			panelW = std::clamp(panelW, panelMin, panelMax);
			const float splitW = 8.0f * scale;
			ImGui::BeginChild("##treewrap", ImVec2(-(panelW + splitW), 0), false,
				ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
			snapshot(frameStart);   // the pre-click state, in case Draw changes it
			bool changed = view.Draw(tree, scale, showZh && zhLoaded ? &i18n : nullptr, planningMode); // auto-saves below; the file is tiny
			if (changed) undo = frameStart;
			ImGui::EndChild();

			ImGui::SameLine(0, 0);
			ImGui::InvisibleButton("##splitter", ImVec2(splitW, ImGui::GetContentRegionAvail().y));
			if (ImGui::IsItemHovered() || ImGui::IsItemActive()) {
				ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeEW);
				ImVec2 a = ImGui::GetItemRectMin(), b = ImGui::GetItemRectMax();
				float cx = (a.x + b.x) * 0.5f;
				ImGui::GetWindowDrawList()->AddLine(ImVec2(cx, a.y + 8.0f * scale), ImVec2(cx, b.y - 8.0f * scale),
					IM_COL32(99, 102, 241, ImGui::IsItemActive() ? 220 : 120), 2.0f);
			}
			if (ImGui::IsItemActive())
				panelW = std::clamp(panelW - io.MouseDelta.x, panelMin, panelMax);
			if (ImGui::IsItemDeactivated()) { // write once on release, not per drag frame
				uiState.panelW = panelW / scale;
				uiState.Save(exeDir);
			}
			// Clicking a mastery icon toggles its mechanic. The view consumed the
			// click, so this can never also allocate.
			if (view.ClickedMastery() >= 0) {
				int mi = view.ClickedMastery();
				std::string hit;
				for (const auto& kv : mechMastIdx)
					if (std::find(kv.second.begin(), kv.second.end(), mi) != kv.second.end()) {
						hit = kv.first;
						break;
					}
				mechSel = (hit.empty() || hit == mechSel) ? std::string() : hit;
				applyMechHighlight();
			}
			if (!mechSel.empty() && ImGui::IsKeyPressed(ImGuiKey_Escape, false)) {
				mechSel.clear();
				applyMechHighlight();
			}
			if (changed) {
				saveActive();
				panelDirty = true;
			}
			if (panelDirty) {
				rebuildPanel();
				panelDirty = false;
			}

			ImGui::SameLine(0, 0);
			ImGui::BeginChild("##sidepanel", ImVec2(0, 0), true);

			if (compareMode) {
			renderComparePanel();
			} else {

			// --- points summary (pinned) ---
			ImGui::TextDisabled(u8"할당된 포인트");
			if (fontBig) ImGui::PushFont(fontBig);
			ImGui::TextColored(cnt, "%d / %d", used, total);
			if (fontBig) ImGui::PopFont();
			ImGui::PushStyleColor(ImGuiCol_PlotHistogram,
				used >= total ? PobUi::StatusColor(PobUi::StatusTone::Warning)
				              : PobUi::Accent());
			ImGui::ProgressBar(total > 0 ? (float)used / (float)total : 0.0f,
				ImVec2(-FLT_MIN, 8.0f * scale), "");
			ImGui::PopStyleColor();
			{
				int nTargets = (int)tree.TargetIdx().size();
				int wiring = used - nTargets;
				if (wiring < 0) wiring = 0;   // (windows.h's max macro is in scope here)
				ImGui::TextDisabled(u8"직접 선택 %d개 · 연결에 사용 %d포인트", nTargets, wiring);
				if (nTargets > AtlasOptExactCap()) {
					ImGui::SameLine(0, 8.0f * scale);
					ImGui::TextColored(ImVec4(0.95f, 0.75f, 0.35f, 1.0f), u8"근삿값");
					if (ImGui::IsItemHovered())
						ImGui::SetTooltip(u8"%d개를 초과하면 '최소까지 압축'과 계획 모드가 근사 알고리즘을 사용합니다.\n"
							u8"정확한 최솟값보다 몇 포인트 더 많을 수 있습니다. 일반 노드 클릭에는 영향이 없습니다.",
							AtlasOptExactCap());
				}
				if (undo.valid) {
					ImGui::SameLine(0, 10.0f * scale);
					ImGui::TextDisabled(u8"Ctrl+Z 되돌리기");
				}
			}
			ImGui::Spacing();


			// --- search (pinned; filters stats AND the node list, en + zh) ---
			ImGui::SetNextItemWidth(-FLT_MIN);
			ImGui::InputTextWithHint("##panelsearch", u8"통계 또는 노드 검색...",
				panelSearch, sizeof(panelSearch), ImGuiInputTextFlags_EscapeClearsAll);
			std::string needle = ToLowerAscii(panelSearch);
			auto matches = [&](const std::string& key) {
				return needle.empty() || key.find(needle) != std::string::npos;
			};
			ImGui::Spacing();

			// --- scrolling content ---
			// borderless children skip WindowPadding by default; force it so
			// text keeps a margin from the panel edges
			ImGui::BeginChild("##panelscroll", ImVec2(0, 0), false,
				ImGuiWindowFlags_AlwaysUseWindowPadding);
			// Quadrants, then the map, then the device that map goes into, then
			// notes. All show even with nothing allocated: they are useful
			// before a single node is picked.
			// Each panel gets its own id namespace. Without this the astrolabe
			// quadrants and the map slots collide: both loop with PushID(index)
			// starting at 0 and both label their widgets "+##add" / "##slot", so
			// in this single child window they hash to the SAME ImGuiID. ImGui
			// requires ids to be unique per window; when they are not, the first
			// widget submitted keeps the interaction and the later one goes dead
			// — which is exactly why the map slots' + did nothing while the
			// astrolabe section was expanded, and started working once it was
			// collapsed (its buttons stop being submitted).
			ImGui::PushID("astrolabes"); renderAstrolabePanel(); ImGui::PopID();
			ImGui::PushID("mainmap");    renderMapPanel();       ImGui::PopID();
			ImGui::PushID("mapslots");   renderScarabPanel();    ImGui::PopID();
			ImGui::PushID("notes");      renderNotesPanel();     ImGui::PopID();
			ImGui::PushID("mechanics");  renderMechanicPanel();  ImGui::PopID();
			// (the map-slot picker is submitted after EndChild, below)
			bool anyAlloc = false;
			for (const auto& g : nodeGroups) anyAlloc = anyAlloc || !g.empty();
			if (!anyAlloc) {
				ImGui::Dummy(ImVec2(0, 30.0f * scale));
				ImGui::TextDisabled(u8"아직 노드를 설정하지 않았습니다.");
				ImGui::TextWrapped(u8"왼쪽 아틀라스에서 노드를 클릭해 계획을 시작하세요. 마우스 휠로 확대/축소하고 드래그로 이동합니다.");
			} else {
				if (ImGui::CollapsingHeader(u8"보너스 통계", ImGuiTreeNodeFlags_DefaultOpen)) {
					const std::vector<int>& order = (showZh && zhLoaded) ? statOrderZh : statOrderEn;
					int shown = 0;
					for (int gi : order) {
						const StatAggGroup& g = statAgg[gi];
						if (!matches(g.searchKey)) continue;
						shown++;
						const std::string& disp = (showZh && zhLoaded) ? g.dispZh : g.dispEn;
						if (g.kind == StatAggGroup::kMulti && g.count > 1) {
							ImGui::TextColored(ImVec4(0.55f, 0.80f, 0.95f, 1.0f), "x%d", g.count);
							ImGui::SameLine(0, 6.0f * scale);
						}
						ImVec4 col = g.kind == StatAggGroup::kSummed
							? ImVec4(0.72f, 0.80f, 0.98f, 1.0f)   // summed value rows pop
							: g.kind == StatAggGroup::kBoolean
							? ImVec4(0.62f, 0.67f, 0.74f, 1.0f)   // boolean effects recede
							: ImVec4(0.973f, 0.980f, 0.988f, 1.0f);
						ImGui::PushStyleColor(ImGuiCol_Text, col);
						ImGui::TextWrapped("%s", disp.c_str());
						ImGui::PopStyleColor();
					}
					if (shown == 0)
						ImGui::TextDisabled(u8"검색과 일치하는 통계가 없습니다.");
					ImGui::Spacing();
				}
				if (ImGui::CollapsingHeader(u8"노드 목록", ImGuiTreeNodeFlags_DefaultOpen)) {
					for (int r = 0; r < 4; r++) {
						if (nodeGroups[r].empty()) continue;
						int m = 0;
						for (const PanelNode& p : nodeGroups[r])
							if (matches(p.searchKey)) m++;
						if (m == 0 && !needle.empty()) continue;
						// group header: 4px color bar (DrawList; the font atlas
						// has no "●" glyph) + name + count
						ImDrawList* pdl = ImGui::GetWindowDrawList();
						ImVec2 hp = ImGui::GetCursorScreenPos();
						float lh = ImGui::GetTextLineHeight();
						pdl->AddRectFilled(ImVec2(hp.x, hp.y + lh * 0.20f),
							ImVec2(hp.x + 4.0f * scale, hp.y + lh * 0.95f),
							ImGui::GetColorU32(kKindCol[r]), 2.0f * scale);
						ImGui::Dummy(ImVec2(9.0f * scale, 0));
						ImGui::SameLine(0, 0);
						if (needle.empty())
							ImGui::TextDisabled("%s (%d)", kGroupName[r], (int)nodeGroups[r].size());
						else
							ImGui::TextDisabled("%s (%d/%d)", kGroupName[r], m, (int)nodeGroups[r].size());
						ImGui::Indent(10.0f * scale);
						for (const PanelNode& p : nodeGroups[r]) {
							if (!matches(p.searchKey)) continue;
							const AtlasNode& n = tree.nodes[p.idx];
							const std::string& nm = showZh && zhLoaded ? i18n.NodeName(n.id, n.name) : n.name;
							ImGui::PushID(p.idx); // duplicate display names exist
							ImGui::PushStyleColor(ImGuiCol_Text, kKindCol[r]);
							if (ImGui::Selectable(nm.empty() ? u8"(이름 없음)" : nm.c_str(), false))
								view.CenterOn(tree, p.idx);
							ImGui::PopStyleColor();
							if (ImGui::IsItemHovered()) {
								ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(16.0f * scale, 12.0f * scale));
								ImGui::SetNextWindowSizeConstraints(ImVec2(0, 0), ImVec2(460.0f * scale, FLT_MAX));
								ImGui::BeginTooltip();
								ImGui::TextColored(kKindCol[r], "%s", nm.empty() ? u8"(이름 없음)" : nm.c_str());
								// 明確 wrap 寬度,不讓短標題把 tooltip 寬度撐死(同 atlas_view drawTooltip)
								ImGui::PushTextWrapPos(380.0f * scale);
								for (const std::string& s : n.stats) {
									ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.62f, 0.68f, 0.90f, 1.0f));
									ImGui::TextUnformatted(StripStatMarkup(showZh && zhLoaded ? i18n.StatLine(s) : s).c_str());
									ImGui::PopStyleColor();
								}
								ImGui::PopTextWrapPos();
								ImGui::TextDisabled(u8"목록을 클릭하면 아틀라스의 해당 위치로 이동합니다.");
								ImGui::EndTooltip();
								ImGui::PopStyleVar();
							}
							ImGui::PopID();
						}
						ImGui::Unindent(10.0f * scale);
						ImGui::Spacing();
					}
				}
			}
			ImGui::EndChild();
			} // end normal side panel (else branch of compareMode)
			ImGui::EndChild();
		}

		// Outside every child: a popup submitted inside one gets clipped to it,
		// and this one is wide enough to be flipped clean out of the panel.
		renderScarabPicker();

		// Escape dismisses an ImGui modal, and only the prompt's buttons resolve a
		// close. Without this a dismissed prompt would leave the panel permanently
		// "asking": unclosable, and blocking the launcher's own shutdown.
		if (close_ == ToolCloseState::Asking && !planningAskExit &&
		    !ImGui::IsPopupOpen(u8"계획 종료"))
			close_ = ToolCloseState::Cancelled;
	}

	// The one place this panel may block; the host calls it after the frame is on
	// screen and after the docked windows have been hidden.
	void RunDeferred() override
	{
		const ApDialog want = pendingDialog_;
		pendingDialog_ = ApDialog::None;
		HWND owner = (HWND)(host_ ? host_->hostHwnd : nullptr);
		switch (want) {
			case ApDialog::None:
				break;
			case ApDialog::ImportSeasonData:
				importSeasonFrom(OpenDataJsonDialog(owner));
				break;
			case ApDialog::ExportBuild: {
				std::wstring path = SaveBuildJsonDialog(owner, pendingExportName_);
				if (!path.empty()) {
					bool ok = PlannerWriteFile(path, AtlasExportJson(buildFile.Active(), tree.Version()));
					importMsg = ok ? u8"프로젝트를 내보냈습니다." : u8"내보내기 파일을 쓰지 못했습니다.";
					importFailed = !ok;
				}
				break;
			}
			case ApDialog::ImportBuild: {
				std::wstring path = OpenBuildJsonDialog(owner);
				if (!path.empty()) {
					std::string body, perr;
					AtlasBuildEntry e;
					if (PlannerReadFile(path, body) && AtlasParseExportJson(body, &e, &perr)) {
						importEntry(e);
					} else {
						importMsg = perr.empty() ? u8"가져오기 파일을 읽을 수 없습니다." : perr;
						importFailed = true;
					}
				}
				break;
			}
		}
	}

	ToolCloseState RequestClose() override
	{
		if (close_ == ToolCloseState::Asking) return close_;
		// Closing mid-plan must not silently drop the sandbox work and must not
		// silently keep it either -- the same prompt the 結束規劃 button raises.
		if (ready && planningMode) { planningAskExit = true; close_ = ToolCloseState::Asking; }
		else close_ = ToolCloseState::Closed;
		return close_;
	}
	ToolCloseState CloseState() const override { return close_; }
	void AbortClose() override
	{
		if (close_ == ToolCloseState::Closed) close_ = ToolCloseState::Open;
	}

	void Shutdown() override
	{
		if (shutdown_) return;
		shutdown_ = true;
		updater.Shutdown();     // cancels any in-flight download, joins the worker
		icons.Shutdown();       // joins the icon worker, deletes its textures (GL thread)
		view.DestroyTextures(); // while the GL context is still current
	}

	~AtlasPlannerPanel() override { Shutdown(); }

	PobUi::Density Density() const override { return PobUi::Density::Canvas; }
	const char* PanelId() const override { return "atlas"; }

private:
	// The 結束規劃 prompt is raised two ways -- the toolbar button (stay in the
	// tool) and a close request (leave once it is answered). Only the second has a
	// close to resolve, so the answer alone cannot decide it.
	void finishPlanningPrompt(bool answered)
	{
		if (close_ != ToolCloseState::Asking) return;
		close_ = answered ? ToolCloseState::Closed : ToolCloseState::Cancelled;
	}

	// --- data + view ---
	AtlasTreeData tree;
	AtlasView view;
	std::string loadErr;
	// Multi-project build file: the in-memory copy is the single source of
	// truth while the planner is open; every save funnels through saveActive.
	AtlasBuildFile buildFile;

	// Scarab catalogue + icon fetcher. Both are optional: a missing
	// Data/scarabs_poe1.json hides the section (and makes Sanitize a no-op, so a
	// saved scarab list survives untouched), and no network just means no icons.
	ScarabDb scarabDb;
	std::string scarabErr;

	// Astrolabes (3.29 Shaped Regions, one per atlas quadrant) and the map
	// catalogue behind the project's main-map pick. Optional on exactly the same
	// terms as the scarabs: absent data hides the section and turns Sanitize
	// into a no-op rather than erasing what the user saved.
	AstrolabeDb astroDb;
	std::string astroErr;
	AtlasMapDb mapDb;
	std::string mapErr;


	IconManager icons;

	std::string nameBuf; // shared by the new/rename project modals

	// --- persisted UI state (panel width + last viewed season) ---
	AtlasUiState uiState;
	float panelW = -1.0f; // sentinel: initialized on the first frame (needs DisplaySize)

	// --- version registry: which seasons are installed, which one is shown ---
	AtlasVersionIndex verIndex;
	// Load() repairs the index against the season folders actually on disk (the
	// packaged atlas_index.json overwrites the user's on every app update). Write
	// the repair back once so it sticks.
	// viewTag = the season currently on the canvas (persisted choice, else active)
	std::string viewTag;   // assigned in Init(), from uiState + verIndex

	int startupDropped = 0;  // nodes lost because the saved build predates this season
	bool ready = false;      // set by the initial loadSeason() below
	std::string importMsg;   // last import result shown in the toolbar
	bool importFailed = false;

	// The newest installed season is canonical (the one the build persists for);
	// an older-season view is a read-only preview.
	bool onCanonicalSeason()
	{
		return verIndex.Active().empty() || viewTag == verIndex.Active();
	}
	// Capture the allocation only on the canonical season, so a preview of an
	// older season never prunes it back to that season's subset. The file is
	// still written either way: notes and scarabs are season-independent, and
	// before they existed an edit made while previewing was simply lost.
	// Set while the sandbox planning mode is open. saveActive() checks it, so
	// there is exactly ONE place that can write during planning: nowhere.
	bool planningMode = false;
	void saveActive()
	{
		if (planningMode) return;   // sandbox: never touch the file
		if (onCanonicalSeason()) {
			buildFile.Active().alloc = tree.AllocIds();
			buildFile.Active().targets = tree.TargetIds();
			buildFile.Active().blocked = tree.BlockedIds();
			buildFile.version = tree.Version();
		}
		buildFile.Save(exeDir);
	}

	AtlasUndo undo, frameStart;
	void snapshot(AtlasUndo& u)
	{
		u.valid = true;
		u.alloc = tree.AllocIds();
		u.targets = tree.TargetIds();
		u.blocked = tree.BlockedIds();
	}

	// --- sandbox planning mode ---
	// Entering starts from a blank slate so several core nodes can be marked
	// quickly; leaving asks whether to keep the result. NOTHING is written to
	// the build file while planning, so abandoning a session is guaranteed to
	// leave the project byte-identical -- that is the whole point of the mode.
	bool planningAskExit = false;      // the save/discard prompt is up
	AtlasUndo planSnapshot;            // state captured on entry
	void enterPlanning()
	{
		snapshot(planSnapshot);
		tree.Reset();                  // clears alloc, targets and blocked
		planningMode = true;
		planningAskExit = false;
	}
	void restorePlanning()
	{
		tree.ApplyAllocIds(planSnapshot.alloc);
		tree.ApplyTargetIds(planSnapshot.targets);
		tree.ApplyBlockedIds(planSnapshot.blocked);
		planningMode = false;
		planningAskExit = false;
		undo.valid = false;            // undo does not straddle the sandbox
	}
	void keepPlanning()
	{
		planningMode = false;
		planningAskExit = false;
		undo = planSnapshot;           // one step back = "before I started planning"
		saveActive();
	}

	// On-demand minimum-point compression.
	//
	// This used to run inside every click: the allocation was re-derived from the
	// target set each time, which is minimal but re-routes paths the user already
	// walked -- clicking a second node visibly scrambles the first one's route,
	// and it compounds. Clicking is now plain shortest-path (atlas_view.cpp), and
	// minimality is a button you press when you want it.
	//
	// What gets pinned is deliberately conservative: the user's own picks UNION
	// every notable / keystone / leaf (AtlasInferTargets). So compression can
	// only ever delete redundant wiring -- it can never cost you a big node or an
	// endpoint, which is the failure a one-way "make it smaller" button must not
	// have. Undo covers it either way.
	int compressFrom = 0, compressTo = 0;
	std::vector<int> compressTargets()
	{
		std::vector<int> t = tree.TargetIdx();
		for (int i : AtlasInferTargets(tree))
			if (std::find(t.begin(), t.end(), i) == t.end()) t.push_back(i);
		return t;
	}
	// Solved only when the button is actually pressed -- a Steiner solve is far
	// too heavy to run once per frame just to grey out a button, and "press it
	// and be told it is already minimal" is a perfectly good answer.
	bool applyCompress(std::string& msg)
	{
		std::vector<int> targets = compressTargets();
		AtlasPlan p = AtlasPlanMinimal(tree, targets, tree.BlockedIdx(), tree.AllocIdx());
		if (!p.ok()) {
			msg = u8"'제외'로 표시한 노드가 경로를 막아 연결할 수 없으므로 압축하지 못했습니다.";
			return false;
		}
		if (p.points >= tree.UsedPoints()) {
			msg = u8"이미 최소 포인트 경로입니다(" + std::to_string(tree.UsedPoints()) + u8"포인트).";
			return false;
		}
		snapshot(undo);
		compressFrom = tree.UsedPoints();
		compressTo = p.points;
		tree.SetAllocSet(p.nodes);
		for (AtlasNode& nd : tree.nodes) nd.target = false;
		for (int t : targets)
			if (t >= 0 && t < (int)tree.nodes.size()) tree.nodes[t].target = true;
		saveActive();
		msg = u8"압축 완료: " + std::to_string(compressFrom) + u8" → " + std::to_string(compressTo) +
		      u8"포인트(Ctrl+Z로 되돌리기 가능)";
		if (!p.exact) msg += u8"(근삿값)";
		return true;
	}

	// --- league-mechanic overlay ---------------------------------------------
	// "Where else is 裂痕?" -- clicking a cluster's mastery icon, or a row in the
	// side panel, rings every node of that mechanic across the whole atlas. The
	// per-season map is written next to the tree by the importer/updater; when a
	// season predates the feature the db borrows the newest one it can find and
	// says so. Purely a view: it never touches the allocation.
	AtlasMechanicDb mechDb;
	std::string mechSel;                                   // selected mechanic id ("" = none)
	std::vector<std::pair<std::string, std::vector<int>>> mechNodeIdx;   // id -> node indices
	std::vector<std::pair<std::string, std::vector<int>>> mechMastIdx;   // id -> mastery indices
	static const std::vector<int>* mechFind(const std::vector<std::pair<std::string, std::vector<int>>>& v,
	                                       const std::string& id)
	{
		for (const auto& kv : v)
			if (kv.first == id) return &kv.second;
		return nullptr;
	}
	void applyMechHighlight()
	{
		const std::vector<int>* n = mechSel.empty() ? nullptr : mechFind(mechNodeIdx, mechSel);
		const std::vector<int>* m = mechSel.empty() ? nullptr : mechFind(mechMastIdx, mechSel);
		if (!n && !m) { view.ClearMechanicHighlight(); return; }
		view.SetMechanicHighlight(n ? *n : std::vector<int>(), m ? *m : std::vector<int>());
	}
	// Resolve the season's mechanic map onto THIS tree's node indices. Ids that
	// the season does not have simply do not resolve; nothing is invented.
	void reloadMechanics()
	{
		mechNodeIdx.clear();
		mechMastIdx.clear();
		mechDb.Load(exeDir, viewTag);
		std::unordered_map<int, int> idxById;
		for (int i = 0; i < (int)tree.nodes.size(); i++) idxById[tree.nodes[i].id] = i;
		for (const AtlasMechanicDb::Entry& e : mechDb.Entries()) {
			std::vector<int> idx;
			for (int id : e.nodeIds) {
				auto it = idxById.find(id);
				if (it != idxById.end()) idx.push_back(it->second);
			}
			if (!idx.empty()) mechNodeIdx.emplace_back(e.def->id, std::move(idx));
		}
		// Mastery icons carry the English mechanic name, which is the catalogue's
		// join key -- the same key the generator used, so this cannot drift.
		std::vector<std::string> labels(tree.masteries.size());
		for (int i = 0; i < (int)tree.masteries.size(); i++) {
			const AtlasMechanicDef* d = AtlasMechanicByEn(tree.masteries[i].name);
			if (!d) continue;
			labels[i] = d->zh;
			bool found = false;
			for (auto& kv : mechMastIdx)
				if (kv.first == d->id) { kv.second.push_back(i); found = true; break; }
			if (!found) mechMastIdx.emplace_back(d->id, std::vector<int>{ i });
		}
		view.SetMasteryLabels(std::move(labels));
		if (!mechSel.empty() && !mechFind(mechNodeIdx, mechSel)) mechSel.clear();
		applyMechHighlight();
	}

	// --- zh display layer + background auto updater ---
	AtlasI18n i18n;
	bool zhLoaded = false;
	bool showZh = false;                 // set after the first season load
	AtlasUpdater updater;

	// (Re)load a season's tree + zh + textures onto the canvas, re-apply the
	// build (by GGG id), and backfill Chinese for value-only changes from the
	// previous season (same wording, adjusted number -> reuse old zh with the new
	// value; changed wording -> keep the new English).
	void loadSeason(const std::string& tag)
	{
		viewTag = tag;
		startupDropped = 0;
		ready = tree.LoadVersion(exeDir, tag, &loadErr);
		if (!ready) {
			// The season's tree is the planner: without it the whole tab is a
			// message. Nothing else records which season failed or why.
			PobLog::Error("data", "atlas season " + tag + " failed to load: " + loadErr);
		}
		if (ready) {
			int mapped = tree.ApplyAllocIds(buildFile.Active().alloc);
			tree.ApplyTargetIds(buildFile.Active().targets);   // must follow ApplyAllocIds
			tree.ApplyBlockedIds(buildFile.Active().blocked);
			if (!buildFile.version.empty() && buildFile.version != tree.Version())
				startupDropped = (int)buildFile.Active().alloc.size() - mapped;
			zhLoaded = i18n.LoadVersion(exeDir, tag);
			std::string older = verIndex.OlderThan(tag);
			if (zhLoaded && !older.empty()) {
				AtlasTreeData ot;
				AtlasI18n oi;
				std::string e;
				if (ot.LoadVersion(exeDir, older, &e) && oi.LoadVersion(exeDir, older)) {
					// zh built from a repoe older than the season: whatever got
					// paired to this season's NEW/CHANGED lines is a translation
					// of the old wording -> drop those (fall back to English) and
					// the stale names of renamed nodes. Unchanged lines keep zh.
					bool zhLags = !i18n.RepoeVersion().empty() &&
					              AtlasVersionIndex::CompareSemver(i18n.RepoeVersion(), tag) < 0;
					if (zhLags) {
						PruneStaleTranslations(i18n, tree, ot);
						DropRenamedNames(i18n, tree, ot);
					}
					BackfillAtlasI18n(i18n, tree, oi, ot); // unchanged lines repoe missed
				}
			}
			ready = view.LoadTextures(exeDir, tree, &loadErr);
			reloadMechanics();
		}
	}

	// initial load of the chosen season

	// --- version-compare state ---
	// The pair being compared is USER-CHOSEN, not fixed to compareBase -> active:
	// with every revision of the current league retained (3.29.0 alongside
	// 3.29.1), "what did GGG change mid-league?" is a question about two
	// revisions of the same league, which a fixed previous-league base could
	// never answer. Defaults to compareBase -> active.
	bool compareMode = false;
	AtlasTreeDiff diff;
	bool diffReady = false;
	std::string diffErr;
	char diffSearch[256] = "";
	std::string cmpBase, cmpTarg;               // chosen seasons; empty = use the defaults
	std::unordered_map<int, int> activeIdxById; // GGG id -> displayed-tree node index

	// --- right-hand summary panel ---
	// Stat rows are value-aggregated (atlas_stat_agg); nodes are grouped by
	// kind. Everything display-related (en/zh strings, both sort orders, the
	// search keys) is cached here so F2 language flips never rebuild.
	std::vector<StatAggGroup> statAgg;
	std::vector<int> statOrderEn, statOrderZh;
	std::vector<PanelNode> nodeGroups[4]; // keystone / wormhole / notable / small
	char panelSearch[256] = "";
	bool panelDirty = true;
	void rebuildPanel()
	{
		statAgg.clear();
		statOrderEn.clear();
		statOrderZh.clear();
		for (auto& g : nodeGroups) g.clear();
		auto rank = [](int kind) {
			return kind == kAtlasKeystone ? 0 : kind == kAtlasWormhole ? 1 : kind == kAtlasNotable ? 2 : 3;
		};
		std::unordered_map<std::string, size_t> pos;
		for (int i = 0; i < (int)tree.nodes.size(); i++) {
			const AtlasNode& n = tree.nodes[i];
			if (!n.alloc || n.kind == kAtlasStart) continue;
			const std::string& zhName = zhLoaded ? i18n.NodeName(n.id, n.name) : n.name;
			nodeGroups[rank(n.kind)].push_back({ i, ToLowerAscii(n.name + "\n" + zhName) });
			for (const std::string& s : n.stats)
				AccumulateStatLine(s, statAgg, pos);
		}
		std::function<std::string(const std::string&)> zhFn =
			[&](const std::string& en) { return i18n.StatLine(en); };
		BuildStatAggDisplay(statAgg, zhLoaded ? &zhFn : nullptr);
		statOrderEn.resize(statAgg.size());
		std::iota(statOrderEn.begin(), statOrderEn.end(), 0);
		statOrderZh = statOrderEn;
		std::sort(statOrderEn.begin(), statOrderEn.end(), [&](int a, int b) {
			return statAgg[a].dispEn != statAgg[b].dispEn ? statAgg[a].dispEn < statAgg[b].dispEn : a < b;
		});
		std::sort(statOrderZh.begin(), statOrderZh.end(), [&](int a, int b) {
			return statAgg[a].dispZh != statAgg[b].dispZh ? statAgg[a].dispZh < statAgg[b].dispZh : a < b;
		});
		for (auto& g : nodeGroups)
			std::sort(g.begin(), g.end(), [&](const PanelNode& a, const PanelNode& b) {
				return tree.nodes[a.idx].name < tree.nodes[b.idx].name;
			});
	}

	// --- astrolabe section (one Shaped Region per atlas quadrant) ---
	// Above the scarabs on purpose: an astrolabe covers a whole quadrant, a
	// scarab covers the one map you are about to open.
	char astroSearch[256] = "";
	const std::vector<std::string>& astroLines(const AstrolabeDef& d)
	{
		// One list or the other, never a line from each.
		return (showZh && !d.descZh.empty()) ? d.descZh : d.descEn;
	}
	const std::string& astroName(const AstrolabeDef& d)
	{
		return (showZh && !d.zh.empty()) ? d.zh : d.en;
	}
	// The compass label is OURS. AtlasRegions ships an Id and no name column, so
	// the only official Traditional Chinese string for a quadrant is its Memory
	// Vault's area name — shown in parentheses so the invented part and the
	// official part stay visibly separate. (Compare the scarab families, where
	// no Chinese name was invented at all; the difference is that a quadrant has
	// to be addressable here, so it needs some label.)
	std::string quadrantLabel(const AtlasQuadrant& q)
	{
		std::string compass = q.id;
		if (showZh) {
			if (q.id == "NorthWest") compass = u8"북서";
			else if (q.id == "NorthEast") compass = u8"북동";
			else if (q.id == "SouthEast") compass = u8"남동";
			else if (q.id == "SouthWest") compass = u8"남서";
		}
		const std::string& vault = (showZh && !q.vaultZh.empty()) ? q.vaultZh : q.vaultEn;
		return vault.empty() ? compass : compass + u8"(" + vault + u8")";
	}

	void renderAstrolabePanel()
	{
		AtlasBuildEntry& b = buildFile.Active();
		if (!astroDb.available()) {
			if (ImGui::CollapsingHeader(u8"아스트롤라베")) {
				ImGui::TextWrapped(u8"아스트롤라베 데이터를 불러오지 못했습니다: %s", astroErr.c_str());
				ImGui::TextDisabled(u8"저장된 아스트롤라베 설정은 변경되지 않습니다.");
			}
			return;
		}
		std::string hdr = u8"아스트롤라베 (" + std::to_string(b.astrolabes.size()) + "/" +
		                  std::to_string(astroDb.Regions().size()) + ")###astrohdr";
		if (!ImGui::CollapsingHeader(hdr.c_str(), ImGuiTreeNodeFlags_DefaultOpen)) return;

		ImGui::TextDisabled(u8"각 반구에는 아스트롤라베를 하나만 배치할 수 있습니다.");
		const float slot = 38.0f * scale;
		int regionIdx = 0;
		for (const AtlasQuadrant& q : astroDb.Regions()) {
			ImGui::PushID(regionIdx++);
			// Which astrolabe (if any) sits on this quadrant.
			const AstrolabePlacement* placed = nullptr;
			for (const AstrolabePlacement& p : b.astrolabes)
				if (p.region == q.id) { placed = &p; break; }
			const AstrolabeDef* def = placed ? astroDb.ById(placed->id) : nullptr;

			const ImVec2 fp = ImGui::GetStyle().FramePadding;
			bool clicked = false;
			if (def) {
				icons.RequestPath(def->art);
				unsigned tex = icons.TextureByPath(def->art);
				clicked = tex
					? ImGui::ImageButton("##slot", (ImTextureID)(intptr_t)tex, ImVec2(slot, slot))
					: ImGui::Button("...", ImVec2(slot + fp.x * 2, slot + fp.y * 2));
			} else {
				clicked = ImGui::Button("+##add", ImVec2(slot + fp.x * 2, slot + fp.y * 2));
			}
			if (clicked) {
				if (def) {
					// Clicking a filled slot clears that quadrant.
					for (size_t i = 0; i < b.astrolabes.size(); i++)
						if (b.astrolabes[i].region == q.id) { b.astrolabes.erase(b.astrolabes.begin() + i); break; }
					saveActive();
				} else {
					astroSearch[0] = '\0';
					ImGui::OpenPopup(u8"아스트롤라베 선택");
				}
			}
			if (def && ImGui::IsItemHovered()) {
				ImGui::SetTooltip(u8"클릭하여 제거");
			}

			// One picker per quadrant; the PushID above keeps their ids apart.
			if (ImGui::BeginPopup(u8"아스트롤라베 선택")) {
				ImGui::TextDisabled("%s", quadrantLabel(q).c_str());
				ImGui::SetNextItemWidth(320.0f * scale);
				if (ImGui::IsWindowAppearing()) ImGui::SetKeyboardFocusHere();
				ImGui::InputTextWithHint("##astrosearch", u8"이름 또는 효과 검색(한국어/영어, 퍼지 검색)...",
					astroSearch, sizeof(astroSearch), ImGuiInputTextFlags_EscapeClearsAll);
				FuzzyQuery q2 = MakeFuzzyQuery(astroSearch);

				std::vector<std::pair<int, const AstrolabeDef*>> hits;
				for (const AstrolabeDef& d : astroDb.All()) {
					int s = astroDb.MatchScore(d, q2);
					if (s > 0) hits.push_back({ s, &d });
				}
				if (!q2.empty())
					std::stable_sort(hits.begin(), hits.end(),
						[](const auto& x, const auto& y) {
							if (x.first != y.first) return x.first > y.first;
							return x.second->zh.size() < y.second->zh.size();
						});
				ImGui::TextDisabled(u8"%d종 · %s", (int)hits.size(), astroDb.Source().c_str());

				ImGui::BeginChild("##astrolist", ImVec2(420.0f * scale, 300.0f * scale));
				for (size_t k = 0; k < hits.size(); k++) {
					const AstrolabeDef& d = *hits[k].second;
					ImGui::PushID((int)k);
					icons.RequestPath(d.art);
					unsigned tex = icons.TextureByPath(d.art);
					float sz = ImGui::GetTextLineHeight() * 1.4f;
					if (tex) ImGui::Image((ImTextureID)(intptr_t)tex, ImVec2(sz, sz));
					else     ImGui::Dummy(ImVec2(sz, sz));
					ImGui::SameLine();
					if (ImGui::Selectable(astroName(d).c_str())) {
						// The slot was empty, so CanPlace can only refuse on data
						// the catalogue does not know; check anyway rather than
						// trusting the UI state.
						if (astroDb.CanPlace(b.astrolabes, q.id, d.id).ok()) {
							b.astrolabes.push_back({ q.id, d.id });
							saveActive();
						}
						ImGui::CloseCurrentPopup();
					}
					if (ImGui::IsItemHovered()) {
						ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding,
							ImVec2(14.0f * scale, 10.0f * scale));
						ImGui::BeginTooltip();
						ImGui::TextColored(PobUi::Accent(), "%s", astroName(d).c_str());
						ImGui::PushTextWrapPos(360.0f * scale);
						for (const std::string& s : astroLines(d))
							ImGui::TextUnformatted(StripStatMarkup(s).c_str());
						ImGui::PopTextWrapPos();
						if (!d.enabled)
							ImGui::TextDisabled(u8"(이번 시즌에는 활성화되지 않아 거래소에도 없습니다.)");
						ImGui::EndTooltip();
						ImGui::PopStyleVar();
					}
					ImGui::PopID();
				}
				ImGui::EndChild();
				ImGui::EndPopup();
			}

			ImGui::SameLine();
			ImGui::BeginGroup();
			ImGui::TextDisabled("%s", quadrantLabel(q).c_str());
			if (def) {
				ImGui::TextColored(PobUi::Accent(), "%s", astroName(*def).c_str());
			} else if (placed) {
				// Sanitize should have removed this; say so instead of drawing a blank.
				ImGui::TextDisabled(u8"알 수 없는 아스트롤라베");
			} else {
				ImGui::TextDisabled(u8"미할당");
			}
			ImGui::EndGroup();

			if (def) {
				ImGui::Indent(10.0f * scale);
				ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.72f, 0.80f, 0.98f, 1.0f));
				for (const std::string& s : astroLines(*def))
					ImGui::TextWrapped("%s", StripStatMarkup(s).c_str());
				ImGui::PopStyleColor();
				if (!def->enabled)
					ImGui::TextDisabled(u8"(이번 시즌에는 활성화되지 않았습니다.)");
				ImGui::Unindent(10.0f * scale);
			}
			ImGui::PopID();
		}
		ImGui::Spacing();
	}

	// --- main map section (one per project) ---
	char mapSearch[256] = "";
	// The two dropdowns are INDEPENDENT, and deliberately not modelled on the
	// game's own data: once a quadrant's Voidstone is socketed, every map in that
	// quadrant becomes T16, so a map's shipped tier says nothing about the tier
	// it will actually be run at. Filtering the name list by it would hide maps
	// the user can legitimately pick. So the tier dropdown records the PLAN and
	// the name dropdown always offers every map.
	const int kMapTierUnique = 99;
	const std::string& mapPrimaryName(const AtlasMapDef& d)
	{
		// The atlas shows the AREA name, so that is what the planner leads with.
		return showZh ? d.zhArea : d.enArea;
	}
	const std::string& mapSecondName(const AtlasMapDef& d)
	{
		return showZh ? d.zhItem : d.enItem;
	}
	std::string mapRegionLabel(const std::string& regionId)
	{
		const AtlasQuadrant* q = astroDb.RegionById(regionId);
		return q ? quadrantLabel(*q) : regionId;
	}
	// A map's own tier, shown only as a hint in the tooltip — never as the label,
	// so it cannot be mistaken for the tier the project plans to run.
	std::string mapOwnTierLabel(const AtlasMapDef& d)
	{
		if (d.kind == AtlasMapDef::kUnique) return std::string(showZh ? u8"고유" : "unique");
		return d.tier > 0 ? "T" + std::to_string(d.tier) : std::string("-");
	}
	std::string mapTierLabel(int t)
	{
		if (t == 0) return std::string(showZh ? u8"미지정" : "unset");
		if (t == kMapTierUnique) return std::string(showZh ? u8"고유 맵" : "unique");
		return "T" + std::to_string(t);
	}
	// Endgame is almost entirely run at the top tier, so an unset project shows
	// that as its starting point. Only a deliberate pick is written to the file:
	// this is display-only until the user touches something.
	int plannedTier()
	{
		int t = buildFile.Active().mapTier;
		if (t > 0) return t;
		return mapDb.TiersPresent().empty() ? 0 : mapDb.TiersPresent().back();
	}

	void renderMapPanel()
	{
		AtlasBuildEntry& b = buildFile.Active();
		if (!mapDb.available()) {
			if (ImGui::CollapsingHeader(u8"주력 지도")) {
				ImGui::TextWrapped(u8"지도 데이터를 불러오지 못했습니다: %s", mapErr.c_str());
				ImGui::TextDisabled(u8"저장된 지도 설정은 변경되지 않습니다.");
			}
			return;
		}
		if (!ImGui::CollapsingHeader(u8"주력 지도", ImGuiTreeNodeFlags_DefaultOpen)) return;

		const AtlasMapDef* cur = b.mapId.empty() ? nullptr : mapDb.ById(b.mapId);
		if (cur) {
			const float sz = 28.0f * scale;
			icons.RequestPath(cur->art);
			unsigned tex = icons.TextureByPath(cur->art);
			if (tex) {
				ImGui::Image((ImTextureID)(intptr_t)tex, ImVec2(sz, sz));
				ImGui::SameLine();
			}
			ImGui::BeginGroup();
			// The PLANNED tier leads, then the name — two separate facts, and the
			// eye should not have to split a sentence to read them.
			ImGui::TextColored(ImVec4(0.55f, 0.80f, 0.95f, 1.0f), "%s", mapTierLabel(plannedTier()).c_str());
			ImGui::SameLine(0, 8.0f * scale);
			ImGui::TextColored(PobUi::Accent(), "%s", mapPrimaryName(*cur).c_str());
			std::string sub;
			const std::string& item = mapSecondName(*cur);
			if (!item.empty() && item != mapPrimaryName(*cur)) sub = item + u8" · ";
			sub += mapRegionLabel(cur->region);
			ImGui::TextDisabled("%s", sub.c_str());
			ImGui::EndGroup();
		} else {
			ImGui::TextDisabled(u8"선택되지 않았습니다.");
		}

		// --- two INDEPENDENT dropdowns: the tier to run at, and which map ---
		ImGui::TextDisabled(u8"등급");
		ImGui::SameLine();
		ImGui::SetNextItemWidth(110.0f * scale);
		if (ImGui::BeginCombo("##maptier", mapTierLabel(plannedTier()).c_str())) {
			// Only tiers this season actually ships get an entry (AtlasMapDb
			// derives the list from the data, so a season with a different tier
			// range needs no code change).
			for (int t : mapDb.TiersPresent())
				if (ImGui::Selectable(mapTierLabel(t).c_str(), plannedTier() == t)) {
					b.mapTier = t;
					saveActive();
				}
			if (ImGui::Selectable(mapTierLabel(kMapTierUnique).c_str(),
			                      plannedTier() == kMapTierUnique)) {
				b.mapTier = kMapTierUnique;
				saveActive();
			}
			ImGui::EndCombo();
		}

		ImGui::SameLine();
		ImGui::TextDisabled(u8"지도");
		ImGui::SameLine();
		ImGui::SetNextItemWidth(-FLT_MIN);
		const char* namePreview = cur ? mapPrimaryName(*cur).c_str() : u8"지도를 선택하세요...";
		if (ImGui::BeginCombo("##mapname", namePreview)) {
			// EVERY map, always. The tier dropdown does not filter this list:
			// a Voidstone lifts a whole quadrant to T16, so a map's shipped tier
			// is no reason to hide it from a T16 plan.
			ImGui::SetNextItemWidth(-FLT_MIN);
			if (ImGui::IsWindowAppearing()) {
				mapSearch[0] = '\0';
				ImGui::SetKeyboardFocusHere();
			}
			ImGui::InputTextWithHint("##mapsearch", u8"지도 이름 검색...",
				mapSearch, sizeof(mapSearch), ImGuiInputTextFlags_EscapeClearsAll);
			FuzzyQuery q = MakeFuzzyQuery(mapSearch);

			std::vector<std::pair<int, const AtlasMapDef*>> hits;
			for (const AtlasMapDef& d : mapDb.All()) {
				int s = mapDb.MatchScore(d, q);
				if (s > 0) hits.push_back({ s, &d });
			}
			// With no query the natural order is by quadrant then tier, which is
			// how someone reads the atlas; a query ranks by match quality.
			if (q.empty())
				std::stable_sort(hits.begin(), hits.end(), [](const auto& x, const auto& y) {
					if (x.second->region != y.second->region) return x.second->region < y.second->region;
					if (x.second->tier != y.second->tier) return x.second->tier < y.second->tier;
					return x.second->enArea < y.second->enArea;
				});
			else
				std::stable_sort(hits.begin(), hits.end(), [](const auto& x, const auto& y) {
					if (x.first != y.first) return x.first > y.first;
					return x.second->enArea.size() < y.second->enArea.size();
				});

			ImGui::TextDisabled(u8"%d개", (int)hits.size());
			ImGui::BeginChild("##maplist", ImVec2(340.0f * scale, 320.0f * scale));
			ImGuiListClipper clip;
			clip.Begin((int)hits.size());
			while (clip.Step()) {
				for (int k = clip.DisplayStart; k < clip.DisplayEnd; k++) {
					const AtlasMapDef& d = *hits[k].second;
					ImGui::PushID(k);
					// The name alone. The map's own tier goes in the tooltip, not
					// the label — showing it beside a planned tier of T16 would
					// read as a contradiction rather than as extra information.
					if (ImGui::Selectable(mapPrimaryName(d).c_str(), d.id == b.mapId)) {
						b.mapId = d.id;
						saveActive();
						ImGui::CloseCurrentPopup();
					}
					if (ImGui::IsItemHovered()) {
						std::string tip = mapRegionLabel(d.region) +
							u8" · 기본 등급 " + mapOwnTierLabel(d);
						const std::string& item = mapSecondName(d);
						if (!item.empty() && item != mapPrimaryName(d)) tip = item + u8" · " + tip;
						ImGui::SetTooltip("%s", tip.c_str());
					}
					ImGui::PopID();
				}
			}
			ImGui::EndChild();
			ImGui::EndCombo();
		}

		if (cur && ImGui::Button(u8"지우기")) {
			b.mapId.clear();
			saveActive();
		}
		ImGui::Spacing();
	}

	// --- scarab section (map device) ---
	// Kept beside the atlas stats but never merged into them: these are map
	// modifiers, not passive bonuses, and their numbers do not add up with the
	// tree's. The picker filters on en+zh and only asks for the icons of the
	// rows actually on screen, so opening it does not queue 130 downloads.
	char scarabSearch[256] = "";
	bool openScarabPicker = false;   // set inside the panel, acted on outside it
	const std::vector<std::string>& scarabLines(const ScarabDef& d)
	{
		// One list or the other, never a line from each: a Description cell can
		// split into a different number of lines per locale.
		return (showZh && !d.descZh.empty()) ? d.descZh : d.descEn;
	}
	const std::string& scarabName(const ScarabDef& d)
	{
		return (showZh && !d.zh.empty()) ? d.zh : d.en;
	}
	std::string scarabRefuseText(const ScarabAddResult& r)
	{
		switch (r.code) {
		case ScarabAdd::kFull:
			return u8"지도 장치에는 갑충석을 최대 " + std::to_string(kMaxScarabs) + u8"개까지 넣을 수 있습니다.";
		case ScarabAdd::kOverLimit:
			return u8"이 갑충석은 최대 " + std::to_string(r.limit) + u8"개까지 넣을 수 있습니다.";
		case ScarabAdd::kFamilyConflict:
			return (r.conflict ? scarabName(*r.conflict) : std::string("?")) + u8"과(와) 동시에 사용할 수 없습니다.";
		default:
			return u8"이 갑충석은 현재 데이터에 없습니다.";
		}
	}

	void renderScarabPanel()
	{
		AtlasBuildEntry& b = buildFile.Active();
		if (!scarabDb.available()) {
			if (ImGui::CollapsingHeader(u8"갑충석")) {
				ImGui::TextWrapped(u8"갑충석 데이터를 불러오지 못했습니다: %s", scarabErr.c_str());
				ImGui::TextDisabled(u8"저장된 갑충석 설정은 변경되지 않습니다.");
			}
			return;
		}
		std::string hdr = u8"갑충석 (" + std::to_string(b.scarabs.size()) + "/" +
		                  std::to_string(kMaxScarabs) + ")###scarabhdr";
		if (!ImGui::CollapsingHeader(hdr.c_str(), ImGuiTreeNodeFlags_DefaultOpen)) return;

		const float slot = 38.0f * scale;
		int removeAt = -1;
		for (int i = 0; i < kMaxScarabs; i++) {
			if (i) ImGui::SameLine(0, 6.0f * scale);
			ImGui::PushID(i);
			if (i < (int)b.scarabs.size()) {
				const ScarabDef* d = scarabDb.ById(b.scarabs[i]);
				unsigned tex = 0;
				if (d) {
					icons.RequestPath(d->art);
					tex = icons.TextureByPath(d->art);
				}
				const ImVec2 fp = ImGui::GetStyle().FramePadding;
				bool hit = tex ? ImGui::ImageButton("##slot", (ImTextureID)(intptr_t)tex, ImVec2(slot, slot))
				               : ImGui::Button(d ? "..." : "?", ImVec2(slot + fp.x * 2, slot + fp.y * 2));
				if (hit) removeAt = i;
				if (d && ImGui::IsItemHovered()) {
					ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(14.0f * scale, 10.0f * scale));
					ImGui::BeginTooltip();
					ImGui::TextColored(PobUi::Accent(), "%s", scarabName(*d).c_str());
					ImGui::PushTextWrapPos(360.0f * scale);
					for (const std::string& s : scarabLines(*d))
						ImGui::TextUnformatted(StripStatMarkup(s).c_str());
					ImGui::PopTextWrapPos();
					ImGui::TextDisabled(u8"클릭하여 제거");
					ImGui::EndTooltip();
					ImGui::PopStyleVar();
				}
			} else {
				// ImageButton adds FramePadding around the image, so a plain
				// Button needs it too or the empty slots come out smaller.
				const ImVec2 fp = ImGui::GetStyle().FramePadding;
				if (ImGui::Button("+##add", ImVec2(slot + fp.x * 2, slot + fp.y * 2))) {
					scarabSearch[0] = '\0';
					// Raised here, submitted outside the panel — see renderScarabPicker.
					openScarabPicker = true;
				}
				ImGui::PopID();
				break; // only the first empty slot is interactive
			}
			ImGui::PopID();
		}
		if (removeAt >= 0) {
			b.scarabs.erase(b.scarabs.begin() + removeAt);
			saveActive();
		}

		ImGui::Spacing();
		if (b.scarabs.empty()) {
			ImGui::TextDisabled(u8"아직 배치한 갑충석이 없습니다.");
		} else {
			for (const std::string& id : b.scarabs) {
				const ScarabDef* d = scarabDb.ById(id);
				if (!d) continue;
				ImGui::TextColored(PobUi::Accent(), "%s", scarabName(*d).c_str());
				ImGui::Indent(10.0f * scale);
				ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.72f, 0.80f, 0.98f, 1.0f));
				for (const std::string& s : scarabLines(*d))
					ImGui::TextWrapped("%s", StripStatMarkup(s).c_str());
				ImGui::PopStyleColor();
				ImGui::Unindent(10.0f * scale);
			}
		}
		ImGui::Spacing();
	}

	// Submitted OUTSIDE the scrolling panel, on purpose.
	//
	// A popup opened from inside a child window is clipped to that child. This
	// picker is ~460px wide and the + button sits near the panel's right edge,
	// so ImGui's auto-placement flips it leftwards onto the atlas canvas —
	// outside the panel's clip rect. The popup then renders nothing at all while
	// still swallowing every mouse click, so the first press on + silently opens
	// an invisible window and from then on the whole UI looks dead. Submitting it
	// in the main window means it is never clipped.
	void renderScarabPicker()
	{
		if (!scarabDb.available()) return;
		AtlasBuildEntry& b = buildFile.Active();
		if (openScarabPicker) {
			ImGui::OpenPopup(u8"갑충석 선택");
			openScarabPicker = false;
		}
		if (ImGui::BeginPopup(u8"갑충석 선택")) {
					ImGui::SetNextItemWidth(320.0f * scale);
					if (ImGui::IsWindowAppearing()) ImGui::SetKeyboardFocusHere();
					ImGui::InputTextWithHint("##scarabsearch", u8"이름 또는 효과 검색(한국어/영어, 퍼지 검색)...",
						scarabSearch, sizeof(scarabSearch), ImGuiInputTextFlags_EscapeClearsAll);
					ScarabQuery q = MakeScarabQuery(scarabSearch);

					// Rank by match quality; an empty query scores everything 1 so
					// the list keeps its natural family+tier order until you type.
					std::vector<std::pair<int, const ScarabDef*>> hits;
					for (const ScarabDef& d : scarabDb.All()) {
						int s = ScarabMatchScore(d, q);
						if (s > 0) hits.push_back({ s, &d });
					}
					if (!q.empty())
						std::stable_sort(hits.begin(), hits.end(),
							[](const auto& a, const auto& b) {
								if (a.first != b.first) return a.first > b.first;
								return a.second->zh.size() < b.second->zh.size(); // tighter name first
							});
					ImGui::TextDisabled(u8"%d종 · %s", (int)hits.size(), scarabDb.Source().c_str());

					ImGui::BeginChild("##scarablist", ImVec2(420.0f * scale, 360.0f * scale));
					std::string lastType;
					ImGuiListClipper clip;
					clip.Begin((int)hits.size());
					while (clip.Step()) {
						for (int k = clip.DisplayStart; k < clip.DisplayEnd; k++) {
							const ScarabDef& d = *hits[k].second;
							ScarabAddResult can = scarabDb.CanAdd(b.scarabs, d.id);
							ImGui::PushID(k);
							// Only rows the clipper actually emits; scrolling the
							// whole list does end up fetching all 130, but that
							// happens once and then lives in the disk cache.
							icons.RequestPath(d.art);
							unsigned tex = icons.TextureByPath(d.art);
							float sz = ImGui::GetTextLineHeight() * 1.4f;
							if (tex) ImGui::Image((ImTextureID)(intptr_t)tex, ImVec2(sz, sz));
							else     ImGui::Dummy(ImVec2(sz, sz));
							ImGui::SameLine();
							if (!can.ok()) ImGui::BeginDisabled();
							if (ImGui::Selectable(scarabName(d).c_str())) {
								b.scarabs.push_back(d.id);
								saveActive();
								ImGui::CloseCurrentPopup();
							}
							if (!can.ok()) ImGui::EndDisabled();
							if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
								ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding,
									ImVec2(14.0f * scale, 10.0f * scale));
								ImGui::BeginTooltip();
								ImGui::TextColored(PobUi::Accent(), "%s", scarabName(d).c_str());
								ImGui::PushTextWrapPos(360.0f * scale);
								for (const std::string& s : scarabLines(d))
									ImGui::TextUnformatted(StripStatMarkup(s).c_str());
								ImGui::PopTextWrapPos();
								if (d.limit > 1)
									ImGui::TextDisabled(u8"최대 %d개 배치 가능", d.limit);
								if (!d.stash)
									ImGui::TextDisabled(u8"(파편 보관함 및 거래소에 표시되지 않음)");
								if (!can.ok())
									ImGui::TextColored(PobUi::StatusColor(PobUi::StatusTone::Warning),
										"%s", scarabRefuseText(can).c_str());
								ImGui::EndTooltip();
								ImGui::PopStyleVar();
							}
							ImGui::PopID();
						}
					}
					ImGui::EndChild();
			ImGui::EndPopup();
		}
	}

	// --- project notes ---
	void renderNotesPanel()
	{
		if (!ImGui::CollapsingHeader(u8"메모")) return;
		AtlasBuildEntry& b = buildFile.Active();
		ImGui::InputTextMultiline("##notes", &b.notes,
			ImVec2(-FLT_MIN, 90.0f * scale));
		// Writing on every keystroke would hit the disk once per character.
		if (ImGui::IsItemDeactivatedAfterEdit()) saveActive();
		ImGui::Spacing();
	}

	// League mechanics: the same highlight the mastery icons drive, reachable as
	// a list so you do not have to find a cluster first. Not part of the build --
	// nothing here is saved, it is a way of reading the map.
	void renderMechanicPanel()
	{
		if (!ImGui::CollapsingHeader(u8"메커니즘")) return;
		if (mechNodeIdx.empty()) {
			ImGui::TextWrapped(u8"이번 시즌의 메커니즘 분류 데이터가 없습니다. 다시 다운로드하거나 시즌 데이터를 가져오면 생성됩니다.");
			ImGui::Spacing();
			return;
		}
		if (!mechDb.BorrowedFrom().empty())
			ImGui::TextDisabled(u8"(%s의 분류를 사용 중이므로 이번 시즌에 추가된 노드는 분류되지 않을 수 있습니다.)",
				mechDb.BorrowedFrom().c_str());
		ImGui::TextDisabled(u8"항목을 클릭하면 아틀라스에서 해당 메커니즘 위치를 모두 표시합니다. 다시 클릭하면 해제됩니다.");
		for (const auto& kv : mechNodeIdx) {
			const AtlasMechanicDef* d = AtlasMechanicById(kv.first);
			if (!d) continue;
			const std::vector<int>* mm = mechFind(mechMastIdx, kv.first);
			std::string label = (showZh && zhLoaded ? d->zh : d->en) +
			                    "###mech_" + d->id;   // stable id, label may flip language
			ImGui::PushStyleColor(ImGuiCol_Text, kv.first == mechSel
				? ImVec4(1.0f, 0.89f, 0.43f, 1.0f) : ImVec4(0.86f, 0.88f, 0.92f, 1.0f));
			bool hit = ImGui::Selectable(label.c_str(), kv.first == mechSel);
			ImGui::PopStyleColor();
			ImGui::SameLine();
			ImGui::TextDisabled("%d", (int)kv.second.size());
			if (hit) {
				mechSel = (kv.first == mechSel) ? std::string() : kv.first;
				applyMechHighlight();
				// Jump to the first cluster so a mechanic off-screen is not just
				// "nothing happened".
				if (!mechSel.empty() && mm && !mm->empty()) {
					int mi = (*mm)[0];
					// masteries are decorations, not nodes; centre on the nearest
					// node of the mechanic instead so CenterOn has something real
					int best = -1;
					float bestSq = 0.0f;
					for (int ni : kv.second) {
						float dx = tree.nodes[ni].x - tree.masteries[mi].x;
						float dy = tree.nodes[ni].y - tree.masteries[mi].y;
						float sq = dx * dx + dy * dy;
						if (best < 0 || sq < bestSq) { best = ni; bestSq = sq; }
					}
					if (best >= 0) view.CenterOn(tree, best);
				}
			}
		}
		if (mechDb.Unassigned() > 0)
			ImGui::TextDisabled(u8"그 밖의 %d개 노드는 어떤 메커니즘 그룹에도 속하지 않습니다.", mechDb.Unassigned());
		ImGui::Spacing();
	}

	// Compute the compareBase -> active season diff (data-only; independent of the
	// user's allocation). Maps every changed id to a canvas node index so the
	// panel can focus it and the overlay can ring it.
	void rebuildDiff()
	{
		diffReady = false;
		diffErr.clear();
		diff = AtlasTreeDiff();
		activeIdxById.clear();
		// Fall back to the registry's defaults until the user picks a pair, and
		// re-validate every time: an update or a prune can retire a chosen tag.
		if (cmpBase.empty() || !verIndex.Has(cmpBase)) cmpBase = verIndex.CompareBase();
		if (cmpTarg.empty() || !verIndex.Has(cmpTarg)) cmpTarg = verIndex.Active();
		std::string base = cmpBase, targ = cmpTarg;
		if (base.empty() || targ.empty()) {
			diffErr = u8"비교하려면 두 버전의 데이터가 필요합니다(현재 한 버전만 설치됨).";
			return;
		}
		if (base == targ) {
			diffErr = u8"서로 다른 버전을 선택하세요.";
			return;
		}
		AtlasTreeData bt, tt;
		std::string e;
		if (!bt.LoadVersion(exeDir, base, &e)) { diffErr = base + u8" 불러오기 실패: " + e; return; }
		if (!tt.LoadVersion(exeDir, targ, &e)) { diffErr = targ + u8" 불러오기 실패: " + e; return; }
		AtlasI18n bz, tz;
		bool hb = bz.LoadVersion(exeDir, base), ht = tz.LoadVersion(exeDir, targ);
		// same display rules as the canvas: when the zh snapshot predates the
		// season, changed lines / renamed nodes fall back to English; unchanged
		// lines keep (or backfill) their Chinese
		if (hb && ht) {
			bool zhLags = !tz.RepoeVersion().empty() &&
			              AtlasVersionIndex::CompareSemver(tz.RepoeVersion(), targ) < 0;
			if (zhLags) {
				PruneStaleTranslations(tz, tt, bt);
				DropRenamedNames(tz, tt, bt);
			}
			BackfillAtlasI18n(tz, tt, bz, bt);
		}
		diff = ComputeAtlasTreeDiff(bt, tt, hb ? &bz : nullptr, ht ? &tz : nullptr, base, targ);
		for (int i = 0; i < (int)tree.nodes.size(); i++) activeIdxById[tree.nodes[i].id] = i;
		diffReady = true;
	}

	// Ring the changed nodes on whichever season's tree is on the canvas
	// (activeIdxById is the displayed tree): added=green, removed=red, modified=
	// amber. added only maps on the newer tree, removed only on the older one, so
	// each season shows the rings that make sense for it.
	void applyDiffOverlay()
	{
		std::unordered_map<int, ImU32> rings;
		for (const AtlasNodeDiff& n : diff.added) {
			auto it = activeIdxById.find(n.id);
			if (it != activeIdxById.end()) rings[it->second] = IM_COL32(90, 220, 120, 235);
		}
		for (const AtlasNodeDiff& n : diff.removed) {
			auto it = activeIdxById.find(n.id);
			if (it != activeIdxById.end()) rings[it->second] = IM_COL32(224, 80, 80, 235);
		}
		for (const AtlasNodeDiff& n : diff.modified) {
			auto it = activeIdxById.find(n.id);
			if (it != activeIdxById.end()) rings[it->second] = IM_COL32(240, 205, 90, 235);
		}
		view.SetDiffOverlay(rings);
	}

	// Toggle helper shared by the toolbar button and hot-reload.
	void refreshCompare()
	{
		rebuildDiff();
		if (diffReady) applyDiffOverlay();
		else view.ClearDiffOverlay();
	}

	// Right-hand panel body while the version-compare view is open. Lists added /
	// removed / value-changed nodes with per-line deltas; clicking a node that
	// still exists in the new season focuses it on the canvas.
	void renderComparePanel()
	{
		ImGui::TextDisabled(u8"버전 비교");

		// --- pick the two versions ---
		// Every installed tag is offered on both sides, so this covers both
		// "3.28 -> 3.29" (what the new league changed) and "3.29.0 -> 3.29.1"
		// (what GGG adjusted mid-league).
		std::vector<std::string> tags = verIndex.TagsNewestFirst();
		auto versionCombo = [&](const char* id, const char* caption, std::string& slot) {
			ImGui::TextDisabled("%s", caption);
			ImGui::SameLine();
			ImGui::SetNextItemWidth(110.0f * scale);
			bool changed = false;
			if (ImGui::BeginCombo(id, slot.c_str())) {
				for (const std::string& t : tags)
					if (ImGui::Selectable(t.c_str(), t == slot) && t != slot) {
						slot = t;
						changed = true;
					}
				ImGui::EndCombo();
			}
			return changed;
		};
		bool pairChanged = versionCombo("##cmpbase", u8"이전", cmpBase);
		ImGui::SameLine();
		ImGui::TextDisabled(">>");
		ImGui::SameLine();
		pairChanged |= versionCombo("##cmptarg", u8"신규", cmpTarg);
		ImGui::SameLine();
		if (ImGui::SmallButton(u8"맞바꾸기")) {
			std::swap(cmpBase, cmpTarg);
			pairChanged = true;
		}
		if (pairChanged) refreshCompare();

		if (fontBig) ImGui::PushFont(fontBig);
		ImGui::TextColored(PobUi::Accent(), "%s  >>  %s", diff.oldVer.c_str(), diff.newVer.c_str());
		if (fontBig) ImGui::PopFont();
		if (!diffReady) {
			ImGui::Dummy(ImVec2(0, 12.0f * scale));
			ImGui::TextWrapped("%s", diffErr.empty() ? u8"아직 비교를 계산하지 않았습니다." : diffErr.c_str());
			return;
		}
		ImGui::Text(u8"추가 %d 삭제 %d 수치/사용 변경 %d",
			(int)diff.added.size(), (int)diff.removed.size(), (int)diff.modified.size());
		ImGui::Spacing();
		ImGui::SetNextItemWidth(-FLT_MIN);
		ImGui::InputTextWithHint("##diffsearch", u8"변경된 노드 또는 문구 검색...",
			diffSearch, sizeof(diffSearch), ImGuiInputTextFlags_EscapeClearsAll);
		std::string needle = ToLowerAscii(diffSearch);
		ImGui::Spacing();

		auto label = [&](const AtlasNodeDiff& n) -> const std::string& {
			return (showZh && zhLoaded && !n.nameZh.empty()) ? n.nameZh : n.name;
		};
		auto lineNew = [&](const AtlasStatDelta& d) -> std::string {
			return StripStatMarkup((showZh && zhLoaded && !d.zh.empty()) ? d.zh : d.en);
		};
		auto lineOld = [&](const AtlasStatDelta& d) -> std::string {
			return StripStatMarkup((showZh && zhLoaded && !d.zhOld.empty()) ? d.zhOld : d.enOld);
		};
		auto match = [&](const AtlasNodeDiff& n) -> bool {
			if (needle.empty()) return true;
			if (ToLowerAscii(n.name).find(needle) != std::string::npos) return true;
			if (ToLowerAscii(n.nameZh).find(needle) != std::string::npos) return true;
			for (const AtlasStatDelta& d : n.stats)
				if (ToLowerAscii(d.en).find(needle) != std::string::npos) return true;
			return false;
		};
		auto header = [&](const char* zh, size_t count) {
			return std::string(zh) + " (" + std::to_string(count) + ")";
		};

		ImGui::BeginChild("##diffscroll", ImVec2(0, 0), false, ImGuiWindowFlags_AlwaysUseWindowPadding);

		if (!diff.added.empty() &&
		    ImGui::CollapsingHeader(header(u8"추가 노드", diff.added.size()).c_str(), ImGuiTreeNodeFlags_DefaultOpen)) {
			for (const AtlasNodeDiff& n : diff.added) {
				if (!match(n)) continue;
				ImGui::PushID(n.id);
				bool clickable = activeIdxById.count(n.id) > 0;
				ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.50f, 0.85f, 0.55f, 1.0f));
				if (ImGui::Selectable(("+ " + (label(n).empty() ? std::string("?") : label(n))).c_str()) && clickable)
					view.CenterOn(tree, activeIdxById[n.id]);
				ImGui::PopStyleColor();
				ImGui::PopID();
			}
		}
		if (!diff.removed.empty() &&
		    ImGui::CollapsingHeader(header(u8"노드 제거", diff.removed.size()).c_str(), ImGuiTreeNodeFlags_DefaultOpen)) {
			for (const AtlasNodeDiff& n : diff.removed) {
				if (!match(n)) continue;
				ImGui::PushID(n.id);
				ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.90f, 0.45f, 0.45f, 1.0f));
				ImGui::Selectable(("- " + (label(n).empty() ? std::string("?") : label(n))).c_str());
				ImGui::PopStyleColor();
				if (ImGui::IsItemHovered()) {
					ImGui::BeginTooltip();
					ImGui::TextDisabled(u8"해당 노드가 새 시즌에서 삭제되었습니다.");
					ImGui::PushTextWrapPos(380.0f * scale);
					for (const std::string& s : n.statsOld) ImGui::TextUnformatted(StripStatMarkup(s).c_str());
					ImGui::PopTextWrapPos();
					ImGui::EndTooltip();
				}
				ImGui::PopID();
			}
		}
		if (!diff.modified.empty() &&
		    ImGui::CollapsingHeader(header(u8"수치/사용 변경", diff.modified.size()).c_str(), ImGuiTreeNodeFlags_DefaultOpen)) {
			for (const AtlasNodeDiff& n : diff.modified) {
				if (!match(n)) continue;
				ImGui::PushID(n.id);
				bool clickable = activeIdxById.count(n.id) > 0;
				ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.95f, 0.82f, 0.42f, 1.0f));
				if (ImGui::Selectable(("~ " + (label(n).empty() ? std::string("?") : label(n))).c_str()) && clickable)
					view.CenterOn(tree, activeIdxById[n.id]);
				ImGui::PopStyleColor();
				ImGui::Indent(12.0f * scale);
				ImGui::PushTextWrapPos(0.0f);
				if (n.nameChanged) {
					ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.60f, 0.66f, 0.74f, 1.0f));
					ImGui::TextWrapped(u8"이름 변경: %s",
						(showZh && zhLoaded && !n.nameOldZh.empty() ? n.nameOldZh : n.nameOld).c_str());
					ImGui::PopStyleColor();
				}
				for (const AtlasStatDelta& d : n.stats) {
					if (d.kind == AtlasStatDelta::kValueChanged) {
						ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.58f, 0.63f, 0.72f, 1.0f));
						ImGui::TextWrapped("  %s", lineOld(d).c_str());
						ImGui::PopStyleColor();
						ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.72f, 0.80f, 0.98f, 1.0f));
						ImGui::TextWrapped("=> %s", lineNew(d).c_str());
						ImGui::PopStyleColor();
					} else if (d.kind == AtlasStatDelta::kLineAdded) {
						ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.50f, 0.85f, 0.55f, 1.0f));
						ImGui::TextWrapped("+ %s", lineNew(d).c_str());
						ImGui::PopStyleColor();
					} else {
						ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.90f, 0.45f, 0.45f, 1.0f));
						ImGui::TextWrapped("- %s", lineNew(d).c_str());
						ImGui::PopStyleColor();
					}
				}
				ImGui::PopTextWrapPos();
				ImGui::Unindent(12.0f * scale);
				ImGui::Spacing();
				ImGui::PopID();
			}
		}
		ImGui::EndChild();
	}

	// hot-reload after new data landed on disk (manual import or auto update);
	// GL work, main thread only
	void hotReload(const std::string& okMsg)
	{
		verIndex.Load(exeDir);              // a new season may have landed
		bool zhWas = zhLoaded;              // the zh mapping may have changed too
		loadSeason(verIndex.Active());      // follow to the (possibly new) active season
		if (ready) saveActive();            // lock in the id-mapping after any pruning
		if (!zhLoaded) showZh = false;
		else if (!zhWas) showZh = true;     // translations appeared: switch on
		importMsg = ready ? okMsg : loadErr;
		importFailed = !ready;
		panelDirty = true;
		// compute the diff so the toolbar can prompt "what changed this update"
		diffReady = false;
		if (ready && verIndex.Versions().size() >= 2 && !verIndex.CompareBase().empty()) {
			rebuildDiff();
			if (diffReady)
				importMsg += u8" · 비교 " + diff.oldVer + u8" → " + diff.newVer + u8": 추가 " +
				             std::to_string(diff.added.size()) + u8", 삭제 " + std::to_string(diff.removed.size()) +
				             u8", 변경 " + std::to_string(diff.modified.size()) + u8"('버전 비교'에서 확인)";
		}
		if (compareMode) { if (diffReady) applyDiffOverlay(); else view.ClearDiffOverlay(); }
		else view.ClearDiffOverlay();
	}

	// convert + hot-reload; keeps the old data untouched when conversion fails
	void importSeason()
	{
		// See ApDialog: the file dialog cannot run inside a frame.
		pendingDialog_ = ApDialog::ImportSeasonData;
	}
	void importSeasonFrom(const std::wstring& path)
	{
		if (path.empty()) return;
		// manual import replaces the active season in place (no tag is available
		// from a local data.json); the auto updater handles versioned rolling
		std::wstring dest = verIndex.ResolveDataDir(exeDir, verIndex.Active());
		std::string ierr, isum;
		if (!ImportAtlasTreeData(path, dest, &ierr, &isum)) {
			importMsg = ierr;
			importFailed = true;
			return;
		}
		hotReload(isum);
	}


	// Was a closure in the frame body; a member because the .json import path
	// reaches it from RunDeferred() rather than from a frame.
	void importEntry(const AtlasBuildEntry& e)
	{
		saveActive();
		int idx = buildFile.AddBuild(e.name);
		buildFile.active = idx;
		// Keep the raw ids so a preview season cannot prune them; the
		// canonical season's saveActive() below replaces them with the
		// mapped set.
		buildFile.builds[idx].alloc = e.alloc;
		buildFile.builds[idx].notes = e.notes;
		buildFile.builds[idx].targets = e.targets;
		buildFile.builds[idx].blocked = e.blocked;
		// Each Sanitize clears the note it is handed, so they get their own
		// and are concatenated afterwards.
		std::string snote, anote;
		buildFile.builds[idx].scarabs = scarabDb.Sanitize(e.scarabs, &snote);
		buildFile.builds[idx].astrolabes = astroDb.Sanitize(e.astrolabes, &anote);
		snote += anote;
		buildFile.builds[idx].mapId = mapDb.SanitizeOne(e.mapId);
		if (!e.mapId.empty() && buildFile.builds[idx].mapId.empty())
			snote += u8", 알 수 없는 지도 1개 무시";
		int kept = tree.ApplyAllocIds(e.alloc);
		tree.ApplyTargetIds(e.targets);
		tree.ApplyBlockedIds(e.blocked);
		undo.valid = false;
		saveActive();
		panelDirty = true;
		int dropped = (int)e.alloc.size() - kept;
		importMsg = u8"가져오기 완료 '" + buildFile.Active().name + u8"': " + std::to_string(kept) + u8"포인트";
		if (dropped > 0) importMsg += u8"(알 수 없는 노드 " + std::to_string(dropped) + u8"개 제외)";
		if (!buildFile.builds[idx].astrolabes.empty())
			importMsg += u8", 아스트롤라베 " + std::to_string(buildFile.builds[idx].astrolabes.size()) + u8"개";
		if (!buildFile.builds[idx].mapId.empty()) importMsg += u8", 주력 지도";
		if (!buildFile.builds[idx].scarabs.empty())
			importMsg += u8", 갑충석 " + std::to_string(buildFile.builds[idx].scarabs.size()) + u8"개";
		if (!buildFile.builds[idx].notes.empty()) importMsg += u8", 메모";
		importMsg += snote; // "，忽略 N 個未知甲蟲" etc., empty when nothing was dropped
		importFailed = false;
	}

	// ---- what the host lends, and what a close is waiting on -----------------
	const ToolPanelHost* host_ = nullptr;
	std::wstring exeDir;
	float scale = 1.0f;
	ImFont* fontBig = nullptr;   // refreshed from the host every frame
	bool cjkOk = false;          // ditto

	ToolCloseState close_ = ToolCloseState::Open;
	ApDialog pendingDialog_ = ApDialog::None;
	std::string pendingExportName_;   // captured with the intent, used in RunDeferred
	bool shutdown_ = false;
};

IToolPanel* CreateAtlasPlannerPanel()
{
	return new AtlasPlannerPanel();
}

void ShowAtlasPlanner(const std::wstring& exeDir, const std::wstring& locale)
{
	AtlasPlannerPanel panel;
	ToolWindowDesc desc;
	// "PobTools — 輿圖策略"
	desc.titleUtf8 = u8"PobTools — 아틀라스 전략";
	desc.defW = 1280;
	desc.defH = 860;
	RunToolWindow(panel, desc, exeDir, L"poe1", locale);
}
