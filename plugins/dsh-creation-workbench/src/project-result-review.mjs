import { randomUUID } from 'node:crypto';
import { extractSkillNames } from './skill-commands.mjs';

export const resultReviewSource = 'wtt-project-review';
const maxRevisions = 2;
export const readReceipts = step => {
  const receipt = typeof step.receipt === 'string' ? JSON.parse(step.receipt) : step.receipt;
  return step.artifact_set ? JSON.parse(step.artifact_set) : receipt ? [receipt] : [];
};

export class ProjectResultReview {
  constructor(runner) {
    this.runner = runner;
    this.db = runner.db;
    this.active = new Map();
    this.sent = new Set();
    const columns = new Set(this.db.prepare('PRAGMA table_info(pa_steps)').all().map(column => column.name));
    for (const [name, type] of Object.entries({
      artifact_set: 'TEXT', operation_id: 'TEXT', revision_task: 'TEXT',
      revision_count: 'INTEGER NOT NULL DEFAULT 0', result_review_id: 'TEXT',
    })) {
      if (!columns.has(name)) this.db.exec('ALTER TABLE pa_steps ADD COLUMN ' + name + ' ' + type);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS pa_result_reviews (
      id TEXT PRIMARY KEY,step_id TEXT NOT NULL,task_id TEXT NOT NULL,session_id TEXT NOT NULL,
      scope_token TEXT NOT NULL,state TEXT NOT NULL,decision TEXT,reason TEXT
    )`);
  }

  transaction(apply) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = apply();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  collect(step, task, saved) {
    if (step.revision_task) {
      const target = JSON.parse(step.revision_task);
      const revised = saved.find(card => card.cardId === target.cardId);
      if (!revised) throw Error('修订任务未登记原卡的新版本');
      saved = readReceipts(step).map(card => card.cardId === target.cardId ? revised : card);
    }
    if (saved.length > 24) throw Error('此步骤产出了超过 24 张成果卡，请在原任务核对交付范围');
    const sources = this.runner.freezeByCanvas(saved, step.data.requirementId);
    const receipts = saved.map((card, index) => ({...card, title: sources[index].title, hash: sources[index].hash}));
    this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM pa_steps WHERE id=? AND task_id=? AND handoff=0 AND state NOT IN ('done','checking','review-waiting')").get(step.id,task.id);
      if (!current) return;
      const reviewId = step.data.acceptance ? this.enqueue(current, step.data) : null;
      this.db.prepare('UPDATE pa_steps SET state=?,receipt=?,artifact_set=?,result_review_id=?,revision_task=NULL,error=NULL WHERE id=?')
        .run(reviewId ? 'checking' : 'done', JSON.stringify(receipts[0]), JSON.stringify(receipts), reviewId, step.id);
    });
  }

  enqueue(step, data) {
    const id = randomUUID();
    const sessionId = data.sessionId || this.db.prepare('SELECT session_id FROM pa_turns WHERE id=?').get(step.plan_id)?.session_id;
    if (!sessionId) throw Error('无法找到委托的原助手会话');
    this.db.prepare("INSERT INTO pa_result_reviews(id,step_id,task_id,session_id,scope_token,state) VALUES(?,?,?,?,?,'pending')")
      .run(id,step.id,step.task_id,sessionId,this.runner.planStepsToken(step.plan_id));
    return id;
  }

  row(id) {
    return this.db.prepare(`SELECT r.*,s.data,s.state AS step_state,s.task_id AS current_task,s.artifact_set,s.receipt,s.handoff,
      s.revision_count,s.authorized,s.kept_version,s.seq,s.plan_id,p.state AS plan_state,p.mode
      FROM pa_result_reviews r JOIN pa_steps s ON s.id=r.step_id AND s.result_review_id=r.id
      JOIN pa_plans p ON p.id=s.plan_id WHERE r.id=?`).get(id);
  }

  current(id, sessionId) {
    if (this.runner.service.store.closed) return null;
    const row = this.row(id);
    return row && row.session_id === sessionId && row.plan_state === 'running' && row.step_state === 'checking' &&
      !row.handoff && row.authorized && row.task_id === row.current_task &&
      ['pending','running'].includes(row.state) && this.runner.planStepsToken(row.plan_id) === row.scope_token ? row : null;
  }

  evidence(row,{allowKept=false}={}) {
    const receipts = readReceipts(row);
    const requirementId = JSON.parse(row.data).requirementId;
    for (const receipt of receipts) {
      const card = this.db.prepare('SELECT head_version_id FROM output_cards WHERE id=? AND requirement_id=?').get(receipt.cardId,receipt.requirementId);
      const kept = row.kept_version?.startsWith('{') ? JSON.parse(row.kept_version)[receipt.cardId] : row.kept_version;
      if (card?.head_version_id !== receipt.versionId && !(allowKept && kept && card?.head_version_id===kept))
        throw Error('成果已有新版，请核对并选择要交付的版本');
    }
    return this.runner.freezeByCanvas(receipts,requirementId).map((source,index) => ({
      ...receipts[index],kind:source.kind,excerpt:source.note?'':(source.content || '').slice(0,2400),
      limited:Boolean(source.note||source.noteTruncated||source.content?.length>2400),
    }));
  }

  async deliver(step) {
    const id = step.result_review_id;
    const queued = this.row(id);
    if (!queued || !['pending','running'].includes(queued.state)) return;
    const allowed = () => Boolean(this.current(id,queued.session_id));
    if (!allowed()) {
      if (queued.plan_state==='running' && !queued.handoff && queued.authorized)
        this.wait(id,'委托范围已有变化，请重新发起验收');
      return;
    }
    if (this.active.get(queued.session_id) === id) return;
    try {
      const result = await this.runner.host.deliverReview(this.runner.service,queued.session_id,id,allowed,() => {
        const data = JSON.parse(queued.data);
        return {
          reviewId:id,planId:queued.plan_id,stepId:queued.step_id,title:data.title,criteria:data.acceptance.criteria,
          minCards:data.acceptance.minCards,remainingRevisions:queued.mode==='step' ? 0 : maxRevisions-queued.revision_count,
          artifacts:this.evidence(queued),
        };
      },this.sent.has(id));
      if (result==='sent') this.sent.add(id);
      if (result==='observed') this.wait(id,'复核已结束，请核对结果或重新验收');
      if (result==='unconfirmed') this.wait(id,'原助手会话未确认接收，请重新验收');
    } catch (error) {
      this.wait(id,String(error.message).slice(0,1000));
    }
  }

  admit(sessionId,id) {
    if (!this.current(id,sessionId)) return false;
    this.db.prepare("UPDATE pa_result_reviews SET state='running' WHERE id=? AND state='pending'").run(id);
    this.active.set(sessionId,id);
    return true;
  }

  end(sessionId) {
    const id = this.active.get(sessionId);
    this.active.delete(sessionId);
    if (id && !this.runner.service.store.closed) this.wait(id,'本轮未提交有效的验收决定，请重新验收');
  }

  wait(id,reason) {
    this.sent.delete(id);
    if (this.runner.service.store.closed) return;
    this.transaction(()=>this.markWaiting(id,reason));
  }

  markWaiting(id,reason) {
    if (!this.db.prepare("UPDATE pa_result_reviews SET state='waiting',reason=? WHERE id=? AND state IN ('pending','running')").run(reason,id).changes) return;
    this.db.prepare("UPDATE pa_steps SET state='review-waiting',error=? WHERE result_review_id=? AND state='checking' AND handoff=0")
      .run(reason,id);
  }

  pausePlan(planId) {
    this.transaction(() => {
      this.db.prepare("UPDATE pa_plans SET state='paused' WHERE id=? AND state='running'").run(planId);
      const reviews = this.db.prepare("SELECT r.id FROM pa_result_reviews r JOIN pa_steps s ON s.result_review_id=r.id WHERE s.plan_id=? AND r.state='running'").all(planId);
      for (const {id} of reviews) this.markWaiting(id,'此轮验收已暂停，继续委托后可以重新验收');
    });
  }

  retry(step,plan) {
    if (plan.state!=='running' || step.state!=='review-waiting' || step.handoff || !step.task_id)
      throw Error('只有当前待核对的验收可以重试');
    this.transaction(() => {
      const id = this.enqueue(step,step.data);
      if(!this.db.prepare("UPDATE pa_steps SET state='checking',result_review_id=?,error=NULL WHERE id=? AND result_review_id=? AND state='review-waiting' AND handoff=0")
        .run(id,step.id,step.result_review_id).changes)throw Error('本次验收已变化，请刷新后重新核对');
    });
  }

  acceptManually(step,plan) {
    if (plan.state!=='running' || step.state!=='review-waiting' || step.handoff) throw Error('当前步骤无需人工验收');
    const row = this.row(step.result_review_id);
    if (!row || this.evidence(row,{allowKept:true}).length<step.data.acceptance.minCards) throw Error('正式成果张数未达到验收要求');
    this.transaction(() => {
      const reason = '用户已核对并确认采用成果';
      if(!this.db.prepare(`UPDATE pa_steps SET state='done',error=NULL WHERE id=? AND result_review_id=? AND state='review-waiting'
        AND handoff=0 AND EXISTS (SELECT 1 FROM pa_plans p WHERE p.id=pa_steps.plan_id AND p.state='running')`).run(step.id,row.id).changes)
        throw Error('本次验收已变化，请刷新后重新核对');
      this.db.prepare("UPDATE pa_result_reviews SET state='applied',decision='accept',reason=? WHERE id=?").run(reason,row.id);
      this.runner.memory.event('manual-review-'+row.id,'成果验收',step.data.title,reason,{planId:plan.id,taskId:row.task_id});
    });
  }

  decide(sessionId,{reviewId,decision,reason,cardId,versionId,instruction,steps,replaceFrom}) {
    if (this.active.get(sessionId)!==reviewId) throw Error('只能处理本轮收到的验收');
    const row = this.current(reviewId,sessionId);
    if (!row) throw Error('计划、任务或授权已变化，验收决定已失效');
    if (typeof reason!=='string' || !reason.trim() || reason.length>1200) throw Error('请说明具体的验收依据');
    const data = JSON.parse(row.data);
    const evidence = decision==='ask' ? [] : this.evidence(row);
    if (['accept','adjust'].includes(decision) && evidence.length < data.acceptance.minCards)
      throw Error('正式成果张数未达到验收要求，请修订或请用户处理');
    if (decision==='revise') {
      if (row.mode==='step' || row.revision_count>=maxRevisions) throw Error('当前档位或修订次数需要用户确认');
      const target = evidence.find(card => card.cardId===cardId && card.versionId===versionId);
      if (!target || typeof instruction!=='string' || !instruction.trim() || instruction.length>2800)
        throw Error('请选择此次验收的准确卡片、版本和修订要求');
      const allowedSkills = extractSkillNames(data.instruction);
      if (extractSkillNames(instruction).some(skill=>!allowedSkills.includes(skill)))
        throw Error('新增 Skill 需要重新授权，请提交需要用户处理的决定');
      if (data.executor==='codex' && target.kind!=='artifact') throw Error('当前外部路线只支持文本报告的修订');
    }
    if (!['accept','revise','adjust','ask'].includes(decision)) throw Error('验收决定无效');
    return this.transaction(() => {
      if (!this.current(reviewId,sessionId)) throw Error('计划、任务或授权已变化，验收决定已失效');
      let change;
      if (decision==='adjust') {
        const original = this.db.prepare('SELECT data FROM pa_turns WHERE id=?').get(row.plan_id);
        const turn = {...JSON.parse(original.data),mode:'plan',sessionId};
        this.db.prepare('INSERT INTO pa_turns VALUES(?,?,?)').run(reviewId,sessionId,JSON.stringify(turn));
        change = this.runner.amend(reviewId,{planId:row.plan_id,steps,replaceFrom},turn);
      }
      this.db.prepare("UPDATE pa_result_reviews SET state='applied',decision=?,reason=? WHERE id=?").run(decision,reason,reviewId);
      if (decision==='revise') {
        const revision = {cardId,versionId,instruction};
        this.db.prepare(`UPDATE pa_steps SET state='ready',task_id=NULL,operation_id=?,revision_task=?,
          revision_count=revision_count+1,kept_version=NULL,interaction=NULL,error=NULL WHERE id=?`)
          .run(randomUUID(),JSON.stringify(revision),row.step_id);
      } else {
        this.db.prepare('UPDATE pa_steps SET state=?,error=? WHERE id=?')
          .run(decision==='ask' ? 'review-waiting' : 'done',decision==='ask' ? reason : null,row.step_id);
      }
      this.runner.memory.event('result-review-'+reviewId,'成果验收',data.title,reason,
        {planId:row.plan_id,taskId:row.task_id,cardId,versionId});
      return {saved:true,decision,...change};
    });
  }

  view(id) {
    if (!id) return null;
    return this.db.prepare('SELECT decision,reason FROM pa_result_reviews WHERE id=?').get(id) || null;
  }
}
