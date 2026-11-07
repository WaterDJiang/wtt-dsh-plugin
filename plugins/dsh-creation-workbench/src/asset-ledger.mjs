import { randomUUID, createHash } from 'node:crypto';

export const BUSINESS_STAGES = ['需求梳理', '方案待确认', '制作中', '待交付', '已交付', '已授课'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value, label, max = 2000) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label}无效`); return value.trim(); };
const date = value => {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('日期必须为有效年月日');
  return value;
};
export function amountMinor(value) {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new Error('金额须为非负数，最多两位小数');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 999_999_999_999) throw new Error('金额超过范围');
  return amount;
}

export class AssetLedger {
  constructor(service) {
    this.service = service; this.db = service.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS asset_business(requirement_id TEXT PRIMARY KEY REFERENCES canvas_spaces(id), revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_receipts(id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL REFERENCES canvas_spaces(id), currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, paid_on TEXT NOT NULL, note TEXT NOT NULL, reversal_of TEXT UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_reviews(version_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, requirement_id TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_deliveries(card_id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, version_id TEXT NOT NULL, selected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  requirement(id) { const row = this.service.store.getRequirement(id); if (!row) throw new Error('课程不存在或不属于当前项目'); return row; }
  business(requirementId) {
    this.requirement(requirementId);
    const saved = this.db.prepare('SELECT * FROM asset_business WHERE requirement_id=?').get(requirementId);
    const record = saved ? { revision: saved.revision, ...JSON.parse(saved.data) } : {
      revision: 0, stage: '需求梳理', customer: '', nextAction: '', waitingFor: '', followUpDate: '',
      currency: 'CNY', receivableMinor: null, dueDate: '', note: '' };
    const receipts = this.db.prepare('SELECT id,currency,amount_minor AS amountMinor,paid_on AS paidOn,note,reversal_of AS reversalOf,created_at AS createdAt FROM asset_receipts WHERE requirement_id=? ORDER BY created_at,id').all(requirementId).map(row => ({ ...row }));
    const collectedByCurrency = {};
    for (const receipt of receipts) collectedByCurrency[receipt.currency] = (collectedByCurrency[receipt.currency] || 0) + receipt.amountMinor;
    return { requirementId, ...record, receipts, collectedByCurrency,
      outstandingMinor: record.receivableMinor == null ? null : record.receivableMinor - (collectedByCurrency[record.currency] || 0) };
  }
  mutate(input, kind, action) {
    if (!uuid(input.operationId)) throw new Error('请提供有效操作标识');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT * FROM asset_operations WHERE id=?').get(input.operationId);
      if (previous) {
        if (previous.kind !== kind || previous.input_hash !== fingerprint) throw new Error('操作标识已用于不同内容');
        this.db.exec('COMMIT'); return JSON.parse(previous.result);
      }
      const result = action();
      this.db.prepare('INSERT INTO asset_operations VALUES(?,?,?,?,?)').run(input.operationId, kind, fingerprint, JSON.stringify(result), new Date().toISOString());
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveBusiness(input) {
    this.requirement(input.requirementId);
    if (!BUSINESS_STAGES.includes(input.stage) || !/^[A-Z]{3}$/.test(input.currency || '') || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('业务阶段、币种或版本无效');
    const data = { stage: input.stage, currency: input.currency, customer: text(input.customer, '客户', 200),
      nextAction: text(input.nextAction, '下一步'), waitingFor: text(input.waitingFor, '等待对象', 200),
      followUpDate: date(input.followUpDate), receivableMinor: input.receivable === '' ? null : amountMinor(input.receivable),
      dueDate: date(input.dueDate), note: text(input.note, '业务备注') };
    return this.mutate(input, 'business', () => {
      const current = this.business(input.requirementId);
      if (current.revision !== input.revision) throw new Error('业务记录已在其他页面更新，请刷新后合并，当前输入保留');
      this.db.prepare('INSERT INTO asset_business VALUES(?,?,?) ON CONFLICT(requirement_id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
        .run(input.requirementId, input.revision + 1, JSON.stringify(data));
      return this.business(input.requirementId);
    });
  }
  recordReceipt(input) {
    this.requirement(input.requirementId);
    if (input.confirmed !== true || !/^[A-Z]{3}$/.test(input.currency || '') || !input.paidOn) throw new Error('请明确确认人工收款事实、币种和收款日期');
    const amount = amountMinor(input.amount);
    if (amount <= 0) throw new Error('收款金额须大于零');
    const paidOn = date(input.paidOn), note = text(input.note, '收款说明');
    if (!note) throw new Error('请填写收款依据或说明');
    return this.mutate(input, 'receipt', () => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO asset_receipts VALUES(?,?,?,?,?,?,NULL,?)').run(id, input.requirementId, input.currency, amount, paidOn, note, new Date().toISOString());
      return this.business(input.requirementId);
    });
  }
  reverseReceipt(input) {
    this.requirement(input.requirementId);
    if (input.confirmed !== true || !uuid(input.receiptId)) throw new Error('请明确确认冲销记录');
    const note = text(input.note, '冲销原因');
    if (!note) throw new Error('请填写冲销原因');
    return this.mutate(input, 'receipt-reversal', () => {
      const original = this.db.prepare('SELECT * FROM asset_receipts WHERE id=? AND requirement_id=?').get(input.receiptId, input.requirementId);
      if (!original || original.reversal_of) throw new Error('只可冲销当前课程的原收款记录');
      if (this.db.prepare('SELECT id FROM asset_receipts WHERE reversal_of=?').get(original.id)) throw new Error('此收款已冲销，原记录保留');
      this.db.prepare('INSERT INTO asset_receipts VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.requirementId, original.currency, -original.amount_minor, date(input.paidOn), note, original.id, new Date().toISOString());
      return this.business(input.requirementId);
    });
  }
  describe(input) {
    this.requirement(input.requirementId);
    if (!input.versionId || !input.cardId) throw new Error('必须选择准确卡片版本');
    const described = this.service.cards.describe(input);
    if (described.node.status !== 'ready' && !['saved', 'current'].includes(described.node.status)) throw new Error('此版本文件不可用或已变化，不能审阅或选作交付');
    if (!described.node.path && !described.node.markdownPath) throw new Error('此版本没有真实文件');
    return described;
  }
  review(input) {
    this.describe(input);
    if (!['pending', 'approved', 'changes'].includes(input.state)) throw new Error('审阅结果无效');
    const note = text(input.note, '审阅意见');
    return this.mutate(input, 'review', () => {
      this.db.prepare('INSERT INTO asset_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(version_id) DO UPDATE SET state=excluded.state,note=excluded.note,updated_at=excluded.updated_at')
        .run(input.versionId, input.cardId, input.requirementId, input.state, note, new Date().toISOString());
      return { versionId: input.versionId, state: input.state, note };
    });
  }
  selectDelivery(input) {
    if (input.selected === false) { this.requirement(input.requirementId); this.service.cards.describe(input); }
    else this.describe(input);
    return this.mutate(input, 'delivery-selection', () => {
      if (input.selected === false) this.db.prepare('DELETE FROM asset_deliveries WHERE card_id=? AND requirement_id=?').run(input.cardId, input.requirementId);
      else {
        const reviewed = this.db.prepare("SELECT state FROM asset_reviews WHERE version_id=? AND requirement_id=? AND card_id=?").get(input.versionId, input.requirementId, input.cardId);
        if (reviewed?.state !== 'approved') throw new Error('请先审阅通过此准确版本，再选入交付清单');
        this.db.prepare('INSERT INTO asset_deliveries VALUES(?,?,?,?) ON CONFLICT(card_id) DO UPDATE SET version_id=excluded.version_id,selected_at=excluded.selected_at')
          .run(input.cardId, input.requirementId, input.versionId, new Date().toISOString());
      }
      return { cardId: input.cardId, versionId: input.versionId, selected: input.selected !== false };
    });
  }
  course(requirementId) {
    const requirement = this.requirement(requirementId), board = this.service.canvas.getBoard(requirementId);
    const tasks = this.service.tasks.list(requirementId), details = new Map();
    const cards = board.nodes.filter(node => node.outputCard?.versions?.length).map(node => {
      const card = node.outputCard, selected = this.db.prepare('SELECT version_id FROM asset_deliveries WHERE card_id=?').get(card.id);
      const versions = card.versions.map(version => {
        if (version.taskId && !details.has(version.taskId)) details.set(version.taskId, this.service.tasks.get(version.taskId));
        const file = details.get(version.taskId)?.files.find(item => `artifact:${item.id}` === version.primaryRef);
        return { ...version, path: file?.path || null, format: file?.path?.split('.').pop().toUpperCase() || (card.type === 'outline' ? 'MD' : card.type.toUpperCase()), review: this.db.prepare('SELECT state,note,updated_at AS updatedAt FROM asset_reviews WHERE version_id=?').get(version.id) || { state: 'pending' } };
      });
      const taskIds = new Set(versions.map(version => version.taskId));
      const dependencyWarnings = [];
      for (const task of tasks.filter(task => taskIds.has(task.id))) {
        if (!details.has(task.id)) details.set(task.id, this.service.tasks.get(task.id));
        const detail = details.get(task.id);
        for (const source of detail.input.sources || []) {
          const producer = board.nodes.find(item => item.outputCard?.versions?.some(version => version.primaryRef === source.cardId));
          if (producer && producer.sourceId !== source.cardId) dependencyWarnings.push({ taskId: task.id, title: source.title, source: source.cardId, latest: producer.sourceId });
        }
      }
      return { id: card.id, title: node.title, type: card.type, fileKind: node.artifactKind,
        versions, latestVersionId: card.latestVersionId, selectedVersionId: selected?.version_id || null,
        node: { id: node.id, refId: node.refId, sourceId: node.sourceId, sourceHash: node.sourceHash, path: node.path, status: node.status }, dependencyWarnings };
    });
    return { requirement, business: this.business(requirementId), cards, tasks: tasks.map(task => ({ id: task.id, kind: task.kind,
      title: task.title, instruction: task.instruction.slice(0, 400), sessionId: task.sessionId, status: task.status,
      files: task.files.map(file => ({ title: file.title, kind: file.kind })) })) };
  }
  overview() {
    return { stages: BUSINESS_STAGES, courses: this.service.store.listRequirements().map(requirement => ({ requirement, business: this.business(requirement.id),
      deliveries: this.db.prepare('SELECT COUNT(*) AS n FROM asset_deliveries WHERE requirement_id=?').get(requirement.id).n })),
      policy: this.service.production.policy() };
  }
  deliveryManifest(requirementId) {
    const course = this.course(requirementId), entries = [];
    for (const card of course.cards.filter(card => card.selectedVersionId)) {
      const selected = this.describe({ requirementId, cardId: card.id, versionId: card.selectedVersionId });
      const review = this.db.prepare('SELECT state FROM asset_reviews WHERE version_id=?').get(card.selectedVersionId);
      if (review?.state !== 'approved') throw new Error(`「${card.title}」当前交付版尚未审阅通过`);
      entries.push({ cardId: card.id, title: card.title, versionId: card.selectedVersionId, number: selected.version.number,
        path: selected.node.path || selected.node.markdownPath, hash: selected.node.sourceHash, sourceId: selected.version.primaryRef,
        attachments: selected.version.outputs || [] });
    }
    return { format: 'wtt-course-delivery-v1', requirementId, course: course.requirement.title, createdAt: new Date().toISOString(),
      entries, notice: '选定文件清单，不代表已经发送、机构确认、授课或收款。' };
  }
}
