import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type Stock={symbol:string;name:string};
type Summary={total:number;skipped:number;pending:number;failed:number;error:string};
type Item=Stock & {failure:string|null};

export class SyncCheckpoint {
  private readonly file:string;
  private db?:DatabaseSync;
  private lock?:DatabaseSync;

  constructor(private readonly dir:string,binding:string){
    this.file=join(dir,createHash('sha256').update(binding).digest('hex')+'.sqlite');
  }

  summary():Summary|undefined{
    if(!this.db && !existsSync(this.file))return;
    const db=this.db??new DatabaseSync(this.file,{readOnly:true});
    try{
      // An interrupted first open may leave an empty SQLite file.
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run'").get())return;
      return db.prepare(`SELECT total,skipped,error,
        (SELECT count(*) FROM remaining WHERE failure IS NULL) AS pending,
        (SELECT count(*) FROM remaining WHERE failure IS NOT NULL) AS failed FROM run`).get() as Summary|undefined;
    }finally{if(db!==this.db)db.close()}
  }

  acquire(){
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    this.lock=new DatabaseSync(this.file+'.lock');
    try{
      // A separate SQLite writer lock lasts for this run and is released by the OS on exit.
      this.lock.exec('BEGIN IMMEDIATE');
      this.db=new DatabaseSync(this.file);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS run(total INTEGER NOT NULL,skipped INTEGER NOT NULL,error TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remaining(symbol TEXT PRIMARY KEY,name TEXT NOT NULL,failure TEXT);
        COMMIT;`);
    }catch(error){
      this.release();
      if(error.errcode===5)throw Error('另一 DSH 宿主正在同步此数据库，请稍后继续');
      throw error;
    }
  }

  release(){
    this.db?.close();this.db=undefined;
    this.lock?.close();this.lock=undefined;
  }

  begin(queue:Stock[],skipped:number){
    const db=this.db!;
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('DELETE FROM remaining; DELETE FROM run');
      db.prepare("INSERT INTO run VALUES(?,?,'')").run(queue.length+skipped,skipped);
      const add=db.prepare('INSERT INTO remaining(symbol,name) VALUES(?,?)');
      for(const stock of queue)add.run(stock.symbol,stock.name);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
  }

  remaining():Item[]{
    return this.db!.prepare('SELECT symbol,name,failure FROM remaining ORDER BY rowid').all() as Item[];
  }
  retryFailed(){this.db!.exec('UPDATE remaining SET failure=NULL WHERE failure IS NOT NULL')}
  message(error:string){this.db!.prepare('UPDATE run SET error=?').run(error)}
  finished(symbol:string){this.db!.prepare('DELETE FROM remaining WHERE symbol=?').run(symbol)}
  failed(symbol:string,message:string){this.db!.prepare('UPDATE remaining SET failure=? WHERE symbol=?').run(message,symbol)}
}
