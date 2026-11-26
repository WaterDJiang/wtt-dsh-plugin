import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  marketSnapshotId,
  parseMarketSnapshotV1,
  parseStockContext,
  type StockContextResponse,
  type Adjustment,
  type MarketBar,
  type MarketField,
} from '@wanalysis/contracts';

const applicationId = 0x57414e41;
const fields: MarketField[] = ['open', 'high', 'low', 'close', 'volume', 'amount', 'turnoverRate'];
export const cnSymbol = /^(sh|sz|bj)\d{6}$/;
export type Location = { id: string; path: string };
type StoredBar = MarketBar & { id: number };
type Header = { name: string; fetched: string; members: Uint8Array };

type DailyWindow = { symbol: string; name: string; adjust: Adjustment; fetchedAt: string; asOf: string; bars: MarketBar[] };

function snapshotIds(members: Uint8Array): number[] {
  const manifest: number[] | { deltas: number[] } = JSON.parse(
    inflateRawSync(members, { maxOutputLength: 256 * 1024 }).toString(),
  );
  let id = 0;
  return Array.isArray(manifest) ? manifest : manifest.deltas.map((delta) => (id += delta));
}

export class MarketDatabase {
  private readonly db: DatabaseSync;
  readonly location: Location;

  constructor(file: string) {
    const path = realpathSync(file);
    const uri = pathToFileURL(path);
    uri.searchParams.set('mode', 'rw');
    this.db = new DatabaseSync(uri.href);
    try {
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000');
      if (this.db.prepare('PRAGMA application_id').get()?.application_id !== applicationId ||
          this.db.prepare('PRAGMA user_version').get()?.user_version !== 3)
        throw Error('请选择现有的 Wanalysis v3 行情库');
      const id = this.db.prepare('SELECT id FROM identity').get()?.id;
      if (typeof id !== 'string') throw Error('数据库标识无效');
      this.db.prepare('SELECT b.turnoverRate, s.members FROM bars b, snapshots s LIMIT 0').all();

      this.location = { id, path: realpathSync(file) };
    } catch (error) {
      this.db.close();

      throw error;
    }
  }

  save(input: unknown) {
    const s = parseMarketSnapshotV1(input);
    if (
      s.period !== 'daily' ||
      !cnSymbol.test(s.symbol) ||
      s.market !== s.symbol.slice(0, 2) ||
      !fields.every((field) => s.fields.includes(field))
    )
      throw Error('仅支持完整的 A 股日线快照');
    return this.persist(s);
  }

  private persist(s: DailyWindow) {
    const fetched = new Date(s.fetchedAt).toISOString();
    const digest = createHash('sha256').update(JSON.stringify(s.bars)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(
        'UPDATE snapshots SET fetched=max(fetched,?), name=CASE WHEN fetched<=? THEN ? ELSE name END WHERE symbol=? AND adj=? AND digest=?',
      );
      if (!update.run(fetched, fetched, s.name, s.symbol, s.adjust, digest).changes) {
        const previous = this.db.prepare(
          'SELECT * FROM bars WHERE symbol=? AND adj=? AND date=? ORDER BY id DESC LIMIT 1',
        );
        const insert = this.db.prepare(
          'INSERT INTO bars(symbol,adj,date,open,high,low,close,volume,amount,turnoverRate) VALUES(?,?,?,?,?,?,?,?,?,?)',
        );
        // A snapshot pins immutable row IDs. A price correction appends only changed bars.
        const existing = this.db.prepare('SELECT 1 FROM bars WHERE symbol=? AND adj=? LIMIT 1').get(s.symbol, s.adjust);
        const ids = s.bars.map((b) => {
          const old = existing && previous.get(s.symbol, s.adjust, b.date);
          if (old && fields.every((f) => old[f] === b[f])) return Number(old.id);
          return Number(insert.run(s.symbol, s.adjust, b.date, ...fields.map((f) => b[f])).lastInsertRowid);
        });
        // Consecutive trading days typically reference adjacent row IDs. Deltas keep
        // a daily archive of overlapping 2,000-bar windows small.
        const deltas = ids.map((id, index) => id - (ids[index - 1] ?? 0));
        const members = deflateRawSync(JSON.stringify({ deltas }));
        this.db
          .prepare('INSERT INTO snapshots(symbol,adj,digest,name,fetched,members,last_date) VALUES(?,?,?,?,?,?,?)')
          .run(s.symbol, s.adjust, digest, s.name, fetched, members, s.asOf);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { count: s.bars.length, asOf: s.asOf };
  }

  read(symbol: string, adjust: Adjustment, limit: number) {
    const header = this.db
      .prepare('SELECT name,fetched,members FROM snapshots WHERE symbol=? AND adj=? ORDER BY last_date DESC,fetched DESC LIMIT 1')
      .get(symbol, adjust) as Header | undefined;
    if (!header) return undefined;
    const selected = snapshotIds(header.members).slice(-limit);
    const rows = this.db
      .prepare('SELECT b.* FROM json_each(?) AS j JOIN bars b ON b.id=j.value ORDER BY CAST(j.key AS INTEGER)')
      .all(JSON.stringify(selected)) as unknown as StoredBar[];
    if (!rows.length || rows.length !== selected.length) throw Error('快照记录不完整');
    const bars = rows.map(({ date, open, high, low, close, volume, amount, turnoverRate }) => ({
      date,
      open,
      high,
      low,
      close,
      volume,
      amount,
      turnoverRate,
    }));
    const base = {
      schemaVersion: 1,
      dataSemanticVersion: 'market-bars-v1',
      period: 'daily',
      basePeriod: 'daily',
      symbol,
      code: symbol.slice(2),
      market: symbol.slice(0, 2),
      name: header.name,
      fields,
      adjust,
      bars,
      quality: { status: 'valid', missingFields: fields.filter((f) => bars.some((b) => b[f] === null)) },
      fetchedAt: header.fetched,
      asOf: bars.at(-1)!.date,
    } as const;
    return { ...base, snapshotId: marketSnapshotId(base) };
  }

  saveContext(context: StockContextResponse) {
    const value = parseStockContext(context, context.symbol);
    if (value.status === 'unavailable') return false;
    if (
      value.finance.status === 'unavailable' &&
      ['valid', 'partial'].includes(this.readContext(value.symbol)?.finance.status ?? '')
    )
      return false;
    const result = this.db
      .prepare(
        'INSERT INTO contexts(symbol,fetched,json) VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET fetched=excluded.fetched,json=excluded.json WHERE excluded.fetched>=contexts.fetched',
      )
      .run(value.symbol, new Date(value.fetchedAt).toISOString(), JSON.stringify(value));
    return Number(result.changes) > 0;
  }

  readContext(symbol: string) {
    const row = this.db.prepare('SELECT json FROM contexts WHERE symbol=?').get(symbol);
    return typeof row?.json === 'string' ? parseStockContext(JSON.parse(row.json), symbol) : undefined;
  }

  coverage() {
    return this.db.prepare("SELECT max(last_date) AS asOf,count(DISTINCT symbol) AS symbols FROM snapshots WHERE adj='qfq'").get();
  }

  stocks(query: string) {
    return this.db
      .prepare(
        'SELECT symbol,name,substr(symbol,3) AS code,substr(symbol,1,2) AS market FROM snapshots WHERE instr(symbol,?) OR instr(name,?) GROUP BY symbol ORDER BY symbol LIMIT 30',
      )
      .all(query, query);
  }
  close() {
    this.db.close();
  }
}

// O_EXCL ensures even a racing create can never overwrite an existing file.
export function createDatabase(file:string){
  closeSync(openSync(file,'wx',0o600));
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(file);
    db.exec(`BEGIN;
          PRAGMA application_id=${applicationId}; PRAGMA user_version=3;
          CREATE TABLE identity (id TEXT PRIMARY KEY);
          CREATE TABLE contexts (symbol TEXT PRIMARY KEY, fetched TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
          CREATE TABLE bars (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, adj TEXT NOT NULL, date TEXT NOT NULL,
            open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, turnoverRate REAL);
          CREATE INDEX bar_date ON bars(symbol,adj,date);
          CREATE TABLE snapshots (symbol TEXT NOT NULL, adj TEXT NOT NULL, digest TEXT NOT NULL, name TEXT NOT NULL,
            fetched TEXT NOT NULL, members BLOB NOT NULL,last_date TEXT, PRIMARY KEY(symbol,adj,digest)) WITHOUT ROWID;
          CREATE INDEX newest ON snapshots(symbol,adj,last_date DESC,fetched DESC);
      CREATE TABLE history_imports(symbol TEXT NOT NULL,cutoff TEXT NOT NULL,source TEXT NOT NULL,listed TEXT NOT NULL,delisted TEXT,first_date TEXT NOT NULL,last_date TEXT NOT NULL,n INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(symbol,cutoff)) WITHOUT ROWID;`);
    db.prepare('INSERT INTO identity VALUES (?)').run(randomUUID());
    db.exec('COMMIT');
  }catch(e){db?.close();db=undefined;unlinkSync(file);throw e}finally{db?.close()}
}
