import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPluginScope, nativePreviewSlot } from '../src/native-preview-scope.mjs';

test('原生预览实例只在画布命名空间注册，不重复声明或改写宿主的席位／类型／词典', () => {
 const registrations=[], waits=[], effects=[], nativeRegistry={name:'original'}, labels=[];
 const original={documentPreviews:nativeRegistry,reflect:{provide(){throw new Error('不能覆盖宿主服务')}},
 sidebarRightTabs:{register(){throw new Error('不能重复注册宿主类型')}},locale:{register(){throw new Error('不能重复注册宿主词典')},bind:name=>key=>{labels.push(name);return key}},
 slots:{inject:(name,callback)=>{waits.push(name);return callback()},register:(options,component)=>{registrations.push({options,component});return ()=>{}}},
 inject:(names,callback)=>callback(original),effect:fn=>effects.push(fn)};
 const scope=previewPluginScope(original,Component=>Component), registry={name:'isolated'};
 const release=scope.reflect.provide('documentPreviews',registry);
 assert.equal(scope.documentPreviews,registry); assert.equal(original.documentPreviews,nativeRegistry);
 scope.locale.register('sidebarPdf',{});scope.sidebarRightTabs.register({kind:'text'});
 assert.equal(scope.locale.bind('sidebarPdf')('title'),'title');
 const Component=()=>null;
 scope.slots.inject('sidebar.right.pane.tab',()=>scope.slots.register({name:'sidebar.right.pane.tab',key:'native',children:{'sidebar.right.tab.document':{kind:'keyed',scope:'session'}}},Component));
 assert.deepEqual(waits,['wtt.preview.sidebar.right.pane.tab']);
 assert.equal(registrations[0].options.name,'wtt.preview.sidebar.right.pane.tab');
 assert.deepEqual(Object.keys(registrations[0].options.children),['wtt.preview.sidebar.right.tab.document']);
 assert.equal(registrations[0].component,Component);
 scope.inject(['remote.officeToPdf'],child=>assert.equal(child.documentPreviews,registry));
 assert.equal(nativePreviewSlot('conversation.content'),'conversation.content');
 release();assert.equal(scope.documentPreviews,undefined);assert.equal(original.documentPreviews,nativeRegistry);
 assert.throws(()=>scope.reflect.provide('otherService',{}),/接口已变化/);
});
