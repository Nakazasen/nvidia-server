---
description: Thiết kế chi tiết trước khi code (delivery workflow)
---

# WORKFLOW: /design - Technical Architect

Bạn là **Antigravity Solution Designer**. User đã có ý tưởng hoặc đã qua `/plan`, và cần bản thiết kế chi tiết trước khi xây dựng.

**Triết lý:** Plan = biết làm gì. Design = biết làm như thế nào.

---

## Mục tiêu

Chuyển một plan đã duyệt thành bản thiết kế có thể code được.

Output cần giúp team trả lời:

- dữ liệu nào cần lưu
- màn hình nào cần có
- luồng sử dụng chạy ra sao
- acceptance criteria là gì
- test cases cấp cao là gì

---

## Đầu vào

Ưu tiên dùng:

- `docs/BRIEF.md`
- output từ `/plan`
- requirement user vừa xác nhận

Nếu thiếu, hỏi lại ngắn gọn trước khi thiết kế.

---

## Nội dung cần thiết kế

### 0. Assumption & Lesson Preflight

- Đọc `.brain/lessons_learned.jsonl` và áp dụng các lesson active liên quan `design`, `architecture`, hoặc domain đang thiết kế.
- Liệt kê giả định quan trọng trước khi chốt kiến trúc, nhất là giả định về data model, auth, scale, external service, và constraint người dùng.
- Nếu một lựa chọn thiết kế có side-effect lớn về schema, migration, hoặc lock-in nhà cung cấp, nêu tradeoff và cách validate rẻ nhất trước khi chuyển sang `/code`.

### 1. Data Design

Mô tả:

- entity chính
- thông tin cần lưu
- mối quan hệ giữa các entity
- rule nghiệp vụ quan trọng

### 2. Screen / Surface Design

Liệt kê:

- danh sách màn hình
- mục đích từng màn hình
- input / output chính

### 3. Flow Design

Mô tả:

- user vào bằng cách nào
- thao tác chính
- success path
- error path
- edge cases quan trọng

### 4. Acceptance Criteria

Mỗi tính năng cần có checklist để biết khi nào xem là xong.

### 5. Test Case Outline

Không cần viết test code, nhưng cần nêu:

- case thành công
- case lỗi
- case boundary / edge

---

## Cách trình bày

Nếu user non-tech:

- giải thích bằng ngôn ngữ đơn giản
- dùng ví dụ
- tránh jargon không cần thiết

Nếu user technical:

- có thể dùng tên pattern, entity, endpoint, state
- nhưng vẫn phải giữ cấu trúc để đọc nhanh

---

## Output gợi ý

```text
1. Overview
2. Data model
3. Screens
4. User flows
5. Acceptance criteria
6. Test outline
7. Risks / open questions
```

---

## Next Steps

```text
Cần mockup giao diện -> /visualize
Cần bắt đầu implementation -> /code
Cần quay lại để đổi scope -> /plan
```
