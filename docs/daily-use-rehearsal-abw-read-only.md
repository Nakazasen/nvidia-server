# Bounded Daily-Use Rehearsal: ABW Read-Only

Date: 2026-05-16

Scope:
- Synthetic/non-sensitive rehearsal only
- NVIDIA repo runtime at `3d32881a567ed15791dc44d499bf6f2d6c581e09`
- ABW repo runtime at `de1d8560d3a26000fb113e0acbfe947bd785f721`
- Control repo was not mutated

Temp workspace:
- `D:\Sandbox\_daily_use_rehearsal\rerun_home_abwcheck_20260516_063859`

Synthetic files created:
- `raw/agv_manual.md`
- `raw/maintenance_note.txt`
- `raw/broken.docx`
- `raw/unsupported.xyz`
- `wiki/agv.md`

## Ingest result

- ingested: `2`
- skipped: `2`
- unsupported: `raw/unsupported.xyz`
- parse errors: `raw/broken.docx` -> `invalid zip container`
- generated drafts:
  - `drafts/agv-manual_draft.md`
  - `drafts/maintenance-note_draft.md`
- review_required: `true`
- promotion_performed: `false`
- warnings:
  - `1 unsupported file(s) skipped.`
  - `1 parse error file(s) skipped.`
  - `Drafts were created and still require review before any trusted wiki use.`

## Direct ABW JSON

Environment:
- `PYTHONPATH` set to repo `src`
- `ABW_READ_ONLY_QUERY=1`

Results:
- `What protocol does the AGV use for dispatch messages?`
  - status: `success`
  - retrieval_status: `fuzzy_match`
  - trust_score: `72`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - read-only suppression: `runtime_write_suppressed=true`
  - `.brain` mutation during ask: `false`
- `What should be checked before each shift?`
  - status: `success`
  - retrieval_status: `fuzzy_match`
  - trust_score: `72`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - read-only suppression: `runtime_write_suppressed=true`
  - `.brain` mutation during ask: `false`
- `Who approved the AGV supplier contract?`
  - status: `no_match`
  - retrieval_status: `no_match`
  - trust_score: `0`
  - evidence tier: `E0_unknown`
  - sources: none
  - warnings: `No supporting sources were returned.`
  - read-only suppression:
    - `gap_log_suppressed=true`
    - `would_log_gap=true`
    - `runtime_write_suppressed=true`
  - `.brain` mutation during ask: `false`
- `AGV dùng giao thức gì để nhận lệnh điều phối?`
  - status: `success`
  - retrieval_status: `fuzzy_match`
  - trust_score: `70`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - read-only suppression: `runtime_write_suppressed=true`
  - `.brain` mutation during ask: `false`

## NVIDIA bridge and UI

Bridge runtime metadata:
- `runtimeSource=repo`
- `abwRepoPath=D:\Sandbox\skill-Anti-brain-wiki_note`
- command path: `py -m abw.cli --json --workspace <temp> <command>`
- active trusted workspace: `D:\Sandbox\_daily_use_rehearsal\rerun_home_abwcheck_20260516_063859`

Bridge results:
- `POST /proxy/abw/version`
  - status: `ABW_CLI_OK`
  - repo runtime preserved
- `POST /proxy/abw/doctor`
  - status: `ABW_CLI_OK`
  - workspace health: `WARN`
  - warnings:
    - `corpus readiness partial_supported_corpus`
    - `release match could not be verified from git tag`
- `POST /proxy/abw/ask` protocol question
  - status: `ABW_CLI_OK`
  - retrieval_status: `fuzzy_match`
  - trust_score: `72`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - `.brain` mutation during ask: `false`
- `POST /proxy/abw/ask` maintenance question
  - status: `ABW_CLI_OK`
  - retrieval_status: `fuzzy_match`
  - trust_score: `72`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - `.brain` mutation during ask: `false`
- `POST /proxy/abw/ask` supplier-contract question
  - status: `ABW_CLI_NO_MATCH`
  - retrieval_status: `no_match`
  - trust_score: `0`
  - evidence tier: `E0_unknown`
  - sources: none
  - warnings: `No supporting sources were returned.`
  - read-only indicators:
    - `readOnly=true`
    - `runtimeWriteSuppressed=true`
    - `gapLogSuppressed=true`
    - `wouldLogGap=true`
  - `.brain` mutation during ask: `false`
- `POST /proxy/abw/ask` Vietnamese question
  - status: `ABW_CLI_OK`
  - retrieval_status: `fuzzy_match`
  - trust_score: `70`
  - evidence tier: `E2_wiki`
  - source: `wiki\agv.md`
  - `.brain` mutation during ask: `false`

UI command results:
- `/abw-ask What protocol does the AGV use for dispatch messages?`
  - displayed status: `ABW_CLI_OK`
  - displayed retrieval: `fuzzy_match`
  - displayed trust: `72`
  - displayed evidence: `E2_wiki`
  - displayed source: `wiki\agv.md`
  - displayed read-only pills:
    - `read-only bridge: true`
    - `runtimeWriteSuppressed: true`
    - `gapLogSuppressed: false`
    - `wouldLogGap: false`
  - `.brain` mutation during ask: `false`
- `/abw-ask Who approved the AGV supplier contract?`
  - displayed status: `ABW_CLI_NO_MATCH`
  - displayed retrieval: `no_match`
  - displayed trust: `0`
  - displayed evidence: `E0_unknown`
  - displayed warning: `No supporting sources were returned.`
  - displayed read-only pills:
    - `read-only bridge: true`
    - `runtimeWriteSuppressed: true`
    - `gapLogSuppressed: true`
    - `wouldLogGap: true`
  - `.brain` mutation during ask: `false`

## Mutation safety

- Control repo remained clean
- NVIDIA repo remained clean before this evidence doc
- ABW repo remained clean
- no pending edits were created
- no Apply action ran
- no sync/write-back occurred
- no query-time runtime writes occurred in `.brain` during direct ABW, bridge, or UI `/abw-ask`

## Regression rerun

- `npm test`: PASS
- `py -m pytest tests/test_abw_ingest.py tests/test_abw_json_hardening.py tests/test_abw_api.py tests/test_abw_runner.py`: PASS

## Limitations and non-claims

- not `DAILY_USE_READY`
- not production-ready
- not full bridge ready
- synthetic rehearsal only
- real private/work documents were not tested
- parser coverage remains bounded
- browser smoke still reports the existing non-blocking warning: `Inline edit widget opens from selection: widget not observable in current smoke state`
