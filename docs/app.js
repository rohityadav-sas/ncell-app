(() => {
  'use strict';

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const root = document.documentElement;
  const article = $('#content');
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const menuBtn = $('#menu-btn');
  const navLinks = [...sidebar.querySelectorAll('a')];
  const THEME_KEY = 'ncell-package-docs-theme';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function icon(name, extraClass = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', ('ico ' + extraClass).trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  /* ---------- Theme ---------- */
  const media = matchMedia('(prefers-color-scheme: dark)');
  const themeBtn = $('#theme-btn');
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {}
  function syncThemeButton() {
    themeBtn.setAttribute(
      'aria-label',
      `Switch to ${root.dataset.theme === 'dark' ? 'light' : 'dark'} theme`,
    );
  }
  themeBtn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    stored = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    syncThemeButton();
  });
  media.addEventListener('change', (event) => {
    if (stored === 'light' || stored === 'dark') return;
    root.dataset.theme = event.matches ? 'dark' : 'light';
    syncThemeButton();
  });
  syncThemeButton();

  /* ---------- Shared sidebar scroll position ---------- */
  const SIDEBAR_SCROLL_KEY = 'ncell-package-docs-sidebar-scroll';
  function saveSidebarScroll() {
    if (!sidebar.getClientRects().length) return;
    try {
      sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(sidebar.scrollTop));
    } catch {}
  }
  function restoreSidebarScroll() {
    try {
      const position = Number(sessionStorage.getItem(SIDEBAR_SCROLL_KEY));
      if (Number.isFinite(position)) sidebar.scrollTop = position;
    } catch {}
  }
  restoreSidebarScroll();
  sidebar.addEventListener('scroll', saveSidebarScroll, { passive: true });
  window.addEventListener('pagehide', saveSidebarScroll);
  window.addEventListener('pageshow', restoreSidebarScroll);

  /* ---------- Mobile navigation ---------- */
  function setMenu(open) {
    if (!open) saveSidebarScroll();
    sidebar.classList.toggle('open', open);
    if (open) restoreSidebarScroll();
    scrim.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  }
  menuBtn.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
  scrim.addEventListener('click', () => setMenu(false));
  navLinks.forEach((link) => link.addEventListener('click', () => setMenu(false)));

  // Every indexed heading needs a destination, including feature-card headings.
  article.querySelectorAll('h1, h2, h3').forEach((heading, i) => {
    if (!heading.id) heading.id = 'topic-' + i;
  });

  /* ---------- Search index (built before the DOM is enhanced) ---------- */
  const navIcons = new Map(
    navLinks.map((link) => {
      const use = link.querySelector('use');
      return [link.hash.slice(1), use ? use.getAttribute('href').slice(3) : 'hash'];
    }),
  );
  const index = [];
  function indexPage(doc, page) {
    const content = doc.querySelector('#content');
    content.querySelectorAll('h1, h2, h3').forEach((heading, i) => {
      if (!heading.id) heading.id = 'topic-' + i;
    });
    let entry = null,
      section = '';
    for (const el of content.children) {
      if (/^H[123]$/.test(el.tagName)) {
        const title = el.textContent.trim();
        if (el.tagName !== 'H3') section = title;
        entry = { id: el.id, url: page + '#' + el.id, title, section, text: '' };
        index.push(entry);
      } else if (entry && el.id !== 'code-rows' && !el.querySelector('#code-rows'))
        entry.text += ' ' + el.textContent;
    }
    for (const row of content.querySelectorAll('#code-rows tr[data-prefix]')) {
      const code = row.cells[0].textContent.trim();
      index.push({
        id: code,
        url: page + '#' + code,
        title: code,
        section: 'Response codes · ' + row.dataset.prefix,
        text: row.cells[1].textContent,
        icon: 'info',
      });
    }
    for (const item of index) {
      item.text = item.text.replace(/\s+/g, ' ').trim();
      item.textLower = item.text.toLowerCase();
    }
  }
  indexPage(document, '');
  /* ---------- Heading anchors ---------- */
  for (const heading of article.querySelectorAll('h2[id], h3[id]')) {
    const anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = '#' + heading.id;
    anchor.setAttribute('aria-label', `Link to “${heading.textContent}”`);
    heading.append(anchor);
  }

  /* ---------- Syntax colors (text nodes preserve copy and search text) ---------- */
  const commandWords = new Set(
    'ncell npm npx install add login logout status balance profile account list switch remove plans categories search subscribe sms send-free game check-in claim-task math scratch spin ranks script create edit delete run help'.split(
      ' ',
    ),
  );
  function highlightCode(code, language) {
    const source = code.textContent;
    const output = language === 'Output';
    const json = language === 'JSON';
    const typescript = language === 'TypeScript';
    const fragment = document.createDocumentFragment();
    const tokens =
      /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\.|[^"\\])*"|'[^']*'|https?:\/\/[^\s]+|--?[a-zA-Z][\w-]*|<[^>\r\n]+>|\b[\w-]+(?:\.[\w-]+)+\b|\b\d+(?:[.,]\d+)*(?:s|m|h)?\b|\b[a-zA-Z][\w-]*\b/g;
    let offset = 0;
    for (const match of source.matchAll(tokens)) {
      const value = match[0];
      let kind = '';
      if (!output && !json && (value.startsWith('#') || (typescript && value.startsWith('/'))))
        kind = 'comment';
      else if (/^["']/.test(value))
        kind = json && /^\s*:/.test(source.slice(match.index + value.length)) ? 'key' : 'string';
      else if (/^https?:/.test(value)) kind = 'string';
      else if (!output && /^--?/.test(value)) kind = 'option';
      else if (!output && value.startsWith('<')) kind = 'parameter';
      else if (/^\d/.test(value)) kind = 'number';
      else if (!output && commandWords.has(value)) kind = 'command';
      else if (
        [
          'true',
          'false',
          'null',
          ...(typescript
            ? [
                'import',
                'from',
                'export',
                'default',
                'const',
                'let',
                'new',
                'await',
                'async',
                'return',
                'if',
                'else',
                'try',
                'catch',
                'throw',
                'instanceof',
              ]
            : []),
        ].includes(value)
      )
        kind = 'keyword';
      fragment.append(document.createTextNode(source.slice(offset, match.index)));
      if (kind) {
        const span = document.createElement('span');
        span.className = 'syntax-' + kind;
        span.textContent = value;
        fragment.append(span);
      } else fragment.append(document.createTextNode(value));
      offset = match.index + value.length;
    }
    fragment.append(document.createTextNode(source.slice(offset)));
    code.replaceChildren(fragment);
  }
  article.querySelectorAll('code').forEach((code) => {
    highlightCode(code, code.closest('pre')?.dataset.lang || 'Shell');
  });

  /* ---------- Code blocks ---------- */
  const langIcons = {
    Shell: 'terminal',
    PowerShell: 'terminal',
    TypeScript: 'braces',
    JSON: 'braces',
    Output: 'file-text',
    Text: 'file-text',
  };
  for (const pre of article.querySelectorAll('pre')) {
    const label = pre.dataset.lang || 'Shell';
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';

    const lang = document.createElement('span');
    lang.className = 'code-lang';
    lang.append(icon(langIcons[label] || 'terminal'), label);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.setAttribute('aria-label', `Copy ${label} code to clipboard`);
    const buttonIcon = icon('copy');
    const buttonText = document.createElement('span');
    buttonText.textContent = 'Copy';
    button.append(buttonIcon, buttonText);

    let timer;
    const reset = () => {
      button.classList.remove('copied');
      buttonIcon.firstChild.setAttribute('href', '#i-copy');
      buttonText.textContent = 'Copy';
    };
    button.addEventListener('click', async () => {
      clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(pre.textContent);
        button.classList.add('copied');
        buttonIcon.firstChild.setAttribute('href', '#i-check');
        buttonText.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        buttonText.textContent = 'Press Ctrl+C';
      }
      timer = setTimeout(reset, 1800);
    });

    head.append(lang, button);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
    pre.tabIndex = 0;
  }
  article.querySelectorAll('.table-wrap').forEach((wrap) => {
    wrap.tabIndex = 0;
  });

  /* ---------- Active section in the sidebar ---------- */
  const spyTargets = navLinks
    .filter((link) => link.pathname === location.pathname)
    .map((link) => ({ link, heading: document.getElementById(link.hash.slice(1)) }))
    .filter((target) => target.heading)
    .sort((a, b) =>
      a.heading.compareDocumentPosition(b.heading) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let followedLink = null;
  function followActiveLink(link) {
    if (!link || link === followedLink || !sidebar.getClientRects().length) return;
    followedLink = link;
    sidebar.scrollTo({ top: sidebar.scrollTop, behavior: 'instant' });
    const bounds = sidebar.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    const padding = 20;
    let delta = 0;
    if (item.top < bounds.top + padding) delta = item.top - bounds.top - padding;
    else if (item.bottom > bounds.bottom - padding) delta = item.bottom - bounds.bottom + padding;
    if (delta)
      sidebar.scrollTo({
        top: sidebar.scrollTop + delta,
        behavior: reducedMotion.matches ? 'instant' : 'smooth',
      });
  }
  let codesMode = false;
  let ticking = false;
  let routing = false;
  let navigationTarget = null;
  let scrollIdle;
  function releaseNavigationTarget() {
    navigationTarget = null;
    clearTimeout(scrollIdle);
    updateActive();
  }
  function updateActive() {
    ticking = false;
    if (routing) return;
    if (codesMode) {
      for (const link of navLinks) {
        const on = link.hash === '#response-codes';
        link.classList.toggle('active', on);
        if (on) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
      followActiveLink(navLinks.find((link) => link.hash === '#response-codes'));
      return;
    }
    const threshold = $('.header').getBoundingClientRect().bottom + 29;
    let current = spyTargets[0];
    for (const target of spyTargets) {
      if (target.heading.getBoundingClientRect().top <= threshold) current = target;
      else break;
    }
    if (innerHeight + scrollY >= root.scrollHeight - 2) current = spyTargets[spyTargets.length - 1];
    if (navigationTarget) current = navigationTarget;
    for (const link of navLinks) {
      const target = spyTargets.find((target) => target.link === link);
      const on = target === current;
      link.classList.toggle('active', on);
      if (on) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
    followActiveLink(current?.link);
  }
  addEventListener(
    'scroll',
    () => {
      if (navigationTarget) {
        clearTimeout(scrollIdle);
        scrollIdle = setTimeout(releaseNavigationTarget, 150);
      }
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(updateActive);
      }
    },
    { passive: true },
  );
  addEventListener('scrollend', releaseNavigationTarget);
  for (const type of ['wheel', 'touchstart']) {
    addEventListener(
      type,
      (event) => {
        if (!(event.target instanceof Node) || !sidebar.contains(event.target))
          releaseNavigationTarget();
      },
      { passive: true },
    );
  }
  addEventListener('keydown', (event) => {
    if (
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) &&
      !event.target.closest('input, textarea, select, dialog')
    )
      releaseNavigationTarget();
  });
  addEventListener('resize', updateActive);
  addEventListener('pageshow', updateActive);
  addEventListener('load', updateActive);
  updateActive();

  /* ---------- Response codes view, loaded only for navigation or search ---------- */
  const codesView = document.createElement('article');
  codesView.id = 'codes-view';
  codesView.hidden = true;
  article.after(codesView);
  let codesReady;
  function loadCodes() {
    if (!codesReady)
      codesReady = fetch('response-codes-content.html')
        .then((response) => {
          if (!response.ok) throw new Error('Response codes could not be loaded.');
          return response.text();
        })
        .then((html) => {
          const doc = new DOMParser().parseFromString(
            '<article id="content">' + html + '</article>',
            'text/html',
          );
          indexPage(doc, '');
          codesView.replaceChildren(...doc.querySelector('#content').childNodes);
          codesView.querySelectorAll('code').forEach((code) => highlightCode(code, 'Text'));
          codesView.querySelectorAll('.table-wrap').forEach((wrap) => {
            wrap.tabIndex = 0;
          });
          for (const heading of codesView.querySelectorAll('h2[id], h3[id]')) {
            const anchor = document.createElement('a');
            anchor.className = 'anchor';
            anchor.href = '#' + heading.id;
            anchor.setAttribute('aria-label', `Link to “${heading.textContent}”`);
            heading.append(anchor);
          }
        })
        .catch((error) => {
          codesReady = null;
          throw error;
        });
    return codesReady;
  }
  let routeVersion = 0;
  let routeStarted = false;
  let viewAnimation;
  async function route() {
    const version = ++routeVersion;
    const id = location.hash.slice(1);
    routing = true;
    const nextCodesMode =
      id === 'response-codes' || id.startsWith('codes-') || /^[A-Z]+[0-9]+$/.test(id);
    const switchingView = routeStarted && nextCodesMode !== codesMode;
    const smoothScroll = routeStarted && !switchingView && !reducedMotion.matches;
    routeStarted = true;
    viewAnimation?.cancel();
    codesMode = nextCodesMode;
    article.hidden = codesMode;
    codesView.hidden = !codesMode;
    if (codesMode) {
      if (!codesReady) codesView.textContent = 'Loading response codes…';
      try {
        await loadCodes();
      } catch (error) {
        if (version === routeVersion) {
          codesView.textContent = error.message + ' Select Response codes to try again.';
          routing = false;
          updateActive();
        }
        return;
      }
    }
    if (version !== routeVersion) return;
    document.title = codesMode ? 'Response codes · ncell' : 'ncell documentation';
    // Scroll within a view; fade between views after positioning the destination.
    const destination = document.getElementById(id);
    navigationTarget =
      codesMode || !destination
        ? null
        : spyTargets.findLast(
            (target) =>
              target.heading === destination ||
              target.heading.compareDocumentPosition(destination) &
                Node.DOCUMENT_POSITION_FOLLOWING,
          );
    clearTimeout(scrollIdle);
    const behavior = smoothScroll ? 'smooth' : 'instant';
    if (destination) destination.scrollIntoView({ behavior });
    else window.scrollTo({ top: 0, behavior });
    routing = false;
    updateActive();
    if (switchingView && !reducedMotion.matches) {
      viewAnimation = (codesMode ? codesView : article).animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 180,
        easing: 'ease-out',
      });
    }
  }
  addEventListener('hashchange', route);
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const url = new URL(link.href, location.href);
    if (
      url.origin !== location.origin ||
      url.pathname !== location.pathname ||
      url.search !== location.search ||
      !url.hash
    )
      return;
    event.preventDefault();
    if (url.hash !== location.hash) history.pushState(null, '', url.hash);
    route();
  });

  /* ---------- Search dialog ---------- */
  const dialog = $('#search-dialog');
  const input = $('#search-input');
  const list = $('#search-results');
  const status = $('#search-status');
  let results = [];
  let active = -1;

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(target, text, terms) {
    const pattern = new RegExp('(' + terms.map(escapeRegExp).join('|') + ')', 'gi');
    text.split(pattern).forEach((part, i) => {
      if (!part) return;
      if (i % 2) {
        const mark = document.createElement('mark');
        mark.textContent = part;
        target.append(mark);
      } else {
        target.append(part);
      }
    });
  }

  function snippet(entry, terms) {
    let pos = -1;
    for (const term of terms) {
      const i = entry.textLower.indexOf(term);
      if (i !== -1 && (pos === -1 || i < pos)) pos = i;
    }
    const start = Math.max(0, pos === -1 ? 0 : pos - 40);
    const end = start + 140;
    return (
      (start > 0 ? '…' : '') + entry.text.slice(start, end) + (end < entry.text.length ? '…' : '')
    );
  }

  function runSearch(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return index
      .map((entry) => {
        let score = 0;
        for (const term of terms) {
          const inTitle = entry.title.toLowerCase().includes(term);
          const inSection = entry.section.toLowerCase().includes(term);
          const inText = entry.textLower.includes(term);
          if (!inTitle && !inSection && !inText) return null;
          score += (inTitle ? 10 : 0) + (inSection ? 3 : 0) + (inText ? 1 : 0);
        }
        return { entry, score, terms };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  function setActive(i) {
    active = i;
    [...list.children].forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', 'result-' + i);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function render() {
    const query = input.value.trim();
    list.replaceChildren();
    results = [];
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
    if (!query) {
      status.className = 'search-hint';
      status.textContent = 'Search documentation and response codes.';
      return;
    }
    results = runSearch(query);
    if (!results.length) {
      status.className = 'search-hint';
      status.textContent = `No results for “${query}”.`;
      return;
    }
    status.className = 'sr-only';
    status.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
    results.forEach(({ entry, terms }, i) => {
      const li = document.createElement('li');
      li.id = 'result-' + i;
      li.setAttribute('role', 'option');

      const a = document.createElement('a');
      a.href = entry.url;

      const tile = document.createElement('span');
      tile.className = 'result-icon';
      tile.append(icon(entry.icon || navIcons.get(entry.id) || 'hash'));

      const body = document.createElement('span');
      body.className = 'result-text';
      const title = document.createElement('span');
      title.className = 'result-title';
      title.textContent = entry.title;
      body.append(title);
      if (entry.section !== entry.title) {
        const section = document.createElement('span');
        section.className = 'result-section';
        section.textContent = entry.section;
        body.append(section);
      }
      const excerpt = document.createElement('span');
      excerpt.className = 'result-snippet';
      highlight(excerpt, snippet(entry, terms), terms);
      body.append(excerpt);

      a.append(tile, body);
      a.addEventListener('click', () => {
        dialog.close();
      });
      li.append(a);
      list.append(li);
    });
    input.setAttribute('aria-expanded', 'true');
    setActive(0);
  }

  async function openSearch() {
    setMenu(false);
    if (dialog.open) {
      input.select();
      return;
    }
    dialog.showModal();
    input.value = '';
    render();
    input.focus();
    try {
      await loadCodes();
      if (dialog.open) render();
    } catch {
      status.textContent = 'Response codes unavailable; searching the main documentation.';
    }
  }

  $('#search-btn').addEventListener('click', openSearch);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (results.length) setActive(Math.min(active + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) setActive(Math.max(active - 1, 0));
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      list.children[active].firstElementChild.click();
    }
  });
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    )
      dialog.close();
  });

  document.addEventListener('keydown', (event) => {
    const target = document.activeElement;
    const editing =
      target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable);
    const slash =
      event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey;
    const palette = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
    if (slash || palette) {
      event.preventDefault();
      openSearch();
    } else if (event.key === 'Escape' && sidebar.classList.contains('open')) {
      setMenu(false);
      menuBtn.focus();
    }
  });
  route();
})();
