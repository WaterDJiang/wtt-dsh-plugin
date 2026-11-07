#!/usr/bin/env python3
"""Read native slide text; patch selected text/notes without rewriting other parts."""
from __future__ import annotations

import copy
import difflib
import io
import json
import math
import os
from pathlib import Path
import posixpath
import re
import sys
import zipfile

from lxml import etree as ET
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
NS = {'p': P, 'a': A, 'r': R}
MAX_TEXT = 50_000
MAX_TOTAL_TEXT = 1_000_000
MAX_PACKAGE = 209_715_200
MAX_EXPANDED = 536_870_912
MAX_XML = 16_777_216
IDENTITY = (1., 0., 0., 1., 0., 0.)


def fail(message):
    raise ValueError(message)


def parse_xml(data):
    if len(data) > MAX_XML or re.search(br'<!\s*(?:DOCTYPE|ENTITY)', data, re.I):
        fail('PPT XML 超过限制或包含不支持的实体声明')
    root = ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True))
    if root.getroottree().docinfo.doctype or root.getroottree().docinfo.internalDTD is not None:
        fail('PPT XML 包含不支持的实体声明')
    return root


def xml_bytes(root):
    return ET.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


class Package:
    def __init__(self, source):
        self.source = Path(source)
        if not self.source.is_file() or not 0 < self.source.stat().st_size <= MAX_PACKAGE:
            fail('PPTX 必须为非空且不超过 200 MiB 的文件')
        self.zip = zipfile.ZipFile(self.source)
        self.entries = self.zip.infolist()
        names = [entry.filename for entry in self.entries]
        if len(names) > 10_000 or len(names) != len(set(names)):
            fail('PPTX 部件数量超过限制或存在重复部件')
        if sum(entry.file_size for entry in self.entries) > MAX_EXPANDED:
            fail('PPTX 解压体积超过限制')
        if any(entry.flag_bits & 1 for entry in self.entries):
            fail('不支持加密的 PPTX 部件')
        for entry in self.entries:
            name = entry.filename
            if name.startswith('/') or '\\' in name or '..' in name.split('/'):
                fail('PPTX 部件路径无效')
            lowered = name.lower()
            if 'vbaproject' in lowered or lowered.startswith('ppt/activex/'):
                fail('不支持包含宏或 ActiveX 的 PPTX')
            if lowered.endswith(('.xml', '.rels')):
                root = parse_xml(self.zip.read(name))
                if lowered.endswith('.rels'):
                    for relation in root:
                        if relation.get('TargetMode', '').lower() == 'external' and not relation.get('Type', '').endswith('/hyperlink'):
                            fail('课件包含不支持的外部资源')
        if self.zip.testzip() is not None:
            fail('PPTX 部件 CRC 校验失败')
        self.presentation = Presentation(str(self.source))
        if not 1 <= len(self.presentation.slides) <= 200:
            fail('PPTX 页数须为 1–200 页')
        self.width = int(self.presentation.slide_width)
        self.height = int(self.presentation.slide_height)
        if self.width <= 0 or self.height <= 0:
            fail('PPTX 页面尺寸无效')
        self.slides = {}
        self.total_text = 0
        for number, slide in enumerate(self.presentation.slides, 1):
            slide_id = str(slide.slide_id)
            if slide_id in self.slides:
                fail('PPTX 页面标识重复')
            part = str(slide.part.partname).lstrip('/')
            root = parse_xml(self.zip.read(part))
            shapes = {}
            elements = []
            self.walk_shapes(slide.shapes, IDENTITY, shapes, elements)
            notes = ''
            notes_part = None
            notes_body_id = None
            notes_editable = True
            if slide.has_notes_slide:
                notes_slide = slide.notes_slide
                notes_part = str(notes_slide.part.partname).lstrip('/')
                notes_root = parse_xml(self.zip.read(notes_part))
                bodies = notes_root.xpath('.//p:sp[p:nvSpPr/p:nvPr/p:ph[@type="body"]]', namespaces=NS)
                if len(bodies) > 1:
                    fail('备注中存在重复正文占位符')
                if bodies:
                    body = bodies[0].find('p:txBody', NS)
                    notes_body_id = bodies[0].find('p:nvSpPr/p:cNvPr', NS).get('id')
                    notes = body_text(body)
                    notes_editable = editable_body(body)
                else:
                    notes_editable = False
            self.total_text += len(notes)
            self.slides[slide_id] = {
                'id': slide_id, 'number': number, 'slide': slide, 'part': part, 'root': root,
                'shapes': shapes, 'elements': elements, 'notes': notes,
                'notesPart': notes_part, 'notesBodyId': notes_body_id, 'notesEditable': notes_editable,
            }
        if self.total_text > MAX_TOTAL_TEXT:
            fail('PPTX 可编辑文字总量超过限制')

    def walk_shapes(self, shapes, matrix, seen, elements, hidden=False):
        for shape in shapes:
            element_id = str(shape.shape_id)
            if element_id in seen:
                fail('PPTX 同页原生对象标识重复')
            seen[element_id] = shape
            if len(seen) > 20_000:
                fail('PPTX 单页对象数量超过限制')
            properties = shape.element.find('p:nvSpPr/p:cNvPr', NS)
            if properties is None:
                properties = next(iter(shape.element.xpath('./*[starts-with(local-name(),"nv")]/*[local-name()="cNvPr"]')), None)
            is_hidden = hidden or properties is not None and properties.get('hidden', '').lower() in ('1', 'true')
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                self.walk_shapes(shape.shapes, multiply(matrix, group_matrix(shape)), seen, elements, is_hidden)
                continue
            has_text = shape.has_text_frame
            has_table = getattr(shape, 'has_table', False)
            if not has_text and not has_table:
                continue
            # Accessing text_frame creates a body for some decorative shapes.
            # Inspect the real XML first; a getter must not invent an edit target.
            body = shape.element.find('p:txBody', NS) if has_text else None
            text = (body_text(body) if body is not None else '') if has_text else '\n'.join('\t'.join(cell.text for cell in row.cells) for row in shape.table.rows)
            if len(text) > MAX_TEXT:
                fail('PPTX 单个文字对象超过 50000 字')
            self.total_text += len(text)
            editable = has_text and editable_body(body) and not is_hidden
            reason = None if editable else ('隐藏对象暂不编辑' if is_hidden else '此形状没有原生文字正文' if has_text and body is None else '动态字段或复杂文字结构暂不编辑' if has_text else '首版暂不编辑表格单元格')
            bounds = shape_bounds(shape, matrix)
            element = {'id': element_id, 'name': shape.name, 'type': 'text', 'text': text,
                       'bounds': bounds, 'rotation': float(shape.rotation), 'editable': bool(editable)}
            if has_text and body is not None:
                paragraphs = shape.text_frame.paragraphs
                paragraph = next((p for p in paragraphs if p.text.strip()), paragraphs[0])
                run = next(iter(paragraph.runs), None)
                font = run.font if run is not None else paragraph.font
                size = font.size or paragraph.font.size
                scale = bounds['height'] / float(shape.height) if shape.height else 1
                scale_x = bounds['width'] / float(shape.width) if shape.width else 1
                def rgb(color):
                    try:
                        return '#' + str(color.rgb) if color.type == 1 else None
                    except (AttributeError, ValueError):
                        return None
                foreground = rgb(font.color) or rgb(paragraph.font.color)
                background = rgb(shape.fill.fore_color) if shape.fill.type == 1 else None
                frame = shape.text_frame
                element['textStyle'] = {
                    'fontPoints': float(size.pt) * scale if size else None,
                    'fontFamily': font.name or paragraph.font.name,
                    'bold': bool(font.bold if font.bold is not None else paragraph.font.bold),
                    'italic': bool(font.italic if font.italic is not None else paragraph.font.italic),
                    'align': {1: 'left', 2: 'center', 3: 'right', 4: 'justify'}.get(paragraph.alignment, 'left'),
                    'color': foreground,
                    'backgroundColor': background,
                    'margins': [float(frame.margin_top) * scale, float(frame.margin_right) * scale_x,
                                float(frame.margin_bottom) * scale, float(frame.margin_left) * scale_x],
                }
            if reason:
                element['reason'] = reason
            elements.append(element)

    def model(self):
        slides = []
        for page in self.slides.values():
            title_shape = page['slide'].shapes.title
            title = title_shape.text.replace('\v', '\n') if title_shape is not None else ''
            if not title.strip():
                first_note = page['notes'].strip().split('\n')[0] if page['notes'].strip() else ''
                import re
                note_title = re.sub(r'^(?:P\d+|第\s*\d+\s*页)\s*[｜|:：]\s*', '', first_note)
                candidates = [e for e in page['elements'] if e.get('text', '').strip() and not re.fullmatch(r'[\d\s/／]+', e['text'].strip())]
                title = note_title[:80] if note_title != first_note and note_title else candidates[0]['text'].replace('\n', ' ')[:80] if candidates else '无文字页面'
            slides.append({'id': page['id'], 'number': page['number'], 'title': title,
                           'notes': page['notes'], 'notesEditable': page['notesEditable'],
                           'elements': page['elements']})
        return {'width': self.width, 'height': self.height, 'slides': slides, 'previewModelVersion': 2}


def multiply(left, right):
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return (a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f)


def translate(x, y):
    return (1., 0., 0., 1., float(x), float(y))


def rotate(angle):
    theta = math.radians(angle)
    return (math.cos(theta), math.sin(theta), -math.sin(theta), math.cos(theta), 0., 0.)


def group_matrix(shape):
    transform = shape.element.find('p:grpSpPr/a:xfrm', NS)
    if transform is None:
        return IDENTITY
    def pair(name, first, second, default):
        node = transform.find('a:' + name, NS)
        return (float(node.get(first, default[0])), float(node.get(second, default[1]))) if node is not None else default
    off = pair('off', 'x', 'y', (0., 0.))
    ext = pair('ext', 'cx', 'cy', (1., 1.))
    child_off = pair('chOff', 'x', 'y', (0., 0.))
    child_ext = pair('chExt', 'cx', 'cy', ext)
    if child_ext[0] == 0 or child_ext[1] == 0:
        return translate(*off)
    sx, sy = ext[0]/child_ext[0], ext[1]/child_ext[1]
    flip_x = -1 if transform.get('flipH', '').lower() in ('1', 'true') else 1
    flip_y = -1 if transform.get('flipV', '').lower() in ('1', 'true') else 1
    result = translate(off[0]+ext[0]/2, off[1]+ext[1]/2)
    result = multiply(result, rotate(float(transform.get('rot', '0'))/60000))
    result = multiply(result, (sx*flip_x, 0., 0., sy*flip_y, 0., 0.))
    return multiply(result, translate(-child_off[0]-child_ext[0]/2, -child_off[1]-child_ext[1]/2))


def shape_bounds(shape, parent):
    x, y = float(shape.left or 0), float(shape.top or 0)
    width, height = float(shape.width or 0), float(shape.height or 0)
    matrix = multiply(parent, translate(x+width/2, y+height/2))
    matrix = multiply(matrix, rotate(float(shape.rotation)))
    points = []
    a, b, c, d, e, f = matrix
    for px, py in ((-width/2, -height/2), (width/2, -height/2), (width/2, height/2), (-width/2, height/2)):
        points.append((a*px+c*py+e, b*px+d*py+f))
    return {'x': round(min(p[0] for p in points)), 'y': round(min(p[1] for p in points)),
            'width': round(max(p[0] for p in points)-min(p[0] for p in points)),
            'height': round(max(p[1] for p in points)-min(p[1] for p in points))}


def body_text(body):
    if body is None:
        return ''
    paragraphs = []
    for paragraph in body.findall('a:p', NS):
        pieces = []
        for child in paragraph:
            if child.tag in ('{'+A+'}r', '{'+A+'}fld'):
                text = child.find('a:t', NS)
                pieces.append(text.text or '' if text is not None else '')
            elif child.tag == '{'+A+'}br':
                pieces.append('\n')
        paragraphs.append(''.join(pieces))
    return '\n'.join(paragraphs)


def editable_body(body):
    if body is None or any(body.iter('{'+A+'}fld')):
        return False
    allowed = {'pPr', 'r', 'br', 'endParaRPr', 'extLst'}
    for paragraph in body.findall('a:p', NS):
        if any(ET.QName(child).localname not in allowed for child in paragraph):
            return False
    return True


def valid_text(value, label):
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        fail(label + '须为不超过 50000 字的文本')
    if any(ord(char) < 32 and char not in ('\n', '\t') or 0xD800 <= ord(char) <= 0xDFFF or ord(char) in (0xFFFE, 0xFFFF) for char in value):
        fail(label + '包含不支持的控制字符')
    return value


def body_tokens(body):
    paragraphs = body.findall('a:p', NS)
    tokens = []
    for index, paragraph in enumerate(paragraphs):
        for child in paragraph:
            if child.tag == '{'+A+'}r':
                text = child.find('a:t', NS)
                style = child.find('a:rPr', NS)
                for char in (text.text or '' if text is not None else ''):
                    tokens.append((char, style, index, 'text'))
            elif child.tag == '{'+A+'}br':
                tokens.append(('\n', child.find('a:rPr', NS), index, 'soft'))
        if index < len(paragraphs)-1:
            tokens.append(('\n', None, index, 'paragraph'))
    return paragraphs, tokens


def replace_body(body, value):
    if body_text(body) == value:
        return False
    if not editable_body(body):
        fail('此文字包含动态字段或不支持的复杂结构，不能安全替换')
    paragraphs, old = body_tokens(body)
    if not paragraphs:
        fail('文字正文缺少段落')
    old_text = ''.join(token[0] for token in old)
    new = []
    for operation, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old_text, value).get_opcodes():
        if operation == 'equal':
            new.extend(old[i1:i2])
        elif operation in ('replace', 'insert'):
            anchor = next((old[k] for k in range(i1, min(i2, len(old))) if old[k][3] == 'text'), None)
            if anchor is None:
                anchor = next((old[k] for k in range(min(i1-1, len(old)-1), -1, -1) if old[k][3] == 'text'), None)
            if anchor is None:
                anchor = next((token for token in old if token[3] == 'text'), ('', None, 0, 'text'))
            for char in value[j1:j2]:
                new.append((char, anchor[1], anchor[2], 'paragraph' if char == '\n' else 'text'))
    chunks = [[]]
    paragraph_indices = [new[0][2] if new else 0]
    for token in new:
        if token[3] == 'paragraph':
            chunks.append([])
            paragraph_indices.append(min(token[2]+1, len(paragraphs)-1))
        else:
            chunks[-1].append(token)
    for paragraph in paragraphs:
        body.remove(paragraph)
    for index, tokens in zip(paragraph_indices, chunks):
        paragraph = copy.deepcopy(paragraphs[min(index, len(paragraphs)-1)])
        for child in list(paragraph):
            if child.tag in ('{'+A+'}r', '{'+A+'}br', '{'+A+'}fld'):
                paragraph.remove(child)
        insertion = 1 if paragraph.find('a:pPr', NS) is not None else 0
        current = None
        current_style = None
        for char, style, _, kind in tokens:
            style_key = ET.tostring(style) if style is not None else None
            if kind == 'soft':
                br = ET.Element('{'+A+'}br')
                if style is not None:
                    br.append(copy.deepcopy(style))
                paragraph.insert(insertion, br)
                insertion += 1
                current = None
            else:
                if current is None or current_style != style_key:
                    run = ET.Element('{'+A+'}r')
                    if style is not None:
                        run.append(copy.deepcopy(style))
                    current = ET.SubElement(run, '{'+A+'}t')
                    current.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                    current.text = ''
                    paragraph.insert(insertion, run)
                    insertion += 1
                    current_style = style_key
                current.text += char
        body.append(paragraph)
    return True


def notes_body(root):
    bodies = root.xpath('.//p:sp[p:nvSpPr/p:nvPr/p:ph[@type="body"]]/p:txBody', namespaces=NS)
    if len(bodies) != 1:
        fail('备注缺少唯一正文占位符')
    return bodies[0]


def relation_part(part):
    return posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part)+'.rels')


def merge_children(original, generated, key):
    root = parse_xml(original)
    known = {key(child) for child in root}
    changed = False
    for child in parse_xml(generated):
        if key(child) not in known:
            root.append(copy.deepcopy(child))
            known.add(key(child))
            changed = True
    return xml_bytes(root) if changed else original


def create_notes(package, requests, updates):
    for page, value in requests:
        frame = page['slide'].notes_slide.notes_text_frame
        if frame is None:
            fail('无法创建讲师备注正文')
        frame.text = value
    memory = io.BytesIO()
    package.presentation.save(memory)
    generated = zipfile.ZipFile(memory)
    original_names = set(package.zip.namelist())
    new_names = set(generated.namelist()) - original_names
    for name in new_names:
        if not (name.startswith(('ppt/notesSlides/', 'ppt/notesMasters/', 'ppt/theme/'))):
            fail('新增备注产生了预期外的部件：'+name)
        updates[name] = generated.read(name)
    for page, _ in requests:
        name = relation_part(page['part'])
        if name in original_names:
            updates[name] = merge_children(package.zip.read(name), generated.read(name), lambda child: child.get('Id'))
        else:
            updates[name] = generated.read(name)
    for name, key in (('[Content_Types].xml', lambda child: (child.tag, child.get('PartName'), child.get('Extension'))),
                      ('ppt/_rels/presentation.xml.rels', lambda child: child.get('Id'))):
        updates[name] = merge_children(package.zip.read(name), generated.read(name), key)
    original = parse_xml(package.zip.read('ppt/presentation.xml'))
    result = parse_xml(generated.read('ppt/presentation.xml'))
    if original.find('p:notesMasterIdLst', NS) is None:
        added = result.find('p:notesMasterIdLst', NS)
        if added is not None:
            preceding = {child.tag for child in list(result)[:list(result).index(added)]}
            position = sum(child.tag in preceding for child in original)
            original.insert(position, copy.deepcopy(added))
            updates['ppt/presentation.xml'] = xml_bytes(original)


def apply(package, output, patch):
    if not isinstance(patch, dict) or set(patch) != {'pages'} or not isinstance(patch['pages'], list) or not 1 <= len(patch['pages']) <= 200:
        fail('修改须包含 1–200 页的 pages 数组')
    output = Path(output).absolute()
    if output.resolve() == package.source.resolve() or output.exists() or output.is_symlink():
        fail('输出必须为新的文件路径，不能覆盖原文件或已有文件')
    updates = {}
    seen_pages = set()
    new_notes = []
    count = 0
    for request in patch['pages']:
        if not isinstance(request, dict) or not set(request).issubset({'slideId', 'changes', 'notes'}) or 'slideId' not in request:
            fail('页面修改字段无效')
        slide_id = request['slideId']
        if not isinstance(slide_id, str) or slide_id not in package.slides or slide_id in seen_pages:
            fail('页面不存在或重复')
        seen_pages.add(slide_id)
        page = package.slides[slide_id]
        changes = request.get('changes', [])
        if not isinstance(changes, list) or len(changes) > 2000:
            fail('文字修改数量无效')
        seen_elements = set()
        changed_slide = False
        element_models = {element['id']: element for element in page['elements']}
        for change in changes:
            if not isinstance(change, dict) or set(change) != {'elementId', 'text'}:
                fail('文字修改只接受 elementId 与 text')
            element_id = change['elementId']
            if not isinstance(element_id, str) or element_id in seen_elements or element_id not in element_models:
                fail('文字对象不存在或重复')
            seen_elements.add(element_id)
            model = element_models[element_id]
            if not model['editable']:
                fail(model.get('reason', '文字对象不可编辑'))
            value = valid_text(change['text'], '页面文字')
            count += len(value)
            shapes = page['root'].xpath('.//p:sp[p:nvSpPr/p:cNvPr[@id=$id]]', namespaces=NS, id=element_id)
            if len(shapes) != 1:
                fail('目标文字对象无法唯一定位')
            body = shapes[0].find('p:txBody', NS)
            changed_slide = replace_body(body, value) or changed_slide
        if changed_slide:
            updates[page['part']] = xml_bytes(page['root'])
        if 'notes' in request:
            value = valid_text(request['notes'], '讲师备注')
            count += len(value)
            if not page['notesEditable']:
                fail('此备注包含不支持的正文结构，不能安全编辑')
            if value != page['notes']:
                if page['notesPart'] is None:
                    new_notes.append((page, value))
                else:
                    root = parse_xml(package.zip.read(page['notesPart']))
                    if replace_body(notes_body(root), value):
                        updates[page['notesPart']] = xml_bytes(root)
    if count > MAX_TOTAL_TEXT:
        fail('本次修改文字总量超过限制')
    if new_notes:
        create_notes(package, new_notes, updates)
    updates = {name: data for name, data in updates.items() if name not in package.zip.namelist() or data != package.zip.read(name)}
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, 'w') as result:
        for entry in package.entries:
            result.writestr(copy.copy(entry), updates.get(entry.filename, package.zip.read(entry.filename)))
        for name in sorted(set(updates) - set(package.zip.namelist())):
            result.writestr(name, updates[name], compress_type=zipfile.ZIP_DEFLATED)
    data = memory.getvalue() if updates else package.source.read_bytes()
    if len(data) > MAX_PACKAGE:
        fail('修改后的 PPTX 超过 200 MiB')
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as destination:
            destination.write(data)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return {'changedParts': sorted(updates), 'changed': bool(updates), 'pageCount': len(package.slides)}


def main():
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ('inspect', 'apply'):
        fail('用法：ppt-editor.py inspect <source> | apply <source> <new-output>')
    command = sys.argv[1]
    if command == 'inspect' and len(sys.argv) != 3 or command == 'apply' and len(sys.argv) != 4:
        fail('PPT 编辑命令参数无效')
    package = Package(sys.argv[2])
    if command == 'inspect':
        value = package.model()
    else:
        raw = sys.stdin.buffer.read(1_500_001)
        if len(raw) > 1_500_000:
            fail('修改请求超过大小限制')
        value = apply(package, sys.argv[3], json.loads(raw))
    print(json.dumps(value, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
