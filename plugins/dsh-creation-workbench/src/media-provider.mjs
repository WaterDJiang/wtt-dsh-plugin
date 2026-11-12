import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const GENERATED_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000';
const DEFAULT_MODELS = { image: { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' }, video: { model: 'jimeng-video-3.0', ratio: '4:3', resolution: '720p', duration: 5 } };
const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const VIDEO_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'];
const IMAGE_MODELS = ['jimeng-5.0', 'jimeng-4.6', 'jimeng-4.5', 'jimeng-4.1', 'jimeng-4.0', 'jimeng-3.1', 'jimeng-3.0', 'jimeng-2.1', 'jimeng-2.0-pro', 'jimeng-2.0', 'jimeng-1.4', 'jimeng-xl-pro'];
const VIDEO_MODELS = ['jimeng-video-3.0', 'jimeng-video-3.0-pro', 'jimeng-video-3.5-pro'];
const SEEDANCE_MODELS = ['jimeng-video-seedance-2.0', 'seedance-2.0', 'seedance-2.0-pro', 'jimeng-video-seedance-2.0-mini', 'seedance-2.0-mini', 'jimeng-video-seedance-2.0-fast', 'seedance-2.0-fast', 'jimeng-video-seedance-2.0-fast-vip', 'seedance-2.0-fast-vip', 'jimeng-video-seedance-2.0-vip', 'seedance-2.0-vip'];
const CATALOG = [
  ...IMAGE_MODELS.map(id => ({ id, type: 'image', requiresReference: false, maxReferences: 10, ratios: IMAGE_RATIOS, resolutions: ['1k', '2k', '4k'] })),
  // The upstream dual-frame path forces the basic 3.0 model, so Pro models accept one reference.
  ...VIDEO_MODELS.map(id => ({ id, type: 'video', requiresReference: false, maxReferences: id === 'jimeng-video-3.0' ? 2 : 1, ratios: VIDEO_RATIOS, resolutions: ['480p', '720p', '1080p'], durations: [5, 10] })),
  // The isolated service preserves explicitly supplied duration and ratio values.
  // Later Seedance reference uploads may be silently skipped; a single reference fails visibly.
  ...SEEDANCE_MODELS.map(id => ({ id, type: 'video', requiresReference: true, maxReferences: 1, ratios: VIDEO_RATIOS, resolutions: ['720p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] })),
];
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const copy = value => JSON.parse(JSON.stringify(value));

function defaultsOf(value, previous = DEFAULT_MODELS) {
  if (value === undefined) return copy(previous);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['image', 'video'].includes(key))) throw fail('provider_configuration_invalid', '默认媒体参数设置无效。');
  const result = copy(previous);
  for (const type of ['image', 'video']) {
    if (value[type] === undefined) continue;
    const incoming = typeof value[type] === 'string' ? { model: value[type] } : value[type];
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || Object.keys(incoming).some(key => !['model', 'ratio', 'resolution', ...(type === 'video' ? ['duration'] : [])].includes(key))) throw fail('provider_configuration_invalid', '默认媒体参数字段无效。');
    const model = CATALOG.find(item => item.id === (incoming.model || result[type].model) && item.type === type);
    if (!model) throw fail('provider_configuration_invalid', '默认模型不在已验证的媒体模型目录中。');
    const base = typeof value[type] === 'string' ? { model: model.id, ratio: '4:3', resolution: type === 'image' ? '2k' : '720p', ...(type === 'video' ? { duration: model.durations[0] } : {}) } : result[type];
    const next = { ...base, ...incoming };
    if (!model.ratios.includes(next.ratio) || !model.resolutions.includes(next.resolution) || (type === 'video' && !model.durations.includes(next.duration))) throw fail('provider_configuration_invalid', '默认比例、分辨率或时长不在该模型的已验证范围内。');
    result[type] = next;
  }
  return result;
}

function redact(value, secret = '') {
  let message = String(value || '媒体服务操作失败').slice(0, 4096);
  if (secret) message = message.split(secret).join('[已隐藏]');
  return message.replace(/Bearer\s+[^\s"'<>;,]+/gi, 'Bearer [已隐藏]').slice(0, 600);
}

function ipv4Private(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function mappedIPv4(address) {
  const match = address.toLowerCase().match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (!match) return null;
  const high = parseInt(match[1], 16), low = parseInt(match[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function loopback(address) {
  const clean = address.toLowerCase().replace(/^\[|\]$/g, '');
  return clean === '::1' || (isIP(clean) === 4 && clean.startsWith('127.')) || Boolean(mappedIPv4(clean)?.startsWith('127.'));
}

function publicAddress(address) {
  if (isIP(address) === 4) return !ipv4Private(address);
  if (isIP(address) !== 6) return false;
  const mapped = mappedIPv4(address);
  if (mapped) return !ipv4Private(mapped);
  // Global unicast only; exclude documentation and transition tunnels.
  const clean = address.toLowerCase();
  return /^[23][0-9a-f]{0,3}:/.test(clean) && !/^2001:(?:db8|0):/.test(clean) && !clean.startsWith('2002:');
}

function endpointOf(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('provider_configuration_invalid', '媒体服务地址无效，请填写本机 HTTP 地址。'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !(hostname === 'localhost' || loopback(hostname))) {
    throw fail('provider_configuration_invalid', '媒体服务地址必须是本机 loopback HTTP 服务，不能向外部地址发送认证。');
  }
  return url.href.replace(/\/+$/, '');
}

async function targetOf(value, { localOnly = false, allowLocal = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw fail('download_url_invalid', '生成结果地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('download_url_invalid', '生成结果只支持不含账号信息的 HTTP(S) 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!localOnly && !allowLocal && /(?:^|\.)(?:localhost|local|internal)$/.test(hostname.replace(/\.$/, ''))) throw fail('download_url_blocked', '生成结果地址不能指向本机或私有网络。');
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true }); }
  catch (cause) { throw fail(localOnly ? 'service_unavailable' : 'download_failed', '媒体地址解析失败，请检查服务或稍后重试。', cause); }
  if (!addresses.length || addresses.some(item => localOnly ? !loopback(item.address) : !allowLocal && !publicAddress(item.address))) {
    throw fail(localOnly ? 'provider_configuration_invalid' : 'download_url_blocked', localOnly ? '媒体服务必须解析到本机 loopback 地址。' : '生成结果地址不能指向本机或私有网络。');
  }
  return { url, addresses };
}

function statusError(status, payload, secret, { submitting = false } = {}) {
  const raw = payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || payload?.message || payload?.fail_reason || `媒体服务返回 HTTP ${status}`;
  const message = redact(raw, secret);
  const code = Number(payload?.code ?? payload?.error?.code);
  if (code === -2002 || status === 401 || status === 403 || /token.*(?:invalid|expired|失效|无效|过期)|session.?id.*(?:invalid|expired)|登录.*(?:失效|过期)|认证.*(?:失败|失效)/i.test(message)) return fail('credential_invalid', '即梦认证已失效，请更新媒体认证后重试。');
  if (code === -2009 || status === 402 || /积分不足|余额不足|insufficient.*(?:credit|balance)|(?:credit|balance).*insufficient/i.test(message)) return fail('quota_exceeded', '即梦积分或余额不足，请核对账号额度后重试。');
  if (submitting && (status >= 500 || /超时|timeout|timed out/i.test(message))) return fail('submission_unknown', '提交结果未知，请先核对原任务，勿重复生成。');
  return fail(status === 503 ? 'service_unavailable' : 'provider_rejected', status === 429 ? '即梦请求过于频繁，请稍后再试。' : status === 503 ? '即梦本机服务暂不可用，请检查服务状态。' : '即梦服务拒绝本次操作，请核对模型、参数、参考图片及账号权限。');
}

function payloadRejected(payload) {
  return Boolean(payload?.error) || ['failed', 'error'].includes(String(payload?.status).toLowerCase())
    || (typeof payload?.code === 'number' && payload.code !== 0 && payload.code !== 200);
}

function missingTaskError(status, payload) {
  if (status === 404) return fail('provider_task_missing', '即梦服务中找不到原视频任务；保留原任务标识，不会自动重新生成。');
  if (status === 410) return fail('provider_task_expired', '即梦原视频任务已过期；保留原任务标识，不会自动重新生成。');
  if (Number(payload?.code) !== -2000) return null;
  const message = String(payload?.errmsg || payload?.message || '');
  if (/任务[\s\S]*(?:已过期|过期)|task[\s\S]*expired/i.test(message)) return fail('provider_task_expired', '即梦原视频任务已过期；保留原任务标识，不会自动重新生成。');
  if (/任务[\s\S]*不存在|task[\s\S]*(?:not found|does not exist)/i.test(message)) return fail('provider_task_missing', '即梦服务中找不到原视频任务；保留原任务标识，不会自动重新生成。');
  return null;
}

function resultOf(payload) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : payload?.result || payload?.data || payload;
  const resultURL = item?.url || item?.resultURL || item?.video_url || payload?.url;
  if (typeof resultURL === 'string' && /^https?:\/\//i.test(resultURL)) return { resultURL, ...(typeof item.mime === 'string' ? { mime: item.mime } : {}) };
  let resultBase64 = item?.b64_json || item?.resultBase64;
  if (typeof resultBase64 === 'string' && resultBase64) {
    let mime = typeof item.mime === 'string' ? item.mime : undefined;
    const data = resultBase64.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (data) { mime = data[1]; resultBase64 = data[2]; }
    if (!/^[A-Za-z0-9+/\s]*={0,2}$/.test(resultBase64) || !Buffer.from(resultBase64, 'base64').length) return null;
    return { resultBase64, ...(mime ? { mime } : {}) };
  }
  return null;
}

export function createMediaProvider(config = {}) {
  const settingsPath = config.mediaSettingsPath || path.join(config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'wtt-creation-workbench/media-settings.json');
  try { const legacy = settingsPath.replace('wtt-creation-workbench/', 'wtt-course-workbench/'); if (!config.mediaTransportOnly && !existsSync(settingsPath) && existsSync(legacy)) { mkdirSync(path.dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, readFileSync(legacy)); } } catch {}
  const active = new Set();
  let closed = false;
  const assertOpen = () => { if (closed) throw fail('provider_closed', '媒体服务连接已关闭。'); };

  function stored() {
    try {
      if (!existsSync(settingsPath)) return {};
      const value = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { return { credentialCleared: true, settingsError: '媒体设置文件无法读取，请重新保存设置和认证。' }; }
  }

  function snapshot() {
    const settings = stored();
    const endpoint = endpointOf(settings.endpoint || config.mediaEndpoint || DEFAULT_ENDPOINT);
    const modelDefaults = defaultsOf(settings.modelDefaults, defaultsOf(config.mediaModelDefaults));
    let secret = '';
    if (!settings.credentialCleared) {
      secret = settings.sessionId || config.mediaSessionId || '';
    }
    secret = typeof secret === 'string' ? secret.trim().replace(/^Bearer\s+/i, '') : '';
    if (secret && (/\s/.test(secret) || secret.length > 8192)) throw fail('provider_configuration_invalid', '媒体认证格式无效，请重新填写 sessionId。');
    return { endpoint, modelDefaults, secret, ...(settings.settingsError ? { settingsError: settings.settingsError } : {}) };
  }

  function fence(state, expectedEndpoint) {
    if (expectedEndpoint !== undefined && expectedEndpoint !== state.endpoint) throw fail('provider_configuration_changed', '媒体服务地址已更改；请先恢复原端点再核对该任务，不会向新端点提交或查询旧任务。');
  }

  function request(value, { method = 'GET', headers = {}, body, timeoutMs = 5000, maxBytes = 1024 * 1024, localOnly = true, allowLocal = false, skipRedirectBody = false } = {}) {
    assertOpen();
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      active.add(controller);
      let pending, finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.delete(controller);
        if (error) { pending?.destroy(); reject(error); } else resolve(result);
      };
      const timer = setTimeout(() => finish(fail('request_timeout', '媒体服务响应超时。')), timeoutMs);
      controller.signal.addEventListener('abort', () => finish(fail('provider_closed', '媒体服务连接已关闭。')), { once: true });
      void targetOf(value, { localOnly, allowLocal }).then(({ url, addresses }) => {
        if (finished) return;
        pending = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent: false, autoSelectFamily: true,
          // Pin the addresses checked above; a second DNS lookup must not bypass the fence.
          lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        }, response => {
          if (skipRedirectBody && response.statusCode >= 300 && response.statusCode < 400) {
            finish(null, { status: response.statusCode, headers: response.headers, bytes: Buffer.alloc(0) }); response.destroy(); return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) { finish(fail('response_too_large', '媒体响应超过允许大小。')); response.destroy(); return; }
          const chunks = []; let total = 0;
          response.on('data', chunk => {
            total += chunk.length;
            if (total > maxBytes) { finish(fail('response_too_large', '媒体响应超过允许大小。')); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on('error', error => finish(error));
          response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks, total) }));
        });
        pending.on('error', error => finish(error));
        if (body) pending.end(body); else pending.end();
      }).catch(error => finish(error));
    });
  }

  async function json(state, suffix, { method = 'GET', body, headers = {}, timeoutMs = 5000, maxBytes = 1024 * 1024, allowFailureStatus = false, taskQuery = false } = {}) {
    const submitting = method === 'POST';
    let response;
    try {
      response = await request(`${state.endpoint}${suffix}`, { method, body, timeoutMs, maxBytes,
        headers: { Accept: 'application/json', ...(state.secret ? { Authorization: `Bearer ${state.secret}` } : {}), ...headers } });
    } catch (cause) {
      if (cause.code === 'provider_configuration_invalid' || cause.code === 'provider_closed') throw cause;
      const unavailable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'service_unavailable'].includes(cause.code);
      throw fail(submitting && !unavailable ? 'submission_unknown' : 'service_unavailable', submitting && !unavailable ? '提交结果未知，请先核对原任务，勿重复生成。' : '即梦本机服务未运行或暂不可达。', cause);
    }
    if (taskQuery) { const error = missingTaskError(response.status); if (error) throw error; }
    let payload;
    try { payload = JSON.parse(response.bytes.toString('utf8')); }
    catch {
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, null, state.secret, { submitting });
      throw fail(submitting ? 'submission_unknown' : 'provider_rejected', submitting ? '媒体服务未返回可核对的提交回执，结果未知；请勿重复生成。' : '媒体服务返回了无效查询回执。');
    }
    if (taskQuery) { const error = missingTaskError(response.status, payload); if (error) throw error; }
    if (allowFailureStatus && response.status >= 200 && response.status < 300 && ['failed', 'error', 'cancelled', 'canceled'].includes(String(payload?.status).toLowerCase())) return payload;
    if (response.status < 200 || response.status >= 300 || payloadRejected(payload)) throw statusError(response.status, payload, state.secret, { submitting });
    return payload;
  }

  async function capabilities() {
    assertOpen();
    let state;
    try { state = snapshot(); }
    catch (error) { return { endpoint: '', credentialConfigured: false, healthy: false, error: error.message, modelDefaults: copy(DEFAULT_MODELS), models: copy(CATALOG) }; }
    const dto = { endpoint: state.endpoint, credentialConfigured: Boolean(state.secret), healthy: false, modelDefaults: copy(state.modelDefaults), models: copy(CATALOG) };
    try {
      if (state.settingsError) throw fail('provider_configuration_invalid', state.settingsError);
      const payload = await json(state, '/v1/models', { timeoutMs: config.mediaHealthTimeoutMs || 5000 });
      const rows = Array.isArray(payload?.data) ? payload.data : payload?.models;
      if (!Array.isArray(rows)) throw fail('provider_rejected', '媒体服务没有返回有效模型目录。');
      const ids = new Set(rows.map(item => typeof item === 'string' ? item : item?.id));
      dto.models = copy(CATALOG.filter(item => ids.has(item.id)));
      dto.healthy = true;
    } catch (error) { dto.error = redact(error.message, state.secret); }
    return dto;
  }

  async function updateSettings(data) {
    assertOpen();
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['endpoint', 'sessionId', 'clearCredential', 'modelDefaults'].includes(key))) throw fail('provider_configuration_invalid', '媒体设置只接受端点、认证和默认模型。');
    const before = stored();
    const next = { ...before }; delete next.settingsError;
    if (data.endpoint !== undefined) next.endpoint = endpointOf(data.endpoint);
    if (data.clearCredential !== undefined && typeof data.clearCredential !== 'boolean') throw fail('provider_configuration_invalid', '清除认证选项无效。');
    if (data.sessionId !== undefined && typeof data.sessionId !== 'string') throw fail('provider_configuration_invalid', 'sessionId 必须为文本。');
    const supplied = data.sessionId?.trim().replace(/^Bearer\s+/i, '');
    if (supplied && (supplied.length > 8192 || /\s/.test(supplied))) throw fail('provider_configuration_invalid', '媒体认证格式无效。');
    if (data.clearCredential && supplied) throw fail('provider_configuration_invalid', '填写新认证与清除认证不能同时执行。');
    if (data.clearCredential) { delete next.sessionId; next.credentialCleared = true; }
    else if (supplied) { next.sessionId = supplied; next.credentialCleared = false; }
    if (data.modelDefaults !== undefined) {
      next.modelDefaults = defaultsOf(data.modelDefaults, defaultsOf(before.modelDefaults, defaultsOf(config.mediaModelDefaults)));
    }
    if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) throw fail('provider_configuration_invalid', '媒体设置文件不能为符号链接。');
    mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
    const temporary = `${settingsPath}.pending-${randomUUID()}`;
    try { writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temporary, settingsPath); chmodSync(settingsPath, 0o600); }
    finally { try { unlinkSync(temporary); } catch { /* Only this attempt's temporary file is disposable. */ } }
    return capabilities();
  }

  async function submit(input) {
    assertOpen();
    let state = snapshot(); fence(state, input?.expectedEndpoint);
    const model = CATALOG.find(item => item.id === input?.model && item.type === input?.type);
    if (!model) throw fail('provider_rejected', '请显式选择已验证的图片／视频模型。');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16_000) throw fail('provider_rejected', '请输入不超过 16000 字符的生成提示词。');
    const references = input.references || [];
    if (!Array.isArray(references) || references.length > model.maxReferences || (model.requiresReference && !references.length)) throw fail('provider_rejected', model.requiresReference ? `此 Seedance 模型需要 1–${model.maxReferences} 张参考图片。` : `此模型最多支持 ${model.maxReferences} 张参考图片。`);
    for (const item of references) if (!(item?.bytes instanceof Uint8Array) || !item.bytes.length || item.bytes.length > MAX_MEDIA_BYTES || !IMAGE_MIMES.has(item.mime)) throw fail('provider_rejected', '媒体参考只接受已核验的 PNG／JPEG／WebP／GIF 图片字节，单份不超过 20 MiB。');
    const configuredDefaults = state.modelDefaults[model.type].model === model.id ? state.modelDefaults[model.type] : null;
    const ratio = input.ratio || configuredDefaults?.ratio || '4:3';
    const resolution = input.resolution || configuredDefaults?.resolution || (model.type === 'image' ? '2k' : '720p');
    const duration = input.duration === undefined ? configuredDefaults?.duration ?? model.durations?.[0] : Number(input.duration);
    if (!model.ratios.includes(ratio) || !model.resolutions.includes(resolution) || (model.type === 'video' && !model.durations.includes(duration))) throw fail('provider_rejected', '所选比例、分辨率或时长不在该模型的已验证范围内。');
    if (!state.secret) throw fail('credential_missing', '尚未配置即梦 sessionId，请先在媒体设置中填写认证。');
    const available = await capabilities();
    if (!available.healthy) throw fail('service_unavailable', available.error || '即梦本机服务暂不可用。');
    if (!available.models.some(item => item.id === model.id && item.type === model.type)) throw fail('provider_rejected', '当前媒体服务未提供所选模型，不会静默切换模型。');
    state = snapshot(); fence(state, input.expectedEndpoint);
    if (!state.secret) throw fail('credential_missing', '即梦认证已清除，未提交生成。');
    const values = { model: model.id, prompt: input.prompt.trim(), ratio, resolution, ...(model.type === 'video' ? { duration } : { response_format: 'url' }) };
    let body, headers;
    if (references.length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(values)) form.append(key, String(value));
      for (const item of references) form.append(model.type === 'image' ? 'images' : 'files', new Blob([item.bytes], { type: item.mime }), path.basename(String(item.name || 'reference.png').replace(/\\/g, '/')).replace(/[\r\n\u0000]/g, '_'));
      const encoded = new Request('http://localhost/', { method: 'POST', body: form });
      body = Buffer.from(await encoded.arrayBuffer()); headers = { 'Content-Type': encoded.headers.get('content-type') };
    } else { body = Buffer.from(JSON.stringify(values)); headers = { 'Content-Type': 'application/json' }; }
    const latest = snapshot(); fence(latest, input.expectedEndpoint);
    if (latest.endpoint !== state.endpoint) throw fail('provider_configuration_changed', '媒体服务地址在准备提交期间已更改，未提交生成。');
    state = latest;
    if (!state.secret) throw fail('credential_missing', '即梦认证已清除，未提交生成。');
    const payload = await json(state, model.type === 'image' ? '/v1/images/generations' : '/v1/videos/generations/async', { method: 'POST', body, headers,
      timeoutMs: config.mediaSubmitTimeoutMs || 600_000, maxBytes: model.type === 'image' ? Math.ceil(GENERATED_MEDIA_MAX_BYTES * 4 / 3) + 1024 * 1024 : 1024 * 1024 });
    if (model.type === 'video') {
      const providerTaskId = payload.task_id || payload.taskId || payload?.data?.task_id;
      if (typeof providerTaskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(providerTaskId)) throw fail('submission_unknown', '视频服务未返回有效任务标识，提交结果未知；请勿重复生成。');
      return { providerTaskId };
    }
    const result = resultOf(payload);
    if (!result) throw fail('submission_unknown', '图片服务未返回可核对的结果，提交结果未知；请勿重复生成。');
    return result;
  }

  async function query(providerTaskId, { expectedEndpoint } = {}) {
    assertOpen();
    const state = snapshot(); fence(state, expectedEndpoint);
    if (typeof providerTaskId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(providerTaskId)) throw fail('provider_rejected', '视频任务标识无效。');
    if (!state.secret) throw fail('credential_missing', '尚未配置即梦 sessionId，无法查询原任务。');
    const payload = await json(state, `/v1/videos/generations/async/${encodeURIComponent(providerTaskId)}`, { timeoutMs: config.mediaQueryTimeoutMs || 600_000, allowFailureStatus: true, taskQuery: true });
    const status = String(payload.status || payload?.data?.status || '').toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { status: 'failed', error: statusError(200, payload, state.secret).message };
    const result = resultOf(payload);
    if (result?.resultURL) return { status: 'succeeded', resultURL: result.resultURL };
    if (['processing', 'pending', 'queued', 'running', 'submitted'].includes(status)) return { status: 'processing' };
    throw fail('provider_rejected', '视频服务未返回可核对的任务状态。');
  }

  async function download(value, { maxBytes = GENERATED_MEDIA_MAX_BYTES } = {}) {
    assertOpen();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw fail('download_failed', '下载字节上限无效。');
    let url = value;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response;
      try { response = await request(url, { localOnly: false, allowLocal: config.mediaAllowLocalDownloads === true, skipRedirectBody: true,
        headers: { 'Accept-Encoding': 'identity' }, maxBytes, timeoutMs: config.mediaDownloadTimeoutMs || 60_000 }); }
      catch (cause) {
        if (cause.code === 'download_url_blocked' || cause.code === 'download_url_invalid') throw cause;
        throw fail(cause.code === 'response_too_large' ? 'download_too_large' : 'download_failed', cause.code === 'response_too_large' ? '生成文件超过下载大小上限。' : '生成文件下载失败，请重试获取同一结果。', cause);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3 || typeof response.headers.location !== 'string') throw fail('download_failed', '生成文件下载重定向无效或次数过多。');
        try { url = new URL(response.headers.location, url).href; } catch { throw fail('download_url_invalid', '生成文件重定向地址无效。'); }
        continue;
      }
      if (response.status !== 200 || !response.bytes.length) throw fail('download_failed', '生成文件下载未返回完整的有效内容。');
      return { bytes: response.bytes, mime: String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase() };
    }
  }

  return { capabilities, updateSettings, submit, query, download, request, async close() { closed = true; for (const controller of active) controller.abort(); active.clear(); } };
}
