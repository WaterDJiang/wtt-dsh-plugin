import { createMediaProvider } from './media-provider.mjs';
import { mediaDefaults, mediaModelDefinition, validateMediaParameters } from './media-api-catalog.mjs';
import { GENERATED_MEDIA_MAX_BYTES } from './artifact-validation.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const dataURI = ref => `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`;
const supported = new Set(['queued', 'pending', 'submitted', 'processing', 'running', 'in_progress', 'queueing', 'preparing']);
const succeeded = new Set(['succeeded', 'succeed', 'success', 'completed']);

export function createOfficialMediaProvider(id, access, config = {}) {
  const transport = createMediaProvider({ ...config, mediaTransportOnly: true });
  let closed = false;
  const profile = () => {
    if (closed) throw fail('provider_closed', '媒体服务已关闭');
    const value = access.get ? access.get(id) : access.profiles()[id];
    if (!value) throw fail('provider_configuration_changed', '媒体服务配置已移除，不会切换提供商');
    const expected = config.mediaExpectedProfile;
    if (expected && ['baseURL','apiKeyEnv','protocol','model','type'].some(key => expected[key] !== value[key])) throw fail('provider_configuration_changed', '媒体服务配置已更改，原任务不会改用新配置');
    return value;
  };
  const safeError = (value, secret) => String(value || '媒体服务操作失败').split(secret || '\0').join('[已隐藏]').replace(/Bearer\s+[^\s"'<>;,]+/gi, 'Bearer [已隐藏]').slice(0, 600);
  async function api(suffix, { method = 'GET', body, multipart, expectedEndpoint, expectedProfile, binary = false, asyncHeader = false } = {}) {
    const current = profile();
    if (expectedEndpoint !== undefined && expectedEndpoint !== current.baseURL) throw fail('provider_configuration_changed', '媒体服务地址已更改，原任务不会发送到新端点');
    const secret = await access.resolve(id, expectedProfile || current);
    const google = current.protocol.startsWith('gemini-');
    let bytes, contentType;
    if (multipart) {
      const encoded = new Request('http://form.invalid', { method: 'POST', body: multipart });
      contentType = encoded.headers.get('content-type');
      bytes = Buffer.from(await encoded.arrayBuffer());
    } else if (body !== undefined) { bytes = Buffer.from(JSON.stringify(body)); contentType = 'application/json'; }
    const latest = profile();
    if (latest.baseURL !== current.baseURL || latest.apiKeyEnv !== current.apiKeyEnv || latest.protocol !== current.protocol) throw fail('provider_configuration_changed', '媒体设置在准备请求期间已变化，未提交生成');
    let response;
    try {
      response = await transport.request(apiURL(current, suffix), { method, body: bytes,
        localOnly: false, allowLocal: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(current.baseURL).hostname),
        timeoutMs: config.mediaApiTimeoutMs || 600_000, maxBytes: binary ? GENERATED_MEDIA_MAX_BYTES : Math.ceil(GENERATED_MEDIA_MAX_BYTES * 4 / 3) + 1024 * 1024,
        headers: { ...(google ? { 'x-goog-api-key': secret, 'Api-Revision': '2026-05-20' } : { Authorization: `Bearer ${secret}` }), ...(contentType ? { 'Content-Type': contentType } : {}), ...(asyncHeader ? { 'X-DashScope-Async': 'enable' } : {}), Accept: binary ? '*/*' : 'application/json' } });
    } catch (cause) {
      const unavailable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(cause.code);
      throw fail(method === 'POST' && !unavailable ? 'submission_unknown' : 'service_unavailable', method === 'POST' && !unavailable ? '提交结果未知，请先核对原任务，不会自动重投' : '媒体服务不可达，请检查地址与网络');
    }
    if (binary && response.status >= 300 && response.status < 400 && response.headers.location) return transport.download(new URL(response.headers.location, current.baseURL + suffix).href, { maxBytes: GENERATED_MEDIA_MAX_BYTES });
    let payload;
    if (!binary) { try { payload = JSON.parse(response.bytes.toString('utf8')); } catch { throw fail(method === 'POST' ? 'submission_unknown' : 'provider_rejected', '媒体服务未返回有效 JSON，请核对原任务'); } }
    const refusal = response.status < 200 || response.status >= 300 || payload?.error || payload?.code !== undefined && ![0, '0', 200, '200'].includes(payload.code) || payload?.base_resp?.status_code;
    if (refusal) {
      const code = method === 'GET' && response.status === 404 ? 'provider_task_missing' : method === 'GET' && response.status === 410 ? 'provider_task_expired' : [401, 403].includes(response.status) ? 'credential_invalid' : response.status === 402 ? 'quota_exceeded' : response.status >= 500 && method === 'POST' ? 'submission_unknown' : 'provider_rejected';
      const raw = payload?.error?.message || payload?.message || payload?.base_resp?.status_msg || `HTTP ${response.status}`;
      throw fail(code, safeError(raw, secret));
    }
    if (binary) return { bytes: response.bytes, mime: String(response.headers['content-type'] || 'video/mp4').split(';')[0] };
    return payload;
  }

  function singleResult(payload, type) {
    if (payload?.data?.[0]?.b64_json) return { resultBase64: payload.data[0].b64_json };
    if (payload?.data?.[0]?.url) return { resultURL: payload.data[0].url };
    if (payload?.data?.image_urls?.[0]) return { resultURL: payload.data.image_urls[0] };
    const blocks = (payload?.steps || []).filter(step => step.type === 'model_output').flatMap(step => step.content || []);
    const block = blocks.find(part => part.type === type && (part.data || part.uri));
    if (block?.data) return { resultBase64: block.data };
    if (block?.uri) return { resultURL: block.uri };
    const content = payload?.output?.choices?.[0]?.message?.content || [];
    const image = content.find(part => part.image);
    if (image) return { resultURL: image.image };
    throw fail('submission_unknown', '生成响应没有可核对的成果，请在原服务核对，不会自动重复生成');
  }

  function taskResult(record, type, resultURL) {
    const status = String(record?.status || record?.task_status || '').toLowerCase();
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { status: 'failed', error: '服务生成失败，请在提供商处核对原任务' };
    if (succeeded.has(status)) {
      const url = resultURL || record?.outputs?.find(item => item.type === type)?.url || record?.task_result?.[type === 'image' ? 'images' : 'videos']?.[0]?.url;
      if (!url) throw fail('provider_rejected', '已完成任务缺少可取回的成果地址');
      return { status: 'succeeded', resultURL: url };
    }
    if (supported.has(status)) return { status: 'processing' };
    throw fail('provider_rejected', '媒体服务未返回可核对的任务状态');
  }

  async function submit(input) {
    const current = profile(), protocol = current.protocol, model = mediaModelDefinition(current);
    const { references = [], prompt, expectedEndpoint, ...raw } = input;
    const { type, ...parameters } = raw;
    validateMediaParameters(type, parameters, model);
    if (references.length > model.maxReferences || model.requiresReference && !references.length) throw fail('provider_rejected', '参考图片数量不符合所选模型要求');
    if (references.some(ref => ref.bytes.length > (model.maxReferenceBytes || 20 * 1024 * 1024)) || references.reduce((sum, ref) => sum + ref.bytes.length, 0) > 32 * 1024 * 1024) throw fail('provider_rejected', '参考图片超过所选模型上传大小限制');
    const request = { method: 'POST', expectedEndpoint, expectedProfile: current };
    const { ratio, resolution, duration, size, quality } = parameters;
    if (protocol === 'openai-image') {
      if (references.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries({ model: current.model, prompt, n: 1, size, quality })) if (value !== undefined) form.append(key, String(value));
        for (const ref of references) form.append('image[]', new Blob([ref.bytes], { type: ref.mime }), ref.name);
        return singleResult(await api('/images/edits', { ...request, multipart: form }), type);
      }
      return singleResult(await api('/images/generations', { ...request, body: { model: current.model, prompt, n: 1, size, quality } }), type);
    }
    if (protocol === 'openai-video') {
      const form = new FormData();
      for (const [key, value] of Object.entries({ model: current.model, prompt, size, seconds: duration })) form.append(key, String(value));
      for (const ref of references) form.append('input_reference', new Blob([ref.bytes], { type: ref.mime }), ref.name);
      const result = await api('/videos', { ...request, multipart: form });
      return accepted(result.id);
    }
    if (protocol.startsWith('gemini-')) {
      const response_format = type === 'image' ? { type, aspect_ratio: ratio, image_size: resolution } : { type, aspect_ratio: ratio, resolution, duration: `${duration}s` };
      const result = await api('/interactions', { ...request, body: { model: current.model, input: references.length ? [{ type: 'text', text: prompt }, ...references.map(ref => ({ type: 'image', mime_type: ref.mime, data: Buffer.from(ref.bytes).toString('base64') }))] : prompt, response_format } });
      if (result.status && supported.has(result.status)) return accepted(result.id);
      return singleResult(result, type);
    }
    if (protocol === 'volc-image') return singleResult(await api('/images/generations', { ...request, body: { model: current.model, prompt, size, response_format: 'b64_json', sequential_image_generation: 'disabled', ...(references.length ? { image: references.map(dataURI) } : {}) } }), type);
    if (protocol === 'volc-video') {
      const result = await api('/contents/generations/tasks', { ...request, body: { model: current.model, content: [{ type: 'text', text: prompt }, ...references.map(ref => ({ type: 'image_url', image_url: { url: dataURI(ref) }, role: 'first_frame' }))], ratio, resolution, duration } });
      return accepted(result.id);
    }
    if (protocol === 'kling-image') {
      const result = await api('/v1/images/generations', { ...request, body: { model_name: current.model, prompt, aspect_ratio: ratio, resolution, n: 1, ...(references.length ? { image: Buffer.from(references[0].bytes).toString('base64') } : {}) } });
      return accepted(result.data?.task_id);
    }
    if (protocol === 'kling-video') {
      const result = await api(`/text-to-video/${encodeURIComponent(current.model)}`, { ...request, body: { prompt, settings: { aspect_ratio: ratio, resolution, duration, multi_shot: false, audio: 'off' } } });
      return accepted(result.data?.id);
    }
    if (protocol === 'minimax-image') {
      const [width, height] = size.split('x').map(Number);
      return singleResult(await api('/image_generation', { ...request, body: { model: current.model, prompt, width, height, n: 1, response_format: 'url', ...(references.length ? { subject_reference: references.map(ref => ({ type: 'character', image_file: dataURI(ref) })) } : {}) } }), type);
    }
    if (protocol === 'minimax-video') {
      const h3 = current.model.startsWith('MiniMax-H3');
      if (h3 && (references.length ? ratio !== 'adaptive' : ratio === 'adaptive')) throw fail('provider_rejected', 'MiniMax H3 首帧视频请选择 adaptive 比例，纯文字请选择明确比例');
      const body = h3 ? { model: current.model, content: [{type:'text',text:prompt}, ...references.map(ref=>({type:'image_url',image_url:{url:dataURI(ref)},role:'first_frame'}))], ratio, resolution, duration, extra:{prompt_expansion_mode:'disabled'} } : { model: current.model, prompt, resolution, duration, prompt_optimizer: false, ...(references.length ? { first_frame_image: dataURI(references[0]) } : {}) };
      const result = await api(h3 ? '/v2/video_generation' : '/v1/video_generation', { ...request, body });
      return accepted(result.task_id);
    }
    if (protocol === 'wan-image') {
      return singleResult(await api('/services/aigc/multimodal-generation/generation', { ...request, body: { model: current.model, input: { messages: [{ role: 'user', content: [...references.map(ref => ({ image: dataURI(ref) })), { text: prompt }] }] }, parameters: { size: size.replace('x', '*'), n: 1, enable_interleave: false } } }), type);
    }
    if (protocol === 'wan-video') {
      const result = await api('/services/aigc/video-generation/video-synthesis', { ...request, body: { model: current.model, input: { prompt, ...(references.length ? { img_url: dataURI(references[0]) } : {}) }, parameters: { ...(model.requiresReference ? { resolution } : { size: videoSize(ratio, resolution).replace('x', '*') }), duration, prompt_extend: false } } , asyncHeader: true });
      return accepted(result.output?.task_id);
    }
    throw fail('provider_rejected', '未实现所选媒体协议');
  }

  const accepted = value => {
    if (typeof value !== 'string' || !value || value.length > 1024) throw fail('submission_unknown', '服务没有返回有效任务标识，请核对原请求');
    return { providerTaskId: value };
  };
  async function query(taskId, options = {}) {
    const current = profile(), protocol = current.protocol, encoded = encodeURIComponent(taskId);
    if (protocol === 'openai-video') return taskResult(await api(`/videos/${encoded}`, options), 'video', `${current.baseURL}/videos/${encoded}/content`);
    if (protocol.startsWith('gemini-')) {
      const result = await api(`/interactions/${encoded}`, options);
      if (result.status === 'completed') return { status: 'succeeded', ...singleResult(result, current.type) };
      return taskResult(result, current.type);
    }
    if (protocol === 'volc-video') { const result = await api(`/contents/generations/tasks/${encoded}`, options); return taskResult(result, 'video', result.content?.video_url); }
    if (protocol === 'kling-image') { const result = await api(`/v1/images/generations/${encoded}`, options); return taskResult(result.data, 'image'); }
    if (protocol === 'kling-video') {
      const result = await api(`/tasks?task_ids=${encoded}`, options);
      const record = result.data?.find(task => task.id === taskId);
      if (!record) throw fail('provider_task_missing', '可灵中找不到原任务');
      return taskResult(record, 'video');
    }
    if (protocol === 'minimax-video') {
      if (current.model.startsWith('MiniMax-H3')) { const result = await api(`/v2/query/video_generation/${encoded}`, options); return taskResult(result.task, 'video', result.task?.content?.url); }
      const result = await api(`/v1/query/video_generation?task_id=${encoded}`, options);
      if (String(result.status).toLowerCase() !== 'success') return taskResult(result, 'video');
      const file = await api(`/v1/files/retrieve?file_id=${encodeURIComponent(result.file_id)}`, options);
      return { status: 'succeeded', resultURL: file.file?.download_url };
    }
    if (protocol === 'wan-video') { const result = await api(`/tasks/${encoded}`, options); return taskResult(result.output, 'video', result.output?.video_url); }
    throw fail('provider_rejected', '该协议没有异步任务查询');
  }
  return {
    async capabilities() {
      const current = profile(), model = mediaModelDefinition(current), info = await access.describe(id);
      return { endpoint: current.baseURL, healthy: true, credentialConfigured: info.configured, modelDefaults: { [current.type]: mediaDefaults(model) }, models: [model] };
    }, submit, query,
    async download(url, options) {
      const current = profile();
      const prefix = `${current.baseURL}/videos/`;
      if (current.protocol === 'openai-video' && url.startsWith(prefix) && /^[-\w]+\/content$/.test(url.slice(prefix.length))) return api(url.slice(current.baseURL.length), { binary: true });
      return transport.download(url, options);
    },
    close() { closed = true; return transport.close(); },
  };
}

function videoSize(ratio, resolution) {
  const short = /1080/i.test(resolution) ? 1080 : 720;
  return ratio === '9:16' ? `${short}x${short === 720 ? 1280 : 1920}` : ratio === '1:1' ? `${short}x${short}` : `${short === 720 ? 1280 : 1920}x${short}`;
}

function apiURL(profile, suffix) {
  let base = profile.baseURL;
  if (profile.protocol.startsWith('gemini-')) base = base.replace(/\/openai$/, '');
  if (profile.protocol.startsWith('wan-')) base = base.replace(/\/compatible-mode\/v1$/, '/api/v1');
  if (profile.protocol === 'minimax-video' && /^\/v[12]\//.test(suffix)) base = base.replace(/\/v[12]$/, '');
  return base + suffix;
}
