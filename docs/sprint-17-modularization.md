# Sprint 17: Server Route Modularization Foundation

**Date**: 2026-05-02  
**Status**: BUILDER_DONE (first-pass)

## Objective

Begin Phase 2 with a modularization-first foundation sprint. Extract a low-risk, testable module boundary from the monolith `tools/nvidia-server.mjs` so future Sprint 18+ work can proceed without making the monolith worse.

## What Was Done

### New Module: `tools/routes/health-routes.mjs`

Created the first route module boundary. Exports `tryHandleHealthRoute(req, res, requestUrl, context)` which handles:

| Route | Method | Type | Status |
|---|---|---|---|
| `GET /api/health` | GET | New (safe read-only) | Returns `{ ok, status, uptime, workspace, port, version, node_version, diagnostics }` |
| `GET /api/tools` | GET | Extracted from monolith | Returns `{ tools: [...] }` - agent tools list |
| `GET /api/rate_limit` | GET | Extracted from monolith | Returns rate limit status |
| `GET /api/pending_edits` | GET | Extracted from monolith | Returns pending edits list |
| `GET /api/workspace` | GET | Extracted from monolith | Returns `{ path: currentWorkspace }` |

### Monolith Changes: `tools/nvidia-server.mjs`

- Added import: `import { tryHandleHealthRoute } from './routes/health-routes.mjs'`
- Added route delegation call before the GET handler block with a context object carrying `sendJSON`, `getDiagnosticsSummary`, `currentWorkspace`, `port`, `version`, `getAgentTools`, `getRateLimitStatus`, `workspaceCore`
- Removed 4 extracted inline route handlers to avoid duplication

### Smoke Coverage: `tools/browser-smoke.mjs`

Added 2 new checks:
- `API: GET /api/health returns running` - validates status=200, ok=true
- `API: /api/health contains uptime and workspace` - validates response fields

### Net Size Change

```
tools/browser-smoke.mjs | 11 ++
tools/nvidia-server.mjs | 17 ++++---- (24 insertions, 4 deletions)
tools/routes/health-routes.mjs | 47 lines (new file)
```

## Validation Evidence

| Gate | Result | Detail |
|---|---|---|
| `node --check` all files | PASS | No syntax errors |
| `npm run budget:check` | PASS | Budget report generated |
| `npm run runtime:hygiene` | PASS | DRY-RUN mode, no boundary violations |
| `npm run agent:audit` | PASS | 25/25 capabilities |
| `npm run browser:smoke -- --start-server --port 3456` | PASS | 99 passed / 0 failed, real-browser mode |

Browser smoke confirmed:
- All existing API endpoints (12 regression endpoints) still return 200
- New `/api/health` endpoint returns correct response shape
- Security/guard matrix: 16/16 actions secure
- Real endpoint guard regression pack: 10/10
- Code hygiene: no duplicate functions, no mojibake, div balance OK
- Server stopped cleanly, no orphan processes

## Behavior Preservation

All extracted routes maintain identical:
- URL
- Method (GET)
- Response shape
- Status code behavior
- No permission check was added or removed (the 4 extracted routes were already read-only/no-guard)

## Limitations / Carry-Over Risks

- `securityRotation`: NOT_ROTATED_YET (unchanged)
- `idleMemoryEstimateMb`: NOT_MEASURED_YET (unchanged)
- Monolith still large at ~3850 lines (net reduction of ~4 inline handlers)
- ABW bridge: not implemented
- No commit/push/stage performed
- Builder result is not final truth — audit/fix required before commit

## Scope Boundary Confirmation

- No ABW repo modified
- No control repo modified
- No ABW bridge implemented
- No commit/push/stage performed
- No Sprint 18 work started
