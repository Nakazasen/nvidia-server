export async function runApiRegressionChecks(url, addCheck, requestJson) {
  const apiRegressionChecks = [
    { name: 'GET /api/permissions', url: '/api/permissions', expect200: true },
    { name: 'GET /api/project_rules', url: '/api/project_rules', expect200: true },
    { name: 'GET /api/git/status', url: '/api/git/status', expect200: true },
    { name: 'GET /api/tasks', url: '/api/tasks', expect200: true },
    { name: 'GET /api/extensions', url: '/api/extensions', expect200: true },
    { name: 'GET /api/agent_providers', url: '/api/agent_providers', expect200: true },
    { name: 'GET /api/settings', url: '/api/settings', expect200: true },
    { name: 'GET /api/providers', url: '/api/providers', expect200: true },
    { name: 'GET /api/security/summary', url: '/api/security/summary', expect200: true },
    { name: 'GET /api/diagnostics', url: '/api/diagnostics', expect200: true },
    { name: 'GET /api/index/search', url: '/api/index/search?q=test', expect200: true },
    { name: 'GET /api/pending_edits', url: '/api/pending_edits', expect200: true },
  ];
  for (const check of apiRegressionChecks) {
    try {
      const res = await requestJson(`${url}${check.url}`, { timeoutMs: 8000 });
      const ok = check.expect200 ? res.statusCode === 200 : res.statusCode >= 400;
      addCheck(`API reg: ${check.name}`, ok ? 'pass' : 'fail', `status=${res.statusCode}`, true);
    } catch (e) {
      addCheck(`API reg: ${check.name}`, 'fail', `error: ${e.message}`, true);
    }
  }

  // Sprint 17: Health endpoint modularization smoke
  try {
    const healthRes = await requestJson(`${url}/api/health`, { timeoutMs: 8000 });
    const healthOk = healthRes.statusCode === 200 && healthRes.json?.ok === true && healthRes.json?.status === 'running';
    addCheck('API: GET /api/health returns running', healthOk ? 'pass' : 'fail', `status=${healthRes.statusCode} ok=${healthRes.json?.ok}`, true);
    const hasFields = typeof healthRes.json?.uptime === 'number' && typeof healthRes.json?.workspace === 'string';
    addCheck('API: /api/health contains uptime and workspace', hasFields ? 'pass' : 'fail', hasFields ? 'fields present' : 'missing uptime/workspace', true);
  } catch (e) {
    addCheck('API: GET /api/health', 'fail', `error: ${e.message}`, true);
  }
}
