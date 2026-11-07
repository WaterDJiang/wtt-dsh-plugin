const clone = value => JSON.parse(JSON.stringify(value));
const text = value => String(value ?? '').replace(/\r\n?/g, '\n');

export function checkPptDocument(document) {
  if (!document || !Number.isFinite(document.width) || document.width <= 0 || !Number.isFinite(document.height) || document.height <= 0
    || !Array.isArray(document.slides) || !document.slides.length) throw new Error('课件页面信息不完整，请重新读取。');
  const slides = new Set();
  for (const slide of document.slides) {
    if (!slide?.id || slides.has(slide.id) || !Array.isArray(slide.elements)) throw new Error('课件页标识或文字对象信息无效。');
    slides.add(slide.id);
    const elements = new Set();
    for (const element of slide.elements) {
      if (!element?.id || elements.has(element.id) || typeof element.text !== 'string') throw new Error('课件文字对象标识或正文无效。');
      elements.add(element.id);
    }
  }
  return document;
}

export function pptDocumentChanges(before, after) {
  checkPptDocument(before); checkPptDocument(after);
  if (before.width !== after.width || before.height !== after.height || before.slides.length !== after.slides.length) throw new Error('本轮不能修改课件尺寸或页序。');
  const pages = [];
  for (let index = 0; index < before.slides.length; index += 1) {
    const original = before.slides[index], current = after.slides[index];
    if (original.id !== current.id) throw new Error('本轮不能修改页序或替换页面。');
    if (original.elements.length !== current.elements.length) throw new Error('本轮不能增删页面或文字对象。');
    const changes = [];
    for (let objectIndex = 0; objectIndex < original.elements.length; objectIndex += 1) {
      const old = original.elements[objectIndex], next = current.elements[objectIndex];
      if (old.id !== next.id) throw new Error('文字对象定位发生变化，请重新读取。');
      if (text(old.text) !== text(next.text)) {
        if (old.editable === false) throw new Error(old.reason || '此文字对象暂不支持安全修改。');
        changes.push({ elementId: old.id, text: text(next.text) });
      }
    }
    const notesChanged = text(original.notes) !== text(current.notes);
    if (notesChanged && original.notesEditable === false) throw new Error(original.notesReason || '此页讲师备注暂不能安全修改。');
    if (changes.length || notesChanged) pages.push({ slideId: original.id, changes, ...(notesChanged ? { notes: text(current.notes) } : {}) });
  }
  return pages;
}

export function patchPptText(document, slideId, elementId, value) {
  const next = clone(document), slide = next.slides.find(item => item.id === slideId);
  if (!slide) throw new Error('所选页面已不存在，请重新读取。');
  if (elementId == null) {
    if (slide.notesEditable === false) throw new Error(slide.notesReason || '此页讲师备注暂不能安全修改。');
    slide.notes = text(value);
  } else {
    const element = slide.elements.find(item => item.id === elementId);
    if (!element) throw new Error('所选文字对象已不存在，请重新读取。');
    if (element.editable === false) throw new Error(element.reason || '此文字对象暂不支持安全修改。');
    element.text = text(value);
  }
  return next;
}

// A save response may arrive after another keystroke. Preserve those later edits.
export function retainLaterPptEdits(submitted, current, saved) {
  const pending = pptDocumentChanges(submitted, current), result = clone(saved);
  for (const page of pending) {
    const slide = result.slides.find(item => item.id === page.slideId);
    if (!slide) throw new Error('保存后页面定位变化，当前文字已保留，请重新读取。');
    if (page.notes !== undefined) {
      if (slide.notesEditable === false) throw new Error(slide.notesReason || '保存后讲师备注不可编辑，当前输入已保留。');
      slide.notes = page.notes;
    }
    for (const change of page.changes) {
      const element = slide.elements.find(item => item.id === change.elementId);
      if (!element || element.editable === false) throw new Error('保存后文字对象定位变化，当前文字已保留，请重新读取。');
      element.text = change.text;
    }
  }
  return result;
}

export function recoverPptLocalEdits(previous, local, remote) {
  const changes = pptDocumentChanges(previous, local), conflicts = [];
  for (const page of changes) {
    const before = previous.slides.find(item => item.id === page.slideId), latest = remote.slides.find(item => item.id === page.slideId);
    if (!latest) throw new Error('服务器中的页面已变化，本地输入仍保留。');
    if (page.notes !== undefined && text(latest.notes) !== text(before.notes) && text(latest.notes) !== page.notes) conflicts.push({ slideId: page.slideId, kind: 'notes' });
    for (const change of page.changes) {
      const old = before.elements.find(item => item.id === change.elementId), next = latest.elements.find(item => item.id === change.elementId);
      if (!next) throw new Error('服务器中的文字对象已变化，本地输入仍保留。');
      if (text(next.text) !== text(old.text) && text(next.text) !== change.text) conflicts.push({ slideId: page.slideId, elementId: change.elementId, kind: 'text' });
    }
  }
  return { document: retainLaterPptEdits(previous, local, remote), conflicts };
}

export function reconcilePublishedPptDraft(submitted, local, latest, published) {
  checkPptDocument(latest?.document);
  if (!Number.isSafeInteger(latest.revision) || !Number.isSafeInteger(published?.revision) || latest.revision < published.revision) throw new Error('保存后草稿修订号无效或仍是旧修订。');
  const cleanPublication = latest.revision === published.revision && latest.dirty === false;
  const reconciled = cleanPublication
    ? { document: retainLaterPptEdits(submitted, local, latest.document), conflicts: [] }
    : recoverPptLocalEdits(submitted, local, latest.document);
  return { ...reconciled, unsaved: pptDocumentChanges(latest.document, reconciled.document).length > 0 };
}

export function pptObjectStyle(document, element) {
  const bounds = element?.bounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    left: `${bounds.x / document.width * 100}%`, top: `${bounds.y / document.height * 100}%`,
    width: `${bounds.width / document.width * 100}%`, height: `${bounds.height / document.height * 100}%`,
    ...(Number.isFinite(element.rotation) && element.rotation ? { transform: `rotate(${element.rotation}deg)` } : {}),
  };
}
