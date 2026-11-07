import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('../src/ppt-editor.py', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = (args, input) => spawnSync('python3', ['-B', ...args], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const inspect = source => {
  const result = execute([adapter, 'inspect', source]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const apply = (source, output, pages) => {
  const result = execute([adapter, 'apply', source, output], { pages });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-native-ppt-edit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, '原始三页课件.pptx');
  const created = execute(['-c', String.raw`
import json,sys,zipfile
from pptx import Presentation
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
from pptx.oxml.xmlchemy import OxmlElement
deck=Presentation();deck.slide_width=Inches(13.333333);deck.slide_height=Inches(7.5)
first=deck.slides.add_slide(deck.slide_layouts[6])
box=first.shapes.add_textbox(Inches(1),Inches(1),Inches(10),Inches(2))
p=box.text_frame.paragraphs[0]
r=p.add_run();r.text='开场旧标题';r.font.bold=True;r.font.name='PingFang SC';r.font.size=Pt(28)
r=p.add_run();r.text=' / 保留斜体';r.font.italic=True;r.font.color.rgb=RGBColor(0x12,0x34,0x56)
p.add_line_break();r=p.add_run();r.text='原有软换行';r.font.size=Pt(18)
first.notes_slide.notes_text_frame.text='讲师原备注\n第二段'
second=deck.slides.add_slide(deck.slide_layouts[6])
group=second.shapes.add_group_shape()
child=group.shapes.add_textbox(Inches(1),Inches(2),Inches(3),Inches(1));child.text='分组中的原生文字'
group.left=Inches(2);group.top=Inches(1);group.width=Inches(6);group.height=Inches(2)
third=deck.slides.add_slide(deck.slide_layouts[6])
plain=third.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(2));plain.text='第三页保持原样'
dynamic=third.shapes.add_textbox(Inches(1),Inches(4),Inches(6),Inches(1));p=dynamic.text_frame.paragraphs[0]
field=OxmlElement('a:fld');field.set('id','{18F7FD55-4CF6-4D38-B246-EE8702B88D71}');field.set('type','datetime1')
text=OxmlElement('a:t');text.text='动态日期';field.append(text);p._p.append(field)
table=third.shapes.add_table(1,2,Inches(1),Inches(5),Inches(6),Inches(1)).table
table.cell(0,0).text='表格保留';table.cell(0,1).text='只读说明'
deck.save(sys.argv[1])
with zipfile.ZipFile(sys.argv[1],'a') as package: package.writestr('docProps/keep-original.bin',b'UNREFERENCED-ORIGINAL-PART')
print(json.dumps({'first':str(first.slide_id),'firstElement':str(box.shape_id),'second':str(second.slide_id),'groupElement':str(child.shape_id),'third':str(third.slide_id),'fieldElement':str(dynamic.shape_id)}))
`, source]);
  assert.equal(created.status, 0, created.stderr);
  return { root, source, ids: JSON.parse(created.stdout), original: readFileSync(source) };
}

function compareParts(before, after) {
  const result = execute(['-c', String.raw`
import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as before,zipfile.ZipFile(sys.argv[2]) as after:
 old=set(before.namelist());new=set(after.namelist())
 print(json.dumps({'changed':sorted(name for name in old&new if before.read(name)!=after.read(name)),
                   'added':sorted(new-old),'removed':sorted(old-new)}))
`, before, after]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('inspect locates grouped native text without adding notes or modifying any source bytes', t => {
  const f = fixture(t), model = inspect(f.source);
  assert.equal(model.slides.length, 3);
  assert.equal(model.width, 12191999);
  assert.deepEqual(model.slides.map(page => page.id), [f.ids.first, f.ids.second, f.ids.third]);
  assert.equal(model.slides[0].notes, '讲师原备注\n第二段');
  assert.equal(model.slides[1].notes, '');
  const grouped = model.slides[1].elements.find(element => element.id === f.ids.groupElement);
  assert.equal(grouped.text, '分组中的原生文字'); assert.equal(grouped.editable, true);
  assert.deepEqual(grouped.bounds, { x: 1828800, y: 914400, width: 5486400, height: 1828800 });
  const field = model.slides[2].elements.find(element => element.id === f.ids.fieldElement);
  assert.equal(field.text, '动态日期'); assert.equal(field.editable, false);
  assert.match(field.reason, /动态字段/);
  assert.equal(model.slides[2].elements.find(element => element.text.includes('表格保留')).editable, false);
  assert.deepEqual(readFileSync(f.source), f.original);
  assert.equal(inspect(f.source).slides[1].notes, '', 'repeated reads do not manufacture note parts');
});

test('text and existing notes patch only the intended parts while retaining run styles, soft breaks and untouched objects', t => {
  const f = fixture(t), output = path.join(f.root, '修改后的V2.pptx');
  const report = apply(f.source, output, [{ slideId: f.ids.first,
    changes: [{ elementId: f.ids.firstElement, text: '开场新标题 / 保留斜体\n原有软换行' }], notes: '修改后的讲师备注\n第二段' }]);
  assert.equal(report.changed, true); assert.equal(report.pageCount, 3);
  const parts = compareParts(f.source, output);
  assert.deepEqual(parts.removed, []); assert.deepEqual(parts.added, []);
  assert.deepEqual(parts.changed, ['ppt/notesSlides/notesSlide1.xml', 'ppt/slides/slide1.xml']);
  assert.deepEqual(report.changedParts, parts.changed);
  const model = inspect(output);
  assert.equal(model.slides[0].elements[0].text, '开场新标题 / 保留斜体\n原有软换行');
  assert.equal(model.slides[0].notes, '修改后的讲师备注\n第二段');
  assert.equal(model.slides[1].elements[0].text, '分组中的原生文字');
  assert.deepEqual(readFileSync(f.source), f.original);
  const styleCheck = execute(['-c', String.raw`
import sys,zipfile
from lxml import etree as E
n={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as before,zipfile.ZipFile(sys.argv[2]) as after:
 b=E.fromstring(before.read('ppt/slides/slide1.xml'));a=E.fromstring(after.read('ppt/slides/slide1.xml'))
 assert a.xpath('count(.//a:br)',namespaces=n)==b.xpath('count(.//a:br)',namespaces=n)==1
 runs=a.xpath('.//a:r',namespaces=n)
 assert any('开场新标题' in ''.join(r.itertext()) and r.find('a:rPr',n).get('b')=='1' for r in runs)
 assert any('保留斜体' in ''.join(r.itertext()) and r.find('a:rPr',n).get('i')=='1' and r.find('a:rPr/a:solidFill/a:srgbClr',n).get('val')=='123456' for r in runs)
 # Non-body placeholders in notes keep their exact element structure and values.
 b=E.fromstring(before.read('ppt/notesSlides/notesSlide1.xml'));a=E.fromstring(after.read('ppt/notesSlides/notesSlide1.xml'))
 old=b.xpath('.//p:sp[not(p:nvSpPr/p:nvPr/p:ph[@type="body"])]',namespaces=n)
 new=a.xpath('.//p:sp[not(p:nvSpPr/p:nvPr/p:ph[@type="body"])]',namespaces=n)
 assert [E.tostring(x) for x in old]==[E.tostring(x) for x in new]
`, f.source, output]);
  assert.equal(styleCheck.status, 0, styleCheck.stderr);
});

test('adding notes to an existing deck and editing group text keeps every other original part byte-for-byte', t => {
  const f = fixture(t), output = path.join(f.root, '分组与新增备注.pptx');
  const report = apply(f.source, output, [{ slideId: f.ids.second,
    changes: [{ elementId: f.ids.groupElement, text: '分组文字已修改' }], notes: '这一页新建的讲师备注' }]);
  const model = inspect(output), parts = compareParts(f.source, output);
  assert.equal(model.slides[1].notes, '这一页新建的讲师备注');
  assert.equal(model.slides[1].elements[0].text, '分组文字已修改');
  assert.deepEqual(parts.removed, []);
  assert.deepEqual(parts.changed, ['[Content_Types].xml', 'ppt/slides/_rels/slide2.xml.rels', 'ppt/slides/slide2.xml']);
  assert.ok(parts.added.some(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)));
  assert.deepEqual([...parts.changed, ...parts.added].sort(), report.changedParts);
  assert.deepEqual(readFileSync(f.source), f.original);
});

test('adding the first notes master preserves unrelated slide data and creates a valid native deck', t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-first-notes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'no-notes.pptx'), output = path.join(root, 'with-notes.pptx');
  const created = execute(['-c', 'import sys;from pptx import Presentation;p=Presentation();s=p.slides.add_slide(p.slide_layouts[6]);s.shapes.add_textbox(0,0,2000000,1000000).text="原生文字保持";p.save(sys.argv[1])', source]);
  assert.equal(created.status, 0, created.stderr);
  const model = inspect(source);
  apply(source, output, [{ slideId: model.slides[0].id, notes: '首次添加备注\n还有一段' }]);
  const result = inspect(output), parts = compareParts(source, output);
  assert.equal(result.slides[0].notes, '首次添加备注\n还有一段');
  assert.equal(result.slides[0].elements[0].text, '原生文字保持');
  assert.ok(!parts.changed.includes('ppt/slides/slide1.xml'));
  assert.ok(parts.added.some(name => name.startsWith('ppt/notesMasters/')));
  assert.ok(parts.changed.includes('ppt/_rels/presentation.xml.rels'));
  assert.ok(parts.changed.every(name => ['[Content_Types].xml', 'ppt/_rels/presentation.xml.rels', 'ppt/presentation.xml', 'ppt/slides/_rels/slide1.xml.rels'].includes(name)));
  assert.deepEqual(parts.removed, []);
});

test('unchanged text yields an exact byte copy; newlines, empty text and Unicode survive actual PPTX parsing', t => {
  const f = fixture(t), model = inspect(f.source);
  const noChange = path.join(f.root, '相同文字.pptx');
  const report = apply(f.source, noChange, [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: model.slides[0].elements[0].text }], notes: model.slides[0].notes }]);
  assert.equal(report.changed, false); assert.deepEqual(report.changedParts, []);
  assert.deepEqual(readFileSync(noChange), f.original);
  const output = path.join(f.root, '新增段落.pptx');
  apply(f.source, output, [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: '新开场\n\n第二段\t中文与 emoji 🧑‍🏫' }], notes: '' }]);
  assert.equal(inspect(output).slides[0].elements[0].text, '新开场\n\n第二段\t中文与 emoji 🧑‍🏫');
  assert.equal(inspect(output).slides[0].notes, '');
  const empty = path.join(f.root, '清空文字.pptx');
  apply(f.source, empty, [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: '' }] }]);
  assert.equal(inspect(empty).slides[0].elements[0].text, '');
});

test('unknown/duplicate targets, unsafe text, fields and overwrite attempts fail without writing an output', t => {
  const f = fixture(t);
  const patches = [
    [{ slideId: '999999', changes: [] }],
    [{ slideId: f.ids.first, changes: [{ elementId: '999999', text: '错误对象' }] }],
    [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: '含\u0000控制符' }] }],
    [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: '\ud800' }] }],
    [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: 'x'.repeat(50_001) }] }],
    [{ slideId: f.ids.first }, { slideId: f.ids.first }],
    [{ slideId: f.ids.first, changes: [{ elementId: f.ids.firstElement, text: '一' }, { elementId: f.ids.firstElement, text: '二' }] }],
    [{ slideId: f.ids.first, changes: [], position: { x: 1 } }],
    [{ slideId: f.ids.third, changes: [{ elementId: f.ids.fieldElement, text: '不能替换字段' }] }],
  ];
  for (const [index, pages] of patches.entries()) {
    const output = path.join(f.root, `rejected-${index}.pptx`), result = execute([adapter, 'apply', f.source, output], { pages });
    assert.notEqual(result.status, 0, `invalid edit ${index} was accepted`);
    assert.equal(existsSync(output), false);
    assert.ok(result.stderr.trim());
  }
  const same = execute([adapter, 'apply', f.source, f.source], { pages: [{ slideId: f.ids.first }] });
  assert.notEqual(same.status, 0); assert.match(same.stderr, /不能覆盖/);
  const occupied = path.join(f.root, 'occupied.pptx'); writeFileSync(occupied, 'keep-me');
  const exists = execute([adapter, 'apply', f.source, occupied], { pages: [{ slideId: f.ids.first }] });
  assert.notEqual(exists.status, 0); assert.equal(readFileSync(occupied, 'utf8'), 'keep-me');
  assert.equal(sha(readFileSync(f.source)), sha(f.original));
});

test('malformed packages, duplicate native IDs and XML entities are rejected', t => {
  const f = fixture(t);
  const broken = path.join(f.root, 'broken.pptx'); writeFileSync(broken, 'not a zip');
  assert.notEqual(execute([adapter, 'inspect', broken]).status, 0);
  for (const kind of ['duplicate-id', 'entity', 'utf16-entity']) {
    const target = path.join(f.root, `${kind}.pptx`);
    const mutate = execute(['-c', String.raw`
import sys,zipfile
from lxml import etree as E
with zipfile.ZipFile(sys.argv[1]) as before,zipfile.ZipFile(sys.argv[2],'w') as after:
 for entry in before.infolist():
  data=before.read(entry.filename)
  if entry.filename=='ppt/slides/slide3.xml':
   if sys.argv[3]=='entity': data=b'<!DOCTYPE x [<!ENTITY nope SYSTEM "file:///etc/passwd">]>'+data
   elif sys.argv[3]=='utf16-entity': data=('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY nope SYSTEM "file:///etc/passwd">]>'+E.tostring(E.fromstring(data),encoding='unicode')).encode('utf-16')
   else:
    root=E.fromstring(data);n={'p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
    ids=root.xpath('.//p:cNvPr',namespaces=n);ids[2].set('id',ids[1].get('id'));data=E.tostring(root)
  after.writestr(entry,data)
`, f.source, target, kind]);
    assert.equal(mutate.status, 0, mutate.stderr);
    const result = execute([adapter, 'inspect', target]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, kind.includes('entity') ? /实体声明/ : /标识重复/);
  }
});

test('inspect supplies optional inline typography without modifying source bytes or edit policy', t => {
  const f = fixture(t), document = inspect(f.source);
  const title = document.slides[0].elements.find(item => item.id === f.ids.firstElement);
  assert.equal(title.textStyle.fontPoints, 28);
  assert.equal(title.textStyle.fontFamily, 'PingFang SC');
  assert.equal(title.textStyle.bold, true);
  assert.equal(title.editable, true);
  assert.equal(document.slides[2].elements.find(item => item.id === f.ids.fieldElement).editable, false);
  assert.deepEqual(readFileSync(f.source), f.original);
});

test('decorative shapes without a real text body cannot become fake editable targets during inspect', t => {
  const f = fixture(t), source = path.join(f.root, '空背景对象.pptx');
  const made = execute(['-c', String.raw`
import sys
from pptx import Presentation
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.util import Inches,Pt
from pptx.dml.color import RGBColor
p=Presentation();s=p.slides.add_slide(p.slide_layouts[6])
background=s.shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE,0,0,p.slide_width,p.slide_height)
body=background.element.find('{http://schemas.openxmlformats.org/presentationml/2006/main}txBody')
if body is not None: background.element.remove(body)
box=s.shapes.add_textbox(Inches(1),Inches(1),Inches(5),Inches(1))
r=box.text_frame.paragraphs[0].add_run();r.text='实际文字';r.font.size=Pt(24);r.font.color.rgb=RGBColor(0,48,112)
p.save(sys.argv[1])
`, source]);
  assert.equal(made.status, 0, made.stderr); const before = readFileSync(source), model = inspect(source);
  assert.equal(model.slides[0].elements[0].editable, false); assert.equal(model.slides[0].elements[0].text, '');
  const real = model.slides[0].elements.find(item => item.text === '实际文字');
  assert.equal(real.textStyle.color, '#003070'); assert.equal(real.textStyle.margins.length, 4);
  const output = path.join(f.root, '真实改字.pptx');
  apply(source, output, [{ slideId: model.slides[0].id, changes: [{ elementId: real.id, text: '修改后的实际文字' }] }]);
  assert.equal(inspect(output).slides[0].elements.find(item => item.id === real.id).text, '修改后的实际文字');
  assert.deepEqual(readFileSync(source), before);
});
