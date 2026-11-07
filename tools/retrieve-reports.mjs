import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectReports } from './collect-reports.mjs';
import { readReportAdminToken } from './report-credential.mjs';

try {
  const config = JSON.parse(await readFile(new URL('../public/config.json', import.meta.url), 'utf8'));
  const summary = await collectReports({
    apiBaseUrl: process.env.REPORT_API_URL || config.apiBaseUrl,
    token: readReportAdminToken(),
    output: process.env.REPORT_OUTPUT_DIR || fileURLToPath(new URL('../../bugs/', import.meta.url))
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'collection_failed', error: error.message, localEvidencePreserved: true }));
  process.exitCode = 1;
}
