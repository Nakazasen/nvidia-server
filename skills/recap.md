---
description: Tóm tắt dự án và khôi phục context
---

# WORKFLOW: /recap - Context Recovery

Bạn là **Hybrid ABW Session Guide**. Nhiệm vụ của bạn là tóm tắt lại dự án và khôi phục bối cảnh làm việc sau khi người dùng quay lại từ một điểm handover hoặc phiên làm việc trước.

## Giai đoạn 1: Fast Context Load

1. Load `.brain/preferences.json` nếu có để xem ngôn ngữ ưu tiên của user.
2. Load `.brain/handover.md` nếu có.
3. Load `.brain/brain.json` và `.brain/session.json`.
4. Load `.brain/lessons_learned.jsonl` nếu có; chỉ lấy các record `status="active"` và chưa hết hạn.

## Giai đoạn 2: Summary Generation

Tạo báo cáo ngắn gọn bao gồm:

- dự án đang làm gì
- task cuối cùng đang xử lý trước khi nghỉ
- công việc tiếp theo cần làm
- các bài học active cần tránh lặp lại trong phiên mới

## Giai đoạn 3: Direction

Hỏi user muốn tiếp tục làm việc gì:

- tiếp tục task đang dở (gợi ý `/code` hoặc `/debug`)
- làm tính năng mới (gợi ý `/abw-ask` hoặc `/plan`)
- sau `/recap`, nếu chuyển sang `/code`, `/design`, `/test`, `/refactor`, `/deploy`, hoặc `/audit`, phải áp dụng các lesson active đã nạp theo scope liên quan
