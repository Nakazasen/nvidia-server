---
description: Dry-run hoặc execute NotebookLM sync cho một ABW package
---

# WORKFLOW: /abw-sync

**Mục đích:** Đồng bộ một package được sinh bởi `/abw-pack` lên NotebookLM bằng `nlm`, với `dry-run` là mặc định. Lệnh này không xóa source trong NotebookLM và không upload nếu người dùng chưa yêu cầu `--execute`.

## Hướng dẫn cho AI

1. Xác định package cần sync, ví dụ `notebooks/packages/<package_id>`.
2. Xác định NotebookLM notebook ID hoặc alias. Nếu user chưa cung cấp, hỏi một câu ngắn để lấy đúng notebook ID.
3. Chạy dry-run trước:

```powershell
python "$env:USERPROFILE\\.gemini\\antigravity\\scripts\\abw_sync.py" `
  --package-dir notebooks/packages/<package_id> `
  --notebook-id <notebook_id>
```

Bash / macOS / Linux:

```bash
python "$HOME/.gemini/antigravity/scripts/abw_sync.py" \
  --package-dir notebooks/packages/<package_id> \
  --notebook-id <notebook_id>
```

4. Đọc JSON stdout và `sync_report.json`, rồi báo cáo:
   - package ID
   - `qa_status`
   - số source sẽ upload
   - danh sách source
   - trạng thái `dry_run`, `blocked`, hoặc `synced`
5. Chỉ chạy upload thật khi người dùng xác nhận rõ:

```powershell
python "$env:USERPROFILE\\.gemini\\antigravity\\scripts\\abw_sync.py" `
  --package-dir notebooks/packages/<package_id> `
  --notebook-id <notebook_id> `
  --execute
```

## Quy tắc an toàn

- Không sync package `fail`
- Không sync package `needs_review` trừ khi user yêu cầu rõ và dùng `--allow-needs-review`
- Không xóa source NotebookLM trong phase này
- Không tự tạo notebook mới nếu user chưa yêu cầu rõ
- Nếu `nlm` lỗi auth hoặc network, báo lỗi và dừng; không retry hung hăng
