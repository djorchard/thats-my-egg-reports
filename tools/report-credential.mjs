import { createRequire } from 'node:module';
import { resolve } from 'node:path';

export function readReportAdminToken() {
  if (process.env.REPORT_ADMIN_TOKEN) return process.env.REPORT_ADMIN_TOKEN;
  if (process.platform !== 'win32' || !process.env.APPDATA) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const { Entry } = require(resolve(process.env.APPDATA, 'npm/node_modules/@napi-rs/keyring'));
    return new Entry('ThatsMyEgg.ReportSite', 'AdminToken').getPassword();
  } catch { return undefined; }
}
