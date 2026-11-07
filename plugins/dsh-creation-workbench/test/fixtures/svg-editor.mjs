import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkbenchService} from '../../src/service.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function svgFixture(t,options={}) {
 const root=realpathSync(options.workspaceRoot||mkdtempSync(path.join(os.tmpdir(),'wtt-svg-'))),service=new WorkbenchService({workspaceRoot:root});
 t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});
 const project=path.join(root,'projects','课件');mkdirSync(path.join(project,'svg_final'),{recursive:true});mkdirSync(path.join(project,'notes'));mkdirSync(path.join(project,'exports'));
 for(let i=1;i<=(options.pageCount||2);i++) {writeFileSync(path.join(project,'svg_final',`p0${i}.svg`),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720"><rect width="1280" height="720" fill="#ffffff"/><g transform="translate(20 10)"><text x="60" y="120" font-family="Arial" font-size="40" fill="#003396">第${i}页标题</text></g><text x="80" y="240" font-size="24">正文原文</text></svg>`);writeFileSync(path.join(project,'notes',`p0${i}.md`),`第${i}页讲师备注`);}
 await service.svgDecks.convert(path.join(service.pptSkillDir,'scripts/svg_to_pptx.py'),project,path.join(project,'exports','原课件.pptx'));
 const requirement=service.store.createRequirement({title:'SVG人工测试',operationId:randomUUID()}),source=service.canvas.getBoard(requirement.id).nodes[0];
 const created=service.createTask({requirementId:requirement.id,instruction:'人工SVG测试',selectedCardIds:[source.id],sourceRefs:[{cardId:source.id,hash:source.sourceHash}],outputType:'pptx',generation:{mode:'new'},operationId:randomUUID()});
 const file=path.join(root,created.prepared.deliveryDirectory,'课件.pptx');writeFileSync(file,readFileSync(path.join(project,'exports','原课件.pptx')));
 const sessionId=options.sessionId||`technical:${created.task.id}`;service.tasks.bindSession({taskId:created.task.id,sessionId});
 const artifact=await service.tasks.files.register({taskId:created.task.id,kind:'pptx',path:file,title:'SVG课件',operationId:randomUUID()},{sessionId});
 const node=service.canvas.getBoard(requirement.id).nodes.find(n=>n.outputCard);
 const scope={requirementId:requirement.id,cardId:node.outputCard.id,versionId:node.outputCard.versionId,artifactId:artifact.id,hash:artifact.hash};
 return {root,service,project,scope,file};
}
