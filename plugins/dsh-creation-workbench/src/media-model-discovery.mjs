import { createMediaProvider } from './media-provider.mjs';
import { mediaCredentialRef, mediaServiceProfile } from './media-service-settings.mjs';

// Listing is deliberately separate from generation: one bounded GET, no retries or redirects.
export async function discoverMediaModels(access, { id, profile: draft, apiKey = '' }, config = {}) {
  if (typeof apiKey !== 'string' || apiKey.length > 16384) throw new Error('API 密钥格式无效');
  const profile = mediaServiceProfile(id, { ...draft, model: draft?.model || '_discovery', displayName: draft?.displayName || '自定义模型 API' });
  const current = access.draft(profile, id);
  const dedicated = !current.connection && current.apiKeyEnv === mediaCredentialRef(id);
  if (!dedicated && apiKey) throw new Error('已有凭据只能引用，请在原提供商设置中更换 API 密钥');
  if (!dedicated && !current.connection) {
    const saved = access.get(id);
    if (!saved || saved.apiKeyEnv !== current.apiKeyEnv || saved.baseURL !== current.baseURL) throw new Error('请先保存共享凭据配置，或选择已有提供商连接');
  }
  let secret = '';
  const transport = createMediaProvider({ ...config, mediaTransportOnly: true });
  try {
    secret = apiKey || await access.resolveReference(current.apiKeyEnv) || '';
    const latest = access.draft(profile, id);
    if (latest.baseURL !== current.baseURL || latest.apiKeyEnv !== current.apiKeyEnv) throw new Error('提供商连接在读取凭据时已变化，请重新获取模型');
    if (secret && (typeof secret !== 'string' || /[^\x20-\x7e]/.test(secret))) throw new Error('API 密钥包含无效字符，请粘贴原始密钥');
    const google = current.protocol.startsWith('gemini-');
    const models = [], seen = new Set();
    let pageToken;
    for (let page = 0; page < 10; page++) {
      const url = new URL(`${current.baseURL}/models`);
      if (google) { url.searchParams.set('pageSize', '1000'); if (pageToken) url.searchParams.set('pageToken', pageToken); }
      const response = await transport.request(url.href, { method: 'GET', localOnly: false,
        allowLocal: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), timeoutMs: 15000, maxBytes: 2 * 1024 * 1024,
        headers: { Accept: 'application/json', ...(secret ? google ? { 'x-goog-api-key': secret } : { Authorization: `Bearer ${secret}` } : {}) } });
      if (response.status < 200 || response.status >= 300) throw new Error(`获取可用模型失败（HTTP ${response.status}）${[401, 403].includes(response.status) ? '，请核对 API 密钥与权限' : '，可手动填写模型 ID'}`);
      let payload;
      try { payload = JSON.parse(response.bytes.toString('utf8')); } catch { throw new Error('模型接口未返回有效 JSON，可手动填写模型 ID'); }
      if (payload.error) throw new Error('模型接口拒绝请求，请核对地址、API 密钥与权限');
      const entries = Array.isArray(payload.data) ? payload.data : payload.models;
      if (!Array.isArray(entries)) throw new Error('此接口未提供可读取的模型列表，可手动填写模型 ID');
      for (const entry of entries) {
        const raw = entry?.id || (google ? entry?.name?.replace(/^models\//, '') : entry?.name);
        if (typeof raw !== 'string' || !raw.trim() || raw.length > 256 || /[\u0000-\u001f\u007f]/.test(raw) || seen.has(raw) || secret && raw.includes(secret)) continue;
        seen.add(raw);
        const name = entry.displayName || entry.display_name;
        models.push({ id: raw, ...(typeof name === 'string' && !(secret && name.includes(secret)) ? { name: name.slice(0, 256) } : {}) });
        if (models.length >= 2000) break;
      }
      pageToken = google && typeof payload.nextPageToken === 'string' ? payload.nextPageToken : null;
      if (!pageToken || models.length >= 2000) return { models };
    }
    throw new Error('模型列表页数超过限制，请手动填写模型 ID');
  } catch (cause) {
    // Never forward upstream response bodies or transport headers to the client.
    const message = String(cause.message || '模型列表读取失败').split(secret || '\0').join('[已隐藏]').split(apiKey || '\0').join('[已隐藏]').replace(/Bearer\s+[^\s"'<>;,]+/gi, 'Bearer [已隐藏]');
    throw new Error(message.slice(0, 600));
  } finally { transport.close(); }
}
