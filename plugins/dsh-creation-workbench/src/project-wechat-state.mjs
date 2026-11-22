import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const wechatTextLimit = 3500;

export class ProjectWeChatState {
  constructor(file) {
    mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    closeSync(openSync(file,'a',0o600));
    chmodSync(file,0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS wx_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT);
      INSERT OR IGNORE INTO wx_binding VALUES(1,NULL);
      CREATE TABLE IF NOT EXISTS wx_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), holder TEXT, until_time INTEGER);
      INSERT OR IGNORE INTO wx_lease VALUES(1,NULL,0);
      CREATE TABLE IF NOT EXISTS wx_peer (
        account TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '', token TEXT, project_id TEXT
      );
      CREATE TABLE IF NOT EXISTS wx_canvas (
        account TEXT NOT NULL, project_id TEXT NOT NULL, canvas_id TEXT, PRIMARY KEY(account,project_id)
      );
      CREATE TABLE IF NOT EXISTS wx_inbox (
        seq INTEGER PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL, request_id TEXT NOT NULL,
        text TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'queued', project_id TEXT, canvas_id TEXT,
        session_id TEXT, response TEXT, signature TEXT, waited_at INTEGER, UNIQUE(account,message_id)
      );
      CREATE INDEX IF NOT EXISTS wx_inbox_phase ON wx_inbox(account,phase,seq);
      CREATE INDEX IF NOT EXISTS wx_inbox_conversation ON wx_inbox(account,seq);
      CREATE TABLE IF NOT EXISTS wx_outbox (
        seq INTEGER PRIMARY KEY, account TEXT NOT NULL, notice TEXT NOT NULL, client_id TEXT NOT NULL,
        text TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending', UNIQUE(account,notice)
      );
      CREATE INDEX IF NOT EXISTS wx_outbox_phase ON wx_outbox(account,phase,seq);
      CREATE TABLE IF NOT EXISTS wx_approvals (
        code TEXT PRIMARY KEY, account TEXT NOT NULL, job INTEGER NOT NULL, scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS wx_approval_job ON wx_approvals(account,job,scope);`);
    this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('wx_outbox') WHERE name='dialog'").get()) {
        this.db.exec('ALTER TABLE wx_outbox ADD COLUMN dialog TEXT');
      }
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('wx_inbox') WHERE name='approval_seq'").get()) {
        this.db.exec('ALTER TABLE wx_inbox ADD COLUMN approval_seq INTEGER');
      }
    });
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value=run();
      this.db.exec('COMMIT');
      return value;
    } catch(error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  binding() {
    const row=this.db.prepare('SELECT data FROM wx_binding WHERE singleton=1').get();
    return row.data ? JSON.parse(row.data) : null;
  }

  bind(value) {
    this.db.prepare('UPDATE wx_binding SET data=? WHERE singleton=1').run(value?JSON.stringify(value):null);
  }

  lease(holder) {
    const now=Date.now();
    return this.db.prepare('UPDATE wx_lease SET holder=?,until_time=? WHERE singleton=1 AND (holder=? OR until_time<=?)')
      .run(holder,now+60_000,holder,now).changes===1;
  }

  release(holder) {
    this.db.prepare('UPDATE wx_lease SET holder=NULL,until_time=0 WHERE singleton=1 AND holder=?').run(holder);
  }

  peer(account) {
    return this.db.prepare('SELECT * FROM wx_peer WHERE account=?').get(account)||{};
  }

  canvas(account,project) {
    return this.db.prepare('SELECT canvas_id FROM wx_canvas WHERE account=? AND project_id=?').get(account,project)?.canvas_id;
  }

  select(account,project,canvas) {
    this.db.prepare('INSERT INTO wx_peer(account,project_id) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET project_id=excluded.project_id')
      .run(account,project);
    this.db.prepare(`INSERT INTO wx_canvas(account,project_id,canvas_id) VALUES(?,?,?)
      ON CONFLICT(account,project_id) DO UPDATE SET canvas_id=excluded.canvas_id`).run(account,project,canvas??null);
  }

  accept(account,response,messages) {
    this.transaction(()=>{
      const set=this.db.prepare(`INSERT INTO wx_peer(account,cursor) VALUES(?,?)
        ON CONFLICT(account) DO UPDATE SET cursor=CASE WHEN excluded.cursor<>'' THEN excluded.cursor ELSE cursor END`);
      set.run(account,typeof response.get_updates_buf==='string'?response.get_updates_buf:'');
      const add=this.db.prepare('INSERT OR IGNORE INTO wx_inbox(account,message_id,request_id,text) VALUES(?,?,?,?)');
      const updateToken=this.db.prepare('UPDATE wx_peer SET token=? WHERE account=?');
      for(const item of messages){
        if(add.run(account,item.id,randomUUID(),item.text).changes&&item.token)updateToken.run(item.token,account);
      }
    });
  }

  queue(row,notice,text,dialog,after=row.seq) {
    const offer = dialog ? JSON.stringify({...dialog,after,expiresAt:Date.now()+15*60_000}) : null;
    this.db.prepare('INSERT OR IGNORE INTO wx_outbox(account,notice,client_id,text,dialog) VALUES(?,?,?,?,?)')
      .run(row.account,notice,'wtt-'+randomUUID(),text.slice(0,wechatTextLimit),offer);
  }

  dialog(row) {
    const sent = this.db.prepare("SELECT dialog FROM wx_outbox WHERE account=? AND phase='sent' ORDER BY seq DESC LIMIT 1").get(row.account);
    if (!sent?.dialog) return null;
    const dialog = JSON.parse(sent.dialog);
    if (dialog.expiresAt <= Date.now()) return null;
    const previous = this.db.prepare('SELECT seq FROM wx_inbox WHERE account=? AND seq<? ORDER BY seq DESC LIMIT 1').get(row.account,row.seq);
    return dialog.after === previous?.seq ? dialog : null;
  }

  finish(row,text,dialog) {
    this.transaction(()=>{
      this.db.prepare("UPDATE wx_inbox SET phase='done',response=? WHERE seq=?").run(text,row.seq);
      this.queue(row,'reply:'+row.seq,text,dialog);
    });
  }

  tracking(row,signature,text,dialog,final=false) {
    this.transaction(()=>{
      this.db.prepare('UPDATE wx_inbox SET phase=?,response=?,signature=? WHERE seq=?')
        .run(final?'done':'tracking',text,signature,row.seq);
      this.queue(row,'plan:'+row.seq+':'+signature,text,dialog,row.approval_seq??row.seq);
    });
  }

  status(account) {
    const failed=this.db.prepare("SELECT count(*) AS total FROM wx_outbox WHERE account=? AND phase IN ('failed','sending')").get(account).total;
    const pending=this.db.prepare("SELECT count(*) AS total FROM wx_inbox WHERE account=? AND phase<>'done'").get(account).total;
    return {deliveryPending:failed,activeRequests:pending};
  }

  close() { this.db.close(); }
}
