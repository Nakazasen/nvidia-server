const SERVER_START_TIME = Date.now();

export function tryHandleHealthRoute(req, res, requestUrl, context) {
    if (!req || !res || !requestUrl || !context || typeof context.sendJSON !== 'function') return false;
    const pathname = requestUrl.pathname;

    if (req.method === 'GET') {
        if (pathname === '/api/health') {
            const uptimeSec = Math.round((Date.now() - SERVER_START_TIME) / 1000);
            let diagnostics = { errors: 0, warnings: 0, info: 0 };
            if (typeof context.getDiagnosticsSummary === 'function') {
                try {
                    diagnostics = context.getDiagnosticsSummary() ?? diagnostics;
                } catch {
                    diagnostics = { errors: 0, warnings: 0, info: 0 };
                }
            }
            context.sendJSON(res, 200, {
                ok: true,
                status: 'running',
                uptime: uptimeSec,
                uptimeFormatted: `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`,
                workspace: context.currentWorkspace,
                port: context.port,
                version: context.version || '1.0.0',
                node_version: process.version,
                diagnostics: diagnostics
            });
            return true;
        }

        if (pathname === '/api/tools') {
            context.sendJSON(res, 200, { tools: context.getAgentTools() });
            return true;
        }

        if (pathname === '/api/rate_limit') {
            context.sendJSON(res, 200, context.getRateLimitStatus());
            return true;
        }

        if (pathname === '/api/pending_edits') {
            context.sendJSON(res, 200, { edits: context.workspaceCore.listPendingEditsTool() });
            return true;
        }

        if (pathname === '/api/workspace') {
            context.sendJSON(res, 200, { path: context.currentWorkspace });
            return true;
        }
    }

    return false;
}
