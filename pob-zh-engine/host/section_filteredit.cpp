#include "editor_shell.h"
#include "editor_util.h"
#include "filter_card_ui.h"
#include "filter_batch.h"
#include "custom_rules_io.h"
#include "filter_parser.h"
#include "ui_theme.h"

#define IMGUI_DEFINE_MATH_OPERATORS
#include <imgui.h>
#include <misc/cpp/imgui_stdlib.h>

#include <algorithm>
#include <string>
#include <vector>

// 過濾編輯 — the three-pane block editor (reference: 文字過濾編輯器):
//   left   block list (search + 顯示 checkbox + label, clipper-rendered)
//   middle selected block's condition / action cards
//   right  add-column (tick to insert, untick to disable)
//
// Index discipline: model-derived caches (rows/visRows/selection) are rebuilt
// whenever FilterDocumentEditor::structureVersion changes; the selected block
// survives rebuilds through BlockAnchor. Translation and summaries run only in
// RebuildRows — never inside the clipper loop.

namespace {

// Display label for a block: NeverSink marker from the header's trailing
// comment, else the last non-decorative comment right above the header, else an
// English condition summary.
std::string ExtractBlockLabel(const FilterFile& f, const FilterBlock& b)
{
	if (!b.headerComment.empty()) return b.headerComment;

	for (int li = b.headerLineIdx - 1; li >= 0; li--) {
		const FilterLine& ln = f.lines[li];
		if (ln.kind != FilterLineKind::Comment) break;
		std::string t = ln.raw.substr(ln.indent.size());
		size_t p = 0;
		while (p < t.size() && (t[p] == '#' || t[p] == ' ' || t[p] == '\t')) p++;
		t = t.substr(p);
		// Skip decorative rules like "=====" / "-----".
		bool decorative = t.empty();
		if (!t.empty() && (t[0] == '=' || t[0] == '-')) decorative = true;
		if (!decorative) return t;
	}
	return BlockSummary(f, b);
}

void RebuildVisRows(EditorShell& s)
{
	s.visRows.clear();
	s.visRows.reserve(s.rows.size());
	for (int i = 0; i < (int)s.rows.size(); i++) {
		if (!s.searchLower.empty() && !EdContainsCI(s.rows[i].haystack, s.searchLower)) continue;
		s.visRows.push_back(i);
	}
}

void RebuildRows(EditorShell& s)
{
	const FilterFile& f = s.model;
	s.rows.clear();
	s.rows.resize(f.blocks.size());
	for (int i = 0; i < (int)f.blocks.size(); i++) {
		const FilterBlock& b = f.blocks[i];
		BlockListRow& r = s.rows[i];
		std::string rawLabel = ExtractBlockLabel(f, b);
		r.label = NeverSinkHeaderZh(rawLabel);
		// haystack 同時收原文與譯文,搜尋 "$type->currency" 或 "通貨" 都命中。
		r.haystack = rawLabel + " " + r.label + " " + BlockSummary(f, b) + " " + CardBlockSummaryZh(f, b, s.i18n);
	}
	// Re-resolve the selection through its anchor (indices may have shifted).
	if (s.selAnchor.valid()) s.selectedBlock = s.doc.ResolveAnchor(s.selAnchor);
	if (s.selectedBlock < 0 || s.selectedBlock >= (int)f.blocks.size())
		s.selectedBlock = f.blocks.empty() ? -1 : 0;
	if (s.selectedBlock >= 0) s.selAnchor = s.doc.CaptureAnchor(s.selectedBlock);
	s.batchSel.assign(f.blocks.size(), 0);
	s.rowsVersion = s.doc.structureVersion();
	RebuildVisRows(s);
}

// Left pane: search box + clipper-rendered block list (+ batch multi-select).
// Returns true when the batch modal should open (popup must be opened at the
// section level, outside this child's ID scope).
bool DrawBlockList(EditorShell& s)
{
	bool openBatch = false;

	PobUi::PushPrimaryButton();
	bool addRule = ImGui::Button(u8"+ 사용자 지정 규칙 추가", ImVec2(-1, 0));
	PobUi::PopButtonStyle();
	if (addRule) {
		CustomZone z = EnsureCustomZone(s.doc);
		if (z.present()) {
			int nb = s.doc.CreateBlockAtLine(z.endLine, false, u8"PobTools custom rule");
			if (nb >= 0) {
				// A bare Show with no condition would match EVERYTHING — seed a
				// BaseType the user is meant to replace.
				s.doc.InsertLine(nb, "BaseType", "",
					{ FilterToken{ "Divine Orb", true } });
				s.selectedBlock = nb;
				s.selAnchor = s.doc.CaptureAnchor(nb);
				s.status = u8"사용자 지정 영역에 규칙을 추가했습니다(아이템 이름을 수정하세요).";
			}
		}
		return false;  // caches are stale; skip the list until next frame's rebuild
	}
	if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"새 규칙은 파일 최상단의 사용자 지정 영역에 추가되며 우선순위가 가장 높습니다.");

	ImGui::SetNextItemWidth(-1);
	if (ImGui::InputTextWithHint("##search", u8"텍스트를 입력해 필터 항목 검색...", &s.search)) {
		s.searchLower = EdToLowerAscii(s.search);
		RebuildVisRows(s);
	}

	if (s.batchMode) {
		int nSel = 0;
		for (char c : s.batchSel) if (c) nSel++;
		if (ImGui::SmallButton(u8"보이는 항목 모두 선택")) {
			for (int bi : s.visRows) s.batchSel[bi] = 1;
		}
		ImGui::SameLine();
		if (ImGui::SmallButton(u8"지우기")) s.batchSel.assign(s.batchSel.size(), 0);
		ImGui::SameLine();
		ImGui::BeginDisabled(nSel == 0);
		if (ImGui::SmallButton((u8"스타일 적용(선택 " + std::to_string(nSel) + u8"개)...").c_str()))
			openBatch = true;
		ImGui::EndDisabled();
	} else {
		ImGui::TextDisabled(u8"필터 항목 %d / %d(클릭하여 선택, 표시/숨기기 전환)",
			(int)s.visRows.size(), (int)s.rows.size());
	}
	ImGui::Separator();

	ImGui::BeginChild("##blocklist", ImVec2(0, 0), false);
	ImGuiListClipper clip;
	clip.Begin((int)s.visRows.size());
	while (clip.Step()) {
		for (int vi = clip.DisplayStart; vi < clip.DisplayEnd; vi++) {
			int bi = s.visRows[vi];
			FilterBlock& b = s.model.blocks[bi];
			const BlockListRow& row = s.rows[bi];
			ImGui::PushID(bi);

			if (s.batchMode) {
				bool bsel = s.batchSel[bi] != 0;
				if (ImGui::Checkbox("##bsel", &bsel)) s.batchSel[bi] = bsel ? 1 : 0;
				ImGui::SameLine();
			}

			bool show = !b.hide;
			if (ImGui::Checkbox("##show", &show)) SetBlockHide(s, b, !show);
			if (ImGui::IsItemHovered()) ImGui::SetTooltip(show ? u8"표시 중(클릭하면 숨김)" : u8"숨김 중(클릭하면 표시)");
			ImGui::SameLine();

			bool blockDirty = false;
			for (int li : b.lineIdx)
				if (s.model.lines[li].dirty) { blockDirty = true; break; }
			std::string label = row.label;
			if (blockDirty) label += u8"  *";

			bool sel = (s.selectedBlock == bi);
			if (b.hide) ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.62f, 0.46f, 0.46f, 1.0f));
			if (ImGui::Selectable(label.c_str(), sel)) {
				if (s.batchMode) {
					s.batchSel[bi] = s.batchSel[bi] ? 0 : 1;
				} else {
					s.selectedBlock = bi;
					s.selAnchor = s.doc.CaptureAnchor(bi);
				}
			}
			if (b.hide) ImGui::PopStyleColor();
			ImGui::PopID();
		}
	}
	clip.End();
	ImGui::EndChild();
	return openBatch;
}

} // namespace

// Shared cache rebuild — 掉落預覽 needs rows (labels) without visiting this
// section first.
void EdRebuildRows(EditorShell& s) { RebuildRows(s); }

void DrawFilterEditSection(EditorShell& s)
{
	if (!s.loaded) {
		const char* prompt = u8"아직 필터를 오픈하지 않았습니다.";
		ImVec2 avail = ImGui::GetContentRegionAvail();
		ImGui::Dummy(ImVec2(0, std::max(60.0f * s.scale, avail.y * 0.30f)));
		float textW = ImGui::CalcTextSize(prompt).x;
		ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0f, (avail.x - textW) * 0.5f));
		ImGui::TextDisabled("%s", prompt);
		ImGui::Spacing();
		const float buttonW = 190.0f * s.scale;
		ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(0.0f, (avail.x - buttonW) * 0.5f));
		PobUi::PushPrimaryButton();
		bool open = ImGui::Button(u8".filter 파일 열기...", ImVec2(buttonW, 0));
		PobUi::PopButtonStyle();
		if (open) s.pendingDialog = EdDialog::OpenFilter;
		return;
	}
	if (s.doc.file() != &s.model) s.doc.Attach(&s.model);
	if (s.rowsVersion != s.doc.structureVersion()) RebuildRows(s);

	const float rightW = 260 * s.scale;
	const float leftW = std::clamp(ImGui::GetContentRegionAvail().x * 0.30f,
		300 * s.scale, 420 * s.scale);

	ImGui::BeginChild("##left", ImVec2(leftW, 0), true);
	bool openBatch = DrawBlockList(s);
	ImGui::EndChild();
	if (openBatch) ImGui::OpenPopup(u8"배치 수정 ###batchmodal");
	DrawBatchModal(s);

	// A structural change in the left pane (new custom rule, import) leaves
	// every cached index stale — skip the other panes until the next frame's
	// rebuild.
	if (s.rowsVersion != s.doc.structureVersion()) return;

	ImGui::SameLine();

	bool mutated = false;
	bool wantDeleteRule = false;
	ImGui::BeginChild("##mid", ImVec2(-rightW - ImGui::GetStyle().ItemSpacing.x, 0), true);
	if (s.selectedBlock < 0) {
		ImGui::TextDisabled(u8"왼쪽에서 필터 항목 하나를 선택해 편집하세요.");
	} else {
		const BlockListRow& row = s.rows[s.selectedBlock];
		ImGui::TextColored(PobUi::Accent(), "%s", row.label.c_str());
		// 自訂區的規則是使用者自己加的:提供真刪除(其餘區塊維持 #! 停用哲學)。
		CustomZone z = FindCustomZone(s.model);
		const FilterBlock& blk = s.model.blocks[s.selectedBlock];
		if (z.present() && blk.headerLineIdx > z.beginLine && blk.headerLineIdx < z.endLine) {
			ImGui::SameLine(ImGui::GetContentRegionMax().x - 92 * s.scale);
			if (ImGui::SmallButton(u8"삭제 규칙")) wantDeleteRule = true;
			if (ImGui::IsItemHovered()) ImGui::SetTooltip(u8"파일에서 이 사용자 지정 규칙을 삭제합니다(복구할 수 없음)." );
		}
		ImGui::Separator();
		ImGui::PushID(s.selectedBlock);
		mutated = DrawBlockCards(s, s.selectedBlock);
		ImGui::PopID();
	}
	ImGui::EndChild();

	ImGui::SameLine();

	ImGui::BeginChild("##right", ImVec2(rightW, 0), true);
	// After a structural mutation every cached index is stale: skip the
	// add-column this frame and let the next frame rebuild.
	if (!mutated) DrawAddColumn(s, s.selectedBlock);
	ImGui::EndChild();

	// Delete-custom-rule confirm modal — opened at section level (popup 不能在
	// PushID 迴圈/子視窗內開)。實際刪除發生在本 frame 尾端,下一 frame 重建快取。
	if (wantDeleteRule) ImGui::OpenPopup(u8"사용자 지정 규칙 삭제###delrule");
	if (ImGui::BeginPopupModal(u8"사용자 지정 규칙 삭제###delrule", nullptr,
	                           ImGuiWindowFlags_AlwaysAutoResize)) {
		const char* nm = (s.selectedBlock >= 0 && s.selectedBlock < (int)s.rows.size())
			? s.rows[s.selectedBlock].label.c_str() : "";
		ImGui::Text(u8"사용자 지정 규칙 '%s'을(를) 삭제하시겠습니까?", nm);
		ImGui::TextDisabled(u8"이 작업은 파일에서 규칙을 바로 제거하며 복구할 수 없습니다.");
		ImGui::Spacing();
		PobUi::PushPrimaryButton();
		if (ImGui::Button(u8"삭제", ImVec2(110 * s.scale, 0))) {
			if (s.selectedBlock >= 0 && s.selectedBlock < (int)s.model.blocks.size()) {
				s.doc.RemoveBlock(s.selectedBlock);
				s.selectedBlock = -1;
				s.selAnchor = {};
				s.status = u8"사용자 지정 규칙을 삭제했습니다(저장 필요).";
			}
			ImGui::CloseCurrentPopup();
		}
		PobUi::PopButtonStyle();
		ImGui::SameLine();
		if (ImGui::Button(u8"취소", ImVec2(110 * s.scale, 0))) ImGui::CloseCurrentPopup();
		ImGui::EndPopup();
	}
}
