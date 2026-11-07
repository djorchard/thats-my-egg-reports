import { readFile } from 'node:fs/promises';
import { readReportAdminToken } from './report-credential.mjs';
import { createReportFetch } from './report-fetch.mjs';

const config = JSON.parse(await readFile(new URL('../public/config.json', import.meta.url), 'utf8'));
const base = config.apiBaseUrl, token = readReportAdminToken();
if (!token) throw new Error('Report service credential is unavailable');
const request = createReportFetch(base);
async function call(path, value) {
  const response = await request(base + path, { method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Jira report bridge returned HTTP ${response.status}`);
  return response.json();
}
if (process.argv[2] === 'status') console.log(JSON.stringify(await call('/jira/status'), null, 2));
else if (process.argv[2] === 'dispatch') console.log(JSON.stringify(await call('/jira/dispatch', {}), null, 2));
else if (process.argv[2] === 'import') {
  const input = JSON.parse(await readFile(process.argv[3], 'utf8'));
  if (input.universeId !== 10772752721 || input.readOnly !== true || !Array.isArray(input.boards)) throw new Error('Wrong board export');
  const reports = [];
  for (const board of input.boards) {
    if (!['published', 'studio'].includes(board.environment) || !Array.isArray(board.bugs)) throw new Error('Invalid board export');
    for (const bug of board.bugs) {
      if (bug.status && bug.status !== 'open') continue;
      reports.push({ source: board.environment, id: bug.id, title: bug.title, description: bug.description, metadata: { store: board.store, testId: bug.testId, testRevision: bug.testRevision, steps: bug.steps, reportedAt: bug.at, reporter: bug.name, userId: bug.userId, placeVersion: bug.placeVersion, jobId: bug.jobId, reportSource: bug.source } });
    }
  }
  const results = [];
  for (let offset = 0; offset < reports.length; offset += 25) results.push(await call('/jira/import', { reports: reports.slice(offset, offset + 25) }));
  console.log(JSON.stringify({ imported: reports.length, sourceCoverageComplete: input.coverageComplete, results }, null, 2));
} else throw new Error('Use: jira-sync.mjs status | dispatch | import <export.json>');
