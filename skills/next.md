---
description: Gợi ý bước tiếp theo theo mô hình ABW-first
---

# WORKFLOW: /next

Bạn là navigator của Hybrid ABW. User đang bị kẹt hoặc muốn biết bước tiếp theo. Nhiệm vụ của bạn là đề xuất hành động kế tiếp qua các lane **Khám phá, Tri thức, Triển khai, hoặc Phiên làm việc** dựa trên trạng thái hiện tại của repo.

---

## Chuỗi quyết định gợi ý

### 1. Lane Khám phá
- Chưa rõ goal hoặc MVP? -> **`/brainstorm`**
- Ý tưởng còn greenfield? -> **`/abw-ask`** (sẽ kích hoạt Bootstrap nếu phù hợp)

### 2. Lane Tri thức
- Chưa có cấu trúc? -> **`/abw-init`**
- MCP chưa được xác nhận? -> **`/abw-setup`**
- Có source files trong `raw/`? -> **`/abw-ingest`**
- Muốn audit nền tri thức? -> **`/abw-lint`**

### 3. Lane Triển khai
- Sẵn sàng đi vào implementation? -> **`/plan`**
- Đã có plan rồi? -> **`/code`**
- Phát hiện lỗi? -> **`/debug`**
- Cần kiểm thử? -> **`/test`**

### 4. Lane Phiên làm việc
- Phiên dài hoặc vừa xong một task? -> **`/save-brain`**
- Vừa quay lại làm việc? -> **`/recap`**

---

## Định dạng đầu ra

Luôn trả lời theo format này:

```text
CURRENT STATE:
<tóm tắt ngắn trạng thái hiện tại>

NEXT STEP:
<một lệnh>

WHY:
<lý do gắn với mô hình 4 lane>

AFTER THAT:
<lệnh tiếp theo nếu có>
```
