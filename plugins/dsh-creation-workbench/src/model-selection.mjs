function identifier(value, label, maxLength = 256) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`模型选择的${label}无效，请重新选择模型。`);
  }
  return value.trim();
}

// Task snapshots carry route identifiers only; credentials and endpoints belong to DSH.
export function normalizeModelSelection(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('模型选择格式无效，请重新选择模型。');
  const selection = { provider: identifier(value.provider, '提供商'), model: identifier(value.model, '模型') };
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null && value.reasoningEffort !== '') {
    if (typeof value.reasoningEffort !== 'string') throw new Error('模型选择的推理等级无效，请重新选择模型。');
    if (value.reasoningEffort.trim()) selection.reasoningEffort = identifier(value.reasoningEffort, '推理等级', 64);
  }
  return selection;
}

function label(value, fallback) { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }

export function normalizeModelCatalog(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.groups) || !Array.isArray(value.routableProviders)) {
    throw new Error('DSH 模型目录格式无效，请刷新目录或打开模型设置。');
  }
  const failures = (Array.isArray(value.failures) ? value.failures : []).map(item => ({
    id: label(item?.id, 'unknown'), name: label(item?.name, label(item?.id, '提供商')),
    message: label(item?.message, '模型目录读取失败'),
  }));
  const groups = [];
  const seen = new Set();
  for (const group of value.groups) {
    try {
      const id = identifier(group?.id, '提供商');
      if (!Array.isArray(group.models)) throw new Error('模型列表格式无效');
      if (seen.has(id)) throw new Error('提供商标识重复');
      const modelIds = new Set();
      const models = group.models.map(model => {
        const modelId = identifier(model?.id, '模型');
        if (modelIds.has(modelId)) throw new Error('模型标识重复');
        modelIds.add(modelId);
        const result = { id: modelId, name: label(model.name, modelId) };
        if (model.reasoning) {
          const efforts = Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts.map(effort => ({
            id: identifier(effort?.id, '推理等级', 64), name: label(effort?.name, effort?.id),
          })) : [];
          result.reasoning = { efforts };
          if (efforts.some(effort => effort.id === model.reasoning.defaultEffort)) result.reasoning.defaultEffort = model.reasoning.defaultEffort;
        }
        return result;
      });
      seen.add(id);
      if (models.length) groups.push({ id, name: label(group.name, id), models });
    } catch (error) {
      failures.push({ id: label(group?.id, 'unknown'), name: label(group?.name, '提供商'), message: error.message });
    }
  }
  let defaultSelection = null;
  try { defaultSelection = normalizeModelSelection(value.default); }
  catch (error) { failures.push({ id: 'default', name: '默认模型', message: error.message }); }
  const routableProviders = [...new Set(value.routableProviders.filter(id => typeof id === 'string' && groups.some(group => group.id === id)))];
  return { default: defaultSelection, routableProviders, groups: groups.filter(group => routableProviders.includes(group.id)), failures };
}

export function openNativeModelSettings(ctx) {
  let diagnostics = null;
  const unavailable = () => {
    const summary = diagnostics ? `（设置来源：${diagnostics.shells.map(entry => entry.registrant || '未标记').join('、') || '无'}；模型分区：${diagnostics.sections.map(entry => entry.id || '未标记').join('、') || '无'}）` : '';
    return Object.assign(new Error(`当前宿主未提供模型设置入口，请从 DSH 侧栏的设置进入“模型”。${summary}`), { slotMetadata: diagnostics });
  };
  if (typeof ctx?.slots?.entriesOfSlot !== 'function') throw unavailable();
  const shells = ctx.slots.entriesOfSlot('sidebar.settings');
  const sections = ctx.slots.entriesOfSlot('settings.section');
  if (!Array.isArray(shells) || !Array.isArray(sections)) throw unavailable();
  const describe = entry => ({
    registrant: typeof entry?.registrant === 'string' ? entry.registrant.slice(0, 160) : null,
    id: typeof entry?.options?.id === 'string' ? entry.options.id.slice(0, 100) : null,
  });
  diagnostics = { shells: shells.map(describe), sections: sections.map(describe) };
  // entriesOfSlot returns what the outlet actually renders; a single slot has one winner.
  // registrant is a diagnostic function name and can be minified, never a package identity.
  if (shells.length !== 1 || sections.filter(entry => entry?.options?.id === 'models').length !== 1) throw unavailable();
  const [shell] = shells;
  if (typeof shell?.store?.create !== 'function') throw unavailable();
  // rc.5 publishes a handle whose create() returns the existing shared shell instance.
  const instance = shell.store.create();
  if (typeof instance?.actions?.openSection !== 'function') throw unavailable();
  instance.actions.openSection('models');
}
