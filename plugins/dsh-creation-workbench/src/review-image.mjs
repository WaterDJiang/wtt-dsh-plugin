import { generatedMediaExtension, validateArtifact } from './artifact-validation.mjs';

export async function readReviewImage(service, relative, hash) {
  if (!/^[a-f\d]{64}$/i.test(hash || '')) throw new Error('候选图片缺少有效的 SHA-256，请重新核对当前问题');
  if (!/\.(png|jpe?g|webp|gif)$/i.test(relative || '')) throw new Error('候选预览仅支持 PNG、JPEG、WebP 和 GIF 图片');
  const file = service.projectFiles.read(relative, hash.toLowerCase());
  const extension = generatedMediaExtension('image', file.bytes);
  // Preview uses the real encoding; original files and registration rules stay intact.
  const checked = await validateArtifact('image', `candidate${extension}`, file.bytes, { pythonExecutable: service.python });
  service.projectFiles.read(relative, file.hash);
  return { ...file, mime: checked.mime };
}
