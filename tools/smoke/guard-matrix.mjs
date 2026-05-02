export async function runGuardMatrixChecks(url, addCheck, requestJson) {
  const GUARD_MATRIX = [];
  const guardActions = [
    { action: 'file.write', mutation: true },
    { action: 'file.apply_edit', mutation: true },
    { action: 'inline_edit.generate', mutation: true },
    { action: 'task.mutate', mutation: true },
    { action: 'provider.mutate', mutation: true },
    { action: 'extension.install', mutation: true },
    { action: 'extension.mutate', mutation: true },
    { action: 'git.stage', mutation: true },
    { action: 'git.discard', mutation: true },
    { action: 'terminal.run', mutation: true },
    { action: 'project_rules.mutate', mutation: true },
    { action: 'memory.mutate', mutation: true },
    { action: 'git.commit', mutation: false, reserved: true },
    { action: 'git.push', mutation: false, reserved: true },
    { action: 'abw.bridge.reserved', mutation: false, reserved: true },
    { action: 'unknown.action', mutation: false, unknown: true },
  ];

  for (const guard of guardActions) {
    const row = { action: guard.action };
    try {
      // Case 1: Enterprise + approval -> denied (for mutations) or denied (for reserved)
      await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'enterprise', trustedWorkspace: false } });
      const r1 = await requestJson(`${url}/api/permissions/check`, {
        method: 'POST',
        headers: { 'X-Agent-Approved': 'true' },
        body: { actionType: guard.action, targetSummary: 'guard-matrix-test' }
      });
      if (guard.reserved || guard.unknown) {
        row.enterpriseApproved = r1.json?.ok === false ? 'denied-ok' : 'BYPA';
      } else {
        row.enterpriseApproved = r1.statusCode >= 400 ? 'denied-ok' : 'BYPA';
      }

      // Case 2: IDE without approval -> denied
      await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });
      const r2 = await requestJson(`${url}/api/permissions/check`, {
        method: 'POST',
        body: { actionType: guard.action, targetSummary: 'guard-matrix-test' }
      });
      row.ideNoApproval = r2.statusCode >= 400 ? 'denied-ok' : 'BYPA';

      // Case 3: IDE with approval -> allowed (for mutations) or denied (for reserved/unknown)
      const r3 = await requestJson(`${url}/api/permissions/check`, {
        method: 'POST',
        headers: { 'X-Agent-Approved': 'true' },
        body: { actionType: guard.action, targetSummary: 'guard-matrix-test' }
      });
      if (guard.reserved || guard.unknown) {
        row.ideApproved = r3.json?.ok === false ? 'denied-ok' : 'BYPA';
      } else {
        row.ideApproved = r3.json?.ok === true ? 'allowed-ok' : 'DENY-ERROR';
      }
    } catch (e) {
      row.error = e.message;
    }
    GUARD_MATRIX.push(row);
  }

  // Switch back to IDE mode
  await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });

  // Verify guard matrix results
  let guardPassed = 0;
  let guardFailed = 0;
  for (const row of GUARD_MATRIX) {
    const enterpriseOk = !row.error && row.enterpriseApproved === 'denied-ok';
    const ideNoApprovalOk = !row.error && row.ideNoApproval === 'denied-ok';
    const ideApprovedOk = !row.error && (row.ideApproved === 'allowed-ok' || row.ideApproved === 'denied-ok');

    if (enterpriseOk && ideNoApprovalOk && ideApprovedOk) {
      guardPassed++;
    } else {
      guardFailed++;
    }
    addCheck(`Guard: ${row.action}`, (enterpriseOk && ideNoApprovalOk && ideApprovedOk) ? 'pass' : 'fail', `ent=${row.enterpriseApproved} noapp=${row.ideNoApproval} app=${row.ideApproved}`, true);
  }

  // Real guard test points
  try {
    const realEndpointCases = [
      { name: 'Real guard: write_file enterprise denied', mode: 'enterprise', path: '/api/write_file', body: { path: 'tmp_guard_probe.txt', content: 'probe' }, expectStatus: 403 },
      { name: 'Real guard: inline_edit enterprise denied', mode: 'enterprise', path: '/api/inline_edit', body: { instruction: 'probe', selectedText: 'const a = 1;' }, expectStatus: 403 },
      { name: 'Real guard: task mutate enterprise denied', mode: 'enterprise', path: '/api/tasks/start', body: { title: 'guard-probe' }, expectStatus: 403 },
      { name: 'Real guard: git stage enterprise denied', mode: 'enterprise', path: '/api/git/stage', body: { files: ['README.md'] }, expectStatus: 403 },
      { name: 'Real guard: project_rules mutate enterprise denied', mode: 'enterprise', path: '/api/project_rules/add', body: { type: 'rule', title: 'guard-probe', content: 'probe', category: 'workflow', priority: 'normal', source: 'user' }, expectStatus: 403 },
      { name: 'Real guard: write_file IDE no approval denied', mode: 'ide', path: '/api/write_file', body: { path: 'tmp_guard_probe.txt', content: 'probe' }, expectStatus: 403 },
      { name: 'Real guard: inline_edit IDE no approval denied', mode: 'ide', path: '/api/inline_edit', body: { instruction: 'probe', selectedText: 'const a = 1;' }, expectStatus: 403 },
      { name: 'Real guard: task mutate IDE no approval denied', mode: 'ide', path: '/api/tasks/start', body: { title: 'guard-probe' }, expectStatus: 403 },
      { name: 'Real guard: git stage IDE no approval denied', mode: 'ide', path: '/api/git/stage', body: { files: ['README.md'] }, expectStatus: 403 },
      { name: 'Real guard: project_rules mutate IDE no approval denied', mode: 'ide', path: '/api/project_rules/add', body: { type: 'rule', title: 'guard-probe', content: 'probe', category: 'workflow', priority: 'normal', source: 'user' }, expectStatus: 403 }
    ];

    for (const c of realEndpointCases) {
      await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: c.mode, trustedWorkspace: false } });
      const res = await requestJson(`${url}${c.path}`, { method: 'POST', body: c.body });
      addCheck(c.name, res.statusCode === c.expectStatus ? 'pass' : 'fail', `status=${res.statusCode}`, true);
    }
    await requestJson(`${url}/api/profile`, { method: 'POST', body: { uiMode: 'ide', trustedWorkspace: false } });
  } catch (e) {
    addCheck('Real endpoint guard regression pack', 'fail', `error: ${e.message}`, true);
  }

  addCheck('Guard matrix overall', guardFailed === 0 ? 'pass' : 'fail', `${guardPassed}/${guardPassed + guardFailed} actions secure`, true);

  return { GUARD_MATRIX, guardPassed, guardFailed };
}
