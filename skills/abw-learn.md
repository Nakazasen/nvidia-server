---
description: Ghi một bài học hành vi vào lessons learned
---

# WORKFLOW: /abw-learn - Lessons Learned Recorder

Bạn là **Hybrid ABW Memory Steward**. Nhiệm vụ của bạn là chuyển một correction hoặc bài học tái sử dụng từ user thành một record JSONL trong `.brain/lessons_learned.jsonl`.

Lệnh này dùng khi user muốn agent nhớ một ràng buộc hành vi kiểu:

```text
/abw-learn "Đừng dùng regex để parse HTML; dùng parser phù hợp."
```

---

## Nguyên Tắc

- Chỉ ghi bài học có khả năng tái sử dụng trong tương lai.
- Không ghi tri thức domain chưa được grounding vào `wiki/`.
- Không biến một correction tạm thời thành luật vĩnh viễn nếu scope hoặc thời hạn chưa rõ.
- Không ghi secret, token, dữ liệu cá nhân, hoặc nội dung nhạy cảm vào `.brain/`.
- Nếu lesson mâu thuẫn với safety, grounding, hoặc instruction cấp cao hơn, báo conflict thay vì ghi mù.

---

## Input

User có thể cung cấp:

- lesson dạng text tự do
- scope, ví dụ `frontend`, `database`, `deploy`, `test`, `general`
- priority, một trong `low`, `medium`, `high`
- expiry, ví dụ `2026-12-31T00:00:00Z` hoặc `null`

Nếu thiếu field:

- `source`: dùng `user_instruction` hoặc `user_correction`
- `scope`: dùng `general` nếu không suy ra được scope hẹp hơn
- `priority`: dùng `medium`
- `expires_at`: dùng `null` nếu lesson là quy tắc ổn định; dùng expiry nếu user nói rõ đây là tạm thời
- `status`: luôn dùng `active` khi tạo mới

---

## Quy Trình

### 1. Chuẩn Hóa Lesson

Viết lesson thành một câu rõ ràng, có thể hành động được.

Không lưu câu mơ hồ như:

```text
Lần sau cẩn thận hơn.
```

Hãy đổi thành:

```text
Verify the target file exists before claiming a command was installed.
```

### 2. Kiểm Tra Trùng Lặp

Đọc `.brain/lessons_learned.jsonl` nếu file tồn tại.

- Nếu đã có lesson tương đương với `status="active"`, không append record mới.
- Nếu lesson cũ gần đúng nhưng scope/priority khác, báo cho user biết record hiện có và đề xuất update rõ ràng.
- Nếu file chưa tồn tại, tạo thư mục `.brain/` nếu cần rồi tạo file.

### 3. Append JSONL

Append đúng một dòng JSON hợp lệ:

```json
{"lesson":"Do not use regular expressions to parse HTML; use an HTML parser instead.","source":"user_instruction","scope":"backend","priority":"high","expires_at":null,"status":"active"}
```

Field bắt buộc:

- `lesson`: string
- `source`: string
- `scope`: string
- `priority`: `low` | `medium` | `high`
- `expires_at`: ISO-8601 string hoặc `null`
- `status`: `active`

### 4. Báo Cáo Ngắn

Sau khi ghi, trả lời ngắn:

- lesson đã ghi
- file đích
- scope / priority / expiry
- nếu không ghi, lý do cụ thể

---

## Output Mẫu

```text
Đã ghi vào .brain/lessons_learned.jsonl:
- lesson: Do not use regular expressions to parse HTML; use an HTML parser instead.
- scope: backend
- priority: high
- expires_at: null
```

---

## Restrictions

- Không sửa `wiki/` trong `/abw-learn`.
- Không tự thêm lesson nếu user chưa yêu cầu hoặc chưa có correction rõ ràng.
- Không overwrite toàn bộ `.brain/lessons_learned.jsonl`; chỉ append hoặc báo duplicate.
- Không ghi lesson trái với instruction hiện hành của user.
