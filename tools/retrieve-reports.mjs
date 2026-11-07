import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectReports } from './collect-reports.mjs';
import { readReportAdminToken } from './report-credential.mjs';
import { createReportFetch } from './report-fetch.mjs';

try {
  const config = JSON.parse(await readFile(new URL('../public/config.json', import.meta.url), 'utf8'));
  const base = process.env.REPORT_API_URL || config.apiBaseUrl;
  const summary = await collectReports({
    apiBaseUrl: base,
    token: readReportAdminToken(),
    fetchImpl: base ? createReportFetch(base) : fetch,
    output: process.env.REPORT_OUTPUT_DIR || fileURLToPath(new URL('../../bugs/', import.meta.url))
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'collection_failed', error: error.message, localEvidencePreserved: true }));
  process.exitCode = 1;
}
