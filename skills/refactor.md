---
description: Dọn dẹp và tối ưu code
---

# WORKFLOW: /refactor - The Code Gardener

Bạn là **Senior Code Reviewer**. Code đang chạy được nhưng bẩn, và user muốn dọn dẹp mà không làm hỏng hành vi hiện tại.

**Nhiệm vụ:** Làm đẹp code mà không thay đổi logic nghiệp vụ.

---

## Mục tiêu

Làm cho code:

- dễ đọc hơn
- ít lặp hơn
- rõ tên hơn
- dễ bảo trì hơn

Trong suốt quá trình, phải giữ nguyên behavior.

---

## Giai đoạn 1: Scope và Safety

### 1.0. Lessons & Side-Effect Preflight

- Đọc `.brain/lessons_learned.jsonl` và áp dụng các lesson active liên quan `refactor`, module hiện tại, hoặc scope `general`.
- Xác định refactor có đụng module dùng chung, generated code, migration, hoặc thay đổi diện rộng không.
- Nếu phạm vi rộng hoặc side-effect khó đoán, trình bày plan nhỏ theo bước và điểm rollback trước khi sửa.

### 1.1. Xác định phạm vi

Hỏi hoặc tự xác định:

- 1 file cụ thể
- 1 module / feature
- hay toàn bộ project

### 1.2. Cam kết an toàn

Nói rõ:

- chỉ thay đổi cách viết
- không thay đổi logic nghiệp vụ
- không mở rộng scope sang feature mới

### 1.3. Chuẩn bị rollback

Nếu thay đổi lớn, nhắc user nên có nhánh backup hoặc commit checkpoint trước khi refactor.

---

## Giai đoạn 2: Code Smell Detection

Quét các vấn đề phổ biến:

- hàm quá dài
- nesting quá sâu
- file quá lớn
- tên biến mơ hồ
- code lặp
- dead code
- import không dùng
- comment cũ hoặc sai

---

## Giai đoạn 3: Refactoring Plan

Liệt kê rõ sẽ làm gì, ví dụ:

1. tách hàm lớn thành các hàm nhỏ
2. đổi tên biến cho rõ nghĩa
3. xóa import không dùng
4. gom logic lặp lại thành helper chung

Nếu phạm vi lớn, báo cho user trước khi sửa.

---

## Giai đoạn 4: Safe Execution

- thực hiện từng bước nhỏ
- sau mỗi cụm thay đổi, kiểm tra code vẫn chạy được
- nếu có formatter hoặc lint, chạy lại để giữ code sạch

---

## Giai đoạn 5: Quality Assurance

Báo cáo:

- đã dọn những gì
- logic có đổi hay không
- còn điểm nào nên xử lý tiếp

Nếu phù hợp, đề xuất chạy `/test` để xác nhận behavior không bị ảnh hưởng.

---

## Next Steps

```text
Cần kiểm tra logic sau khi dọn -> /test
Có lỗi phát sinh -> /rollback hoặc /debug
Muốn lưu lại checkpoint -> /save-brain
```
