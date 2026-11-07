"""Strict SVG text/notes adapter. Never executes a project script."""
import base64, json, re, sys
from pathlib import Path
from lxml import etree as E

NS = 'http://www.w3.org/2000/svg'
TAGS = set('svg g defs rect circle ellipse line polyline polygon path text tspan image use symbol clipPath mask linearGradient radialGradient stop pattern title desc'.split())

def check_raster(source):
    from PIL import Image
    import io
    if isinstance(source,bytes): source=io.BytesIO(source)
    with Image.open(source) as image:
        if image.format not in ('PNG','JPEG','WEBP') or image.width*image.height>40000000: raise ValueError('SVG图片格式或像素超过限制')
        image.verify()

def parse(file, project):
    raw = file.read_bytes()
    if len(raw) > 4_000_000 or re.search(br'<!DOCTYPE|<!ENTITY|<\?', re.sub(br'^\s*<\?xml\s+[^?]*\?>', b'', raw, count=1, flags=re.I), re.I):
        raise ValueError('SVG包含实体、处理指令或内容过大')
    root = E.fromstring(raw, E.XMLParser(resolve_entities=False, no_network=True, remove_comments=False))
    if root.tag != '{'+NS+'}svg': raise ValueError('不是SVG页面')
    for node in root.iter():
        if not isinstance(node.tag, str): continue
        q = E.QName(node)
        if q.namespace != NS or q.localname not in TAGS: raise ValueError('SVG不支持的主动内容：'+q.localname)
        for key, value in node.attrib.items():
            name = E.QName(key).localname.lower()
            if name.startswith('on') or name in ('base', 'src') or re.search(r'@import|javascript:|expression\s*\(|\\', value, re.I): raise ValueError('SVG包含不安全属性')
            for match in re.findall(r'url\s*\((.*?)\)', value, re.I):
                if not re.fullmatch(r'[\s\'\"]*#[\w.-]+[\s\'\"]*', match): raise ValueError('SVG不允许外部样式资源')
            if name == 'href' and not value.startswith('#'):
                if q.localname != 'image': raise ValueError('SVG不允许外部链接')
                if value.startswith('data:'):
                    if not re.fullmatch(r'data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+', value): raise ValueError('SVG仅支持栅格图片引用')
                    check_raster(base64.b64decode(value.split(',',1)[1]))
                else:
                    asset = (file.parent / value).resolve()
                    if not asset.is_relative_to(project.resolve()) or not asset.is_file() or asset.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'): raise ValueError('SVG图片超出工程或格式不支持')
                    if asset.stat().st_size > 20_000_000: raise ValueError('SVG图片超过上限')
                    check_raster(asset)
    return root

def objects(root):
    # Paths use child indices, independent of duplicate/absent author IDs.
    result = []
    def visit(node, route):
        if not isinstance(node.tag, str): return
        if E.QName(node).localname in ('text','tspan') and ((node.text and node.text.strip()) or not any(isinstance(c.tag,str) for c in node)):
            result.append((route, node, not any(isinstance(c.tag,str) for c in node)))
        for i, child in enumerate(node): visit(child, route+'-'+str(i))
    visit(root, 'n')
    return result

def page_records(project):
    directory = project/'svg_final'
    if not directory.is_dir(): directory = project/'svg_output'
    manifest=project/'wtt-svg-pages.json'
    if manifest.exists():
        value=json.loads(manifest.read_text()); records=value.get('pages')
        if value.get('version')!=1 or not isinstance(records,list): raise ValueError('SVG页序清单无效')
        ids=set(); filenames=set()
        for record in records:
            if not isinstance(record,dict) or set(record)!=set(('id','file')) or not re.fullmatch(r'[\w-]{1,80}',record['id']) or not re.fullmatch(r'[\w.-]{1,110}\.svg',record['file']) or record['file'].startswith('.'):
                raise ValueError('SVG页面标识无效')
            if record['id'] in ids or record['file'] in filenames or not (directory/record['file']).is_file(): raise ValueError('SVG页序重复或文件不存在')
            ids.add(record['id']);filenames.add(record['file'])
    else: records=[{'id':f.stem,'file':f.name} for f in sorted(directory.glob('*.svg'))]
    if not 1<=len(records)<=200: raise ValueError('SVG页面数量须为1–200')
    return directory,records

def pages(project):
    directory,records=page_records(project)
    return [directory/r['file'] for r in records]

def note_file(project, file, number):
    exact = project/'notes'/(file.stem+'.md')
    if exact.exists(): return exact
    for n in sorted((project/'notes').glob('*.md')):
        match = re.search(r'slide_?(\d+)', n.stem)
        if match and int(match.group(1)) == number: return n
    return exact

def node_ids(root):
    ids=[]
    def visit(node,route):
        if not isinstance(node.tag,str): return
        ids.append(route)
        for index,child in enumerate(node): visit(child,route+'-'+str(index))
    visit(root,'n');return ids

def inspect(project):
    slides = []; size = None
    directory,records=page_records(project)
    for number, record in enumerate(records,1):
        file=directory/record['file']
        root = parse(file, project)
        box = [float(x) for x in root.get('viewBox','').replace(',',' ').split()]
        if len(box)!=4 or box[:2]!=[0,0] or not all(0<x<=20000 for x in box[2:]): raise ValueError('SVG需要有效的零起点viewBox')
        if size and size != box[2:]: raise ValueError('各页SVG尺寸不一致')
        size = box[2:]; elements = []
        for route, node, editable in objects(root):
            elements.append(dict(id=route,name=node.get('id') or '文字',text=node.text or '',editable=editable,reason='' if editable else '复合文字请修改内部文字段',bounds=None))
        nf = note_file(project,file,number)
        slides.append(dict(id=record['id'],sourceFile=file.name,number=number,title=elements[0]['text'][:48] if elements else '无文字页面',elements=elements,objectIds=node_ids(root),notes=nf.read_text() if nf.exists() else '',notesEditable=True))
    return dict(previewModelVersion=2,sourceFormat='svg',svgModelVersion=2,sourceDirectory=directory.name,width=size[0],height=size[1],slides=slides)

def apply(project, updates):
    directory,records=page_records(project)
    indexed = {r['id']:(i,directory/r['file']) for i,r in enumerate(records,1)}
    for page in updates:
        number,file = indexed[page['slideId']]; root = parse(file,project)
        nodes = {route:(node,editable) for route,node,editable in objects(root)}
        for change in page.get('changes',[]):
            node,editable = nodes[change['elementId']]
            if not editable: raise ValueError('复合文字不可整体改写')
            if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',change['text']): raise ValueError('文字包含无效控制字符')
            node.text = change['text']
        if page.get('changes'): file.write_bytes(E.tostring(root,xml_declaration=True,encoding='UTF-8'))
        if 'notes' in page:
            nf=note_file(project,file,number); nf.parent.mkdir(exist_ok=True); nf.write_text(page['notes'])

def preview(project,number,updates):
    directory,records=page_records(project);files=pages(project)
    if not 1<=number<=len(files): raise ValueError('SVG页码超出范围')
    file=files[number-1]; root=parse(file,project)
    changes={x['elementId']:x['text'] for p in updates if p['slideId']==records[number-1]['id'] for x in p.get('changes',[])}
    for route,node,editable in objects(root):
        if route in changes: node.text=changes[route]
    def annotate(node,route):
        if not isinstance(node.tag,str): return
        node.set('data-wtt-svg-id',route)
        for index,child in enumerate(node): annotate(child,route+'-'+str(index))
    annotate(root,'n')
    for node in root.iter():
        if not isinstance(node.tag,str) or E.QName(node).localname!='image': continue
        for key,value in list(node.attrib.items()):
            if E.QName(key).localname=='href' and not value.startswith(('#','data:')):
                asset=(file.parent/value).resolve(); kind='jpeg' if asset.suffix.lower() in ('.jpg','.jpeg') else asset.suffix[1:].lower()
                node.set(key,'data:image/'+kind+';base64,'+base64.b64encode(asset.read_bytes()).decode())
    return E.tostring(root,encoding='unicode')

def revise(project,data):
    directory,records=page_records(project)
    # Freeze aliases before insertion changes numeric positions.
    for number,record in enumerate(records,1):
        file=directory/record['file'];source=note_file(project,file,number);exact=project/'notes'/(file.stem+'.md')
        if source.exists() and source!=exact: exact.parent.mkdir(exist_ok=True);exact.write_bytes(source.read_bytes())
    for op in data['operations']:
        kind=op['type']; identifier=op.get('pageId'); indexed={r['id']:r for r in records}
        if kind in ('replace-page','insert-page'):
            if not re.fullmatch(r'[\w-]{1,80}',identifier): raise ValueError('SVG页面ID无效')
            if kind=='replace-page':
                if identifier not in indexed: raise ValueError('SVG修改页面不存在')
                record=indexed[identifier]
            else:
                if identifier in indexed: raise ValueError('新增SVG页面ID已存在')
                after=op.get('afterId')
                if after is not None and after not in indexed: raise ValueError('新增页位置不存在')
                record={'id':identifier,'file':'wtt_'+identifier+'.svg'}
                if (directory/record['file']).exists(): raise ValueError('新增SVG文件已存在')
                records.insert(0 if after is None else next(i+1 for i,r in enumerate(records) if r['id']==after),record)
            file=directory/record['file'];file.write_text(op['svg']);parse(file,project)
            if 'notes' in op or kind=='insert-page':
                nf=project/'notes'/(file.stem+'.md');nf.parent.mkdir(exist_ok=True);nf.write_text(op.get('notes',''))
        elif kind=='replace-element':
            if identifier not in indexed: raise ValueError('SVG修改页面不存在')
            file=directory/indexed[identifier]['file'];root=parse(file,project)
            route=op['elementId']
            if not re.fullmatch(r'n(?:-\d+)+',route): raise ValueError('SVG所选对象定位无效')
            node=root
            for part in route.split('-')[1:]: node=node[int(part)]
            parent=node.getparent()
            replacement=E.fromstring(op['svgFragment'].encode(),E.XMLParser(resolve_entities=False,no_network=True))
            replacement.tail=node.tail;parent.replace(node,replacement)
            file.write_bytes(E.tostring(root,xml_declaration=True,encoding='UTF-8'));parse(file,project)
        elif kind=='update-notes':
            if identifier not in indexed: raise ValueError('SVG备注页面不存在')
            file=directory/indexed[identifier]['file'];nf=project/'notes'/(file.stem+'.md');nf.parent.mkdir(exist_ok=True);nf.write_text(op['notes'])
        elif kind=='delete-page':
            if identifier not in indexed or len(records)==1: raise ValueError('不能删除不存在的页或最后一页')
            file=directory/indexed[identifier]['file'];file.unlink()
            nf=project/'notes'/(file.stem+'.md')
            if nf.exists():nf.unlink()
            records=[r for r in records if r['id']!=identifier]
        elif kind=='reorder-pages':
            order=op['pageIds']
            if len(order)!=len(records) or set(order)!=set(indexed): raise ValueError('SVG重排必须保留全部页面且不能重复')
            records=[indexed[identifier] for identifier in order]
        else: raise ValueError('未知SVG操作')
    (project/'wtt-svg-pages.json').write_text(json.dumps({'version':1,'pages':records},ensure_ascii=False))
    return inspect(project)

def export_native(project,script,output):
    # Reuse the installed converter with the reviewed revision's actual page order.
    # Old course contracts remain historical evidence, not a false approval of new pages.
    from contextlib import redirect_stdout
    import io
    sys.path.insert(0,str(Path(script).resolve().parent))
    from svg_to_pptx.pptx_builder import create_pptx_with_native_svg
    files=pages(project);notes={file.stem:note_file(project,file,i).read_text() if note_file(project,file,i).exists() else '' for i,file in enumerate(files,1)}
    log=io.StringIO()
    with redirect_stdout(log):
        ok=create_pptx_with_native_svg(files,Path(output),verbose=False,use_native_shapes=True,use_compat_mode=False,notes=notes,enable_notes=True,transition=None)
    if not ok: raise ValueError('SVG原生导出失败：'+log.getvalue()[-3000:])
    return {'ok':True}

if __name__=='__main__':
    try:
        mode=sys.argv[1]; project=Path(sys.argv[2]); data=json.load(sys.stdin) if mode!='inspect' else {}
        if mode=='inspect': result=inspect(project)
        elif mode=='apply': apply(project,data['pages']); result={'ok':True}
        elif mode=='preview': result={'svg':preview(project,data['page'],data['pages'])}
        elif mode=='revise': result=revise(project,data)
        elif mode=='export-native': result=export_native(project,data['script'],data['output'])
        elif mode=='check-image':
            from PIL import Image
            with Image.open(project) as img:
                if img.format not in ('PNG','JPEG','WEBP') or img.width*img.height>40000000: raise ValueError('图片格式或像素超过限制')
                result={'format':img.format,'width':img.width,'height':img.height};img.verify()
        else: raise ValueError('未知SVG操作')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
