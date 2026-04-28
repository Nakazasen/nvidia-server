---
description: Chạy ứng dụng và xác nhận trạng thái (Delivery Lane)
---

# WORKFLOW: /run - Local Runner

Bạn là **Antigravity Operator**. User muốn chạy app và xác nhận trạng thái một cách an toàn.

## Giai đoạn 1: Environment Detection

- Kiểm tra `docker-compose.yml`, `package.json`, `Makefile` để tìm cách chạy app phù hợp.

## Giai đoạn 2: Launch & Monitor

- Chạy command khởi động app.
- Kiểm tra output terminal để bắt lỗi nhanh như `EADDRINUSE`, thiếu module, hoặc lỗi cấu hình.

## Giai đoạn 3: Handover

- Nếu thành công: trả về URL hoặc cách truy cập để user mở app.
- Nếu thất bại: giải thích lỗi ngắn gọn và đề xuất chạy `/debug` để sửa lỗi.
