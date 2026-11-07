import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

test('切换成果文件后旧加载结果不得挂载新文件编辑器，准确匹配后才能打开', async () => {
 const target={cardId:'card',requirementId:'canvas'},files=[{sourceRef:'artifact:old',name:'旧.pptx',hash:'old'},{sourceRef:'artifact:new',name:'新.docx',hash:'new'}];
 const manifest={cardId:'card',files},identity=JSON.stringify(target),key=`${identity}:artifact:new:new`;
 let states;
 const React={createElement:(type,props,...children)=>({type,props,children}),useEffect(){},useState(){return [states.shift(),()=>{}]}};
 const result=await build({entryPoints:['src/outcome-viewer.jsx'],bundle:false,format:'cjs',write:false,jsx:'transform'});
 const module={exports:{}},DocumentViewer=()=>null;
 vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:name=>name==='react'?{...React,default:React}:name.endsWith('document-preview.jsx')?{DocumentViewer}:name.endsWith('controls.jsx')?{PanelHeader:()=>null,PanelToolbar:()=>null,UiButton:()=>null}:{UserError:()=>null}});
 const render=binding=>{states=[manifest,'artifact:new',binding,'',null,''];return module.exports.OutcomeViewer({target,endpoint:q=>({href:JSON.stringify(q)})})};
 const stale=render({key:`${identity}:artifact:old:old`,value:{name:'旧.pptx',format:'pptx',hash:'old'}});
 assert.equal(stale.type,'aside');assert.equal(JSON.stringify(stale).includes('正在读取成果文件'),true);
 const ready=render({key,value:{name:'新.docx',format:'docx',hash:'new'}});
 assert.equal(ready.type,DocumentViewer);assert.equal(ready.props.sourceRef,'artifact:new');assert.equal(ready.props.hash,'new');assert.equal(ready.props.title,'新.docx');
});

test('编辑源文件仅打开匹配源工程，不提供直接PPTX入口或无源稿回退',async()=>{
 const target={requirementId:'canvas',cardId:'card'},manifest={cardId:'card',versionId:'v1',files:[{sourceRef:'artifact:ppt',artifactId:'ppt',hash:'hash',name:'课件.pptx'}]},identity=JSON.stringify(target),key=`${identity}:artifact:ppt:hash`;
 let states,edited,openedWeb;const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useEffect(){},useState(){return [states.shift(),()=>{}]}};
 const result=await build({entryPoints:['src/outcome-viewer.jsx'],bundle:false,format:'cjs',write:false,jsx:'transform'}),module={exports:{}},UiButton=()=>null;
 vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:name=>name==='react'?{...React,default:React}:name.endsWith('document-preview.jsx')?{DocumentViewer:()=>null}:name.endsWith('controls.jsx')?{PanelHeader:()=>null,PanelToolbar:()=>null,UiButton}:{UserError:()=>null}});
 const render=svg=>{states=[manifest,'artifact:ppt',{key,value:{format:'pptx',name:'课件.pptx',hash:'hash'}},'',{key,value:svg},svg.candidates?.[0]?.id||''];return module.exports.OutcomeViewer({target,onEditPpt:scope=>{edited=scope},onOpenSlides:value=>{openedWeb=value},endpoint:()=>({href:'/file'})}).props.fileActions(false)};
 const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.children||[]).flat(Infinity).flatMap(flatten)];
 const matched=flatten(render({status:'matched',candidates:[{id:'exact-source'}]}));
 const primary=matched.find(n=>n.type===UiButton&&n.children.includes('编辑源文件'));primary.props.onClick();assert.equal(edited.svgCandidateId,'exact-source');assert.equal(edited.artifactId,'ppt');
 assert.equal(matched.some(n=>n.children?.includes('直接编辑 PPTX')||n.children?.includes('其他编辑方式')),false);
 edited=null;
 for(const svg of [{status:'none',candidates:[]},{status:'error',message:'查找失败',candidates:[]}]){
  const plain=flatten(render(svg)),button=plain.find(n=>n.type===UiButton&&n.children.includes('编辑源文件'));
  assert.equal(button.props.disabled,true);button.props.onClick();assert.equal(edited,null);
 }
 manifest.slideProject={artifactId:'other'};
 const unrelated=flatten(render({status:'none',candidates:[]})).find(n=>n.type===UiButton&&n.children.includes('编辑源文件'));assert.equal(unrelated.props.disabled,true);unrelated.props.onClick();assert.equal(openedWeb,undefined);
 manifest.slideProject={artifactId:'ppt'};
 const linked=flatten(render({status:'none',candidates:[]})).find(n=>n.type===UiButton&&n.children.includes('编辑源文件'));assert.equal(linked.props.disabled,false);linked.props.onClick();assert.equal(openedWeb,manifest);assert.equal(edited,null);
});
