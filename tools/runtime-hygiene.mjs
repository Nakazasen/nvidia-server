import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const STATE_DIR = path.join(APP_DIR, '.nvidia-agent');
const REAL_STATE_DIR = fs.existsSync(STATE_DIR) ? fs.realpathSync(STATE_DIR) : STATE_DIR;
const REPORTS_KEEP_BASENAMES = new Set([
    'performance-budget.json',
    'performance-budget.md'
]);
const REPORTS_KEEP_PATTERNS = [/^audit-.*\.md$/i];
const SECURITY_ROTATION_WARN_BYTES = 5 * 1024 * 1024;

const HYGIENE_RULES = {
    reports: {
        dir: path.join(STATE_DIR, 'reports'),
        maxFiles: 50,
        deleteAction: true
    },
    security: {
        dir: path.join(STATE_DIR, 'security'),
        maxFiles: 50, // Keep last 50 log files
        deleteAction: true
    },
    tmp: {
        dir: path.join(STATE_DIR, 'tmp'),
        maxFiles: 20, // Tmp files shouldn't pile up
        deleteAction: true
    },
    index: {
        dir: path.join(STATE_DIR, 'index'),
        maxFiles: Infinity, // Just report, don't delete index files blindly
        deleteAction: false
    }
};

async function getSortedFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const item of items) {
        if (!item.isFile()) continue;
        const fullPath = path.join(dirPath, item.name);
        const stat = await fs.promises.stat(fullPath);
        files.push({ name: item.name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    // Sort by modified time descending (newest first)
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function getSecurityLogDetails(dirPath) {
    const result = {
        securityLogStatus: 'OK',
        securityLogBytes: 0,
        securityLogLines: 0,
        securityLogFiles: 0,
        securityLogErrors: [],
        files: []
    };
    if (!fs.existsSync(dirPath)) return result;

    let items = [];
    try {
        items = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch (e) {
        result.securityLogStatus = 'UNREADABLE';
        result.securityLogErrors.push(`readdir failed: ${e.message}`);
        return result;
    }
    for (const item of items) {
        if (!item.isFile()) continue;
        const fullPath = path.join(dirPath, item.name);
        let stat;
        try {
            stat = await fs.promises.stat(fullPath);
        } catch (e) {
            result.securityLogErrors.push(`stat failed for ${item.name}: ${e.message}`);
            continue;
        }
        result.securityLogBytes += stat.size;
        result.securityLogFiles++;

        let lines = 0;
        const isJsonl = item.name.toLowerCase().endsWith('.jsonl');
        if (isJsonl) {
            try {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                lines = content.length === 0 ? 0 : content.split(/\r?\n/).filter(Boolean).length;
            } catch (e) {
                lines = -1;
                result.securityLogErrors.push(`read failed for ${item.name}: ${e.message}`);
            }
        }
        result.securityLogLines += Math.max(0, lines);

        result.files.push({
            name: item.name,
            sizeBytes: stat.size,
            isJsonl,
            lines: Math.max(0, lines),
            mtimeMs: stat.mtimeMs
        });
    }

    result.files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (result.securityLogErrors.length > 0) {
        result.securityLogStatus = 'PARTIAL';
    } else if (result.securityLogBytes > SECURITY_ROTATION_WARN_BYTES) {
        result.securityLogStatus = 'LARGE';
    } else if (result.securityLogBytes > 0) {
        result.securityLogStatus = 'OK';
    } else {
        result.securityLogStatus = 'EMPTY';
    }
    return result;
}

async function runHygiene(dryRun = true) {
    console.log(`Running runtime hygiene (${dryRun ? 'DRY-RUN' : 'APPLY'})...`);

    const securityDetails = await getSecurityLogDetails(path.join(STATE_DIR, 'security'));

    const summary = {
        boundaryRoot: REAL_STATE_DIR,
        scanned: 0,
        toDelete: 0,
        deleted: 0,
        bytesFreed: 0,
        preserved: 0,
        boundaryRejected: 0,
        securityRotation: 'NOT_ROTATED_YET',
        securityRotationCandidates: [],
        securityRotationReason: 'Automatic rotation not implemented. Only detection/reporting is active.',
        securityLogStatus: securityDetails.securityLogStatus,
        securityLogBytes: securityDetails.securityLogBytes,
        securityLogLines: securityDetails.securityLogLines,
        securityLogFiles: securityDetails.securityLogFiles,
        securityLogErrors: securityDetails.securityLogErrors
    };

    for (const [key, rule] of Object.entries(HYGIENE_RULES)) {
        const files = await getSortedFiles(rule.dir);
        summary.scanned += files.length;
        
        console.log(`\nDirectory: .nvidia-agent/${key}`);
        console.log(`  Current file count: ${files.length}`);
        
        if (rule.maxFiles !== Infinity && files.length > rule.maxFiles) {
            const excessFiles = files.slice(rule.maxFiles);
            console.log(`  Found ${excessFiles.length} files exceeding the limit of ${rule.maxFiles}.`);
            
            if (rule.deleteAction) {
                for (const file of excessFiles) {
                    const base = path.basename(file.fullPath);
                    if (key === 'reports') {
                        const keepByName = REPORTS_KEEP_BASENAMES.has(base);
                        const keepByPattern = REPORTS_KEEP_PATTERNS.some((rx) => rx.test(base));
                        if (keepByName || keepByPattern) {
                            summary.preserved++;
                            console.log(`  [PRESERVE] ${file.name}`);
                            continue;
                        }
                    }
                    const realFile = await fs.promises.realpath(file.fullPath);
                    if (!realFile.startsWith(`${REAL_STATE_DIR}${path.sep}`)) {
                        summary.boundaryRejected++;
                        console.log(`  [BOUNDARY-REJECTED] ${file.name}`);
                        continue;
                    }

                    summary.toDelete++;
                    if (!dryRun) {
                        try {
                            await fs.promises.unlink(file.fullPath);
                            summary.deleted++;
                            summary.bytesFreed += file.size;
                            console.log(`  [DELETED] ${file.name}`);
                        } catch (err) {
                            console.error(`  [ERROR] Failed to delete ${file.name}:`, err.message);
                        }
                    } else {
                        console.log(`  [DRY-RUN: WOULD DELETE] ${file.name}`);
                    }
                }
            } else {
                console.log(`  Delete action disabled for this category.`);
            }
        } else {
            console.log(`  Within bounds.`);
        }

        if (key === 'security') {
            for (const file of files) {
                if (file.name.endsWith('.jsonl') && file.size > SECURITY_ROTATION_WARN_BYTES) {
                    summary.securityRotationCandidates.push({
                        file: file.name,
                        sizeBytes: file.size
                    });
                }
            }
            if (summary.securityRotationCandidates.length > 0) {
                summary.securityRotation = 'NOT_ROTATED_YET';
                console.log('  [LIMITATION] Oversized .jsonl file(s) detected; file-count cap does not rotate a single growing file.');
            }

            if (securityDetails.securityLogFiles > 0) {
                console.log(`  Security log total bytes: ${(securityDetails.securityLogBytes / 1024).toFixed(2)} KB`);
                console.log(`  Security log total lines: ${securityDetails.securityLogLines}`);
                console.log(`  Security log status: ${securityDetails.securityLogStatus}`);
            }
            if (securityDetails.securityLogErrors.length > 0) {
                for (const err of securityDetails.securityLogErrors.slice(0, 5)) {
                    console.log(`  [WARN] Security log read issue: ${err}`);
                }
            }
            if (summary.securityRotation === 'NOT_ROTATED_YET') {
                console.log(`  Security rotation: NOT_ROTATED_YET (${summary.securityRotationReason})`);
            }
            for (const detail of securityDetails.files.slice(0, 5)) {
                const kb = (detail.sizeBytes / 1024).toFixed(2);
                console.log(`    - ${detail.name}: ${kb} KB, ${detail.lines} lines`);
            }
            if (securityDetails.files.length > 5) {
                console.log(`    ... ${securityDetails.files.length - 5} more security log file(s)`);
            }
        }
    }

    console.log('\n=== Hygiene Summary ===');
    console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
    console.log(`Total files scanned: ${summary.scanned}`);
    if (dryRun) {
        console.log(`Files that would be deleted: ${summary.toDelete}`);
    } else {
        console.log(`Files deleted: ${summary.deleted}`);
        console.log(`Bytes freed: ${(summary.bytesFreed / 1024).toFixed(2)} KB`);
    }
    
    // Safety check - ensuring we never delete source files
    console.log('\nSafety Check: All operations were strictly confined to .nvidia-agent runtime directories.');
    console.log(`Security rotation: ${summary.securityRotation}`);
    if (summary.securityRotation === 'NOT_ROTATED_YET') {
        console.log(`Security rotation reason: ${summary.securityRotationReason}`);
    }
    console.log(`Security log: ${summary.securityLogBytes} bytes, ${summary.securityLogLines} lines, status=${summary.securityLogStatus}`);
    console.log('Hygiene summary JSON:', JSON.stringify(summary));
}

const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const isDryRunExplicit = args.includes('--dry-run');
const dryRun = isApply ? false : true;
if (isApply && isDryRunExplicit) {
    console.error('Conflicting flags: use either --apply or --dry-run.');
    process.exit(1);
}
runHygiene(dryRun).catch((err) => {
    console.error(err);
    process.exit(1);
});
