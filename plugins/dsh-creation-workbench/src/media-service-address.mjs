// Shared by the browser form and Host: only explicitly configured private IPs opt in.
export function isLocalMediaServiceHost(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(part => part > 255)) return false;
    const [a, b] = parts;
    return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
  }
  const mapped = host.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return isLocalMediaServiceHost(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
  }
  return /^f[cd][a-f0-9]{2}:/.test(host);
}

const addressError = message => Object.assign(new Error(message), { field: 'baseURL' });
const generationPaths = {
  'openai-image': ['/images/generations', '/images/edits'],
  'openai-video': ['/videos'],
  'gemini-image': ['/interactions'],
  'gemini-video': ['/interactions'],
  'volc-image': ['/images/generations'],
  'jimeng-image': ['/images/generations'],
  'volc-video': ['/contents/generations/tasks'],
  'kling-image': ['/v1/images/generations'],
  'minimax-image': ['/image_generation'],
  'minimax-video': ['/v2/video_generation', '/v1/video_generation'],
  'wan-image': ['/services/aigc/multimodal-generation/generation'],
  'wan-video': ['/services/aigc/video-generation/video-synthesis'],
};

export function normalizeMediaServiceAddress(value, protocol, model) {
  let url;
  try { url = new URL(value); } catch { throw addressError('API 地址无效，请填写完整的 HTTP(S) 地址'); }
  if (url.username || url.password || url.search || url.hash) throw addressError('API 地址不能包含账号、密码、查询参数或片段；密钥请填入 API 密钥');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalMediaServiceHost(url.hostname))) throw addressError('API 地址使用 HTTPS；本机或局域网 IP 可使用 HTTP');
  const pathname = url.pathname.replace(/\/+$/, '');
  const paths = protocol === 'kling-video' ? [`/text-to-video/${encodeURIComponent(model)}`] : generationPaths[protocol] || [];
  const endpoint = paths.find(suffix => pathname.endsWith(suffix));
  if (endpoint) url.pathname = pathname.slice(0, -endpoint.length) || '/';
  return url.href.replace(/\/+$/, '');
}
