import { configuredCredentialReferences, mediaCredentialRef, mediaServiceProfile, MEDIA_SETTINGS_NAMESPACE } from './media-service-settings.mjs';

export function createMediaSettingsOperations(ctx) {
  const form = ctx.configForms.get(MEDIA_SETTINGS_NAMESPACE);
  const mirror = ctx.configForms.describe();
  const valueOf = result => {
    if (!result?.ok) throw new Error(result?.error?.message || 'DSH 未接受媒体设置操作');
    return result.value;
  };
  const assertWritable = () => {
    const current = form.getSnapshot();
    if (current.status !== 'ready' || !current.writable) throw new Error('DSH 设置当前不可写');
    return current;
  };
  const references = () => configuredCredentialReferences(mirror.getSnapshot().view?.namespaces, ctx.settingsSchema);
  async function mutate(ops, expectedRevision) {
    assertWritable();
    if (!Number.isInteger(expectedRevision)) throw new Error('设置版本未读取，请重新打开媒体服务');
    const view = valueOf(await ctx.remote.settings.mutate(MEDIA_SETTINGS_NAMESPACE, ops, expectedRevision));
    mirror.acceptView(view);
  }
  return {
    form, mirror,
    ensure: () => mirror.ensure(),
    references,
    async discover(id, profile, apiKey = '', signal) {
      const response = await fetch('/api/wtt-creation-workbench', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'discover-media-models', data: { id, profile, apiKey } }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '获取可用模型失败');
      return result.models;
    },
    connections() {
      const snapshot = mirror.getSnapshot().view;
      return [...references()].flatMap(([ref, usages]) => usages.filter(usage => usage.namespace !== MEDIA_SETTINGS_NAMESPACE).map(usage => {
        const namespace = snapshot.namespaces.find(entry => entry.ns === usage.namespace);
        const path = usage.path.slice(0, -1);
        const source = ctx.settingsSchema.getPath(namespace.value, path);
        return { key: JSON.stringify([usage.namespace, path]), label: source.displayName || `${usage.namespace} · ${path.at(-1) || '默认'}`, ref,
          baseURL: source.baseURL || '', connection: { namespace: usage.namespace, path } };
      }));
    },
    watchCredentials(listener) { return ctx.remote.$on('credentials/reference-updated', listener); },
    async describe(refs) {
      const result = {};
      for (let index = 0; index < refs.length; index += 64) Object.assign(result, valueOf(await ctx.remote.credentials.describe(refs.slice(index, index + 64))));
      return result;
    },
    async save(id, draft, { apiKey = '', expectedRevision, onCredentialStored } = {}) {
      const profile = mediaServiceProfile(id, draft);
      const current = assertWritable();
      if (current.revision !== expectedRevision) throw new Error('设置已被其他窗口修改，草稿已保留；请重新读取后保存');
      if ((profile.connection || profile.apiKeyEnv !== mediaCredentialRef(id)) && apiKey) throw new Error('已有凭据只能引用，请在原提供商设置中更换 Key');
      if (profile.apiKeyEnv !== mediaCredentialRef(id) && !references().has(profile.apiKeyEnv)) throw new Error('所选已有凭据已不可用，请重新选择');
      let stored = false;
      try {
        if (apiKey) {
          const info = valueOf(await ctx.remote.credentials.describe([profile.apiKeyEnv]))[profile.apiKeyEnv];
          if (!info?.writable) throw new Error('DSH 凭据当前不可写');
          valueOf(await ctx.remote.credentials.set(profile.apiKeyEnv, apiKey));
          stored = true;
          onCredentialStored?.();
        }
        await mutate([{ op: 'set', path: ['mediaServices', id], value: profile }], expectedRevision);
      } catch (cause) {
        const message = apiKey ? String(cause.message || cause).split(apiKey).join('[已隐藏]') : String(cause.message || cause);
        throw new Error(stored ? `API Key 已存入 DSH，但服务配置未保存：${message}` : message);
      }
    },
    remove: (id, revision) => { mediaCredentialRef(id); return mutate([{ op: 'unset', path: ['mediaServices', id] }], revision); },
    async clearCredential(id) {
      const current = assertWritable();
      const ref = mediaCredentialRef(id);
      if (current.value?.mediaServices?.[id]?.connection || current.value?.mediaServices?.[id]?.apiKeyEnv !== ref) throw new Error('不能从媒体页清除共享凭据');
      const usages = references().get(ref) || [];
      if (usages.some(item => item.namespace !== MEDIA_SETTINGS_NAMESPACE || JSON.stringify(item.path) !== JSON.stringify(['mediaServices', id, 'apiKeyEnv']))) throw new Error('该密钥仍被其他配置引用，未清除');
      const info = valueOf(await ctx.remote.credentials.describe([ref]))[ref];
      if (!info?.writable) throw new Error('DSH 凭据当前不可写');
      valueOf(await ctx.remote.credentials.unset(ref));
    },
  };
}
