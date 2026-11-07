"""Render verified local document snapshots; no network or model access."""
import hashlib
import json
import pathlib
import subprocess
import sys
import os
import tempfile
import fitz

source = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
pdf = source
if source.suffix in ('.docx', '.pptx'):
    sys.path.insert(0, sys.argv[3])
    import render_course_pptx
    office = render_course_pptx.resolve_soffice(None)
    if not office:
        raise ValueError('本机未发现可用 LibreOffice，原 Word 可下载')
    with tempfile.TemporaryDirectory(prefix='wtt-doc-office-') as profile:
        command = [str(office), '-env:UserInstallation=' + pathlib.Path(profile).as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(output), str(source)]
        environment = os.environ.copy()
        environment['FONTCONFIG_FILE'] = sys.argv[4]
        result = subprocess.run(command, capture_output=True, timeout=90, env=environment)
        if result.returncode != 0:
            raise ValueError('Word 实际转换失败：' + result.stderr.decode(errors='replace')[:600])
    pdf = output / (source.stem + '.pdf')
if not pdf.is_file():
    raise ValueError('未取得实际 PDF 预览文件')
pages = []
total_bytes = 0
with fitz.open(pdf) as document:
    if not 1 <= len(document) <= 200:
        raise ValueError('文档预览支持1–200页，原件保留可下载')
    total_pixels = 0
    for index, page in enumerate(document):
        scale = min(1.2, 820 / page.rect.width)
        width, height = int(page.rect.width * scale), int(page.rect.height * scale)
        if width * height > 4_000_000 or total_pixels + width * height > 220_000_000:
            raise ValueError('文档预览像素超过限制，原件保留')
        total_pixels += width * height
        image = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        filename = f'page-{index + 1}.png'
        image.save(output / filename)
        data = (output / filename).read_bytes()
        total_bytes += len(data)
        if total_bytes > 200 * 1024 * 1024:
            raise ValueError('文档预览缓存超过限制')
        pages.append({'number': index + 1, 'file': filename, 'hash': hashlib.sha256(data).hexdigest(), 'width': image.width, 'height': image.height})
manifest = {'version': 1, 'pageCount': len(pages), 'pages': pages, 'renderer': 'local-office-pymupdf-v1'}
(output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False))
print(json.dumps({'pages': len(pages), 'status': 'ready'}))
