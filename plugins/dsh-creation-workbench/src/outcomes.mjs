import path from 'node:path';
import { createHash } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refPattern = /^(artifact|material|outline|word):[a-f0-9-]{36}$/i;
export const outcomeFormat = name => path.extname(name || '').slice(1).toLowerCase();
export function defaultOutcome(files, primaryRef) {
  return files.find(file => file.sourceRef === primaryRef)
    || [...files].reverse().find(file => file.format === 'pptx' && file.status === 'ready')
    || files.find(file => file.status === 'ready') || files[0];
}

/** Read-only association and format projection. It never promotes an attachment. */
export class Outcomes {
  constructor(service) { this.service = service; this.db = service.store.db; }
  files(taskId, primaryRef, cardId) {
    if (!taskId) return [];
    const task = this.db.prepare('SELECT requirement_id,input_json FROM course_tasks WHERE id=?').get(taskId);
    if (!task) throw new Error('成果任务不存在。');
    const owned = cardId && JSON.parse(task.input_json).outputPresentation === 'cards'
      ? new Set(this.db.prepare('SELECT source_ref FROM output_card_outputs WHERE task_id=? AND card_id=?').all(taskId, cardId).map(row => row.source_ref))
      : null;
    return this.service.tasks.files.list(task.requirement_id, taskId).filter(file => !owned || owned.has(`artifact:${file.id}`)).map(file => ({
      sourceRef: `artifact:${file.id}`, artifactId: file.id, name: path.basename(file.path), path: file.path,
      title: file.title, hash: file.hash, format: outcomeFormat(file.path), mime: file.mime, status: file.status,
      role: `artifact:${file.id}` !== primaryRef && (file.kind === 'support' || file.kind === 'storyboard') ? 'attachment' : 'result', taskId,
    }));
  }
  annotate(node, version, task) {
    const taskId = version?.taskId || task?.id;
    const files = this.files(taskId, version?.primaryRef, version?.cardId || task?.outputCardId);
    return files.length ? { ...node, outcomeFiles: files, defaultOutcome: defaultOutcome(files, version?.primaryRef) } : node;
  }
  manifest({ requirementId, cardId, versionId, sourceRef }) {
    let descriptor;
    if (versionId) descriptor = this.service.cards.describe({ requirementId, cardId, versionId });
    else {
      try { descriptor = this.service.cards.describe({ requirementId, cardId }); }
      catch (error) {
        if (!/尚无成功产物/.test(error.message)) throw error;
        descriptor = this.service.cards.describePending({ requirementId, cardId });
      }
    }
    const { node, card, version, task } = descriptor;
    const taskId = version?.taskId || task?.id;
    const files = this.files(taskId, version?.primaryRef, card.id);
    if (version && !files.some(file => file.sourceRef === version.primaryRef)) {
      const raw = this.read({ requirementId, sourceRef: version.primaryRef });
      files.unshift({ ...raw, bytes: undefined, role: 'result' });
    }
    if (sourceRef && !files.some(file => file.sourceRef === sourceRef)) throw new Error('所选文件不属于当前卡片版本或任务。');
    return { cardId: card.id, requirementId, versionId: version?.id || null, number: version?.number || null,
      files, selectedRef: sourceRef || defaultOutcome(files, version?.primaryRef)?.sourceRef,
      ...(node.slideProject ? { slideProject: node.slideProject } : {}), title: card.title };
  }
  read({ requirementId, sourceRef, hash, projectPath }) {
    let bytes, relative, title, mime, sessionId, cardId, versionId;
    if (projectPath !== undefined) {
      const file = this.service.projectFiles.read(projectPath, hash);
      return { ...file, format: outcomeFormat(file.name), title: file.name, sourceRef: null };
    }
    if (!refPattern.test(sourceRef || '')) throw new Error('成果文件引用无效。');
    const [kind, id] = sourceRef.split(':');
    if (kind === 'artifact') {
      const file = this.service.tasks.files.read(id);
      if (file.artifact.requirementId !== requirementId) throw new Error('成果文件不属于当前画布。');
      ({ bytes } = file); relative = file.artifact.path; title = file.artifact.title; mime = file.artifact.mime;
      sessionId = this.service.tasks.get(file.artifact.taskId).sessionId;
      const owner = this.db.prepare('SELECT card_id,version_id FROM output_card_outputs WHERE source_ref=?').get(sourceRef);
      cardId = owner?.card_id; versionId = owner?.version_id;
    } else if (kind === 'material') {
      const row = this.db.prepare('SELECT * FROM canvas_materials WHERE id=? AND requirement_id=?').get(id, requirementId);
      if (!row) throw new Error('素材不属于当前画布。');
      const imported = this.db.prepare('SELECT * FROM canvas_imports WHERE material_id=?').get(id);
      if (imported) { bytes = this.service.canvas.readImportedFile(id).bytes; relative = imported.file_path; mime = imported.mime; }
      else { relative = row.markdown_path; bytes = this.service.projectFiles.read(relative).bytes; if (sha(bytes) !== row.hash) throw new Error('素材已变化，请重新选择。'); }
      title = row.title;
    } else {
      const row = this.service.store.getVersion(id);
      if (!row || row.requirementId !== requirementId) throw new Error('文档不属于当前画布。');
      relative = kind === 'word' ? row.wordPath : row.markdownPath;
      if (!relative) throw new Error('此版本尚无对应文件。');
      bytes = this.service.projectFiles.read(relative).bytes; title = this.service.store.getRequirement(requirementId).title;
      if (kind === 'outline' && sha(bytes) !== row.hash) throw new Error('大纲文件已变化。');
    }
    const fileHash = sha(bytes);
    if (hash && hash !== fileHash) throw new Error('成果文件版本已变化，请重新选择。');
    return { bytes, path: relative, name: path.basename(relative), title, hash: fileHash, format: outcomeFormat(relative),
      mime, sourceRef, status: 'ready', sessionId, cardId, versionId };
  }
  preview(input) {
    const source = this.read(input);
    // Office/PDF/image snapshots are immutable inputs for the host's live file reader.
    // HTML/Markdown keep their source directory for relative styles and images.
    let relative = source.path;
    if (!['html', 'htm', 'md', 'markdown'].includes(source.format)) {
      relative = `.wtt-workbench/native-preview/${source.hash}/${source.name}`;
      this.service.documents.write(relative, source.bytes);
    }
    return { ...source, bytes: undefined, path: relative, originalPath: source.path };
  }
  documentScope(input) {
    if (input.projectPath !== undefined || !/^[a-f0-9]{64}$/i.test(input.hash || '')) throw new Error('文档编辑需要准确文件hash，不接收独立文件路径。');
    const manifest = this.manifest(input);
    if (!manifest.files.some(file => file.sourceRef === input.sourceRef)) throw new Error('文件不属于当前课件卡或版本。');
    const source = this.read({ requirementId: input.requirementId, sourceRef: input.sourceRef, hash: input.hash }), extension = path.extname(source.name).toLowerCase();
    if (!['.csv', '.docx', '.pdf', '.pptx'].includes(extension) || source.bytes.length > 20 * 1024 * 1024) throw new Error('本机修改支持20MiB以内的Word、PDF、CSV和PPTX。');
    const descriptor = manifest.versionId
      ? this.service.cards.describe({ requirementId: input.requirementId, cardId: input.cardId, versionId: manifest.versionId })
      : this.service.cards.describePending({ requirementId: input.requirementId, cardId: input.cardId });
    return { ...source, extension, descriptor,
      scope: { requirementId: input.requirementId, cardId: input.cardId, versionId: manifest.versionId,
        sourceRef: input.sourceRef, hash: source.hash, fileHash: source.hash, outcome: true } };
  }
}
