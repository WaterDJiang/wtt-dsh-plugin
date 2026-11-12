const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const definition = (vendor, label, type, endpoint, models, parameters) => ({ vendor, label, type, endpoint, models, ...parameters });
export const MEDIA_PROVIDERS = { openai: 'OpenAI', gemini: 'Google', jimeng: '火山方舟', kling: '可灵', minimax: 'MiniMax', wan: '阿里云百炼' };
export const mediaServiceName = protocol => `${MEDIA_PROVIDERS[MEDIA_PROTOCOLS[protocol].vendor]} ${MEDIA_PROTOCOLS[protocol].type === 'image' ? '图片' : '视频'}`;
export const MEDIA_PROTOCOLS = {
  'openai-image': definition('openai', 'GPT 图片', 'image', 'https://api.openai.com/v1', ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5'], { sizes: ['1024x1024', '1536x1024', '1024x1536'], qualities: ['auto', 'low', 'medium', 'high'], maxReferences: 1 }),
  'openai-video': definition('openai', 'Sora 视频', 'video', 'https://api.openai.com/v1', ['sora-2', 'sora-2-pro'], { sizes: ['1280x720', '720x1280'], durations: [4, 8, 12], maxReferences: 1 }),
  'gemini-image': definition('gemini', 'Gemini 图片', 'image', 'https://generativelanguage.googleapis.com/v1beta', ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3-pro-image'], { ratios: RATIOS, resolutions: ['1K', '2K', '4K'], maxReferences: 14 }),
  'gemini-video': definition('gemini', 'Gemini Omni 视频', 'video', 'https://generativelanguage.googleapis.com/v1beta', ['gemini-omni-1.2-flash'], { ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p', '360p', '4k'], durations: Array.from({ length: 13 }, (_, i) => i + 3), maxReferences: 6 }),
  'volc-image': definition('jimeng', '即梦 · Seedream', 'image', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'], { sizes: ['2048x2048', '2560x1440', '1440x2560', '2304x1728', '1728x2304'], maxReferences: 10 }),
  'volc-video': definition('jimeng', '即梦 · Seedance', 'video', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-seedance-2-0-260128', 'doubao-seedance-1-5-pro-251215'], { ratios: RATIOS, resolutions: ['720p', '1080p'], durations: [5, 6, 8, 10, 12], maxReferences: 1 }),
  'kling-image': definition('kling', '可灵图片', 'image', 'https://api-singapore.klingai.com', ['kling-v3'], { ratios: RATIOS, resolutions: ['1k', '2k'], maxReferences: 1, maxReferenceBytes: 10 * 1024 * 1024 }),
  'kling-video': definition('kling', '可灵视频', 'video', 'https://api-singapore.klingai.com', ['kling-3.0', 'kling-3.0-turbo'], { ratios: ['16:9', '9:16', '1:1'], resolutions: ['720p', '1080p'], durations: Array.from({ length: 13 }, (_, i) => i + 3), maxReferences: 0 }),
  'minimax-image': definition('minimax', 'MiniMax 图片', 'image', 'https://api.minimax.io/v1', ['image-01'], { sizes: ['1024x1024', '1280x720', '720x1280', '2048x2048'], maxReferences: 1 }),
  'minimax-video': definition('minimax', 'MiniMax 视频', 'video', 'https://api.minimax.io', ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max', 'MiniMax-Hailuo-2.3'], { resolutions: ['768P', '1080P'], durations: [6, 10], maxReferences: 1 }),
  'wan-image': definition('wan', '万相图片', 'image', 'https://dashscope.aliyuncs.com/api/v1', ['wan2.6-t2i', 'wan2.6-image'], { sizes: ['1280x1280', '1280x720', '720x1280', '1024x1024'], maxReferences: 0 }),
  'wan-video': definition('wan', '万相视频', 'video', 'https://dashscope.aliyuncs.com/api/v1', ['wan2.6-t2v', 'wan2.6-i2v'], { ratios: ['16:9', '9:16', '1:1'], resolutions: ['720P', '1080P'], durations: [5, 10, 15], maxReferences: 0 }),
};

export const MEDIA_PARAMETER_KEYS = ['model', 'ratio', 'resolution', 'duration', 'size', 'quality'];
export function mediaModelDefinition(profile) {
  const protocol = MEDIA_PROTOCOLS[profile.protocol];
  if (!protocol) throw new Error('媒体 API 协议尚未支持');
  if (profile.type !== protocol.type) throw new Error('媒体类型与所选协议不匹配');
  const model = { id: profile.model, type: profile.type, requiresReference: false, ratios: [], resolutions: [], sizes: [], qualities: [], durations: [], ...protocol };
  if (profile.protocol === 'openai-video' && profile.model === 'sora-2-pro') model.sizes = [...model.sizes, '1920x1080', '1080x1920'];
  if (profile.protocol === 'minimax-video' && profile.model.startsWith('MiniMax-H3')) {
    model.ratios = ['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'];
    model.resolutions = profile.model === 'MiniMax-H3' ? ['768P','2K'] : ['480P','768P'];
    const minimum = profile.model === 'MiniMax-H3-Max' ? 5 : 4;
    model.durations = Array.from({length:16-minimum},(_,i)=>i+minimum);
  }
  if (profile.protocol === 'wan-video' && /i2v/.test(profile.model)) { model.maxReferences = 1; model.requiresReference = true; model.ratios = []; }
  if (profile.protocol === 'wan-image' && profile.model === 'wan2.6-image') model.maxReferences = 1;
  return model;
}

export function mediaDefaults(model) {
  return { model: model.id, ...Object.fromEntries([['ratio', model.ratios], ['resolution', model.resolutions], ['size', model.sizes], ['quality', model.qualities], ['duration', model.durations]].filter(([, choices]) => choices?.length).map(([key, choices]) => [key, choices[0]])) };
}

export function validateMediaParameters(type, parameters, model) {
  if (!parameters || parameters.model !== model.id || type !== model.type) throw new Error('媒体模型与服务不匹配');
  if (Object.keys(parameters).some(key => !MEDIA_PARAMETER_KEYS.includes(key))) throw new Error('媒体参数包含不支持的字段');
  for (const [key, list] of [['ratio', 'ratios'], ['resolution', 'resolutions'], ['size', 'sizes'], ['quality', 'qualities'], ['duration', 'durations']]) {
    const choices = model[list] || [];
    if (choices.length && !choices.includes(parameters[key])) throw new Error(`所选模型不支持该${{ ratio: '比例', resolution: '分辨率', size: '尺寸', quality: '质量', duration: '时长' }[key]}，参数不能静默改写`);
    if (!choices.length && parameters[key] !== undefined) throw new Error('所选模型不支持该参数，未提交生成');
  }
  if (model.vendor === 'minimax' && type === 'video' && parameters.resolution === '1080P' && parameters.duration !== 6) throw new Error('MiniMax 1080P 仅支持 6 秒，请更改时长或分辨率');
  return Object.fromEntries(MEDIA_PARAMETER_KEYS.filter(key => parameters[key] !== undefined).map(key => [key, parameters[key]]));
}
