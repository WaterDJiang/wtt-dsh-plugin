"""Bounded local document adapter: CSV grid, OOXML text patches, PDF annotations."""
import csv, difflib, io, json, pathlib, re, sys, zipfile
from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
def tag(name): return '{' + W + '}' + name
def checked_text(value):
    if not isinstance(value, str) or '\0' in value or len(value) > 1000000: raise ValueError('文字长度或格式无效')
    return value

def grid(rows):
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], list) or not rows[0]: raise ValueError('表格至少保留一行一列')
    width = len(rows[0])
    if len(rows)*width > 10000 or any(not isinstance(r,list) or len(r)!=width for r in rows): raise ValueError('表格需为矩形且不超过10000个单元格')
    for row in rows:
        for cell in row: checked_text(cell)
    if len(json.dumps(rows,ensure_ascii=False).encode()) > 1048576: raise ValueError('表格文字超过1MB')
    return rows

def word(source):
    with zipfile.ZipFile(source) as z:
        entries=z.infolist()
        if len(entries)>10000 or sum(e.file_size for e in entries)>536870912 or any(e.file_size>52428800 for e in entries if e.filename.endswith('.xml')): raise ValueError('Word文件超过解析上限')
        xml=z.read('word/document.xml')
    parser=ET.XMLParser(resolve_entities=False,no_network=True,remove_blank_text=False)
    if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml: raise ValueError('Word不支持DTD或实体')
    root=ET.fromstring(xml,parser)
    paragraphs=root.findall('.//w:body//w:p',NS)
    objects=[]
    for i,p in enumerate(paragraphs):
        value=''.join((n.text or '') if n.tag==tag('t') else '\n' if n.tag==tag('br') else '\t' for n in p.xpath('.//w:t|.//w:br|.//w:tab',namespaces=NS))
        unsafe=bool(p.xpath('.//w:fldChar|.//w:fldSimple|.//w:instrText|.//w:del|.//w:ins|.//w:drawing|.//w:object|.//w:hyperlink|.//w:sdt|.//w:sym',namespaces=NS))
        ancestor=p.getparent()
        while ancestor is not None:
            if ancestor.tag in [tag('sdt'),tag('ins'),tag('del')]: unsafe=True
            ancestor=ancestor.getparent()
        objects.append({'id':str(i),'text':value,'editable':not unsafe,'style':p.xpath('string(w:pPr/w:pStyle/@w:val)',namespaces=NS),'inTable':any(a.tag==tag('tc') for a in p.iterancestors())})
    if sum(len(o['text']) for o in objects)>1000000: raise ValueError('Word正文超过1MB编辑上限')
    by_element={p:str(i) for i,p in enumerate(paragraphs)}
    blocks=[]
    for child in root.find('w:body',NS):
        if child.tag==tag('p'): blocks.append({'type':'paragraph','ids':[by_element[child]]})
        elif child.tag==tag('tbl'):
            rows=[]
            for tr in child.findall('w:tr',NS):
                rows.append([[by_element[p] for p in tc.findall('.//w:p',NS)] for tc in tr.findall('w:tc',NS)])
            blocks.append({'type':'table','rows':rows})
        elif child.findall('.//w:p',NS): blocks.append({'type':'readonly','ids':[by_element[p] for p in child.findall('.//w:p',NS)]})
    return root,paragraphs,{'format':'docx','objects':objects,'blocks':blocks}

def pdf_model(source):
    import fitz
    with fitz.open(source) as doc:
        if doc.is_encrypted or not 1<=len(doc)<=200: raise ValueError('PDF需未加密且在1至200页之间')
        pages=[]; length=0
        for pi,p in enumerate(doc):
            lines=[]
            for b in p.get_text('rawdict')['blocks']:
                for line in b.get('lines',[]):
                    chars=[c for s in line.get('spans',[]) for c in s.get('chars',[])]
                    if not chars: continue
                    text=''.join(c['c'] for c in chars);length+=len(text)
                    rect=fitz.Rect(line['bbox'])*p.rotation_matrix
                    lines.append({'id':str(len(lines)),'text':text,'rect':[rect.x0/p.rect.width,rect.y0/p.rect.height,rect.width/p.rect.width,rect.height/p.rect.height], 'chars':[{'text':c['c'],'rect':list(c['bbox'])} for c in chars]})
            pages.append({'number':pi+1,'width':p.rect.width,'height':p.rect.height,'rotation':p.rotation,'lines':lines})
        if length>1000000: raise ValueError('PDF可选择正文超过1MB编辑上限')
        return {'format':'pdf','pages':pages}

def inspect(source):
    ext=source.suffix.lower()
    if ext=='.csv':
        raw=source.read_bytes();text=raw.decode('utf-8-sig')
        if '\0' in text or len(raw)>1048576: raise ValueError('CSV需为1MB以内UTF-8文本')
        try: delimiter=csv.Sniffer().sniff(text[:8192],delimiters=',;\t').delimiter
        except csv.Error: delimiter=','
        rows=grid(list(csv.reader(io.StringIO(text,newline=''),delimiter=delimiter,strict=True)))
        return {'format':'csv','rows':rows,'delimiter':delimiter,'bom':raw.startswith(b'\xef\xbb\xbf'),'newline':'\r\n' if '\r\n' in text else '\n'}
    if ext=='.docx': return word(source)[2]
    if ext=='.pdf': return pdf_model(source)
    raise ValueError('首轮支持CSV、DOCX和PDF；旧DOC请先另存DOCX')

def patch_paragraph(p,new):
    nodes=p.xpath('.//w:t|.//w:br|.//w:tab',namespaces=NS)
    values=[(n.text or '') if n.tag==tag('t') else '\n' if n.tag==tag('br') else '\t' for n in nodes]
    old=''.join(values)
    if new==old: return
    if not nodes:
        run=ET.SubElement(p,tag('r'));nodes=[ET.SubElement(run,tag('t'))];values=['']
    owners=[i for i,value in enumerate(values) for _ in value]
    out=['' for _ in nodes]
    for op,a,b,c,d in difflib.SequenceMatcher(None,old,new,autojunk=False).get_opcodes():
        if op=='equal':
            for offset,ch in enumerate(new[c:d]): out[owners[a+offset]]+=ch
        elif op in ('insert','replace'):
            owner=owners[min(a,len(owners)-1)] if owners else 0
            out[owner]+=new[c:d]
    for t,text,previous in zip(nodes,out,values):
        if text==previous: continue
        parent=t.getparent();position=parent.index(t);parent.remove(t)
        for part in re.split('(\n|\t)',text):
            if not part: continue
            extra=ET.Element(tag('br' if part=='\n' else 'tab' if part=='\t' else 't'))
            if part not in ('\n','\t'):
                if t.tag==tag('t'): extra.attrib.update(t.attrib)
                extra.text=part;extra.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
            parent.insert(position,extra);position+=1


def apply(source,target,patch):
    if target.exists() or target.is_symlink(): raise ValueError('文档输出已存在，未覆盖')
    model=inspect(source)
    if model['format']=='csv':
        out=io.StringIO(newline='');writer=csv.writer(out,delimiter=model['delimiter'],lineterminator=model['newline']);writer.writerows(grid(patch['rows']))
        data=out.getvalue().encode('utf-8-sig' if model['bom'] else 'utf-8');target.write_bytes(data)
    elif model['format']=='docx':
        root,paragraphs,model=word(source)
        changes=patch.get('changes',{});objects={o['id']:o for o in model['objects']}
        if not isinstance(changes,dict): raise ValueError('Word修改格式无效')
        for key,value in changes.items():
            if key not in objects or not objects[key]['editable']: raise ValueError('Word对象不存在或含复杂内容，只读')
            patch_paragraph(paragraphs[int(key)],checked_text(value))
        xml=ET.tostring(root,encoding='UTF-8',xml_declaration=True,standalone=True)
        with zipfile.ZipFile(source) as old,zipfile.ZipFile(target,'w') as new:
            for info in old.infolist(): new.writestr(info,xml if info.filename=='word/document.xml' else old.read(info.filename))
    else:
        import fitz
        notes=patch.get('annotations',[])
        if not isinstance(notes,list) or len(notes)>500: raise ValueError('PDF批注最多500条')
        with fitz.open(source) as doc:
            for i,a in enumerate(notes):
                if not isinstance(a,dict) or a.get('type') not in ('note','highlight'): raise ValueError('PDF批注类型无效')
                pi=a.get('page')
                if not isinstance(pi,int) or not 1<=pi<=len(doc): raise ValueError('PDF批注页码无效')
                page=doc[pi-1];note=checked_text(a.get('note',''));line=None
                if a.get('lineId') is not None:
                    line=next((x for x in model['pages'][pi-1]['lines'] if x['id']==a['lineId']),None)
                    start,end=a.get('start'),a.get('end')
                    if not line or not isinstance(start,int) or not isinstance(end,int) or not 0<=start<end<=len(line['chars']): raise ValueError('PDF文字范围无效')
                    if a.get('quote')!=''.join(c['text'] for c in line['chars'][start:end]): raise ValueError('PDF选中文字与范围不一致')
                if a['type']=='highlight':
                    if not line: raise ValueError('高亮需要选择准确文字')
                    rectangles=[fitz.Rect(c['rect']) for c in line['chars'][a['start']:a['end']]]
                    annot=page.add_highlight_annot([fitz.Quad(r.tl,r.tr,r.bl,r.br) for r in rectangles])
                else:
                    pos=(line['chars'][a['start']]['rect'][:2] if line else [24,24+(i%20)*18]);annot=page.add_text_annot(pos,note or a.get('quote','页面批注'))
                annot.set_info(content=note or a.get('quote',''),title='WTT 创作工作台');annot.update()
            doc.save(target)
    return {'format':model['format'],'bytes':target.stat().st_size}

if __name__=='__main__':
    action=sys.argv[1];source=pathlib.Path(sys.argv[2])
    if action=='inspect': result=inspect(source)
    elif action=='apply': result=apply(source,pathlib.Path(sys.argv[3]),json.load(sys.stdin))
    elif action=='apply-file': result=apply(source,pathlib.Path(sys.argv[3]),json.loads(pathlib.Path(sys.argv[4]).read_text()))
    else: raise ValueError('未知文档操作')
    print(json.dumps(result,ensure_ascii=False))
