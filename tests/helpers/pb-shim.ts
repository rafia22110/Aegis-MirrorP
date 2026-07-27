/**
 * PocketBase hook shim.
 *
 * The PocketBase JS runtime exposes three globals that hooks use:
 *
 *   routerAdd(method, path, handler)
 *     Registers a route handler. The handler is called with a `c`
 *     (context) object that has:
 *       - c.requestBody()        → string body
 *       - c.json(status, obj)    → Response
 *       - c.queryParam(name)     → string|null
 *       - c.query                → URL search params (used in journal)
 *
 *   $app.dao()
 *     Returns a DAO facade with methods the hook uses:
 *       - findCollectionByNameOrId(name) → Collection
 *       - findFirstRecordByFilter(coll, filter, params) → Record|null
 *       - findRecordsByFilter(coll, filter, sort, limit, offset) → Record[]
 *       - saveRecord(record) → Record
 *
 *   Record(collection)
 *     A row builder. The hook does:
 *       record.set(field, value)
 *       record.get(field)
 *
 * This shim implements all of those on top of bun:sqlite so we can
 * exercise the hook's logic from a regular bun:test without needing
 * the Go runtime. The shim is intentionally minimal — it implements
 * only the surface area the hook uses, not the full PocketBase API.
 */

import { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// In-memory Record
// ---------------------------------------------------------------------------
export class FakeRecord {
    data: Record<string, any> = {};
    constructor(public collection: FakeCollection) {}

    set(field: string, value: any) { this.data[field] = value; return this; }
    get(field: string) { return this.data[field]; }
}

// ---------------------------------------------------------------------------
// In-memory Collection
// ---------------------------------------------------------------------------
export class FakeCollection {
    constructor(public name: string) {}
}

// ---------------------------------------------------------------------------
// DAO facade
// ---------------------------------------------------------------------------
export class FakeDao {
    constructor(public db: Database) {}

    findCollectionByNameOrId(name: string): FakeCollection {
        // Validate that the table exists; throws if not (same as PocketBase).
        const row = this.db.query<{name: string}, [string]>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        ).get(name);
        if (!row) throw new Error(`Collection not found: ${name}`);
        return new FakeCollection(name);
    }

    findFirstRecordByFilter(
        collName: string,
        filter: string,
        params: Record<string, any> = {},
    ): FakeRecord | null {
        const coll = this.findCollectionByNameOrId(collName);
        if (process.env.SHIM_TRACE) {
            console.error(`[shim] findFirst: coll=${collName} filter="${filter}" params=${JSON.stringify(params)}`);
        }
        const { sql, values } = compileFilter(coll.name, filter, params);
        if (process.env.SHIM_TRACE) {
            console.error(`[shim] findFirst: ${sql} values=${JSON.stringify(values)}`);
        }
        const row = this.db.query<Record<string, any>, any[]>(sql).get(...values);
        if (process.env.SHIM_TRACE) {
            console.error(`[shim]   → ${row ? 'HIT' : 'MISS'}`);
        }
        if (!row) return null;
        return recordFromRow(coll, row);
    }

    findRecordsByFilter(
        collName: string,
        filter: string,
        sort: string,
        limit: number,
        offset: number,
    ): FakeRecord[] {
        const coll = this.findCollectionByNameOrId(collName);
        const whereClause = filter.trim() ? `WHERE ${filter.trim()}` : '';
        const orderClause = sort?.trim() ? `ORDER BY ${sort.trim()}` : '';
        const sql = `SELECT * FROM ${coll.name} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`;
        const rows = this.db.query<Record<string, any>, any[]>(sql).all(limit, offset);
        return rows.map((r) => recordFromRow(coll, r));
    }

    saveRecord(record: FakeRecord): FakeRecord {
        // PocketBase's saveRecord handles both insert and update. The
        // public-mirror hooks always use INSERT OR REPLACE because the
        // events table has an autoincrement primary key and we never
        // update existing rows.
        const sql = `INSERT OR REPLACE INTO ${record.collection.name} (${Object.keys(record.data).join(', ')}) VALUES (${Object.keys(record.data).map(() => '?').join(', ')})`;
        this.db.run(sql, ...Object.values(record.data));
        return record;
    }
}

// ---------------------------------------------------------------------------
// PocketBase exposes `Record` as a global (no import). The shim exposes it
// on the returned globals object so the hook can `new Record(coll)`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: compile a PocketBase-style filter to SQL.
// PocketBase filter syntax: "field = {:param} && field2 = 'literal'".
// This handles the subset we use in main.pb.js:
//   * "field = {:name}"           → param substitution
//   * "field = 'literal'"         → literal comparison
//   * "field1 = {:a} && field2 = {:b}" → AND
// ---------------------------------------------------------------------------
function compileFilter(
    coll: string,
    filter: string,
    params: Record<string, any>,
): { sql: string; values: any[] } {
    const values: any[] = [];
    const where = filter
        .split('&&')
        .map((clause) => clause.trim())
        .map((clause) => {
            const m = clause.match(/^(\w+)\s*=\s*(.+)$/);
            if (!m) throw new Error(`Unsupported filter clause: ${clause}`);
            const field = m[1];
            const rhs = m[2].trim();
            if (rhs.startsWith('{') && rhs.endsWith('}')) {
                // PocketBase syntax is "{:name}" (the leading colon is
                // required). Some hooks/older docs use "{name}" — accept
                // both for forward compatibility.
                let key = rhs.slice(1, -1);
                if (key.startsWith(':')) key = key.slice(1);
                const v = params[key];
                if (process.env.SHIM_TRACE) {
                    console.error(`[shim] compile: key=${key} v=${JSON.stringify(v)} (typeof=${typeof v})`);
                }
                values.push(v);
                return `${field} = ?`;
            }
            // quoted literal
            const lit = rhs.match(/^'(.*)'$/)?.[1];
            if (lit !== undefined) {
                values.push(lit);
                return `${field} = ?`;
            }
            throw new Error(`Unsupported RHS in clause: ${clause}`);
        })
        .join(' AND ');
    return { sql: `SELECT * FROM ${coll} WHERE ${where}`, values };
}

function recordFromRow(coll: FakeCollection, row: Record<string, any>): FakeRecord {
    const r = new FakeRecord(coll);
    for (const [k, v] of Object.entries(row)) r.data[k] = v;
    return r;
}

// ---------------------------------------------------------------------------
// Public API: loadPocketBaseHook(opts) → { invoke(method, path, req) }
//
// Loads the hook file and registers all routes on the shim's router.
// Returns an `invoke` helper that mimics the Go runtime's request
// dispatcher: takes an HTTP method + path + request body and returns
// the handler's Response.
// ---------------------------------------------------------------------------
export interface PocketBaseShimOptions {
    db: Database;
}

export interface InvokeResult {
    status: number;
    body: any;
    headers: Headers;
}

export function createPocketBaseShim(opts: PocketBaseShimOptions) {
    const { db } = opts;
    const routes: Array<{ method: string; path: string; handler: (c: any) => any }> = [];

    // Build the runtime globals. The hook file calls `routerAdd(...)` and
    // uses `$app.dao()` + `Record` directly.
    const globals = {
        $app: { dao: () => new FakeDao(db) },
        routerAdd: (method: string, path: string, handler: (c: any) => any) => {
            routes.push({ method, path, handler });
        },
        Record: FakeRecord as any,
        performance: (typeof performance !== 'undefined' ? performance : undefined),
    };

    return { globals, routes, invoke };
}

export async function loadHook(
    shim: ReturnType<typeof createPocketBaseShim>,
    hookPath: string,
) {
    // PocketBase loads hooks via vm.runInNewContext with the globals
    // exposed. Bun doesn't ship vm.runInNewContext out of the box, but
    // we can use Function() to evaluate the hook with the globals
    // injected as parameters.
    const code = await Bun.file(hookPath).text();
    const fn = new Function(
        ...Object.keys(shim.globals),
        code + '\n//# sourceURL=hook',
    );
    fn(...Object.values(shim.globals));
}

export function invoke(
    shim: ReturnType<typeof createPocketBaseShim>,
    method: string,
    path: string,
    body?: string,
): InvokeResult {
    const route = shim.routes.find((r) => r.method === method && r.path === path);
    if (!route) {
        return { status: 404, body: { error: 'not_found' }, headers: new Headers() };
    }
    const url = new URL(`http://localhost${path}`);
    const c = {
        requestBody: () => body || '',
        queryParam: (name: string) => url.searchParams.get(name),
        json: (status: number, payload: any) => ({
            status,
            body: payload,
            headers: new Headers({ 'Content-Type': 'application/json' }),
        }),
    };
    const result = route.handler(c);
    return {
        status: result.status,
        body: result.body,
        headers: result.headers,
    };
}