# Lộ trình NVIDIA NIM Agent IDE

Mục tiêu của dự án là xây dựng một AI coding agent IDE tự chế, có Desktop UI, CLI agent, MCP server, extension host, và khả năng dùng NVIDIA NIM làm backend model. Định hướng gần nhất là đạt UX AI coding agent ngang Antigravity/Cursor trước, sau đó mới san bằng những phần khó của VS Code như extension host đầy đủ, LSP, debug, terminal PTY và marketplace compatibility.

## Hiện Trạng

Dự án đã có nền tảng agent khá tốt:

- Desktop server và CLI agent dùng chung `tools/agent-core.mjs`.
- Agent có workspace tools: đọc file, đọc file theo trang, search, semantic index cơ bản, git context, ghi file qua pending diff, apply patch, command job và cancel.
- Có workspace trust mode.
- Có stop response cho request NIM.
- Có session chat, copy/edit/resend message.
- Có MCP server expose workspace tools.
- Có extension host bước đầu trong `tools/extension-host.mjs`.
- Có Open VSX search/install và VSIX unpacker bước đầu.
- Có VS Code compatibility layer tối thiểu: `commands.registerCommand`, `commands.executeCommand`, `window.showInformationMessage`, `workspace.getConfiguration`, `workspace.fs`, activation event `*` và `onCommand`.
- Có adapter cho agent provider ngoài: Codex CLI, Gemini CLI, OpenCode nếu có trong PATH.
- Có audit harness `npm run agent:audit`, hiện đang đạt 25/25 internal checks.

## Tỷ Lệ Hoàn Thành Ước Tính

Đây là ước tính thực dụng theo trải nghiệm người dùng, không phải số dòng code.

| Mốc so sánh | Ước tính hiện tại | Lý do |
| --- | ---: | --- |
| Cursor UX AI coding agent | 35-45% | Đã có chat agent, tool use, file edit, command, diff, context. Còn thiếu inline edit đẹp, composer, apply hunk chuẩn, autocomplete, semantic context mạnh, task recovery. |
| Antigravity UX AI agent | 40-50% | Đã có workflow agent, MCP, desktop agent loop, workspace tools. Còn thiếu polish UI, planner/task UI, browser automation, multi-agent orchestration, approvals đẹp. |
| VS Code editor platform | 15-25% | Có Monaco và extension compatibility layer tối thiểu. Còn thiếu LSP, debug adapter, terminal PTY, settings UI, keybindings, SCM UI, full extension API. |
| VS Code extension marketplace/runtime | 10-20% | Đã có Open VSX search/install/VSIX unpack/manifest/commands. Chưa có full `vscode.*`, webview, language features, tree view, status bar, tasks/debug APIs. |
| CLI coding agent | 50-60% | Đã có sessions, tools, approvals, shared core. Còn thiếu robust TUI, resume jobs, richer diff review, provider switching, shell PTY. |

## Điểm Còn Chưa Ngang VS Code/Cursor/Antigravity

### 1. Editor và Language Intelligence

- Chưa có LSP client/server integration cho TypeScript, Python, JSON, Markdown.
- Chưa có diagnostics panel thật sự.
- Chưa có go to definition, find references, rename symbol, code actions.
- Chưa có formatter/linter pipeline theo ngôn ngữ.
- Monaco mới là editor view, chưa thành editor workbench đầy đủ.

### 2. AI Coding UX

- Chưa có inline edit trong editor kiểu Cursor.
- Chưa có composer/apply changes trên nhiều file với review từng hunk đẹp.
- Chưa có prompt context picker chuẩn: open files, selected code, changed files, terminal output, problems.
- Chưa có task timeline rõ ràng: plan, actions, tool calls, diffs, test results.
- Chưa có recovery/resume khi app crash giữa task.
- Chưa có memory/project rules UI tốt.

### 3. Diff Review

- Đã có hunk data và checkbox accept hunk, nhưng còn line-based đơn giản.
- Chưa có side-by-side diff editor.
- Chưa có accept/reject từng hunk trong Monaco.
- Chưa có conflict detection UI khi file thay đổi sau khi agent đề xuất patch.
- Chưa có undo stack và patch history.

### 4. Terminal và Job Manager

- Terminal hiện là command job polling, chưa phải PTY.
- Chưa có interactive terminal session.
- Chưa có process tree kill chuẩn trên Windows/Linux/macOS.
- Chưa có job queue, priority, retry, pause/resume.
- Chưa có terminal tabs, command history, attach output vào chat context.

### 5. Extension Host

- Đã có compatibility layer tối thiểu, nhưng chưa full VS Code API.
- Chưa có `languages`, `TextDocument`, `TextEditor`, `window.activeTextEditor`.
- Chưa có `window.createTreeView`, status bar, quick pick, input box.
- Chưa có `workspace.onDidChangeTextDocument`, file watchers.
- Chưa có webview API.
- Chưa có debug/tasks/scm APIs.
- Chưa có extension sandbox security policy hoàn chỉnh.
- Chưa có version compatibility và extension dependency resolution.

### 6. Marketplace

- Đã có Open VSX search/install và VSIX unpack.
- Chưa có UI search/install đủ mượt như VS Code.
- Chưa có update extension, auto update, changelog, ratings, categories.
- Chưa có signature/trust verification.
- Chưa có disable per workspace/global.

### 7. Context Engine

- Semantic index hiện mới là lexical chunk scoring.
- Chưa có embeddings/rerank thật sự.
- Chưa có incremental indexing.
- Chưa có AST chunking, symbol graph, dependency graph.
- Chưa có git-aware context selection mạnh.
- Chưa có ignore policy tốt cho large/binary/generated files.

### 8. Agent Orchestration

- Chưa có multi-agent roles chuẩn: planner, coder, reviewer, tester.
- Chưa có tool budget, retry policy, task graph, step state machine.
- Chưa có evaluation harness thật sự cho 15 năng lực bằng test scenario end-to-end.
- Chưa có automatic self-healing có giới hạn rủi ro.

### 9. Security

- Đã có workspace trust và secret redaction cơ bản.
- Chưa có permission model theo tool/path/extension.
- Chưa có sandbox process riêng cho extension JS.
- Chưa có audit log đầy đủ cho file writes, command runs, extension execution.
- Chưa có policy ngăn extension đọc/ghi ngoài workspace ở mọi API.

### 10. Product UX Và Two-Mode Shell

- Chưa có chế độ ẩn hiện tách biệt:
  - Enterprise chatbot/tool desktop mode.
  - AI coding agent IDE mode.
  - CLI agent mode.
- Chưa có shortcut/gesture/dev unlock để mở IDE mode.
- Chưa có route/layout state riêng cho từng persona.
- Chưa có onboarding và settings rõ ràng.

## Triết Lý Kiến Trúc (Architecture Philosophy)

Dự án định vị là một **Hệ điều hành Nhận thức cho Doanh nghiệp (Cognitive OS for Enterprise)** với kiến trúc 4 lớp tách biệt:

```text
Model Providers: NVIDIA NIM / Gemini / local model / OpenAI
        ↓
NVIDIA Agent Runtime: UI, CLI, MCP, IDE, terminal, tools, self-code loop
        ↓
ABW Constitutional Layer: governance, grounded memory, continuation gate, audit
        ↓
Enterprise Reality Layer: SOP, QA, manuals, ERP/MES/QMS, production logs
```

**Các nguyên tắc thiết kế cốt lõi:**

- **Provider Agnostic:** "NVIDIA" trong tên gọi hiện tại đóng vai trò branding và provider mặc định. Hệ thống được thiết kế trừu tượng hóa để có thể vận hành trơn tru với bất kỳ LLM nào. Linh hồn của hệ thống nằm ở Agent Runtime và ABW Governance.
- **Active Agent Runtime:** Đây không chỉ là "tay chân". Lớp này bao gồm UI, môi trường hành động (editor, terminal), các file tools và vòng lặp tự thực thi. Nó là vỏ sản phẩm có năng lực nhận thức và hành động.
- **Constitutional Governance:** ABW đóng vai trò là "Hiến pháp nhận thức và hành vi". Nó đứng ngang hàng về quyền kiểm soát để đảm bảo trí nhớ được kiểm chứng, quy tắc hành động an toàn, kiểm tra thực tại và cơ chế chống tự phá vỡ (continuation gate) khi agent tiến hóa.
- **Kiến trúc Cầu nối (Bridge Architecture):** Không merge source code cơ học giữa hai hệ thống. Agent Runtime gọi ABW thông qua Bridge Adapter (CLI/FastAPI) nhằm giữ nguyên vẹn triết lý quản trị của ABW, không biến ABW thành một app framework làm loãng mục đích cốt lõi.
- **Bảo mật Dữ liệu Doanh nghiệp:** Không đẩy toàn bộ `.brain` hay `raw/` lên Git. Chỉ version hóa schema, policy, decision log đã sanitized và wiki được duyệt.

## Chiến Lược Phát Triển Hai Repo NVIDIA Và ABW

Hiện tại `D:\Sandbox\Nvidia` và `D:\Sandbox\skill-Anti-brain-wiki_note` phải tiếp tục tồn tại như hai hệ độc lập nhưng phát triển theo một tư tưởng chung.

- `D:\Sandbox\Nvidia` là **product shell và active agent runtime**: Desktop UI, CLI, MCP, Monaco IDE, terminal/job manager, extension host, pending diff, command tools, model provider abstraction và self-code loop.
- `D:\Sandbox\skill-Anti-brain-wiki_note` là **canonical ABW governance engine**: `.brain`, `raw/processed/wiki`, grounded query, bootstrap reasoning, continuation gate, audit/eval, locked decisions, unsafe zones, rollback contract và no-fake-success policy.
- Không copy source cơ học từ repo này sang repo kia khi chưa có contract rõ ràng. NVIDIA chỉ tích hợp ABW qua bridge adapter trước: CLI bridge tối thiểu, sau đó mới cân nhắc FastAPI/local service nếu UI cần realtime state.
- Không biến ABW thành app framework của NVIDIA. ABW giữ vai trò constitutional layer độc lập để tránh làm loãng ưu thế cốt lõi: quản trị tri thức, kiểm chứng thực tại và kiểm soát hành động.
- Không để NVIDIA phụ thuộc sống còn vào provider miễn phí. NIM/Gemini/OpenAI/local model phải là provider có thể thay thế; phần bền vững của hệ nằm ở runtime, governance, knowledge pipeline và audit trail.
- Hai repo cần có một **nhật ký hợp nhất** trong báo cáo/roadmap để tránh bỏ sót: việc nào thuộc NVIDIA runtime, việc nào thuộc ABW engine, việc nào thuộc bridge, việc nào thuộc enterprise deployment.

Chiến lược đúng trong giai đoạn hiện tại là **hợp nhất tư tưởng và contract, chưa hợp nhất source**. Khi ABW có README/roadmap đầy đủ và NVIDIA có bridge chạy ổn định, mới đánh giá có nên monorepo, submodule, package dependency hay tiếp tục multi-repo.

## Chiến Lược Hai Giao Diện

Sau này nên tách ứng dụng thành hai lớp giao diện, dùng chung backend agent core.

### Mode A: Enterprise Chatbot/Tool Desktop

Đây là giao diện mặc định cho người dùng doanh nghiệp.

- Ẩn Explorer, Extensions, Terminal, Diff, Git.
- Chỉ hiện chat, tool cards, workflow buttons, upload file, kết quả báo cáo.
- Không gọi là IDE.
- Chỉ expose các action an toàn: đọc tài liệu, tạo báo cáo, chạy workflow được phê duyệt.
- Có branding riêng theo doanh nghiệp.

### Mode B: AI Coding Agent IDE

Đây là giao diện mở khóa cho developer/power user.

- Hiện Explorer, Monaco editor, Extensions, Terminal, Diff Review, Git, Problems.
- Cho phép workspace trust, command jobs, file edits, extension host.
- Có AI composer, inline edit, plan timeline.
- Có CLI bridge và MCP provider.

### Cách Mở Khóa Đề Xuất

- Keyboard shortcut: `Ctrl+Alt+Shift+I`.
- URL flag local: `/?mode=ide`.
- Config file: `.nvidia-agent/profile.json`.
- Settings toggle có password/dev token.
- CLI flag: `npm run desktop -- --mode=ide`.

Backend nên có một biến mode:

```json
{
  "uiMode": "enterprise" | "ide",
  "trustedWorkspace": false,
  "enabledPanels": ["chat", "tools", "explorer", "terminal", "extensions", "diff"]
}
```

## Kế Hoạch Ngắn Hạn: 1-2 Tuần

Mục tiêu: hoàn thành UX AI coding agent IDE dùng được hàng ngày, gần Cursor/Antigravity về flow chính.

### Sprint 1: Agent Composer Và Diff UX

- [x] **Composer UI Panel:** Gemini 3 Flash added a task sidebar for timeline and changed files.
- [x] **Task Timeline:** Gemini 3 Flash added basic task events for start/tool/plan/apply.
- [x] **Changed Files List:** Gemini 3 Flash added pending edit listing.
- [x] **Monaco Side-by-side Diff:** Gemini 3 Flash added a read-only Monaco diff view.
- [x] **Hunk Accept/Reject:** Gemini 3 Flash added checkbox-based hunk selection.
- [x] **Codex Audit Fix:** Codex fixed discard/revert safety so Clear All/Revert Last now call `discard_pending_edit` instead of accidentally applying pending edits.
- [x] **Codex Audit Fix:** Codex fixed hunk apply semantics so selecting zero hunks keeps the original content instead of applying all hunks.
- [x] **Codex Audit Fix:** Codex made pending edit listing include `beforeContent` and `content` so the Monaco diff viewer has real data.

**Gemini 3 Flash:** Done
**Codex audit:** Fixed critical discard/revert and hunk-apply bugs.
**Files changed:** `nvidia_playground.html`, `tools/agent-core.mjs`, `tools/nvidia-server.mjs`, `README.md`
**Verification:**

1. `node --check tools\nvidia-server.mjs`
2. `node --check tools\agent-core.mjs`
3. Inline script parse check for `nvidia_playground.html`
4. Core hunk/discard smoke test
5. `npm run agent:audit`

**Remaining limitations:**

- Side-by-side diff is intentionally read-only.
- Composer still needs a cleaner task persistence model in `.nvidia-agent/tasks`.
- There are still legacy duplicate extension helper functions in `nvidia_playground.html`; the later backend-backed definitions currently override them.

### Sprint 2: Context Picker

- Thêm UI chọn context:
  - Current file.
  - Selection.
  - Open files.
  - Git diff.
  - Terminal output.
  - Search results.
- Gán `@file`, `@folder`, `@git`, `@terminal`, `@problems`.
- Agent prompt bắt buộc trích dẫn context đã dùng.

Kết quả mong muốn:

- Bớt bớt trả lời lạc đề.
- Prompt của user ngắn nhưng agent vẫn có đủ context.

### Sprint 3: Terminal/Job Manager UX

- Thêm Job panel:
  - Running.
  - Completed.
  - Failed.
  - Cancel.
  - Rerun.
  - Attach output to chat.
- Log stdout/stderr theo chunk.
- Cho phép agent dùng `start_command_job` cho dev server/test watch.

Kết quả mong muốn:

- Gần Antigravity task execution hơn.

### Sprint 4: Enterprise/IDE Mode Toggle

- Tạo `uiMode` trong settings.
- Enterprise mode ẩn Explorer/Terminal/Extensions/Diff/Git.
- IDE mode hiện full workbench.
- Shortcut `Ctrl+Alt+Shift+I` để toggle.
- Lưu mode vào localStorage và `.nvidia-agent/profile.json`.

Kết quả mong muốn:

- Một app có hai mặt: demo chatbot doanh nghiệp và IDE thật.

### Sprint 5: Extension UX Tối Thiểu

- Extensions panel lấy installed/open-vsx từ backend thật.
- Install folder, install VSIX, install Open VSX.
- Activate extension.
- Run registered command.
- Hiện registered commands trong command palette.

Kết quả mong muốn:

- Cài và chạy extension local đơn giản như VS Code extension mini.

## Kế Hoạch Trung Hạn: 3-6 Tuần

Mục tiêu: biến hệ thống thành AI coding IDE khá mạnh, không chỉ chatbot có tools.

### 1. Monaco Workbench

- Multi-tab editor.
- Dirty state.
- Save/save all.
- Open recent files.
- Split editor.
- Minimap/outline.
- Problems panel.

### 2. LSP Integration

- TypeScript/JavaScript LSP.
- Python LSP.
- JSON/Markdown support.
- Diagnostics -> Problems panel.
- Go to definition, references, rename.

### 3. Real Semantic Index

- Tạo index cache trong `.nvidia-agent/index`.
- Chunk theo AST/symbol.
- Embedding provider:
  - NVIDIA embedding/rerank nếu có.
  - Fallback local lexical.
- Incremental update khi file thay đổi.
- Git-aware ranking: changed files và recent files ưu tiên hơn.

### 4. Extension API Phase 2

- `window.showQuickPick`.
- `window.showInputBox`.
- `window.createStatusBarItem`.
- `workspace.findFiles`.
- `workspace.createFileSystemWatcher`.
- `languages.registerCompletionItemProvider`.
- `languages.registerCodeActionsProvider`.
- `window.activeTextEditor`.
- TextDocument/TextEditor model tối thiểu.

### 5. Agent Orchestration

- Planner -> Coder -> Reviewer -> Tester pipeline.
- Task graph với checkpoint.
- Self-healing có giới hạn:
  - Chỉ sửa trong workspace trusted.
  - Chỉ chạy command approved/safe.
  - Stop sau N lần retry.
- Evaluation harness end-to-end cho 15 năng lực ban đầu.

### 6. Git UX

- Source control panel.
- View changes.
- Stage/unstage.
- Commit message AI.
- Branch view.
- Resolve conflict basic.

## Kế Hoạch Dài Hạn: 2-6 Tháng

Mục tiêu: san bằng những phần khó của VS Code/Cursor/Antigravity.

### 1. Full Extension Runtime Hơn

- Extension host process riêng.
- IPC boundary.
- Permission model per extension.
- Full hơn `vscode.*` APIs:
  - Webview.
  - TreeView.
  - Debug adapter.
  - Tasks.
  - SCM.
  - Authentication/secrets.
  - Notebooks nếu cần.

### 2. Real Terminal PTY

- Dùng `node-pty`.
- Terminal tabs.
- Shell profiles.
- Process tree management.
- Attach terminal output vào agent context.
- Agent có thể điều khiển terminal interactive có approval.

### 3. Debugger

- Debug adapter protocol.
- Node/Python debug configs.
- Breakpoints.
- Variables/watch/call stack.
- Agent đọc debug state và đề xuất fix.

### 4. Cursor-Style AI Editing

- Inline edit in editor.
- Tab autocomplete/code prediction.
- Multi-file composer.
- Apply/reject changes in editor.
- Background codebase indexing.
- Rules/memory per project.

### 5. Antigravity-Style Agent Workspace

- Task board.
- Browser automation.
- Multi-agent workers.
- Visual run logs.
- Safe auto-accept policy.
- Project-level skill packs.

### 6. Enterprise Packaging

- Electron auto update.
- Signed installer.
- Policy config.
- Offline mode.
- Private extension registry.
- Audit logs.
- Admin settings.

## Thứ Tự Ưu Tiên Nhanh Nhất Để Đạt UX AI Coding Agent IDE

Nếu mục tiêu là nhanh nhất có cảm giác ngang Antigravity/Cursor, hãy làm theo thứ tự này:

1. **Composer + timeline + changed files panel**.
2. **Monaco side-by-side diff + accept/reject hunk đẹp**.
3. **Context picker `@file`, `@folder`, `@git`, `@terminal`, `@selection`**.
4. **Job manager panel cho terminal/test/dev server**.
5. **Command palette gồm skills + extension commands + agent commands**.
6. **Enterprise/IDE mode toggle**.
7. **Semantic index cache + rerank**.
8. **LSP diagnostics/problems**.
9. **Extension compatibility phase 2**.
10. **PTY terminal và debugger**.

## Definition Of Done Cho Mốc Gần Cursor/Antigravity

Dự án có thể coi là đạt mốc UX AI coding agent IDE khi:

- User mở workspace và hỏi agent về codebase, agent tự search/đọc file đúng.
- User yêu cầu sửa feature, agent lập plan, sửa nhiều file, hiện changed files.
- User review diff side-by-side và accept/reject từng hunk.
- Agent chạy test/lint trong job panel, hiện output và tự sửa lỗi nếu được phép.
- User có thể stop/resume task.
- User có thể dùng context picker để đưa file/selection/git diff vào prompt.
- Enterprise mode ẩn hết IDE panels và trông như chatbot/tool desktop.
- IDE mode mở đầy đủ Explorer, Editor, Terminal, Diff, Extensions.
- Cài được extension local có `activate` và `registerCommand`.
- Open VSX search/install hoạt động cho extension đơn giản.

## Risk Và Nguyên Tắc Thiết Kế

- Không cố gắng clone toàn bộ VS Code ngay. Làm UX AI coding agent trước.
- Mỗi file write và command run phải qua trust/approval.
- Extension JS phải chạy trong sandbox/process riêng khi tiến tới production.
- Diff review là bắt buộc trước khi ghi file thật.
- Context engine phải tiết kiệm token và có bằng chứng file/line.
- Enterprise mode không được lộ các tính năng nguy hiểm như terminal/write file nếu chưa unlock IDE mode.
- ABW bridge không được bypass Continuation Kernel khi task có ghi file, chạy lệnh nguy hiểm, thay đổi quyết định đã khóa hoặc cập nhật tri thức đã duyệt.
- `.nvidia-agent` và `.brain` không được nhập nhằng: app runtime state thuộc `.nvidia-agent`; governed project cognitive state thuộc `.brain`.
- `raw/` chứa dữ liệu doanh nghiệp nhạy cảm phải được policy hóa trước khi version hoặc sync.

## Lệnh Kiểm Tra Hiện Tại

```bash
npm run agent:audit
node --check tools/nvidia-server.mjs
node --check tools/nvidia-cli-agent.mjs
node --check tools/extension-host.mjs
```

Báo cáo audit được ghi vào:

```text
.nvidia-agent/reports/
```

## HANDOFF_STATE_DO_NOT_REMOVE

```json
{
  "project": "NVIDIA NIM Agent IDE",
  "workflow": "Gemini 3 Flash implements roadmap items; Codex audits and fixes after each item",
  "last_completed_sprint": "Sprint 6: Monaco Workbench / Multi-tab Editor",
  "last_implementer": "Gemini 3 Flash",
  "last_auditor": "Codex",
  "last_audit_result": "Codex audited Sprint 6 and verified multi-tab editor behavior (no duplicate tab for same path), per-tab dirty state, Save/Save All pending-edit flow via /api/write_file with explicit X-Agent-Approved and trust checks, recent files path-only localStorage, enterprise-mode IDE guards for open/save actions, Sprint 1/2/3/4/5 static regression checks, mojibake scan patterns all zero, inline HTML parse pass, node --check pass (server/cli/extension-host/core), npm run agent:audit pass 25/25, and safe temp file save/apply smoke pass. Limitation: no full browser E2E visual validation.",
  "next_sprint": "Sprint 7: Semantic Index Cache / Context Engine",
  "next_prompt_instruction": "Ask Gemini 3 Flash to start from README.md Sprint 7 only, keep Sprint 1/2/3/4/5/6 behavior intact, then send results back to Codex for audit/fix",
  "status_marker_version": 1
}
```

Session rule: when continuing later, read `HANDOFF_STATE_DO_NOT_REMOVE` first. If Gemini 3 Flash has made new changes, Codex must audit, run checks, fix bugs, and update this block.
