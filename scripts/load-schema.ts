/**
 * load-schema.ts — applies src/database/schema.sql into an in-memory
 * SQLite database and reports which tables + seed data loaded.
 *
 * Used as a smoke test in CI to make sure the schema is valid.
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(import.meta.dir, '..', 'src', 'database', 'schema.sql'), 'utf-8');
const db = new Database(':memory:');
db.exec(schema);

const tables = db.query<{name: string}, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
).all();

console.log(`Tables created: ${tables.length}`);
for (const t of tables) console.log(`  - ${t.name}`);

const em = db.query<{target_pattern: string, description: string}, []>(
    "SELECT target_pattern, description FROM emergency_whitelist ORDER BY rule_id",
).all();
console.log('\nEmergency whitelist:');
for (const r of em) console.log(`  - ${r.target_pattern} = ${r.description}`);

const loc = db.query<{count: number}, []>("SELECT COUNT(*) as count FROM mock_locations").get();
const con = db.query<{count: number}, []>("SELECT COUNT(*) as count FROM mock_contacts").get();
console.log(`\nSeed data: ${loc?.count} mock locations, ${con?.count} mock contacts`);

// Verify the indexes that the dashboard relies on.
const idx = db.query<{name: string}, []>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all();
console.log(`\nIndexes: ${idx.length}`);
for (const i of idx) console.log(`  - ${i.name}`);

db.close();
console.log('\nSchema loaded cleanly.');