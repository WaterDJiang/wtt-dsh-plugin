import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { cardContentAccept, cardDisplayTitle, cardFormat } from './card-capabilities.mjs';
import { inspectMaterialImport } from './material-import.mjs';
import { validateArtifact } from './artifact-validation.mjs';
import { isActiveTaskPhase } from './pending-card-state.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// File uploads are manual versions, never AI tasks or writes to the source file.
export class CardFileContent {
  constructor(service) { this.service = service; this.db = service.store.db; }

  replay(input, kind, fingerprint) {
    if (!uuid(input.operationId)) throw new Error('卡片操作标识无效');
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(input.operationId);
    if (!row) return null;
    if (row.kind !== kind || row.input_hash !== fingerprint) throw new Error('操作标识已用于不同卡片或内容');
    return JSON.parse(row.result_id);
  }

  target(input) {
    const board = this.service.canvas.getBoard(input.requirementId);
    const head = board.nodes.find(node => node.id === input.nodeId);
    if (!head) throw new Error('卡片不存在或不属于当前画布');
    return head;
  }

  scope(input) {
    const head = this.target(input);
    if (!cardContentAccept(head)) throw new Error('此卡片不支持上传文件内容');
    if ((head.outputCard?.latestVersionId || null) !== input.headVersionId) throw new Error('卡片已有新版本，请刷新后重新选择文件');
    const node = input.versionId && head.outputCard
      ? this.service.cards.describe({ requirementId: input.requirementId, cardId: head.outputCard.id, versionId: input.versionId }).node : head;
    if ((node.sourceHash || null) !== input.sourceHash) throw new Error('卡片内容已变化，请重新打开后上传');
    if (head.pendingGeneration && (isActiveTaskPhase(head.pendingGeneration.phase) || ['submitting', 'unknown'].includes(head.pendingGeneration.phase))) throw new Error('任务尚未结束，请先停止原任务再上传内容');
    if (['missing', 'changed', 'modified', 'unavailable'].includes(node.status)) throw new Error('来源文件已变化或不可用，请先核对原文件');
    if (node.sourceHash) this.service.outcomes.read({ requirementId: input.requirementId,
      sourceRef: node.sourceId || node.id, hash: node.importedFile?.hash || node.sourceHash });
    return { head, node };
  }

  async upload(input, { signal } = {}) {
    const metadata = inspectMaterialImport(input);
    const fingerprint = sha(JSON.stringify({ ...input, bytes: undefined, fileHash: metadata.hash }));
    const old = this.replay(input, 'upload-card-content', fingerprint);
    if (old) return old;
    let { node } = this.scope(input);
    if (!cardContentAccept(node).split(',').includes(metadata.extension)) throw new Error('文件类型与卡片不匹配，请选择对应类型的文件');
    const format = cardFormat(node), type = ['image', 'video', 'pptx'].includes(format) ? format : 'text';
    const bytes = Buffer.from(input.bytes);
    const validationKind = type === 'pptx' || ['.json', '.jsonl'].includes(metadata.extension) ? 'support' : type;
    const validated = await validateArtifact(validationKind, metadata.extension === '.markdown' ? 'upload.md' : metadata.safeName, bytes,
      { pythonExecutable: this.service.python, ffprobeExecutable: this.service.ffprobe, pptSkillDir: this.service.pptSkillDir });
    signal?.throwIfAborted();
    const completed = this.replay(input, 'upload-card-content', fingerprint);
    if (completed) return completed;
    ({ node } = this.scope(input));
    const taskId = randomUUID(), artifactId = randomUUID(), now = new Date().toISOString();
    const title = node.displayTitle || (node.composition ? path.basename(metadata.name, metadata.extension) : cardDisplayTitle(node));
    const taskDirectory = `courses/${input.requirementId}/tasks/${taskId}`;
    const relative = `${taskDirectory}/delivery/${metadata.safeName}`;
    this.service.documents.write(relative, bytes);
    let committed = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const replayed = this.replay(input, 'upload-card-content', fingerprint);
        if (replayed) { this.db.exec('ROLLBACK'); return replayed; }
        const { head } = this.scope(input);
        const card = head.outputCard;
        const plan = card && !card.legacy
          ? { id: card.id, requirementId: input.requirementId, type, title, baseVersionId: input.versionId, composition: Boolean(node.composition?.editable) }
          : this.service.cards.prepare({ requirementId: input.requirementId, outputType: type, instruction: '上传文件',
            generation: { mode: 'revise', cardId: card?.id || `legacy:${node.id}`, baseVersionId: input.versionId || `legacy-v1:${node.id}` } });
        const sourceRef = node.sourceHash ? node.sourceId || node.id : null;
        const previous = node.outputCard?.versionId ? this.service.cards.describe({ requirementId: input.requirementId, cardId: node.outputCard.id, versionId: node.outputCard.versionId }) : null;
        const sources = node.composition?.references.map(({ id, sourceHash, ...source }) => ({ ...source, cardId: id, hash: sourceHash })) || previous?.editor.references || [];
        if (!sources.length && sourceRef) sources.push({ cardId: sourceRef, hash: node.sourceHash, title: node.title });
        const snapshot = { requirement: this.service.store.getRequirement(input.requirementId), workflow: 'file-upload', outputType: type,
          instruction: '', sources,
          selectedSkills: [], outputPosition: head.position, uploadedFile: { name: metadata.name, hash: metadata.hash } };
        this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,NULL,NULL,'output',NULL,?,?)")
          .run(taskId, input.requirementId, 'manual', `上传文件 · ${title}`, '用户上传', JSON.stringify(snapshot), now, now);
        this.service.cards.attach(taskId, plan);
        this.service.documents.read(relative, metadata.hash);
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, input.requirementId, taskId, type,
          title, relative, metadata.hash, bytes.length, validated.mime,
          JSON.stringify({ ...validated.validation, uploaded: true, originalName: metadata.name }), JSON.stringify(sources.map(source => source.cardId)), now);
        this.service.cards.recordOutput(taskId, `artifact:${artifactId}`, { primary: true });
        const binding = this.service.cards.binding(taskId);
        const result = { nodeId: head.id, cardId: binding.outputCardId, versionId: binding.cardVersionId, sourceId: `artifact:${artifactId}` };
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(input.operationId, 'upload-card-content', fingerprint, JSON.stringify(result));
        this.db.exec('COMMIT'); committed = true;
        this.service.store.outputSaved?.(input.requirementId);
        return result;
      } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    } finally { if (!committed) rmSync(path.join(this.service.workspaceRoot, taskDirectory), { recursive: true, force: true }); }
  }

  rename(input) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(input.title)) throw new Error('名称须为1至200个字符，不能包含控制字符');
    const fingerprint = sha(JSON.stringify(input));
    const old = this.replay(input, 'rename-card', fingerprint);
    if (old) return old;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const node = this.target(input);
      if ((node.outputCard?.title || cardDisplayTitle(node)) !== input.expectedTitle) throw new Error('名称已被其他操作修改，请刷新后重试');
      const title = input.title.trim();
      this.db.prepare('INSERT INTO card_display_names VALUES (?,?,?) ON CONFLICT(requirement_id,node_id) DO UPDATE SET title=excluded.title')
        .run(input.requirementId, node.id, title);
      const result = { nodeId: node.id, title };
      this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(input.operationId, 'rename-card', fingerprint, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
