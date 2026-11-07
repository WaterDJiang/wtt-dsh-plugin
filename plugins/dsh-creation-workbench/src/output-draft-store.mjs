import { createHash, randomUUID } from 'node:crypto';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const labels = { text: '新文本', pptx: '新 PPT', image: '新图片', video: '新视频' };

// Compositions are real canvas objects, but are not tasks, files or versions.
export class OutputDraftStore {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS output_card_drafts (
      card_id TEXT PRIMARY KEY REFERENCES output_cards(id), output_type TEXT NOT NULL,
      references_json TEXT NOT NULL, instruction TEXT NOT NULL, position_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    )`);
  }
  get(requirementId, cardId) {
    if (this.store.closed) throw new Error('工作台已关闭');
    const row = this.db.prepare(`SELECT d.*,c.requirement_id FROM output_card_drafts d
      JOIN output_cards c ON c.id=d.card_id WHERE d.card_id=? AND c.requirement_id=?`).get(cardId,requirementId);
    if (!row) throw new Error('草稿卡不存在或不属于当前画布');
    const editable = !this.db.prepare('SELECT 1 FROM output_card_tasks WHERE card_id=?').get(cardId);
    return { cardId, outputType: row.output_type, references: JSON.parse(row.references_json), instruction: row.instruction,
      position: JSON.parse(row.position_json), revision: row.revision, editable };
  }
  create({ requirementId, outputType, references, position, operationId }) {
    if (!uuid(operationId) || !Object.hasOwn(labels,outputType)) throw new Error('新建卡片类型或操作标识无效');
    if (!position || ![position.x,position.y].every(n=>Number.isFinite(n)&&Math.abs(n)<=999_000)) throw new Error('新卡片位置无效');
    const inputHash = createHash('sha256').update(JSON.stringify({requirementId,outputType,references,position})).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
      if(old&&(old.kind!=='create-output-draft'||old.input_hash!==inputHash))throw new Error('操作标识已用于不同内容');
      const id=old?.result_id||randomUUID();
      if(!old){
        this.db.prepare('INSERT INTO output_cards (id,requirement_id,type,title,node_id,created_at) VALUES (?,?,?,?,?,?)')
          .run(id,requirementId,outputType,labels[outputType],`output:${id}`,new Date().toISOString());
        this.db.prepare('INSERT INTO output_card_drafts VALUES (?,?,?,?,?,0)').run(id,outputType,JSON.stringify(references),'',JSON.stringify(position));
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId,'create-output-draft',inputHash,id);
      }
      this.db.exec('COMMIT'); return this.get(requirementId,id);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  save({ requirementId, cardId, instruction, references, expectedRevision }) {
    if(typeof instruction!=='string'||instruction.length>20_000||instruction.includes('\0'))throw new Error('创作要求不能超过20000字');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const draft=this.get(requirementId,cardId);
      if(draft.editable){
        if(draft.revision!==expectedRevision)throw new Error('草稿已在其他窗口更新，请先保留输入并刷新页面核对');
        this.db.prepare('UPDATE output_card_drafts SET instruction=?,references_json=?,revision=revision+1 WHERE card_id=?')
          .run(instruction,JSON.stringify(references),cardId);
      }
      this.db.exec('COMMIT');return this.get(requirementId,cardId);
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
