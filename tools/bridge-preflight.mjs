import fs from 'fs';
import path from 'path';

const REPORT_SCHEMA = 'abw.ingest_report.v1';
const GAPS_SCHEMA = 'abw.ingest_gaps.v1';

const REPORT_TOP_FIELDS = [
  'schema_version', 'run_id', 'created_at', 'workspace',
  'command', 'summary', 'items', 'safety', 'limitations'
];

const REPORT_SUMMARY_FIELDS = [
  'ingested_count', 'skipped_count', 'failed_count',
  'quarantined_count', 'draft_count', 'manifest_count', 'queue_count'
];

const REPORT_ITEM_FIELDS = [
  'source_path', 'source_id', 'content_hash', 'status', 'draft_path',
  'manifest_status', 'queue_status', 'review_state', 'promotion_state',
  'domain_check', 'skip_reason', 'failure_reason'
];

const REPORT_SAFETY_FIELDS = [
  'auto_promote_default', 'promotion_mode', 'domain_guard_active'
];

const GAPS_TOP_FIELDS = [
  'schema_version', 'run_id', 'created_at', 'workspace',
  'gap_summary', 'gaps', 'limitations'
];

const GAPS_SUMMARY_FIELDS = ['total_gaps', 'blocking_gaps', 'warning_gaps'];

const GAPS_ITEM_FIELDS = [
  'source_path', 'source_id', 'gap_type', 'severity',
  'reason', 'evidence_ref', 'recommended_action'
];

function readArtifact(abwRoot, artifactName) {
  const artifactPath = path.join(abwRoot, '.brain', artifactName);
  if (!fs.existsSync(artifactPath)) {
    return { path: artifactPath, exists: false, data: null, parseError: null };
  }
  try {
    const raw = fs.readFileSync(artifactPath, 'utf8');
    const data = JSON.parse(raw);
    return { path: artifactPath, exists: true, data, parseError: null };
  } catch (err) {
    return { path: artifactPath, exists: true, data: null, parseError: err.message };
  }
}

function checkRequiredFields(obj, requiredFields, label) {
  const missing = [];
  if (!obj || typeof obj !== 'object') {
    return [`${label}: not an object`];
  }
  for (const field of requiredFields) {
    if (!(field in obj)) {
      missing.push(`${label}: missing required field '${field}'`);
    }
  }
  return missing;
}

function validateReport(abwRoot) {
  const errors = [];
  const warnings = [];
  const info = {};

  const report = readArtifact(abwRoot, 'ingest_report.json');
  info.reportPath = report.path;

  if (!report.exists) {
    errors.push('ingest_report.json: file not found');
    return { errors, warnings, info, report: null };
  }

  if (report.parseError) {
    errors.push(`ingest_report.json: invalid JSON - ${report.parseError}`);
    return { errors, warnings, info, report: null };
  }

  const data = report.data;

  // Schema version
  if (data.schema_version !== REPORT_SCHEMA) {
    errors.push(`ingest_report.json: unsupported schema_version '${data.schema_version}', expected '${REPORT_SCHEMA}'`);
  }

  // Top-level fields
  errors.push(...checkRequiredFields(data, REPORT_TOP_FIELDS, 'ingest_report.json'));

  // Summary fields
  if (data.summary && typeof data.summary === 'object') {
    errors.push(...checkRequiredFields(data.summary, REPORT_SUMMARY_FIELDS, 'ingest_report.json summary'));
  } else {
    errors.push('ingest_report.json summary: missing or not an object');
  }

  // Items
  if (Array.isArray(data.items)) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      errors.push(...checkRequiredFields(item, REPORT_ITEM_FIELDS, `ingest_report.json items[${i}]`));
    }
  } else {
    errors.push('ingest_report.json items: missing or not an array');
  }

  // Safety
  if (data.safety && typeof data.safety === 'object') {
    errors.push(...checkRequiredFields(data.safety, REPORT_SAFETY_FIELDS, 'ingest_report.json safety'));
  } else {
    errors.push('ingest_report.json safety: missing or not an object');
  }

  // Safety checks
  if (data.safety) {
    if (data.safety.auto_promote_default !== false) {
      errors.push('ingest_report.json safety.auto_promote_default: must be false (fail-closed)');
    }
    if (data.safety.domain_guard_active === false) {
      warnings.push('ingest_report.json: domain_guard_active is false (no domain protection)');
    }
    if (data.safety.promotion_mode === 'auto') {
      warnings.push('ingest_report.json: promotion_mode is auto (not fail-closed)');
    }
  }

  // Content hash check
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (item.content_hash === 'NOT_RECORDED' || item.content_hash === 'UNKNOWN') {
        warnings.push(`ingest_report.json: item '${item.source_path}' has content_hash ${item.content_hash}`);
      }
    }
  }

  // Summary checks
  if (data.summary) {
    if ((data.summary.skipped_count || 0) > 0) {
      warnings.push(`ingest_report.json: summary has ${data.summary.skipped_count} skipped items`);
    }
    if ((data.summary.failed_count || 0) > 0) {
      warnings.push(`ingest_report.json: summary has ${data.summary.failed_count} failed items`);
    }
    if ((data.summary.quarantined_count || 0) > 0) {
      warnings.push(`ingest_report.json: summary has ${data.summary.quarantined_count} quarantined items`);
    }
  }

  // Limitations
  if (Array.isArray(data.limitations) && data.limitations.length > 0) {
    warnings.push('ingest_report.json: limitations is not empty');
  }

  return { errors, warnings, info, report: data };
}

function validateGaps(abwRoot) {
  const errors = [];
  const warnings = [];
  const info = {};

  const gaps = readArtifact(abwRoot, 'ingest_gaps.json');
  info.gapsPath = gaps.path;

  if (!gaps.exists) {
    errors.push('ingest_gaps.json: file not found');
    return { errors, warnings, info, gaps: null };
  }

  if (gaps.parseError) {
    errors.push(`ingest_gaps.json: invalid JSON - ${gaps.parseError}`);
    return { errors, warnings, info, gaps: null };
  }

  const data = gaps.data;

  // Schema version
  if (data.schema_version !== GAPS_SCHEMA) {
    errors.push(`ingest_gaps.json: unsupported schema_version '${data.schema_version}', expected '${GAPS_SCHEMA}'`);
  }

  // Top-level fields
  errors.push(...checkRequiredFields(data, GAPS_TOP_FIELDS, 'ingest_gaps.json'));

  // Gap summary fields
  if (data.gap_summary && typeof data.gap_summary === 'object') {
    errors.push(...checkRequiredFields(data.gap_summary, GAPS_SUMMARY_FIELDS, 'ingest_gaps.json gap_summary'));
  } else {
    errors.push('ingest_gaps.json gap_summary: missing or not an object');
  }

  // Gaps items
  if (Array.isArray(data.gaps)) {
    for (let i = 0; i < data.gaps.length; i++) {
      const gap = data.gaps[i];
      errors.push(...checkRequiredFields(gap, GAPS_ITEM_FIELDS, `ingest_gaps.json gaps[${i}]`));
    }
  } else {
    errors.push('ingest_gaps.json gaps: missing or not an array');
  }

  // Gap severity checks
  if (data.gap_summary) {
    if ((data.gap_summary.blocking_gaps || 0) > 0) {
      warnings.push(`ingest_gaps.json: ${data.gap_summary.blocking_gaps} blocking gaps present`);
    }
    if ((data.gap_summary.warning_gaps || 0) > 0) {
      warnings.push(`ingest_gaps.json: ${data.gap_summary.warning_gaps} warning gaps present`);
    }
  }

  // Limitations
  if (Array.isArray(data.limitations) && data.limitations.length > 0) {
    warnings.push('ingest_gaps.json: limitations is not empty');
  }

  return { errors, warnings, info, gaps: data };
}

function validateCorrelation(report, gaps) {
  const errors = [];

  if (!report || !gaps) {
    return errors;
  }

  if (report.run_id !== gaps.run_id) {
    errors.push(`run_id mismatch: report='${report.run_id}', gaps='${gaps.run_id}'`);
  }

  if (report.created_at !== gaps.created_at) {
    errors.push(`created_at mismatch: report='${report.created_at}', gaps='${gaps.created_at}'`);
  }

  if (report.workspace !== gaps.workspace) {
    errors.push(`workspace mismatch: report='${report.workspace}', gaps='${gaps.workspace}'`);
  }

  return errors;
}

export function preflight(abwRoot) {
  const resultReport = validateReport(abwRoot);
  const resultGaps = validateGaps(abwRoot);

  const errors = [...resultReport.errors, ...resultGaps.errors];
  const warnings = [...resultReport.warnings, ...resultGaps.warnings];

  // Correlation check
  if (resultReport.report && resultGaps.gaps) {
    errors.push(...validateCorrelation(resultReport.report, resultGaps.gaps));
  }

  let status = 'PASS';
  const hasGapBlocking = resultGaps.gaps?.gap_summary?.blocking_gaps > 0;

  if (errors.length > 0) {
    status = 'FAIL';
  } else if (warnings.length > 0 || hasGapBlocking) {
    status = 'WARN';
  }

  return {
    status,
    ok: status !== 'FAIL',
    summary: {
      report_schema: resultReport.report?.schema_version || null,
      gaps_schema: resultGaps.gaps?.schema_version || null,
      run_id: resultReport.report?.run_id || null,
      report_items: resultReport.report?.items?.length ?? 0,
      gap_items: resultGaps.gaps?.gaps?.length ?? 0,
    },
    errors,
    warnings,
    artifacts: {
      ingest_report: resultReport.info.reportPath || null,
      ingest_gaps: resultGaps.info.gapsPath || null,
    }
  };
}

function runCli() {
  const args = process.argv.slice(2);
  let abwRoot = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--abw-root' && i + 1 < args.length) {
      abwRoot = args[++i];
    }
  }

  if (!abwRoot) {
    console.error('Usage: node tools/bridge-preflight.mjs --abw-root <path-to-abw-workspace>');
    process.exit(2);
  }

  const resolved = path.resolve(abwRoot);
  const result = preflight(resolved);

  console.log(JSON.stringify(result, null, 2));

  if (result.status === 'FAIL') {
    process.exit(1);
  }
  process.exit(0);
}

// Run CLI if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('bridge-preflight.mjs') ||
  process.argv[1].replace(/\\/g, '/').endsWith('tools/bridge-preflight.mjs')
);

if (isMain) {
  runCli();
}
