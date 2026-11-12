import { mediaServiceProfiles } from './media-service-settings.mjs';

export function createMediaServiceAccess(ctx, config) {
  const profiles = () => mediaServiceProfiles(config.mediaServices);
  profiles();
  const draft = (profile, id) => {
    if (!profile?.connection) return profile;
    const settings = ctx.get?.('settings') || ctx.settings;
    const namespace = settings?.describe({ redactSecrets: true }).find(entry => entry.ns === profile.connection.namespace);
    let source = namespace?.value;
    for (const key of profile.connection.path) source = source && Object.hasOwn(source, key) ? source[key] : undefined;
    if (!source || typeof source.apiKeyEnv !== 'string') throw new Error('引用的 DSH 提供商凭据配置不可用，请重新选择连接');
    return mediaServiceProfiles({ [id]: { ...profile, apiKeyEnv: source.apiKeyEnv, baseURL: source.baseURL || profile.baseURL } })[id];
  };
  const get = id => draft(profiles()[id], id);
  const credentials = () => ctx.get?.('credentials') || ctx.credentials;
  return {
    profiles, get, draft,
    async resolveReference(ref) { return (await credentials()?.resolve?.(ref))?.value; },
    async describe(id) {
      const profile = get(id);
      if (!profile) throw new Error('媒体服务配置已移除');
      const provider = credentials();
      if (!provider?.describe) return { configured: false, writable: false, unavailable: true };
      const info = await provider.describe(profile.apiKeyEnv);
      return { configured: info.configured === true, writable: info.writable === true, ...(info.source ? { source: info.source } : {}) };
    },
    async resolve(id, expected) {
      const profile = get(id);
      if (!profile) throw new Error('媒体服务配置已移除，不会切换提供商');
      if (expected && (expected.baseURL !== profile.baseURL || expected.apiKeyEnv !== profile.apiKeyEnv)) throw Object.assign(new Error('媒体服务地址或凭据引用已更改，请核对原任务'), { code: 'provider_configuration_changed' });
      const provider = credentials();
      if (!provider?.resolve) throw Object.assign(new Error('DSH 凭据服务不可用'), { code: 'credential_missing' });
      const hit = await provider.resolve(profile.apiKeyEnv);
      if (!hit?.value) throw Object.assign(new Error('尚未配置媒体服务 API Key'), { code: 'credential_missing' });
      return hit.value;
    },
  };
}
