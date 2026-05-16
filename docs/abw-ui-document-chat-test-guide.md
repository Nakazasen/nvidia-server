# ABW UI Document Chat Test Guide

Muc tieu: test luong workspace -> ingest -> review/promote (fail-closed hoac co ket qua) -> ABW chat, khong can CLI.

## 1) Chuan bi

1. `git pull` repo NVIDIA moi nhat.
2. Chay UI/server: `node tools/nvidia-server.mjs` (hoac lenh start thuong dung cua ban).
3. Mo UI tren browser.

## 2) Switch workspace

1. Bam `Change...` trong khu Workspace.
2. Chon workspace duoc trust cho ingest/review.
3. Bam `Refresh ABW status`.
4. Xac nhan:
- Active workspace dung.
- Workspace trust la `trusted`.
- Runtime source/ABW repo path hien thi.

## 3) Tao du lieu raw de ingest

1. Trong workspace, tao thu muc `raw/` neu chua co.
2. Copy 1-3 file test vao `raw/` (vd `.md`, `.txt`).
3. Co the them 1 file unsupported de test canh bao.

## 4) Ingest tu UI

1. Vao panel `ABW Ingest / Nap tai lieu ABW`.
2. Bam `Ingest raw`.
3. Kiem tra loading state va ket qua:
- `ingested`, `skipped`
- `unsupported_files`
- `parse_errors`
- `generated_drafts`
- `review_required`, `promotion_performed`
- `warnings`
4. Neu ABW fail, UI phai hien loi that, khong fake success.

## 5) Review / Promote

1. Vao panel `ABW Review / Drafts`.
2. Bam `Review drafts` de lay tong quan review.
3. Neu co draft, dien 1 `draftPath` va bam `Promote selected draft`.
4. Ky vong sprint hien tai:
- Neu promote contract JSON chua an toan: endpoint fail-closed, co thong bao `manual review required`.
- Khong auto-promote toan bo draft.

## 6) Hoi ABW Chat

1. Vao panel `ABW Chat`.
2. Dat cau hoi lien quan tai lieu vua ingest.
3. Bam `Hoi ABW`.
4. Kiem tra card ket qua co:
- `answer`
- `retrieval_status`
- `trust_score`
- `evidence_tier`
- `sources`
- `warnings`
- no_match ro rang khi thieu nguon

## 7) Safety checks

1. Khong co `Apply` tu ABW bridge path.
2. Khong co sync/write-back ngoai workspace.
3. Khong co execute_command tuy y.
4. Ask read-only khong tao pending edit.

## 8) Neu gap du lieu nhay cam

- Dung lai va sanitize truoc khi ingest.
- Khong dua raw tai lieu nhay cam vao test flow.
