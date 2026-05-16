const args = process.argv.slice(2);
const mode = process.env.ABW_MOCK_MODE || 'ask-success';

function findFlagValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return '';
  return args[idx + 1] || '';
}

const workspace = findFlagValue('--workspace');
const commandIndex = args.findIndex((item, index) => item === '--workspace' && index + 2 < args.length);
const commandName = commandIndex >= 0 ? args[commandIndex + 2] : '';
const question = commandName === 'ask' ? (args[commandIndex + 3] || '') : '';

if (mode === 'timeout') {
  setTimeout(() => process.exit(0), 60000);
} else if (mode === 'nonzero') {
  process.stderr.write('mock ABW nonzero failure\n');
  process.exit(7);
} else if (mode === 'invalid-json') {
  process.stdout.write('not-json');
  process.exit(0);
} else if (mode === 'schema-unsupported') {
  process.stdout.write(JSON.stringify({
    schema_version: '99',
    command_name: commandName || 'ask',
    workspace,
    generated_at: '2026-05-15T00:00:00Z',
    status: 'success',
    data: {}
  }));
  process.exit(0);
}

function envelope(status, data) {
  return {
    schema_version: '1',
    command_name: commandName,
    workspace,
    generated_at: '2026-05-15T00:00:00Z',
    status,
    data
  };
}

if (mode === 'version-ok') {
  process.stdout.write(JSON.stringify(envelope('success', {
    version: '1.1.0',
    package: 'abw_skill',
    python: '3.13'
  })));
  process.exit(0);
}

if (mode === 'doctor-ok') {
  process.stdout.write(JSON.stringify(envelope('warning', {
    checks: [{ level: 'WARN', message: 'mock doctor' }],
    ok: false,
    warnings: ['mock doctor'],
    workspace_health: 'WARN',
    engine_health: 'OK'
  })));
  process.exit(0);
}

if (mode === 'ask-no-match') {
  process.stdout.write(JSON.stringify(envelope('no_match', {
    answer: 'No grounded answer found.',
    retrieval_status: 'no_match',
    trust_score: 0,
    sources: [],
    warnings: ['Need to ingest sources first.'],
    gap_logged: true,
    gap_id: 'gap-123',
    current_state: 'knowledge_gap_logged',
    knowledge_evidence_tier: 'E0_unknown',
    knowledge_source_score: 0,
    source_summary: 'no_grounded_sources',
    logs: [],
    provider: 'local'
  })));
  process.exit(0);
}

if (mode === 'ask-no-match-read-only') {
  process.stdout.write(JSON.stringify(envelope('no_match', {
    answer: 'No grounded answer found.',
    retrieval_status: 'no_match',
    trust_score: 0,
    sources: [],
    warnings: ['No supporting sources were returned.'],
    gap_logged: false,
    gap_id: null,
    current_state: 'knowledge_gap_logged',
    knowledge_evidence_tier: 'E0_unknown',
    knowledge_source_score: 0,
    source_summary: 'unknown',
    logs: [],
    provider: 'local',
    gap_log_suppressed: true,
    would_log_gap: true,
    runtime_write_suppressed: true
  })));
  process.exit(0);
}

if (mode === 'ask-ambiguous-nonzero-json') {
  process.stdout.write(JSON.stringify(envelope('ambiguous', {
    answer: 'Question is ambiguous. Narrow the request.',
    retrieval_status: 'ambiguous',
    trust_score: 0,
    sources: [],
    warnings: ['The request matched multiple possible intents.'],
    gap_logged: false,
    gap_id: null,
    current_state: 'blocked',
    knowledge_evidence_tier: null,
    knowledge_source_score: 0,
    source_summary: 'unknown',
    logs: [],
    provider: 'local',
    runtime_write_suppressed: true
  })));
  process.exit(3);
}

if (mode === 'ask-raw-only') {
  process.stdout.write(JSON.stringify(envelope('success', {
    answer: 'Raw note says AGV dispatch uses MQTT.',
    retrieval_status: 'raw_or_draft_only',
    trust_score: 45,
    sources: [{ path: 'raw/agv-raw.md', title: 'agv raw', snippet: 'AGV dispatch note says MQTT is used for queue handoff.', confidence: 45 }],
    warnings: [
      'Weak evidence: trust score is below 50.',
      'Weak evidence: answer is based on raw or draft material, not grounded wiki.'
    ],
    gap_logged: false,
    gap_id: null,
    current_state: 'knowledge_answered',
    knowledge_evidence_tier: 'E1_fallback',
    knowledge_source_score: 2,
    source_summary: 'raw_source',
    logs: [],
    provider: 'local',
    runtime_write_suppressed: true
  })));
  process.exit(0);
}

if (mode === 'ingest-success' || mode === 'ingest-with-issues' || mode === 'ingest-review-required') {
  const withIssues = mode === 'ingest-with-issues';
  const reviewRequired = mode === 'ingest-review-required';
  process.stdout.write(JSON.stringify(envelope('success', {
    ingested: withIssues ? 1 : 3,
    skipped: withIssues ? 2 : 0,
    unsupported_files: withIssues ? ['raw/bad.exe', 'raw/scan.bin'] : [],
    parse_errors: withIssues ? ['raw/spec.txt: invalid frontmatter'] : [],
    generated_drafts: withIssues ? ['drafts/spec-draft.md'] : ['drafts/doc-1.md', 'drafts/doc-2.md'],
    review_required: reviewRequired || withIssues,
    promotion_performed: false,
    warnings: withIssues ? ['Một số file không hỗ trợ hoặc parse lỗi.'] : ['Ingest chỉ tạo bản nháp; cần review trước khi dùng như wiki đáng tin.']
  })));
  process.exit(0);
}

if (mode === 'ingest-fail-nonzero') {
  process.stderr.write('mock ingest failed\n');
  process.exit(9);
}

process.stdout.write(JSON.stringify(envelope('success', {
  answer: question ? `Mock answer for: ${question}` : 'Mock answer',
  retrieval_status: 'exact_match',
  trust_score: 70,
  sources: [{ path: 'wiki/agv.md', title: 'agv', snippet: '', confidence: 65 }],
  warnings: [],
  gap_logged: false,
  gap_id: null,
  current_state: 'knowledge_answered',
  knowledge_evidence_tier: 'E2_wiki',
  knowledge_source_score: 2,
  sourceSummary: 'local_wiki',
  source_summary: 'local_wiki',
  logs: [],
  provider: 'local',
  runtime_write_suppressed: true
})));
