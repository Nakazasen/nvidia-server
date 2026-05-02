# Sprint 19: Runtime Hygiene / Budget Follow-up

**Date**: 2026-05-02  
**Status**: BUILDER_DONE (first-pass)

## Objective

Directly address carry-over governance risks from previous phases:
- `securityRotation: NOT_ROTATED_YET` - add structured reporting
- `idleMemoryEstimateMb: NOT_MEASURED_YET` - add actual measurement

## What Was Improved

### A. `tools/performance-budget.mjs` - Idle Memory Measurement

**New function**: `measureProcessMemory(pid)`
- Uses Windows `tasklist /FI "PID eq <pid>" /FO CSV /NH` to read working-set memory
- Parses the K column and converts to MB
- Returns structured result with explicit status fields

**New fields in `serverStart` report**:
| Field | Type | Description |
|---|---|---|
| `idleMemoryEstimateMb` | number or string | Measured MB or `NOT_MEASURED_YET` |
| `idleMemoryStatus` | string | `MEASURED` or `UNAVAILABLE` |
| `idleMemoryReason` | string or null | Explanation if not measured |
| `idleMemoryMethod` | string or null | Measurement method used |
| `idleMemoryPid` | number or null | Server PID (if safe) |

**Memory measurement result** (Sprint 19 baseline):
- idleMemoryEstimateMb: measured in latest budget report
- idleMemoryStatus: `MEASURED` when tasklist parse succeeds; otherwise `UNAVAILABLE`
- idleMemoryMethod: `tasklist /FI (Windows) working-set K -> MB`

**Behavior preserved**:
- Server process cleanup remains safe (taskkill fallback on Windows)
- Report outputs preserved: `.nvidia-agent/reports/performance-budget.json` and `.md`
- No secrets printed
- Measurement is best-effort; structured fallback states on failure

### B. `tools/runtime-hygiene.mjs` - Security Log Evidence

**New function**: `getSecurityLogDetails(dirPath)`
- Reads files under `.nvidia-agent/security/`
- Computes total bytes, line count for `.jsonl`, and per-file details
- Sets `securityLogStatus`: `OK`, `LARGE`, `EMPTY`, `PARTIAL`, or `UNREADABLE`

**New fields in hygiene summary**:
| Field | Description |
|---|---|
| `securityLogStatus` | `OK` / `LARGE` / `EMPTY` / `PARTIAL` / `UNREADABLE` |
| `securityLogBytes` | Total bytes in security log files |
| `securityLogLines` | Total lines across `.jsonl` security files |
| `securityLogFiles` | Count of security log files |
| `securityLogErrors` | Read/stat/readdir issues (if any) |
| `securityRotationReason` | Human-readable explanation of rotation status |

**Security rotation behavior**:
- `securityRotation` remains `NOT_ROTATED_YET`
- Detection/reporting only; no auto-rotation or auto-delete added

**Dry-run default preserved**:
- `--apply` must be explicit; no destructive default behavior
- Deletion remains strictly bounded under `.nvidia-agent`
- Boundary guard uses realpath checks

## Dry-Run Guarantee

- Runtime hygiene defaults to dry-run mode
- `--apply` flag must be explicit
- `--apply` and `--dry-run` conflict is rejected
- No destructive operations run during dry-run validation
- Memory measurement is read-only (`tasklist` query only)

## Validation Commands

```bash
# Syntax
node --check tools/performance-budget.mjs
node --check tools/runtime-hygiene.mjs
node --check tools/nvidia-server.mjs
node --check tools/browser-smoke.mjs
node --check tools/agent-core.mjs

# Gates
npm run budget:check
npm run runtime:hygiene
npm run agent:audit
npm run browser:smoke -- --start-server --port 3456

# Git safety
git status --short
git diff --stat
git status --short .nvidia-agent
```

## Limitations

- `securityRotation` is still `NOT_ROTATED_YET` (detection/reporting only)
- Idle memory is startup-point measurement, not continuous monitoring
- Memory measurement is Windows `tasklist` based and best-effort
- Browser smoke remains baseline evidence, not full E2E proof

## Non-Claims

- Not production-ready
- Not Cognitive OS achieved
- Not VS Code parity
- Not Cursor parity
- Not enterprise-grade security
- Full ABW bridge not implemented
- ABW ingest not implemented
- Self-growing wiki not implemented
- Autonomous self-learning not implemented
- No Sprint 20 work started
