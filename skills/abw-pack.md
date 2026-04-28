---
description: Đóng gói tri thức cho NotebookLM (Orchestrator Mode)
---

# WORKFLOW: /abw-pack

**Mục đích:** Giải quyết giới hạn source của NotebookLM bằng quy trình đóng gói xác định. Lệnh này gọi script Python để tổng hợp các note trong `wiki/` thành các package gọn nhưng vẫn giữ truy vết.

**Hướng dẫn dành cho AI (Orchestrator):**
Từ phase này trở đi, không tự tay parse wiki và tạo package bằng LLM. Nhiệm vụ của bạn là chạy script Python và trình bày Approval Menu cho người dùng.

> Lưu ý: Trên clone sạch, muốn `/abw-pack` đạt `pass` thì cần chạy `/abw-ingest` trước hoặc phải có `processed/manifest.jsonl` hợp lệ.

---

## Các bước thực hiện

### 1. Khởi chạy packager script

Sử dụng script đã cài sẵn:

**Bash / macOS / Linux**
```bash
POLICY_FILE=".brain/pack_policy.json"
if [ ! -f "$POLICY_FILE" ]; then
  POLICY_FILE="$HOME/.gemini/antigravity/templates/notebook_pack_policy.example.json"
fi

python ~/.gemini/antigravity/scripts/abw_pack.py \
  --workspace . \
  --policy "$POLICY_FILE" \
  --output notebooks/packages \
  --package-id auto
```

**PowerShell / Windows**
```powershell
$PolicyFile = ".brain\\pack_policy.json"
if (-not (Test-Path $PolicyFile)) {
    $PolicyFile = "$env:USERPROFILE\\.gemini\\antigravity\\templates\\notebook_pack_policy.example.json"
}

python "$env:USERPROFILE\\.gemini\\antigravity\\scripts\\abw_pack.py" `
  --workspace . `
  --policy $PolicyFile `
  --output notebooks/packages `
  --package-id auto
```

Nếu đang chạy trực tiếp trong repo local, có thể thay đường dẫn script bằng `scripts/abw_pack.py`.

### 2. Đọc exit code và báo cáo

Phân tích exit code:

- `0`: pass
- `1`: runtime error
- `2`: needs review
- `3`: fail

Đọc JSON stdout của script và tóm tắt thành operator report:

- số source đã phát hiện
- số file critical được giữ nguyên
- số package đã tạo
- package nào cần review

### 3. Phục vụ Approval Menu

Dừng lại cho người dùng quyết định:

- `approve package`: duyệt package cho phase sync
- `reject package`: cập nhật `package_manifest.json` thành `package_status: rejected`
- `force keep <file>` / `force compress <file>`: tạo hoặc sửa `.brain/pack_policy.json`, sau đó chạy lại script

Nếu QA báo lỗi, tham chiếu `skills/notebooklm-knowledge-packager.md` để giải thích rõ lý do.
