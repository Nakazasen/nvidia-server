import fs from 'fs';
import path from 'path';
import os from 'os';
import { preflight } from '../tools/bridge-preflight.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS: ${testName}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL: ${testName}${detail ? ' - ' + detail : ''}\n`);
    failures.push({ test: testName, detail });
  }
}

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-preflight-test-'));
  fs.mkdirSync(path.join(dir, '.brain'), { recursive: true });
  return dir;
}

function makeReport(tmp, overrides = {}) {
  const report = {
    schema_version: 'abw.ingest_report.v1',
    run_id: 'run-test-20260503T120000',
    created_at: '2026-05-03T12:00:00Z',
    workspace: tmp,
    command: 'ingest raw/test.md',
    summary: {
      ingested_count: 1,
      skipped_count: 0,
      failed_count: 0,
      quarantined_count: 0,
      draft_count: 1,
      manifest_count: 1,
      queue_count: 1
    },
    items: [{
      source_path: 'raw/test.md',
      source_id: 'ingest-abc123',
      content_hash: 'abcdef123456',
      status: 'draft_created',
      draft_path: 'drafts/test_draft.md',
      manifest_status: 'review_needed',
      queue_status: 'review_needed',
      review_state: 'low_confidence',
      promotion_state: 'review_needed',
      domain_check: {},
      skip_reason: null,
      failure_reason: null
    }],
    safety: {
      auto_promote_default: false,
      promotion_mode: 'review_required',
      domain_guard_active: false
    },
    limitations: []
  };
  Object.assign(report, overrides);
  fs.writeFileSync(path.join(tmp, '.brain', 'ingest_report.json'), JSON.stringify(report, null, 2), 'utf8');
}

function makeGaps(tmp, overrides = {}) {
  const gaps = {
    schema_version: 'abw.ingest_gaps.v1',
    run_id: 'run-test-20260503T120000',
    created_at: '2026-05-03T12:00:00Z',
    workspace: tmp,
    gap_summary: { total_gaps: 0, blocking_gaps: 0, warning_gaps: 0 },
    gaps: [],
    limitations: []
  };
  Object.assign(gaps, overrides);
  fs.writeFileSync(path.join(tmp, '.brain', 'ingest_gaps.json'), JSON.stringify(gaps, null, 2), 'utf8');
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// ==================== TESTS ====================

console.log('\nBridge Preflight Contract Tests\n');

// 1. PASS happy path
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, { safety: { auto_promote_default: false, promotion_mode: 'review_required', domain_guard_active: true } });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'PASS', '1. PASS happy path', `got ${result.status}`);
  assert(result.ok === true, '1a. ok=true on PASS');
  assert(result.errors.length === 0, '1b. no errors on PASS');
  cleanup(tmp);
}

// 2. Missing report -> FAIL
{
  const tmp = makeTempWorkspace();
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '2. missing report -> FAIL', `got ${result.status}`);
  assert(result.ok === false, '2a. ok=false');
  cleanup(tmp);
}

// 3. Missing gaps -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '3. missing gaps -> FAIL', `got ${result.status}`);
  assert(result.ok === false, '3a. ok=false');
  cleanup(tmp);
}

// 4. Invalid JSON -> FAIL
{
  const tmp = makeTempWorkspace();
  fs.writeFileSync(path.join(tmp, '.brain', 'ingest_report.json'), 'not-json{{{', 'utf8');
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '4. invalid JSON report -> FAIL', `got ${result.status}`);
  cleanup(tmp);
}

// 4b. Invalid gaps JSON -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  fs.writeFileSync(path.join(tmp, '.brain', 'ingest_gaps.json'), 'not-json{{{', 'utf8');
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '4b. invalid JSON gaps -> FAIL', `got ${result.status}`);
  cleanup(tmp);
}

// 5. Unsupported report schema -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, { schema_version: 'unsupported.v99' });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '5. unsupported report schema -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('unsupported schema_version')), '5a. error mentions schema_version');
  cleanup(tmp);
}

// 6. Unsupported gaps schema -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, { schema_version: 'unsupported.v99' });
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '6. unsupported gaps schema -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('unsupported schema_version')), '6a. error mentions schema_version');
  cleanup(tmp);
}

// 7. Missing required field -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  const rpt = {
    schema_version: 'abw.ingest_report.v1',
    run_id: 'run-test',
    created_at: '2026-05-03T12:00:00Z',
    workspace: tmp,
    command: 'ingest raw/test.md',
    summary: { ingested_count: 0, skipped_count: 0, failed_count: 0, quarantined_count: 0, draft_count: 0, manifest_count: 0, queue_count: 0 },
    items: [],
    safety: { auto_promote_default: false, promotion_mode: 'review_required', domain_guard_active: false }
    // limitations missing
  };
  fs.writeFileSync(path.join(tmp, '.brain', 'ingest_report.json'), JSON.stringify(rpt, null, 2), 'utf8');
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '7. missing required field -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('limitations')), '7a. error mentions missing field');
  cleanup(tmp);
}

// 7b. Missing required gap item field -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, { safety: { auto_promote_default: false, promotion_mode: 'review_required', domain_guard_active: true } });
  makeGaps(tmp, {
    gap_summary: { total_gaps: 1, blocking_gaps: 0, warning_gaps: 1 },
    gaps: [{
      source_path: 'raw/test.md',
      source_id: 'ingest-abc',
      gap_type: 'missing_source_hash',
      severity: 'WARNING',
      reason: 'missing',
      evidence_ref: 'hash'
      // recommended_action missing
    }]
  });
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '7b. missing required gap item field -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('recommended_action')), '7b.a error mentions missing gap field');
  cleanup(tmp);
}

// 8. run_id mismatch -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, { run_id: 'different-run-id' });
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '8. run_id mismatch -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('run_id mismatch')), '8a. error mentions run_id');
  cleanup(tmp);
}

// 9. created_at mismatch -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, { created_at: '2099-01-01T00:00:00Z' });
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '9. created_at mismatch -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('created_at mismatch')), '9a. error mentions created_at');
  cleanup(tmp);
}

// 10. auto_promote_default true -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, { safety: { auto_promote_default: true, promotion_mode: 'auto', domain_guard_active: true } });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '10. auto_promote_default true -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('auto_promote_default')), '10a. error mentions auto_promote_default');
  cleanup(tmp);
}

// 11. Blocking gaps -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, {
    gap_summary: { total_gaps: 1, blocking_gaps: 1, warning_gaps: 0 },
    gaps: [{
      source_path: 'raw/bad.md', source_id: 'ingest-xyz',
      gap_type: 'quarantined_file', severity: 'BLOCKING',
      reason: 'domain contamination', evidence_ref: 'domain_check',
      recommended_action: 'Review file'
    }]
  });
  const result = preflight(tmp);
  assert(result.status === 'WARN', '11. blocking gaps -> WARN', `got ${result.status}`);
  assert(result.warnings.some(w => w.includes('blocking gaps')), '11a. warning mentions blocking gaps');
  cleanup(tmp);
}

// 12. Warning gaps -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, {
    gap_summary: { total_gaps: 1, blocking_gaps: 0, warning_gaps: 1 },
    gaps: [{
      source_path: 'raw/test.md', source_id: 'ingest-abc',
      gap_type: 'missing_source_hash', severity: 'WARNING',
      reason: 'missing', evidence_ref: 'hash',
      recommended_action: 'Re-ingest file'
    }]
  });
  const result = preflight(tmp);
  assert(result.status === 'WARN', '12. warning gaps -> WARN', `got ${result.status}`);
  assert(result.warnings.some(w => w.includes('warning gaps')), '12a. warning mentions warning gaps');
  cleanup(tmp);
}

// 13. domain_guard_active false -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'WARN', '13. domain_guard_active false -> WARN', `got ${result.status}`);
  assert(result.warnings.some(w => w.includes('domain_guard_active')), '13a. warning mentions domain_guard');
  cleanup(tmp);
}

// 14. promotion_mode auto -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, { safety: { auto_promote_default: false, promotion_mode: 'auto', domain_guard_active: true } });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'WARN', '14. promotion_mode auto -> WARN', `got ${result.status}`);
  assert(result.warnings.some(w => w.includes('promotion_mode is auto')), '14a. warning mentions promotion_mode auto');
  cleanup(tmp);
}

// 15. content_hash NOT_RECORDED -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, {
    safety: { auto_promote_default: false, promotion_mode: 'review_required', domain_guard_active: true },
    items: [{
      source_path: 'raw/test.md', source_id: 'ingest-abc',
      content_hash: 'NOT_RECORDED', status: 'draft_created',
      draft_path: 'drafts/test_draft.md', manifest_status: 'review_needed',
      queue_status: 'review_needed', review_state: 'low_confidence',
      promotion_state: 'review_needed', domain_check: {},
      skip_reason: null, failure_reason: null
    }]
  });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'WARN', '15. content_hash NOT_RECORDED -> WARN', `got ${result.status}`);
  assert(result.warnings.some(w => w.includes('NOT_RECORDED')), '15a. warning mentions NOT_RECORDED');
  cleanup(tmp);
}

// 16. skipped/failed/quarantined count > 0 -> WARN
{
  const tmp = makeTempWorkspace();
  makeReport(tmp, {
    safety: { auto_promote_default: false, promotion_mode: 'review_required', domain_guard_active: true },
    summary: { ingested_count: 0, skipped_count: 5, failed_count: 2, quarantined_count: 1, draft_count: 0, manifest_count: 0, queue_count: 0 }
  });
  makeGaps(tmp);
  const result = preflight(tmp);
  assert(result.status === 'WARN', '16. skipped/failed/quarantined > 0 -> WARN', `got ${result.status}`);
  cleanup(tmp);
}

// 17. No writes to ABW evidence files
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp);
  const rptBefore = fs.statSync(path.join(tmp, '.brain', 'ingest_report.json')).mtimeMs;
  const gapsBefore = fs.statSync(path.join(tmp, '.brain', 'ingest_gaps.json')).mtimeMs;
  preflight(tmp);
  const rptAfter = fs.statSync(path.join(tmp, '.brain', 'ingest_report.json')).mtimeMs;
  const gapsAfter = fs.statSync(path.join(tmp, '.brain', 'ingest_gaps.json')).mtimeMs;
  assert(rptBefore === rptAfter, '17. no writes to ingest_report.json', `mtime changed: ${rptBefore} -> ${rptAfter}`);
  assert(gapsBefore === gapsAfter, '17b. no writes to ingest_gaps.json', `mtime changed: ${gapsBefore} -> ${gapsAfter}`);
  cleanup(tmp);
}

// 18. workspace mismatch -> FAIL
{
  const tmp = makeTempWorkspace();
  makeReport(tmp);
  makeGaps(tmp, { workspace: '/different/workspace/path' });
  const result = preflight(tmp);
  assert(result.status === 'FAIL', '18. workspace mismatch -> FAIL', `got ${result.status}`);
  assert(result.errors.some(e => e.includes('workspace mismatch')), '18a. error mentions workspace');
  cleanup(tmp);
}

// Summary
console.log(`\n---`);
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f.test}: ${f.detail}`));
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
  process.exit(0);
}
