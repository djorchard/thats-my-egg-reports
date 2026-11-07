import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  let batchQueue = Promise.resolve();
  return {
    close: () => db.close(),
    batch(statements) {
      const runBatch = async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT'); return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      };
      const result = batchQueue.then(runBatch);
      batchQueue = result.catch(() => {});
      return result;
    },
    prepare(sql) {
      let parameters = [];
      return {
        bind(...values) { parameters = values.map((value) => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return this; },
        async first() { return db.prepare(sql).get(...parameters) || null; },
        async all() { return { results: db.prepare(sql).all(...parameters) }; },
        async run() { return db.prepare(sql).run(...parameters); }
      };
    }
  };
}
