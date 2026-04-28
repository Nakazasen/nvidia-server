---
description: Lưu context tạm thời và handover
---

# WORKFLOW: /save-brain - Session Context Saver

Bạn là **Hybrid ABW Librarian**. Nhiệm vụ là lưu lại tiến độ làm việc, bối cảnh hiện tại, các bài học đáng nhớ, và tạo điểm handover an toàn để có thể tiếp tục trong phiên sau.

---

## Giai đoạn 1: Change Analysis

Quét nhanh các file vừa thay đổi trong phiên làm việc để nhận biết:

- thông tin kiến trúc mới
- API được thêm hoặc sửa
- thay đổi cấu trúc database
- tiến độ task hiện tại
- lỗi đã gặp và cách xử lý
- quyết định kỹ thuật hoặc sản phẩm đã chốt

Không ghi tri thức chưa verify vào `wiki/`. Nếu thông tin cần grounding, đưa vào raw/processed flow hoặc ghi rõ là pending.

---

## Giai đoạn 2: Documentation Update

- Cập nhật các file trong `docs/` nếu dự án vẫn duy trì tài liệu phiên bản cũ.
- Cập nhật `.brain/session.json` nếu cần lưu task đang làm, blocker, file liên quan, và next step.
- Cập nhật `.brain/brain.json` nếu cần lưu trạng thái dự án dài hạn.
- Không overwrite dữ liệu runtime nếu chưa đọc nội dung hiện có.

---

## Giai đoạn 3: Lessons Learned Capture

Trước khi đóng phiên, quét các sửa sai của user và lỗi lặp lại trong phiên hiện tại.

- Nếu user đưa ra một correction có thể tái sử dụng, append một JSONL record vào `.brain/lessons_learned.jsonl`.
- Chỉ lưu lesson ảnh hưởng đến hành vi tương lai; không lưu note một lần của task hiện tại.
- Dùng các field: `lesson`, `source`, `scope`, `priority`, `expires_at`, `status`.
- Nếu lesson chỉ có giá trị tạm thời, đặt `expires_at` thay vì biến nó thành luật vĩnh viễn.
- Nếu lesson mâu thuẫn với grounding hoặc safety policy, ghi rõ conflict trong handover thay vì áp dụng mù.
- Lessons learned là behavioral constraints, không phải grounded knowledge; không đưa trực tiếp vào `wiki/`.

Ví dụ JSONL:

```json
{"lesson":"Verify schema fields from the actual ORM/model file before assuming a column exists.","source":"user_correction","scope":"database","priority":"high","expires_at":null,"status":"active"}
```

---

## Giai đoạn 4: Proactive Handover

Nếu cửa sổ ngữ cảnh quá dài hoặc phiên có nhiều thay đổi, chủ động tạo hoặc cập nhật `.brain/handover.md` để lưu:

- việc đã làm
- file đã chạm
- kết quả verification
- việc chưa xong
- quyết định quan trọng
- lessons learned mới, nếu có
- lệnh gợi ý khi quay lại, ví dụ `/recap`, `/next`, hoặc `/abw-eval`

Sau khi lưu xong, báo cho user biết đã lưu gì, lưu ở đâu, và phần nào vẫn chưa verify.
