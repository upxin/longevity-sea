#!/usr/bin/env python3
"""Build an offline reader from the EPUB / TXT books already in ../.

No downloads or third-party dependencies. Source books are never modified.
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
STORY = HERE.parent
DATA = HERE / 'books'
IMAGES = HERE / 'images'
NCX = {'n': 'http://www.daisy.org/z3986/2005/ncx/'}


def compact(text):
    return re.sub(r'\s+', ' ', text).strip()


class Page(HTMLParser):
    """Read text and supplied illustrations without executing EPUB markup."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.parts = []
        self.in_body = False
        self.skip = 0
        self.kind = 'p'

    def flush(self):
        text = compact(''.join(self.parts))
        if text and text not in {'返回主目录', '返回目录', '返回主页'}:
            self.blocks.append({'type': self.kind, 'text': text})
        self.parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'body':
            self.in_body = True
        if not self.in_body:
            return
        if tag in {'script', 'style'}:
            self.skip += 1
        if self.skip:
            return
        if tag in {'p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}:
            self.flush()
            self.kind = 'heading' if tag.startswith('h') else 'p'
        elif tag == 'br':
            self.flush()
        elif tag == 'img' and attrs.get('src'):
            self.flush()
            self.blocks.append({'type': 'image', 'src': attrs['src'], 'alt': attrs.get('alt', '原书插图')})

    def handle_endtag(self, tag):
        if tag in {'script', 'style'}:
            self.skip = max(0, self.skip - 1)
        if tag in {'body', 'p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}:
            self.flush()
        if tag == 'body':
            self.in_body = False

    def handle_data(self, data):
        if self.in_body and not self.skip:
            self.parts.append(data)


class Epub:
    def __init__(self, path):
        self.path = path
        self.zip = ZipFile(path)
        root = ET.fromstring(self.zip.read('META-INF/container.xml'))
        opf = next(x.attrib['full-path'] for x in root.iter() if x.tag.endswith('}rootfile'))
        base = posixpath.dirname(opf)
        package = ET.fromstring(self.zip.read(opf))
        manifest = {x.attrib['id']: x.attrib for x in package.iter() if x.tag.endswith('}item')}
        self.spine = [posixpath.normpath(posixpath.join(base, unquote(manifest[x.attrib['idref']]['href'])))
                      for x in package.iter() if x.tag.endswith('}itemref')]
        ncx = next(x for x in manifest.values() if x.get('media-type') == 'application/x-dtbncx+xml')
        ncx_path = posixpath.normpath(posixpath.join(base, ncx['href']))
        self.nav_base = posixpath.dirname(ncx_path)
        self.nav = ET.fromstring(self.zip.read(ncx_path)).find('n:navMap', NCX)
        self.nodes = list(self.nav.iter(f"{{{NCX['n']}}}navPoint"))
        self.positions = {self.source(x): self.spine.index(self.source(x)) for x in self.nodes}
        self.covered = set()

    @staticmethod
    def label(node):
        return compact(node.find('n:navLabel/n:text', NCX).text or '')

    def source(self, node):
        href = node.find('n:content', NCX).get('src').split('#')[0]
        return posixpath.normpath(posixpath.join(self.nav_base, unquote(href)))

    def blocks(self, node):
        start = self.positions[self.source(node)]
        end = min((p for p in self.positions.values() if p > start), default=len(self.spine))
        result = []
        for source in self.spine[start:end]:
            self.covered.add(source)
            page = Page()
            page.feed(self.zip.read(source).decode('utf-8-sig'))
            page.flush()
            for block in page.blocks:
                if block['type'] == 'image':
                    resource = posixpath.normpath(posixpath.join(posixpath.dirname(source), unquote(block['src'])))
                    blob = self.zip.read(resource)
                    suffix = Path(resource).suffix.lower()
                    filename = hashlib.sha256(blob).hexdigest()[:20] + suffix
                    (IMAGES / filename).write_bytes(blob)
                    block['src'] = f'images/{filename}'
                result.append(block)
        return result

    def close(self):
        self.zip.close()


def chapter(title, blocks, source, section=''):
    # The UI supplies the chapter title; remove only an identical first heading.
    if blocks and blocks[0].get('text') == title:
        blocks = blocks[1:]
    return {'title': title, 'section': section, 'blocks': blocks, 'source': source,
            'characters': sum(len(re.findall(r'[\u3400-\u9fffA-Za-z0-9]', b.get('text', ''))) for b in blocks)}


def read_jiuzhou(path):
    epub = Epub(path)
    books = []
    names = ['蛮荒', '苍云古齿', '天下名将', '辰月之征', '一生之盟', '豹魂']
    for volume in epub.nav:
        if not epub.label(volume).startswith('卷'):
            continue
        index = len(books)
        book = {'id': f'jiuzhou-{index + 1}', 'series': '九州缥缈录', 'title': f'九州缥缈录 {index + 1} · {names[index]}',
                'author': '江南', 'source': str(path.relative_to(STORY)), 'chapters': []}
        appendices = []
        for group in volume.findall('n:navPoint', NCX):
            descendants = group.findall('n:navPoint', NCX)
            group_title = epub.label(group)
            if descendants:
                # Keep any epigraph before the first subsection, but not a duplicate title.
                prefix = epub.blocks(group)
                labels = {group_title, *(epub.label(x) for x in descendants)}
                prefix = [b for b in prefix if b.get('text') not in labels]
                if any('本书由微信公众号' in b.get('text', '') for b in prefix):
                    appendices.append(chapter('原书附页', prefix, epub.source(group)))
                    prefix = []
                for i, section in enumerate(descendants):
                    title = epub.label(section)
                    blocks = epub.blocks(section)
                    item = chapter(title, blocks, epub.source(section), group_title)
                    if i == 0 and prefix:
                        item = chapter(title, prefix + item['blocks'], epub.source(section), group_title)
                    book['chapters'].append(item)
            else:
                book['chapters'].append(chapter(group_title, epub.blocks(group), epub.source(group)))
        book['chapters'].extend(appendices)
        books.append(book)
    epub.close()
    return books


def read_dragon(path):
    epub = Epub(path)
    # The collection's seven actual volume boundaries (its own TOC order).
    boundaries = {'text00001.html', 'text00018.html', 'text00045.html', 'text00075.html',
                  'text00092.html', 'text00123.html', 'text00144.html'}
    books = []
    for node in epub.nav:
        title = epub.label(node)
        source = epub.source(node)
        if posixpath.basename(source) in boundaries:
            books.append({'id': f'dragon-{len(books) + 1}', 'series': '龙族', 'title': title,
                          'author': '江南', 'source': str(path.relative_to(STORY)), 'chapters': []})
        elif title != '目录' and books:
            books[-1]['chapters'].append(chapter(title, epub.blocks(node), source))
    for book in books:
        book['start'] = next((i for i, c in enumerate(book['chapters'])
                              if c['title'] not in {'版权信息', '纸质版编目数据'}), 0)
    # Some chapters span two spine documents; they must stay joined.
    assert 'OEBPS/text00099.html' in epub.covered, 'Missing continuation of 源家次子'
    epub.close()
    return books


def read_dragon_five(path):
    raw = path.read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('gb18030')
    lines = text.splitlines()
    headings = [(i, line.strip()) for i, line in enumerate(lines)
                if re.match(r'^第\d+章\s+\S', line.strip())]
    book = {'id': 'dragon-8', 'series': '龙族', 'title': '龙族Ⅴ · 悼亡者的归来', 'author': '江南',
            'source': str(path.relative_to(STORY)), 'chapters': []}
    for n, (start, title) in enumerate(headings):
        end = headings[n + 1][0] if n + 1 < len(headings) else len(lines)
        blocks = [{'type': 'p', 'text': line.strip()} for line in lines[start + 1:end] if line.strip()]
        book['chapters'].append(chapter(title, blocks, f'line:{start + 1}'))
    return book


def main():
    DATA.mkdir(exist_ok=True)
    IMAGES.mkdir(exist_ok=True)
    epubs = sorted(STORY.rglob('*.epub'))
    jiuzhou = next(p for p in epubs if '九州缥缈录' in p.name)
    dragon = next(p for p in epubs if '龙族' in p.name)
    five = next(p for p in sorted(STORY.rglob('*.txt')) if '龙族V' in p.name and '龙5' in p.name)
    books = read_jiuzhou(jiuzhou) + read_dragon(dragon) + [read_dragon_five(five)]
    library = []
    for book in books:
        assert book['chapters'], f"No chapters in {book['title']}"
        assert all(c['blocks'] for c in book['chapters']), f"Empty chapter in {book['title']}"
        encoded = json.dumps(book, ensure_ascii=False, separators=(',', ':'))
        (DATA / f"{book['id']}.js").write_text(
            f'window.STORY_BOOKS = window.STORY_BOOKS || {{}};\nwindow.STORY_BOOKS[{json.dumps(book["id"])}] = {encoded};\n', encoding='utf-8')
        metadata = {k: v for k, v in book.items() if k != 'chapters'}
        metadata['chapters'] = [{k: v for k, v in c.items() if k not in {'blocks', 'source'}} for c in book['chapters']]
        library.append(metadata)
        print(f"{book['title']}: {len(book['chapters'])} chapters / sections")
    (HERE / 'library.js').write_text('window.STORY_LIBRARY = ' + json.dumps(library, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')
    (HERE / 'catalog.json').write_text(json.dumps(library, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Ready: {len(books)} books, {sum(len(b['chapters']) for b in books)} chapters / sections")


if __name__ == '__main__':
    main()
