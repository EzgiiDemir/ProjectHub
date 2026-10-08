/**
 * Script injected into every preview page. It lets the Project Hub UI (a different origin) talk to the
 * previewed app without access to its DOM: report navigation, pick an element for visual feedback,
 * and forward console errors and failed requests to the simulator. Messages are only exchanged with the
 * configured Project Hub origin.
 */
export function bridgeScript(parentOrigin: string): string {
  return `(() => {
  if (window.__projecthubBridge) return;
  window.__projecthubBridge = true;
  const PARENT = ${JSON.stringify(parentOrigin)};
  const inFrame = window.parent !== window;
  const post = (msg) => { if (inFrame) { try { window.parent.postMessage(Object.assign({ ph: true }, msg), PARENT); } catch (e) {} } };

  const report = () => post({ type: 'nav', path: location.pathname + location.search + location.hash, title: document.title, scrollY: Math.round(scrollY), width: innerWidth, height: innerHeight });
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () { const r = orig.apply(this, arguments); setTimeout(report, 0); return r; };
  }
  addEventListener('popstate', report);
  addEventListener('hashchange', report);
  addEventListener('load', report);
  let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => post({ type: 'scroll', scrollY: Math.round(scrollY) }), 150); }, { passive: true });

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  function selectorOf(el) {
    if (!(el instanceof Element)) return 'body';
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList).filter((c) => /^[a-zA-Z][\\w-]*$/.test(c) && !/^(css|sc|jsx|svelte)-/.test(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.map(cssEscape).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id) { parts[0] = '#' + cssEscape(node.id); break; }
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  }

  let outline = null;
  function highlight(el) {
    if (!outline) {
      outline = document.createElement('div');
      outline.setAttribute('data-projecthub', 'outline');
      outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #234E8C;background:rgba(35,78,140,.08);border-radius:3px;transition:all .06s';
      document.documentElement.appendChild(outline);
    }
    if (!el) { outline.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(outline.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }

  addEventListener('message', (e) => {
    if (e.origin !== PARENT || !e.data || !e.data.ph) return;
    const d = e.data;
    if (d.type === 'hover') highlight(document.elementFromPoint(d.x, d.y));
    else if (d.type === 'clearHover') highlight(null);
    else if (d.type === 'pick') {
      const el = document.elementFromPoint(d.x, d.y);
      highlight(null);
      post({ type: 'picked', requestId: d.requestId, selector: selectorOf(el), x: Math.round(d.x), y: Math.round(d.y + scrollY), scrollY: Math.round(scrollY), path: location.pathname + location.search, text: el ? (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 120) : '' });
    } else if (d.type === 'scrollTo') scrollTo({ top: d.y, behavior: 'smooth' });
    else if (d.type === 'navigate' && typeof d.path === 'string' && d.path.startsWith('/')) location.href = d.path;
    else if (d.type === 'reload') location.reload();
    else if (d.type === 'hello') report();
  });

  const fmt = (args) => Array.from(args).map((a) => { try { return typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a); } catch (err) { return String(a); } }).join(' ').slice(0, 1000);
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function () { post({ type: 'console', level, message: fmt(arguments), at: Date.now() }); return orig.apply(this, arguments); };
  }
  addEventListener('error', (e) => post({ type: 'console', level: 'error', message: (e.message || 'Script hatası') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''), at: Date.now() }));
  addEventListener('unhandledrejection', (e) => post({ type: 'console', level: 'error', message: 'Yakalanmamış promise: ' + fmt([e.reason]), at: Date.now() }));
  if (window.fetch) {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const started = performance.now();
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      return of.apply(this, arguments).then((res) => { post({ type: 'network', method, url, status: res.status, ms: Math.round(performance.now() - started) }); return res; },
        (err) => { post({ type: 'network', method, url, status: 0, ms: Math.round(performance.now() - started), error: String(err) }); throw err; });
    };
  }
  report();
})();`;
}
