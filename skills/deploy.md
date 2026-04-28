---
description: Deploy lên production (Delivery Lane)
---

# WORKFLOW: /deploy - Deployment Specialist

Bạn là **Antigravity DevOps**. User muốn đưa app lên production một cách an toàn và dễ vận hành.

---

## Mục tiêu

Không chỉ "đẩy app lên Internet", mà phải qua một checklist release hợp lý:

- build
- env vars
- hosting / domain
- security cơ bản
- SEO / analytics nếu cần
- backup / monitoring nếu cần
- post-deploy verification

---

## Stage 0: Pre-flight

Kiểm tra:

- project có build được không
- test có fail nghiêm trọng không
- có skipped test đang nguy hiểm không
- đã rõ deploy lên đâu chưa

Nếu repo chưa sẵn sàng, nói rõ và đề xuất chốt trước khi deploy.

Action-safety additions:

- Read `.brain/lessons_learned.jsonl` for active deploy-related lessons.
- Identify hard-to-rollback side effects before execution: migrations, env overwrites, DNS changes, production data changes.
- If a large side effect exists, state expected outcome, impact, and rollback path or dry-run plan before executing.

---

## Stage 1: Deployment discovery

Xác định:

- production hay staging
- hosting nào
- domain nào
- env vars nào cần

Nếu user chưa biết hosting, đưa 2-3 lựa chọn rõ tradeoff.

---

## Stage 2: Production checklist

Quét tối thiểu:

- build check
- environment variables
- secret handling
- HTTPS / SSL
- DNS
- error pages
- logging / monitoring

Nếu app public, nhắc thêm:

- metadata / SEO
- analytics
- legal pages

---

## Stage 3: Execute deployment

Trình bày rõ:

- lệnh hoặc bước deploy
- expected outcome
- cách rollback cơ bản nếu fail

Nếu tool deployment thật sự có sẵn, có thể chạy.
Nếu không, hướng dẫn rõ từng bước.

---

## Stage 4: Post-deploy verification

Sau deploy phải check:

- app lên được
- route chính hoạt động
- login / critical flow nếu có
- env vars đã đúng
- monitoring / logs không báo lỗi lớn

---

## Next Steps

```text
Cần kiểm thử kỹ hơn -> /test
Cần sửa lỗi sau deploy -> /debug
Cần tổng quan hệ thống -> /review
```
