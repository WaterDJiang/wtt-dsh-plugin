import test from 'node:test';import assert from 'node:assert/strict';import {compactPptRenderDiagnostics} from '../src/artifact-preview.mjs';
test('重复MuPDF提示不能挤掉最后的真实文字校验错误',()=>{
 const repeat='MuPDF error: format error: No common ancestor in structure tree',root='ERROR [render]: Rendered text checks failed; see manifest.json';
 const result=compactPptRenderDiagnostics((repeat+'\n\n').repeat(2000)+root);assert.match(result,/重复 2000 次/);assert.ok(result.endsWith(root));assert.ok(result.length<250);
});
