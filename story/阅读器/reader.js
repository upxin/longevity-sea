(() => {
  'use strict';
  const library = window.STORY_LIBRARY || [];
  const $ = id => document.getElementById(id);
  const content = $('content');
  const sidebar = $('sidebar');
  const mobile = window.matchMedia('(max-width: 760px)');
  const bookLoads = new Map();
  let activeBook = null;
  let chapterIndex = 0;
  let requestNumber = 0;
  let tocBook = null;
  let loading = false;
  let positionReady = false;
  let saveTimer = null;
  let pendingResume = null;
  const progressPrefix = 'shujian:reading:v1:';
  const memoryProgress = new Map();

  // Let the reader restore its own paragraph position instead of racing the browser.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function storageUnavailable() {
    $('save-status').textContent = '进度暂未保存';
    $('save-status').title = '浏览器未允许保存本地数据，关闭页面后可能无法继续上次的位置。';
  }

  function readSaved(key) {
    try {
      const raw = localStorage.getItem(progressPrefix + key);
      return raw ? JSON.parse(raw) : memoryProgress.get(key);
    } catch {
      storageUnavailable();
      return memoryProgress.get(key);
    }
  }

  function writeSaved(key, value) {
    memoryProgress.set(key, value);
    try {
      localStorage.setItem(progressPrefix + key, JSON.stringify(value));
    } catch {
      storageUnavailable();
    }
  }

  function savedPosition(book) {
    const saved = readSaved(book.id);
    if (!saved || !Number.isInteger(saved.chapter) || saved.chapter < 0 || saved.chapter >= book.chapters.length) return null;
    return saved;
  }

  function saveProgress() {
    if (!activeBook || loading || !positionReady) return;
    const blocks = [...content.children];
    const anchor = scrollY > 0 ? blocks.findIndex(block => block.getBoundingClientRect().bottom > 32) : -1;
    const rect = anchor >= 0 ? blocks[anchor].getBoundingClientRect() : null;
    writeSaved(activeBook.id, {
      chapter: chapterIndex,
      scrollY: Math.max(0, scrollY),
      anchor,
      offset: rect ? Math.max(0, Math.min(1, (32 - rect.top) / Math.max(1, rect.height))) : 0,
    });
    writeSaved('last-book', activeBook.id);
  }

  function flushProgress() {
    clearTimeout(saveTimer);
    saveProgress();
  }

  async function restorePosition(saved, token) {
    if (!saved || saved.chapter !== chapterIndex) return;
    const blocks = [...content.children];
    const anchor = Number.isInteger(saved.anchor) && saved.anchor >= 0 ? blocks[saved.anchor] : null;
    // Load illustrations above the saved paragraph before measuring its position.
    if (anchor) {
      const images = blocks.slice(0, saved.anchor + 1).filter(block => block.tagName === 'IMG');
      for (const image of images) image.loading = 'eager';
      if (images.length) await Promise.allSettled(images.map(image => image.decode()));
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (token !== requestNumber) return;
    const fallback = Number.isFinite(saved.scrollY) ? Math.max(0, saved.scrollY) : 0;
    const offset = Number.isFinite(saved.offset) ? Math.max(0, Math.min(1, saved.offset)) : 0;
    const rect = anchor?.getBoundingClientRect();
    window.scrollTo(0, rect ? Math.max(0, scrollY + rect.top + offset * rect.height - 32) : fallback);
  }

  function setMenu(open) {
    sidebar.classList.toggle('open', open);
    $('scrim').hidden = !open;
    $('open-menu').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('menu-open', open);
    sidebar.inert = mobile.matches && !open;
    if (open) {
      (sidebar.querySelector('[aria-current="page"]') || $('book')).focus();
    }
  }

  function syncLayout() {
    setMenu(false);
  }

  function loadBook(id) {
    if (window.STORY_BOOKS?.[id]) return Promise.resolve(window.STORY_BOOKS[id]);
    if (bookLoads.has(id)) return bookLoads.get(id);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `books/${id}.js`;
      const timer = setTimeout(() => fail(), 15000);
      const fail = () => {
        clearTimeout(timer);
        bookLoads.delete(id);
        script.remove();
        reject(new Error('无法打开这本书，请确认 books 文件夹与阅读页放在一起。'));
      };
      script.onerror = fail;
      script.onload = () => {
        clearTimeout(timer);
        if (window.STORY_BOOKS?.[id]) resolve(window.STORY_BOOKS[id]);
        else fail();
      };
      document.head.append(script);
    });
    bookLoads.set(id, promise);
    return promise;
  }

  function chapterLabel(chapter) {
    return chapter.section ? `${chapter.section} · ${chapter.title}` : chapter.title;
  }

  function renderToc(book) {
    if (tocBook === book.id) return;
    tocBook = book.id;
    const fragment = document.createDocumentFragment();
    let section = '';
    book.chapters.forEach((chapter, index) => {
      if (chapter.section && chapter.section !== section) {
        section = chapter.section;
        const heading = document.createElement('h3');
        heading.className = 'toc-group';
        heading.textContent = section;
        fragment.append(heading);
      }
      const button = document.createElement('button');
      button.dataset.chapter = index;
      button.title = chapterLabel(chapter);
      const number = document.createElement('span');
      number.className = 'number';
      number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('span');
      title.textContent = chapter.title;
      button.append(number, title);
      button.addEventListener('click', () => navigate(book.id, index));
      fragment.append(button);
    });
    $('toc').replaceChildren(fragment);
    $('chapter-total').textContent = `${book.chapters.length} 章 / 节`;
  }

  function updateNavigation() {
    const count = activeBook?.chapters.length || 0;
    for (const id of ['prev', 'bottom-prev']) $(id).disabled = loading || chapterIndex <= 0;
    for (const id of ['next', 'bottom-next']) $(id).disabled = loading || chapterIndex >= count - 1;
    $('prev-title').textContent = chapterIndex > 0 ? chapterLabel(activeBook.chapters[chapterIndex - 1]) : '已是本书开篇';
    $('next-title').textContent = chapterIndex < count - 1 ? chapterLabel(activeBook.chapters[chapterIndex + 1]) : '已读至本书末尾';
    $('page-position').textContent = `${chapterIndex + 1} / ${count}`;
  }

  async function showChapter(id, index, resume = false) {
    const book = library.find(b => b.id === id) || library[0];
    if (!book) {
      $('chapter-title').textContent = '还没有可读的书籍';
      $('status').textContent = '请先生成书籍目录。';
      $('status').hidden = false;
      return;
    }
    flushProgress();
    positionReady = false;
    const saved = resume ? savedPosition(book) : null;
    const token = ++requestNumber;
    activeBook = book;
    chapterIndex = Number.isInteger(index) ? Math.max(0, Math.min(index, book.chapters.length - 1)) : (book.start || 0);
    const chapter = book.chapters[chapterIndex];
    $('book').value = book.id;
    $('book-title').textContent = book.title;
    $('book-meta').textContent = `${book.author} 著 · ${book.source.endsWith('.epub') ? '原书目录' : 'TXT 分章'}`;
    $('chapter-kicker').textContent = chapter.section || book.title;
    $('chapter-title').textContent = chapter.section && /^[一二三四五六七八九十百]+$/.test(chapter.title) ? `第${chapter.title}节` : chapter.title;
    $('chapter-count').textContent = `${chapterIndex + 1} / ${book.chapters.length}`;
    $('word-count').textContent = `约 ${chapter.characters.toLocaleString('zh-CN')} 字`;
    $('source').textContent = `原文件：${book.source}`;
    document.title = `${chapterLabel(chapter)} — ${book.title} · 书间`;
    renderToc(book);
    $('toc').querySelectorAll('button').forEach(button => {
      if (Number(button.dataset.chapter) === chapterIndex) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    loading = true;
    document.body.classList.add('loading');
    content.setAttribute('aria-busy', 'true');
    content.replaceChildren();
    $('status').hidden = false;
    $('status').textContent = '正在打开章节…';
    setMenu(false);
    updateNavigation();
    window.scrollTo(0, 0);
    try {
      const data = await loadBook(book.id);
      if (token !== requestNumber) return;
      const fragment = document.createDocumentFragment();
      for (const block of data.chapters[chapterIndex].blocks) {
        const element = document.createElement(block.type === 'image' ? 'img' : block.type === 'heading' ? 'h2' : 'p');
        if (block.type === 'image') {
          element.src = block.src;
          element.alt = block.alt;
          element.loading = 'lazy';
        } else element.textContent = block.text;
        fragment.append(element);
      }
      content.replaceChildren(fragment);
      $('status').hidden = true;
      $('reading').focus({preventScroll: true});
      const current = $('toc').querySelector('[aria-current="page"]');
      if (current) $('toc').scrollTop = Math.max(0, current.offsetTop - $('toc').offsetTop - 110);
      await restorePosition(saved, token);
      if (token !== requestNumber) return;
      positionReady = true;
    } catch (error) {
      if (token !== requestNumber) return;
      $('status').textContent = error.message;
      const retry = document.createElement('button');
      retry.textContent = '重新打开';
      retry.onclick = () => showChapter(book.id, chapterIndex, resume);
      $('status').append(retry);
    } finally {
      if (token === requestNumber) {
        loading = false;
        document.body.classList.remove('loading');
        content.removeAttribute('aria-busy');
        updateNavigation();
        saveProgress();
      }
    }
  }

  function navigate(id, index, resume = false) {
    const hash = `#${id}/${index + 1}`;
    if (location.hash === hash) showChapter(id, index, resume);
    else {
      pendingResume = resume;
      location.hash = hash;
    }
  }

  function readRoute() {
    const match = location.hash.match(/^#([a-z0-9-]+)\/(\d+)$/);
    const resume = pendingResume ?? true;
    pendingResume = null;
    if (match && library.some(book => book.id === match[1])) {
      showChapter(match[1], Number(match[2]) - 1, resume);
    } else {
      const lastBook = readSaved('last-book');
      const book = library.find(book => book.id === lastBook) || library[0];
      const saved = book && savedPosition(book);
      showChapter(book?.id, saved?.chapter ?? book?.start ?? 0, true);
    }
  }

  function turnPage(direction) {
    if (!activeBook || loading) return;
    const next = chapterIndex + direction;
    if (next >= 0 && next < activeBook.chapters.length) navigate(activeBook.id, next);
  }

  const groups = new Map();
  for (const book of library) {
    if (!groups.has(book.series)) {
      const group = document.createElement('optgroup');
      group.label = book.series;
      groups.set(book.series, group);
      $('book').append(group);
    }
    const option = document.createElement('option');
    option.value = book.id;
    option.textContent = book.title;
    groups.get(book.series).append(option);
  }
  $('library-count').textContent = `${library.length} 册藏书`;
  document.querySelector('.skip').onclick = event => {
    event.preventDefault();
    $('reading').focus();
    $('reading').scrollIntoView();
  };
  $('book').addEventListener('change', () => {
    const book = library.find(b => b.id === $('book').value);
    const saved = savedPosition(book);
    navigate(book.id, saved?.chapter ?? book.start ?? 0, true);
  });
  for (const id of ['prev', 'bottom-prev']) $(id).onclick = () => turnPage(-1);
  for (const id of ['next', 'bottom-next']) $(id).onclick = () => turnPage(1);
  $('open-menu').onclick = () => setMenu(true);
  $('close-menu').onclick = $('scrim').onclick = () => { setMenu(false); $('open-menu').focus(); };
  $('current-chapter').onclick = () => {
    if (mobile.matches) setMenu(true);
    const current = $('toc').querySelector('[aria-current="page"]');
    current?.focus();
  };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) {
      setMenu(false); $('open-menu').focus(); return;
    }
    if (event.key === 'Tab' && mobile.matches && sidebar.classList.contains('open')) {
      const targets = [...sidebar.querySelectorAll('button, select')];
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || sidebar.classList.contains('open') ||
        event.target.matches('input, select, textarea, [contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); turnPage(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); turnPage(1); }
  });
  window.addEventListener('hashchange', readRoute);
  window.addEventListener('scroll', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 200);
  }, {passive: true});
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });
  mobile.addEventListener('change', syncLayout);
  syncLayout();
  readRoute();
})();
