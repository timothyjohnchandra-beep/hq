/* Timothy HQ – EPUB reader (Apple Books layout, with Kindle tools). Loaded only when a book is opened.
   Uses epub.js + JSZip from jsDelivr. Book files come from the bridge script (action=book) and are kept
   on this device in the Cache API ("hq-books"), so a book opens offline after the first time. */
(function () {
'use strict';
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', PDFW = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const LIBS = ['https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js'];
const THEMES = {
  original: { name: 'Original', bg: '#ffffff', fg: '#1d1d1f', ui: '#f2f2f7' },
  quiet:    { name: 'Quiet',    bg: '#4a4a4f', fg: '#e5e5e7', ui: '#3c3c41', dark: 1 },
  paper:    { name: 'Paper',    bg: '#f7f3ea', fg: '#2b2a26', ui: '#ece6d8' },
  bold:     { name: 'Bold',     bg: '#ffffff', fg: '#000000', ui: '#f2f2f7', weight: 600 },
  calm:     { name: 'Calm',     bg: '#f3e5c8', fg: '#3b2f1e', ui: '#e8d7b4' },
  focus:    { name: 'Focus',    bg: '#fffcf2', fg: '#1d1d1f', ui: '#f3eedc' },
  night:    { name: 'Night',    bg: '#000000', fg: '#cfcfd4', ui: '#1c1c1e', dark: 1 }
};
const FONTS = { original: ['Original', ''], serif: ['Serif', 'Charter, "Iowan Old Style", "Source Serif 4", Georgia, serif'], sans: ['Sans', '-apple-system, "SF Pro Text", Inter, system-ui, sans-serif'], georgia: ['Georgia', 'Georgia, serif'], palatino: ['Palatino', 'Palatino, "Palatino Linotype", "Book Antiqua", serif'], times: ['Times', '"Times New Roman", Times, serif'], dyslexic: ['Easy read', 'Verdana, Tahoma, sans-serif'] };
const COLS = { y: ['Yellow', '#ffe066'], g: ['Green', '#b6e3a8'], b: ['Blue', '#b5d3f3'], p: ['Pink', '#f5bcd4'], o: ['Orange', '#ffc78a'] };
const DEF = { theme: 'paper', font: 'original', size: 100, lh: 1.5, sp: 0, margin: 2, justify: 1, flow: 'paginated', anim: 'slide', autoNight: 1, goal: 10, yearGoal: 24, ruler: 0, spp: 50 };

let pdf = null, pdfPage = 1, pdfZoom = 1, pdfObs = null;
let X, S, book, rend, B, el, chromeOn = true, sel = null, history = [], saveT, minT, lastAct = Date.now(), turnAt = Date.now(), speaking = false, locReady = false, curLoc = null;

const $ = s => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const load = src => new Promise((res, rej) => { if ([...document.scripts].some(s => s.src === src)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('The reader could not load. Check your internet connection and try again.')); document.head.appendChild(s); });
const saveS = () => X.ls.set('hq-rd', S);
const fmtMin = m => { m = Math.max(1, Math.round(m)); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return h + ' h' + (r ? ' ' + r + ' min' : ''); };
const marks = () => X.D.highlights.filter(h => h.bookId === B.id && !X.yes(h.void));

/* ---------- getting the file ---------- */
async function bytes() {
  let c = null; try { c = await caches.open('hq-books'); } catch (e) {}
  const key = './book/' + B.id;
  const hit = c && await c.match(key);
  if (hit) return hit.arrayBuffer();
  if (!X.live()) throw new Error('Connect your Google Sheet in Settings first, so HQ can fetch the book from Drive.');
  status('Downloading the book from Drive…');
  let j;
  try { j = await X.api({ action: 'book', id: B.id }); }
  catch (e) { if (/Unknown action/.test(e.message)) throw new Error('Your bridge script needs the new version before books open here. Ask Claude for the latest script, or open the book in Drive for now.'); throw e; }
  const bin = atob(j.data), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  try { if (c) await c.put(key, new Response(u, { headers: { 'Content-Type': 'application/epub+zip' } })); } catch (e) {}
  return u.buffer;
}
async function cachedLocations() { try { const c = await caches.open('hq-books'); const r = await c.match('./loc/' + B.id); return r ? r.text() : null; } catch (e) { return null; } }
async function storeLocations(s) { try { const c = await caches.open('hq-books'); await c.put('./loc/' + B.id, new Response(s)); } catch (e) {} }

/* ---------- shell ---------- */
function shell() {
  el = document.createElement('div'); el.id = 'rdr'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Reading ' + B.title);
  el.innerHTML = `<style>
#rdr{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;background:var(--rbg);color:var(--rfg);font-family:Inter,-apple-system,system-ui,sans-serif}
#rdr button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
#rdr .rtop,#rdr .rbot{display:flex;align-items:center;gap:6px;padding:8px 12px;transition:opacity .25s}
#rdr .rtop{padding-top:calc(8px + env(safe-area-inset-top,0px))}#rdr .rbot{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
#rdr.bare .rtop,#rdr.bare .rbot{opacity:0;pointer-events:none}
#rdr .rib{width:40px;height:40px;border-radius:20px;display:grid;place-items:center;background:var(--rui)}#rdr .rib svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#rdr .rib.on svg{fill:currentColor}
#rdr .rttl{flex:1;min-width:0;text-align:center;font-size:13px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rdr .rview{flex:1;min-height:0;position:relative;overflow:hidden;touch-action:pan-y pinch-zoom}#rdr .rview .epub-container{will-change:transform}
#rdr .rprog{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;font-size:12px;opacity:.85;text-align:center}
#rdr .rprog input{width:100%;accent-color:#c6613f}
#rdr .rstat{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:30px;font-size:15px;line-height:1.5}
#rdr .rsheet{position:absolute;left:0;right:0;bottom:0;max-height:58%;overflow:auto;background:var(--rui);border-radius:18px 18px 0 0;padding:14px 16px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.2);z-index:5}
@media(min-width:760px){#rdr .rsheet{left:auto;right:16px;bottom:72px;width:380px;border-radius:16px;max-height:70%}}
#rdr .rsheet h3{margin:4px 0 10px;font-size:17px;font-weight:600;display:flex;align-items:center;justify-content:space-between}
#rdr .rsec{border-top:.5px solid rgba(128,128,128,.25)}#rdr .rsec:first-of-type{border-top:0}#rdr .rsec summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:12px 2px;font-size:15px;font-weight:600;cursor:pointer}#rdr .rsec summary::-webkit-details-marker{display:none}#rdr .rchev{font-size:20px;opacity:.5;transition:transform .2s}#rdr .rsec[open] .rchev{transform:rotate(90deg)}#rdr .rsecb{padding:0 0 10px}#rdr .rsecb .rrow:last-child{border-bottom:0}
#rdr .rsheet h4{margin:14px 0 6px;font-size:12px;opacity:.65;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
#rdr .rrow{display:flex;gap:10px;align-items:center;width:100%;text-align:left;padding:10px 4px;border-bottom:.5px solid rgba(128,128,128,.25);font-size:15px}
#rdr .rrow small{opacity:.6;margin-left:auto;font-size:12px;flex:none}
#rdr .rrow.cur{color:#c6613f;font-weight:600}
#rdr .rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
#rdr .rth{border-radius:12px;padding:10px 8px;border:2px solid transparent;font-size:13px;text-align:center}#rdr .rth.on{border-color:#c6613f}
#rdr .rth b{display:block;font:600 20px Georgia,serif;margin-bottom:2px}
#rdr .rfonts{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px 0 6px}#rdr .rfonts::-webkit-scrollbar{display:none}#rdr .rfonts button{flex:0 0 auto;min-width:74px;padding:10px 12px;border-radius:12px;background:rgba(128,128,128,.14);font-size:16px;line-height:1.1;text-align:center}#rdr .rfonts button small{display:block;font-size:11px;opacity:.7;margin-top:3px;font-family:-apple-system,system-ui,sans-serif}#rdr .rfonts button.on{outline:2px solid #c6613f;background:var(--rbg)}
#rdr .rsize{display:flex;align-items:center;gap:8px}#rdr .rsize button{flex:1 1 0;min-width:0;height:44px;padding:0 10px;border-radius:12px;background:rgba(128,128,128,.14)}#rdr .rsize span{min-width:56px;text-align:center;font-size:13px;opacity:.8}
#rdr .rseg{display:flex;background:rgba(128,128,128,.18);border-radius:10px;padding:2px;gap:2px}#rdr .rseg button{flex:1;padding:7px 4px;border-radius:8px;font-size:13px}#rdr .rseg button.on{background:var(--rbg);font-weight:600}
#rdr .rline{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:14px}#rdr .rline span{min-width:96px}#rdr .rline input[type=range]{flex:1;accent-color:#c6613f}
#rdr .rbtn{padding:9px 14px;border-radius:10px;background:rgba(128,128,128,.18);font-size:14px}#rdr .rbtn.y{background:#ffd60a;color:#000;font-weight:600}
#rdr .rsel{position:absolute;left:50%;transform:translateX(-50%);top:62px;z-index:6;background:var(--rui);border-radius:12px;box-shadow:0 6px 22px rgba(0,0,0,.22);padding:4px;max-width:94vw}
#rdr .rsel .rsrow{display:flex;flex-wrap:nowrap;gap:2px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;white-space:nowrap}#rdr .rsel .rsrow::-webkit-scrollbar{display:none}
#rdr .rsel .rsrow+.rrow{border-top:1px solid rgba(128,128,128,.2);margin-top:4px;padding-top:4px}
#rdr .rsel button{flex:0 0 auto;padding:7px 10px;border-radius:8px;font-size:13px;display:inline-flex;align-items:center;gap:5px}#rdr .rsel button:hover,#rdr .rsel button.on{background:rgba(128,128,128,.2)}
#rdr .rsel .caret{font-size:9px;opacity:.6}
#rdr .sw{width:22px;height:22px;border-radius:11px;display:inline-block;vertical-align:middle;border:1px solid rgba(0,0,0,.1)}
#rdr .rq{font-family:"Source Serif 4",Georgia,serif;font-size:15px;line-height:1.45;border-left:3px solid var(--c,#ffe066);padding-left:10px;margin:2px 0}
#rdr .rcard{background:var(--rbg);border-radius:14px;padding:22px 18px;min-height:150px;display:grid;place-items:center;text-align:center;font:17px/1.5 "Source Serif 4",Georgia,serif}
#rdr .rruler{position:absolute;left:0;right:0;height:64px;pointer-events:none;background:rgba(255,214,10,.16);border-top:1px solid rgba(198,97,63,.5);border-bottom:1px solid rgba(198,97,63,.5);z-index:3}
#rdr input[type=search],#rdr textarea,#rdr input[type=number]{width:100%;padding:10px 12px;border-radius:10px;border:0;background:var(--rbg);color:var(--rfg);font:inherit;font-size:16px}
#rdr .rpdf{position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:8px 0}#rdr .rpg{position:relative;margin:0 auto 10px;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.15)}#rdr .rpg canvas{display:block;width:100%;height:100%}
#rdr .textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;opacity:1}#rdr .textLayer span,#rdr .textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0}#rdr .textLayer ::selection{background:rgba(255,214,10,.45)}
#rdr.pdfdark .rpg canvas{filter:invert(.92) hue-rotate(180deg)}#rdr.pdfwarm .rpg canvas{filter:sepia(.25)}
#rdr .ring{display:flex;align-items:center;gap:14px;margin:6px 0 4px}#rdr .ring svg{width:64px;height:64px}
</style>
<div class="rtop"><button class="rib" data-r="close" aria-label="Close book"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
 <div class="rttl" id="r-ttl">${esc(B.title)}</div>
 <button class="rib" data-r="search" aria-label="Search this book"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg></button>
 <button class="rib" data-r="aa" aria-label="Themes and settings"><svg viewBox="0 0 24 24"><path d="M3 18l5-12 5 12M4.8 14h6.4M14 18l3.5-8 3.5 8M15.2 15.5h4.6"/></svg></button>
 <button class="rib" data-r="bm" id="r-bm" aria-label="Bookmark this page"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-5-6 5z"/></svg></button></div>
<div class="rview" id="r-view"><div class="rstat" id="r-stat">Opening the book…</div></div>
<div class="rbot"><button class="rib" data-r="back" id="r-back" aria-label="Go back to where you were"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
 <div class="rprog"><input type="range" id="r-slide" min="0" max="1000" value="0" aria-label="Go to a place in the book"><span id="r-left">Working out pages…</span></div>
 <button class="rib" data-r="more" aria-label="Book menu"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg></button></div>`;
  document.body.appendChild(el);
  document.documentElement.style.overflow = 'hidden';
  paint();
  el.addEventListener('click', onClick);
  $('#r-slide').addEventListener('change', e => { if (pdf) { remember(); pdfGo(1 + Math.round(e.target.value / 1000 * (pdf.numPages - 1))); return; } if (!locReady) { X.say('Still working out pages. Try again in a moment.'); return; } remember(); rend.display(book.locations.cfiFromPercentage(e.target.value / 1000)); });
  document.addEventListener('keydown', onKey);
}
function status(t) { const s = $('#r-stat'); if (s) s.textContent = t; }
function themeKey() { if (S.autoNight && matchMedia('(prefers-color-scheme: dark)').matches && !THEMES[S.theme].dark) return 'night'; return S.theme; }
function paint() {
  const t = THEMES[themeKey()];
  el.style.setProperty('--rbg', t.bg); el.style.setProperty('--rfg', t.fg); el.style.setProperty('--rui', t.ui);
  const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = t.bg;
  el.classList.toggle('pdfdark', !!(pdf && t.dark)); el.classList.toggle('pdfwarm', !!(pdf && /calm|paper/.test(themeKey())));
  if (!rend) return;
  const f = FONTS[S.font][1];
  const body = { 'background': t.bg + ' !important', 'color': t.fg + ' !important', 'line-height': S.lh + ' !important', 'letter-spacing': (S.sp / 100) + 'em', 'text-align': S.justify ? 'justify' : 'start', 'hyphens': S.justify ? 'auto' : 'manual', 'padding': '0 ' + (S.margin * 0.6) + 'em !important' };
  if (f) body['font-family'] = f + ' !important';
  if (t.weight) body['font-weight'] = t.weight + ' !important';
  body['font-size'] = S.size + '% !important';
  rend.themes.default({ 'html': { 'font-size': '100% !important' }, body, 'p,li,div,span,blockquote,dd,dt,td,th,pre,section,article': Object.assign({ 'line-height': S.lh + ' !important', 'font-size': '1em !important' }, f ? { 'font-family': f + ' !important' } : {}), 'small,sub,sup': { 'font-size': '0.8em !important' }, 'h1': { 'font-size': '1.6em !important', 'line-height': '1.25 !important' }, 'h2': { 'font-size': '1.35em !important', 'line-height': '1.3 !important' }, 'h3': { 'font-size': '1.15em !important' }, 'h4,h5,h6': { 'font-size': '1em !important' }, 'a': { color: t.dark ? '#9cc3ff !important' : '#1f5fbf !important' }, 'img': { 'max-width': '100% !important' }, '::selection': { background: 'rgba(255,214,10,.45)' } });
  rend.themes.fontSize(S.size + '%');
  try { if (f) rend.themes.override('font-family', f, true); else rend.themes.override('font-family', '', false); } catch (e) {}
}

/* ---------- open ---------- */
async function open(b, ctx) {
  X = ctx; B = b; S = Object.assign({}, DEF, X.ls.get('hq-rd', {}));
  history = []; sel = null; locReady = false; curLoc = null;
  shell();
  try {
    const buf = await bytes();
    const head = new Uint8Array(buf.slice(0, 5)); const isPdf = B.format === 'pdf' || String.fromCharCode(...head) === '%PDF-';
    if (isPdf) { await openPdf(buf); clearInterval(minT); minT = setInterval(tick, 30000); return; }
    await load(LIBS[0]); await load(LIBS[1]); B._buf = buf;
    status('Opening the book…');
    book = window.ePub(B._buf); delete B._buf;
    await book.ready;
    $('#r-stat').remove();
    makeRendition();
    const start = B.cfi || undefined;
    await rend.display(start);
    attach();
    const nav = await book.loaded.navigation; B._toc = nav.toc || [];
    const saved = await cachedLocations();
    if (saved) { book.locations.load(saved); locReady = true; place(); }
    else setTimeout(async () => { try { await book.locations.generate(1600); storeLocations(book.locations.save()); locReady = true; place(); } catch (e) {} }, 400);
    clearInterval(minT); minT = setInterval(tick, 30000);
    if (S.ruler) ruler(true);
  } catch (e) {
    status(e.message || String(e));
    const s = $('#r-stat'); if (s) s.insertAdjacentHTML('beforeend', `<div style="margin-top:14px">${X.link(B) ? `<a class="rbtn y" style="text-decoration:none;display:inline-block" href="${esc(X.link(B))}" target="_blank" rel="noopener">Open in Drive</a>` : ''}</div>`);
  }
}
let swiped = 0, turning = false;
function markOn(btn) { const p = btn.parentElement; p.querySelectorAll('.on').forEach(x => x.classList.remove('on')); btn.classList.add('on'); }
function stage() { return el.querySelector('#r-view .epub-container') || el.querySelector('#r-view'); }
const EASE = 'cubic-bezier(.2,.8,.2,1)';
/* Turn a page with a Kindle / Apple Books style slide. from = how far the finger already dragged (px). */
async function turn(dir, from) {
  if (!rend || turning) return; if (sel) closeSel();
  const go = () => dir > 0 ? rend.next() : rend.prev();
  if (S.flow !== 'paginated' || S.anim === 'none' || matchMedia('(prefers-reduced-motion: reduce)').matches) { snap(); return go(); }
  turning = true; const st = stage(), w = st.clientWidth || innerWidth;
  try {
    if (S.anim === 'fade') {
      st.style.transition = 'opacity .14s ease'; st.style.opacity = '0'; await wait(140); await go();
      st.style.opacity = '0'; await wait(16); st.style.transition = 'opacity .2s ease'; st.style.opacity = '1'; await wait(200);
    } else {
      const left = Math.max(120, 260 * (1 - Math.abs(from || 0) / w));
      st.style.transition = `transform ${left}ms ${EASE}, opacity ${left}ms ease`; st.style.transform = `translateX(${-dir * w}px)`; st.style.opacity = '.4'; await wait(left);
      st.style.transition = 'none'; st.style.opacity = '0'; await go();
      st.style.transform = `translateX(${dir * w * 0.35}px)`; void st.offsetWidth;
      st.style.transition = `transform 240ms ${EASE}, opacity 200ms ease`; st.style.transform = 'translateX(0)'; st.style.opacity = '1'; await wait(240);
    }
  } finally { snap(); turning = false; }
}
function snap() { const st = stage(); if (!st) return; st.style.transition = ''; st.style.transform = ''; st.style.opacity = ''; }
const wait = ms => new Promise(r => setTimeout(r, ms));
function makeRendition() {
  const v = $('#r-view'); v.innerHTML = '';
  rend = book.renderTo(v, { width: '100%', height: '100%', flow: S.flow, manager: S.flow === 'scrolled' ? 'continuous' : 'default', spread: innerWidth > 1000 ? 'auto' : 'none', allowScriptedContent: false });
  paint();
  rend.on('relocated', loc => { curLoc = loc; place(); queueSave(); if (speaking) speakPage(); const now = Date.now(), dt = (now - turnAt) / 1000; turnAt = now; if (dt > 4 && dt < 240 && S.flow === 'paginated') { S.spp = Math.round(S.spp * 0.85 + dt * 0.15); saveS(); } lastAct = now; });
  rend.on('selected', (cfi, contents) => { const t = contents.window.getSelection().toString().trim(); if (!t) return; sel = { cfi, text: t, contents }; selBar(); lastAct = Date.now(); });
  rend.on('click', e => { lastAct = Date.now(); if (Date.now() - swiped < 500) return; if (sel && !e.view.getSelection().toString()) { closeSel(); } else if (!e.view.getSelection().toString()) tapZone(e); });
  rend.on('keyup', onKey);
  rend.hooks.content.register(c => {
    const d = c.document; let t0 = null;
    if (S.flow === 'paginated') d.documentElement.style.touchAction = 'pan-y pinch-zoom';
    d.addEventListener('touchstart', e => { lastAct = Date.now(); const t = e.touches[0]; t0 = e.touches.length === 1 && !turning ? { x: t.clientX, y: t.clientY, at: Date.now(), drag: false } : null; }, { passive: true });
    d.addEventListener('touchmove', e => {
      if (!t0 || S.flow !== 'paginated' || e.touches.length !== 1) return; const t = e.touches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
      if (!t0.drag) { if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2 || String(c.window.getSelection() || '').trim()) return; t0.drag = true; }
      if (S.anim === 'slide') { const st = stage(); st.style.transition = 'none'; st.style.transform = `translateX(${dx * 0.9}px)`; }
    }, { passive: true });
    const end = e => {
      if (!t0 || S.flow !== 'paginated') { t0 = null; return; } const t = e.changedTouches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y, dt = Date.now() - t0.at, drag = t0.drag; t0 = null;
      if (!drag && String(c.window.getSelection() || '').trim()) return;
      const w = stage().clientWidth || innerWidth, fast = dt < 300 && Math.abs(dx) > 30;
      if (drag || (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3)) {
        swiped = Date.now();
        if (Math.abs(dx) > w * 0.18 || fast) turn(dx < 0 ? 1 : -1, dx);
        else { const st = stage(); st.style.transition = `transform 200ms ${EASE}`; st.style.transform = 'translateX(0)'; setTimeout(snap, 220); }
      }
    };
    d.addEventListener('touchend', end, { passive: true }); d.addEventListener('touchcancel', end, { passive: true });
  });
  rend.on('markClicked', (cfi, data) => { const h = marks().find(m => m.cfi === cfi); if (h) noteSheet(h); });
}
function attach() { marks().forEach(drawMark); bmState(); }
function drawMark(h) {
  if (!h.cfi || !rend || pdf) return;
  try {
    if (h.kind === 'bookmark' || h.kind === 'word') return;
    if (h.style === 'u') rend.annotations.underline(h.cfi, { id: h.id }, null, 'hq-u', { stroke: COLS[h.colour] ? COLS[h.colour][1] : '#c6613f', 'stroke-width': '2px', 'stroke-opacity': '1' });
    else rend.annotations.highlight(h.cfi, { id: h.id }, null, 'hq-h', { fill: (COLS[h.colour] || COLS.y)[1], 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' });
  } catch (e) {}
}
function undraw(h) { if (pdf) return; try { rend.annotations.remove(h.cfi, h.style === 'u' ? 'underline' : 'highlight'); } catch (e) {} }

/* ---------- position, progress, time left ---------- */
function chapterLabel(loc) {
  if (pdf) return 'p. ' + pdfPage;
  const href = loc && loc.start && loc.start.href; if (!href || !B._toc) return '';
  let best = ''; const walk = (items) => items.forEach(i => { if (i.href && href.split('#')[0].endsWith(i.href.split('#')[0])) best = best || i.label.trim(); if (i.subitems) walk(i.subitems); }); walk(B._toc);
  return best;
}
function place() {
  if (pdf) { $('#r-ttl').textContent = B.title; $('#r-slide').value = Math.round((pdfPage - 1) / Math.max(1, pdf.numPages - 1) * 1000); const pct = pdfPage / pdf.numPages; const tot = Number(B.minutes) || pdf.numPages * 2; $('#r-left').textContent = 'Page ' + pdfPage + ' of ' + pdf.numPages + (pct < 1 ? ' · ' + fmtMin(tot * (1 - pct)) + ' left' : ''); bmState(); return; }
  const loc = curLoc || (rend && rend.currentLocation()); if (!loc || !loc.start) return;
  const ch = chapterLabel(loc); $('#r-ttl').textContent = ch ? ch : B.title;
  let pct = null; if (locReady) { pct = book.locations.percentageFromCfi(loc.start.cfi); $('#r-slide').value = Math.round(pct * 1000); }
  const parts = [];
  if (pct != null) parts.push(Math.round(pct * 100) + '%');
  const d = loc.start.displayed;
  if (S.flow === 'paginated' && d && d.total) { const left = Math.max(0, d.total - d.page); parts.push(left ? fmtMin(left * S.spp / 60) + ' left in chapter' : 'Last page of chapter'); }
  if (pct != null) { const tot = Number(B.minutes) || (book.locations.length() * 1600 / 5.5 / 230); const rem = tot * (1 - pct); if (rem > 1) parts.push(fmtMin(rem) + ' left in book'); }
  $('#r-left').textContent = parts.join(' · ') || ' ';
  bmState();
}
function queueSave() {
  clearTimeout(saveT); saveT = setTimeout(savePos, 4000);
}
function savePos() {
  const loc = curLoc; if (!loc || !loc.start) return;
  const pct = pdf ? pdfPage / pdf.numPages : locReady ? book.locations.percentageFromCfi(loc.start.cfi) : Number(B.position) || 0;
  const fields = { cfi: loc.start.cfi, position: String(Math.round(pct * 1000) / 1000), lastRead: X.today(), updated: X.today() };
  if (pct >= 0.995 && !B.finished) fields.finished = X.today();
  Object.assign(B, fields); X.ls.set('hq-data', X.D);
  if (X.live()) X.post({ action: 'patch', name: 'books', id: B.id, fields }).catch(() => { B._unsaved = 1; });
}
function remember() { const l = curLoc || (rend && rend.currentLocation()); if (l && l.start) history.push(l.start.cfi); }

/* ---------- reading goals (Apple Books) ---------- */
function tick() {
  if (document.hidden || Date.now() - lastAct > 150000) return;
  const L = X.D.reading_log || (X.D.reading_log = []); const id = 'r-' + X.today();
  let r = L.find(x => x.id === id); if (!r) { r = { id, date: X.today(), minutes: '0', bookId: '' }; L.push(r); }
  r.minutes = String(Math.round((Number(r.minutes) + 0.5) * 10) / 10); r.bookId = B.id; r.updated = X.today();
  X.ls.set('hq-data', X.D);
  if (Number(r.minutes) % 2 === 0 && X.live()) X.post({ action: 'patch', name: 'reading_log', id, fields: { date: r.date, minutes: r.minutes, bookId: r.bookId, updated: r.updated } }).catch(() => {});
  if (Math.abs(Number(r.minutes) - S.goal) < 0.25) X.say('Daily reading goal reached. Well done.');
}
function goalStats() {
  const L = (X.D.reading_log || []).filter(r => !X.yes(r.void)); const by = {}; L.forEach(r => { by[r.date] = (by[r.date] || 0) + Number(r.minutes || 0); });
  const today = by[X.today()] || 0; let streak = 0; const d = new Date();
  if ((by[X.today()] || 0) < S.goal) d.setDate(d.getDate() - 1);
  for (;;) { const k = X.ymd(d); if ((by[k] || 0) >= S.goal) { streak++; d.setDate(d.getDate() - 1); } else break; }
  const yr = String(new Date().getFullYear()); const done = X.D.books.filter(b => !X.yes(b.void) && String(b.finished || '').startsWith(yr)).length;
  return { today, streak, done };
}

/* ---------- taps, keys, chrome ---------- */
function tapZone(e) {
  const vb = $('#r-view').getBoundingClientRect(), w = vb.width || innerWidth; let x = e.clientX;
  try { const fr = e.view.frameElement.getBoundingClientRect(); x = fr.left + e.clientX - vb.left; } catch (er) { if (x > w) x = x % w; }
  if (S.ruler) { const r = $('.rruler'); if (r) r.style.top = (e.clientY - 32 + 56) + 'px'; }
  if (S.flow === 'paginated' && x < w * 0.28) return turn(-1);
  if (S.flow === 'paginated' && x > w * 0.72) return turn(1);
  chromeOn = !chromeOn; el.classList.toggle('bare', !chromeOn);
}
function onKey(e) {
  if (!el || !el.isConnected) return; const t = e.target && e.target.tagName; if (t === 'INPUT' || t === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { e.preventDefault && e.preventDefault(); if (pdf) pdfGo(pdfPage + 1); else turn(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { if (pdf) pdfGo(pdfPage - 1); else turn(-1); }
  else if (e.key === 'Escape') { if (el.querySelector('.rsheet,.rsel')) closeSheet(); else close(); }
}

/* ---------- sheets ---------- */
function sheet(html) { closeSheet(); el.insertAdjacentHTML('beforeend', `<div class="rsheet" role="dialog">${html}</div>`); chromeOn = true; el.classList.remove('bare'); return el.querySelector('.rsheet'); }
function closeSheet() { el.querySelectorAll('.rsheet,.rsel').forEach(x => x.remove()); }
const hd = (t) => `<h3>${t}<button class="rbtn" data-r="x">Done</button></h3>`;
/* A section that can be opened or closed; remembers its state. */
function sec(id, title, html, open) {
  const o = S.secs && id in S.secs ? S.secs[id] : open;
  return `<details class="rsec" data-sec="${id}"${o ? ' open' : ''}><summary>${title}<span class="rchev" aria-hidden="true">›</span></summary><div class="rsecb">${html}</div></details>`;
}
function watchSecs(box) { box.querySelectorAll('details[data-sec]').forEach(d => d.addEventListener('toggle', () => { S.secs = Object.assign({}, S.secs, { [d.dataset.sec]: d.open }); saveS(); })); }
function aaSheet() {
  if (pdf) { sheet(`${hd('Themes &amp; Settings')}<div class="rline" style="justify-content:space-between"><button class="rbtn" data-r="zoom" data-v="-0.15" aria-label="Zoom out">−</button><span style="text-align:center;flex:1">Zoom ${Math.round(pdfZoom * 100)}%</span><button class="rbtn" data-r="zoom" data-v="0.15" aria-label="Zoom in">+</button></div><div class="rgrid">${Object.entries(THEMES).map(([k, t]) => `<button class="rth${S.theme === k ? ' on' : ''}" data-r="th" data-v="${k}" style="background:${t.bg};color:${t.fg}"><b>Aa</b>${t.name}</button>`).join('')}</div><div class="rline"><span>Match dark mode</span><button class="rbtn" data-r="tog" data-v="autoNight">${S.autoNight ? 'On' : 'Off'}</button></div><div class="rline"><span>Reading ruler</span><button class="rbtn" data-r="tog" data-v="ruler">${S.ruler ? 'On' : 'Off'}</button></div><p style="font-size:13px;opacity:.7">This is a PDF, so its pages keep their printed layout. Fonts and spacing apply to EPUB books.</p>`); return; }
  const s = sheet(`${hd('Themes &amp; Settings')}
  ${sec('text', 'Text size &amp; font', `<div class="rsize"><button data-r="fs" data-v="-10" aria-label="Smaller text" style="font-size:14px">A</button><span id="r-fsv">${S.size}%</span><button data-r="fs" data-v="10" aria-label="Larger text" style="font-size:22px">A</button></div><div class="rfonts">${Object.entries(FONTS).map(([k, f]) => `<button class="${S.font === k ? 'on' : ''}" data-r="font" data-v="${k}" style="${f[1] ? 'font-family:' + f[1].replace(/"/g, "'") : ''}">Aa<small>${f[0]}</small></button>`).join('')}</div>`, true)}
  ${sec('theme', 'Theme', `<div class="rgrid">${Object.entries(THEMES).map(([k, t]) => `<button class="rth${S.theme === k ? ' on' : ''}" data-r="th" data-v="${k}" style="background:${t.bg};color:${t.fg}${t.weight ? ';font-weight:700' : ''}"><b>Aa</b>${t.name}</button>`).join('')}</div><div class="rline"><span>Match dark mode</span><button class="rbtn" data-r="tog" data-v="autoNight">${S.autoNight ? 'On' : 'Off'}</button></div>`, false)}
  ${sec('layout', 'Spacing &amp; margins', `<div class="rline"><span>Line spacing</span><input type="range" min="1.1" max="2.2" step="0.1" value="${S.lh}" data-set="lh"></div><div class="rline"><span>Letter spacing</span><input type="range" min="0" max="12" step="1" value="${S.sp}" data-set="sp"></div><div class="rline"><span>Margins</span><input type="range" min="0" max="5" step="1" value="${S.margin}" data-set="margin"></div><div class="rline"><span>Justify text</span><button class="rbtn" data-r="tog" data-v="justify">${S.justify ? 'On' : 'Off'}</button></div>`, false)}
  ${sec('turn', 'Page turning', `<div class="rline"><span>Page turn</span><div class="rseg" style="flex:1"><button class="${S.flow === 'paginated' ? 'on' : ''}" data-r="flow" data-v="paginated">Pages</button><button class="${S.flow === 'scrolled' ? 'on' : ''}" data-r="flow" data-v="scrolled">Scroll</button></div></div><div class="rline"><span>Animation</span><div class="rseg" style="flex:1">${[['slide', 'Slide'], ['fade', 'Fade'], ['none', 'None']].map(([k, n]) => `<button class="${S.anim === k ? 'on' : ''}" data-r="anim" data-v="${k}">${n}</button>`).join('')}</div></div>`, false)}
  ${sec('tools', 'Reading tools', `<div class="rline"><span>Reading ruler</span><button class="rbtn" data-r="tog" data-v="ruler">${S.ruler ? 'On' : 'Off'}</button></div><button class="rbtn" data-r="reset" style="margin-top:6px">Reset to defaults</button>`, false)}`);
  watchSecs(s);
  s.querySelectorAll('[data-set]').forEach(i => i.oninput = () => { S[i.dataset.set] = Number(i.value); saveS(); paint(); });
}
function moreSheet() {
  const g = goalStats(); const pc = Math.min(1, g.today / S.goal), C = 2 * Math.PI * 26;
  sheet(`${hd(esc(B.title))}
  <div class="ring"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" stroke="rgba(128,128,128,.25)" stroke-width="6" fill="none"/><circle cx="32" cy="32" r="26" stroke="#c6613f" stroke-width="6" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pc)}" transform="rotate(-90 32 32)"/></svg><div><b>${Math.round(g.today)} of ${S.goal} min today</b><br><small style="opacity:.7">${g.streak ? g.streak + '-day streak · ' : ''}${g.done} of ${S.yearGoal} books finished this year</small></div></div>
  ${sec('nav', 'Find your way', `<button class="rrow" data-r="toc">Contents<small>${B._toc ? B._toc.length + ' parts' : ''}</small></button><button class="rrow" data-r="search">Search book</button><button class="rrow" data-r="goto">Go to page or %</button><button class="rrow" data-r="bms">Bookmarks<small>${marks().filter(m => m.kind === 'bookmark').length}</small></button>`, true)}
  ${sec('mine', 'Highlights &amp; study', `<button class="rrow" data-r="notes">Highlights &amp; Notes<small>${marks().filter(m => !m.kind || m.kind === 'highlight').length}</small></button><button class="rrow" data-r="cards">Study cards<small>from your highlights</small></button><button class="rrow" data-r="words">Vocabulary<small>${marks().filter(m => m.kind === 'word').length} words</small></button><button class="rrow" data-r="export">Send all notes to HQ Notes</button>`, false)}
  ${sec('listen', 'Listen &amp; Claude', `<button class="rrow" data-r="speak">${speaking ? 'Stop reading aloud' : 'Read aloud'}</button><button class="rrow" data-r="recap">Story so far<small>recap with Claude</small></button>`, false)}
  ${sec('progress', 'Goals &amp; book', `<button class="rrow" data-r="goal">Reading goals</button><button class="rrow" data-r="finish">${B.finished ? 'Mark as still reading' : 'Mark as finished'}</button>${X.link(B) ? `<a class="rrow" style="color:inherit;text-decoration:none" href="${esc(X.link(B))}" target="_blank" rel="noopener">Open file in Google Drive</a>` : ''}`, false)}`);
  watchSecs(el.querySelector('.rsheet'));
}
function tocSheet() {
  if (pdf) { pdfToc(); return; }
  const href = curLoc && curLoc.start && curLoc.start.href || '';
  const rows = []; const walk = (items, d) => items.forEach(i => { rows.push(`<button class="rrow${href && href.endsWith(i.href.split('#')[0]) ? ' cur' : ''}" data-r="go" data-v="${esc(i.href)}" style="padding-left:${4 + d * 16}px">${esc(i.label.trim())}</button>`); if (i.subitems && i.subitems.length) walk(i.subitems, d + 1); });
  walk(B._toc || [], 0);
  sheet(hd('Contents') + (rows.join('') || '<p>This book has no table of contents.</p>'));
}
function notesSheet() {
  const hs = marks().filter(m => !m.kind || m.kind === 'highlight').sort((a, b) => (a.cfi || '').localeCompare(b.cfi || '', undefined, { numeric: true }));
  sheet(`${hd('Highlights &amp; Notes')}${hs.length ? '' : '<p>Select any text, then choose a colour to highlight it.</p>'}
  ${hs.map(h => `<button class="rrow" data-r="jump" data-v="${esc(h.cfi)}" style="display:block"><div class="rq" style="--c:${(COLS[h.colour] || COLS.y)[1]}${h.style === 'u' ? ';text-decoration:underline' : ''}">${esc(h.passage)}</div>${h.note ? `<div style="font-size:14px;margin:4px 0 0 13px">${esc(h.note)}</div>` : ''}<div style="font-size:12px;opacity:.6;margin:4px 0 0 13px">${esc(h.chapter || '')} · ${esc(h.date || '')}</div></button>`).join('')}
  ${hs.length ? '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="rbtn y" data-r="export">Send to HQ Notes</button><button class="rbtn" data-r="copyall">Copy all</button><button class="rbtn" data-r="cards">Study cards</button></div>' : ''}`);
}
function bmsSheet() {
  const bs = marks().filter(m => m.kind === 'bookmark');
  sheet(hd('Bookmarks') + (bs.map(h => `<button class="rrow" data-r="jump" data-v="${esc(h.cfi)}">${esc(h.chapter || 'Bookmark')}<small>${esc(h.passage ? h.passage.slice(0, 40) + '…' : h.date)}</small></button>`).join('') || '<p>Tap the bookmark at the top right to mark a page.</p>'));
}
let cardI = 0, cardFlip = false;
function cardsSheet() {
  const hs = marks().filter(m => (!m.kind || m.kind === 'highlight'));
  if (!hs.length) { sheet(hd('Study cards') + '<p>Highlight passages first. Each highlight becomes a card: the front shows where it is, the back shows the words and your note.</p>'); return; }
  cardI = Math.min(cardI, hs.length - 1); const h = hs[cardI];
  sheet(`${hd('Study cards')}<p style="opacity:.65;font-size:13px;margin:0 0 8px">Card ${cardI + 1} of ${hs.length}. Tap the card to flip it.</p>
  <button class="rcard" data-r="flip" style="width:100%">${cardFlip ? `<span>${esc(h.passage)}${h.note ? `<br><br><i style="font-size:15px">${esc(h.note)}</i>` : ''}</span>` : `<span><b>${esc(h.chapter || B.title)}</b><br><small style="opacity:.7">${h.note ? 'Your note: ' + esc(h.note) : 'What did this passage say?'}</small></span>`}</button>
  <div style="display:flex;gap:8px;justify-content:space-between;margin-top:10px"><button class="rbtn" data-r="cardp">Previous</button><button class="rbtn" data-r="jump" data-v="${esc(h.cfi)}">Show in book</button><button class="rbtn" data-r="cardn">Next</button></div>`);
}
function wordsSheet() {
  const ws = marks().filter(m => m.kind === 'word');
  sheet(hd('Vocabulary') + '<p style="font-size:13px;opacity:.7;margin:0 0 6px">Words you looked up while reading, with the sentence they came from.</p>' + (ws.map(w => `<div class="rrow" style="display:block"><b>${esc(w.passage)}</b> <a href="${dictUrl(w.passage)}" target="_blank" rel="noopener" style="font-size:13px;color:#c6613f">Define</a><div style="font-size:14px;opacity:.75;margin-top:3px">${esc(w.note || '')}</div></div>`).join('') || '<p>Select a word and choose Look up to save it here.</p>'));
}
function searchSheet(q) {
  const s = sheet(`${hd('Search book')}<input type="search" id="r-q" placeholder="Word or phrase" value="${esc(q || '')}"><div id="r-res" style="margin-top:8px"></div>`);
  const i = s.querySelector('#r-q'); setTimeout(() => i.focus(), 60);
  let t; i.oninput = () => { clearTimeout(t); t = setTimeout(() => runSearch(i.value.trim()), 350); }; if (q) runSearch(q);
}
async function runSearch(q) {
  const out = el.querySelector('#r-res'); if (!out) return; if (q.length < 2) { out.innerHTML = ''; return; }
  out.innerHTML = '<p style="opacity:.6">Searching…</p>'; const found = [];
  if (pdf) { const ql = q.toLowerCase(); for (let n = 1; n <= pdf.numPages && found.length <= 150; n++) { try { const tc = await (await pdf.getPage(n)).getTextContent(); const tx = tc.items.map(i => i.str).join(' '); let i = tx.toLowerCase().indexOf(ql); while (i >= 0 && found.length <= 150) { found.push({ cfi: 'pdf:' + n, excerpt: 'p. ' + n + ': …' + tx.slice(Math.max(0, i - 60), i + q.length + 60) + '…' }); i = tx.toLowerCase().indexOf(ql, i + q.length); } } catch (e) {} } }
  else
  for (const item of book.spine.spineItems) {
    try { await item.load(book.load.bind(book)); (item.find(q) || []).forEach(r => found.push(r)); item.unload(); } catch (e) {}
    if (found.length > 150) break;
  }
  if (!el.querySelector('#r-res')) return;
  out.innerHTML = found.length ? `<p style="opacity:.6;font-size:13px">${found.length}${found.length > 150 ? '+' : ''} results</p>` + found.map(r => `<button class="rrow" data-r="jump" data-v="${esc(r.cfi)}" style="display:block;font-size:14px">${esc(r.excerpt).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<mark style="background:#ffe066;color:#000">${m}</mark>`)}</button>`).join('') : '<p>No matches in this book.</p>';
}
function gotoSheet() {
  const total = pdf ? pdf.numPages : locReady ? book.locations.length() : 0;
  const s = sheet(`${hd('Go to')}${total ? `<p style="font-size:13px;opacity:.7">This book has ${pdf ? '' : 'about '}${total} pages${pdf ? '' : ' at this size'}.</p>` : '<p style="font-size:13px;opacity:.7">Still working out pages. Percent works already once that finishes.</p>'}
  <div class="rline"><span>Page</span><input type="number" id="r-pg" min="1" max="${total || 1}" placeholder="${total ? '1–' + total : ''}"></div>
  <div class="rline"><span>Percent</span><input type="number" id="r-pc" min="0" max="100" placeholder="0–100"></div><button class="rbtn y" data-r="dogo">Go</button>`);
}
function goalSheet() {
  const g = goalStats();
  const s = sheet(`${hd('Reading goals')}<p>Today: <b>${Math.round(g.today)} min</b> · Streak: <b>${g.streak} day${g.streak === 1 ? '' : 's'}</b> · Finished this year: <b>${g.done}</b></p>
  <div class="rline"><span>Minutes a day</span><input type="number" id="r-g1" min="1" max="600" value="${S.goal}"></div>
  <div class="rline"><span>Books this year</span><input type="number" id="r-g2" min="1" max="500" value="${S.yearGoal}"></div><button class="rbtn y" data-r="savegoal">Save goals</button>
  <p style="font-size:13px;opacity:.7">Minutes count while a book is open and you're turning pages. They sync to your Sheet (reading_log), so every device adds to the same goal.</p>`);
}
function noteSheet(h) {
  const s = sheet(`${hd('Note')}<div class="rq" style="--c:${(COLS[h.colour] || COLS.y)[1]}">${esc(h.passage)}</div>
  <div style="margin:10px 0">${Object.entries(COLS).map(([k, c]) => `<button class="sw" data-r="recol" data-v="${k}" data-id="${esc(h.id)}" aria-label="${c[0]}" style="background:${c[1]};margin-right:6px${h.colour === k ? ';outline:2px solid #c6613f;outline-offset:2px' : ''}"></button>`).join('')}<button class="rbtn" data-r="ustyle" data-id="${esc(h.id)}" style="margin-left:6px">${h.style === 'u' ? 'Highlight' : 'Underline'}</button></div>
  <textarea id="r-note" rows="4" placeholder="Your thoughts, a sermon idea, a cross-reference">${esc(h.note || '')}</textarea>
  <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="rbtn y" data-r="savenote" data-id="${esc(h.id)}">Save</button><button class="rbtn" data-r="asknote" data-id="${esc(h.id)}">Ask Claude</button><button class="rbtn" data-r="delhl" data-id="${esc(h.id)}">Remove</button></div>`);
  setTimeout(() => { const t = s.querySelector('#r-note'); if (t && !h.note) t.focus(); }, 80);
}

/* ---------- selection menu (Apple Books + Kindle) ---------- */
function selBar() {
  closeSheet();
  const last = COLS[S.hlc] ? S.hlc : 'y';
  el.insertAdjacentHTML('beforeend', `<div class="rsel" role="menu">
  <div class="rsrow"><button data-r="hlpick" aria-expanded="false"><span class="sw" style="width:14px;height:14px;background:${COLS[last][1]}"></span>Highlight <span class="caret">▼</span></button><button data-r="addnote">Note</button><button data-r="copy">Copy</button><button data-r="ask">Ask Claude</button><button data-r="selmore" aria-label="More options" aria-expanded="false">•••</button></div></div>`);
}
function selRow(kind) {
  const box = el.querySelector('.rsel'); if (!box) return;
  const open = box.querySelector('.rsrow[data-k="' + kind + '"]'); box.querySelectorAll('.rsrow[data-k]').forEach(x => x.remove());
  box.querySelectorAll('[aria-expanded]').forEach(b => { b.setAttribute('aria-expanded', 'false'); b.classList.remove('on'); });
  if (open) return;
  const html = kind === 'hl'
    ? Object.entries(COLS).map(([k, c]) => `<button data-r="hl" data-v="${k}" aria-label="Highlight ${c[0]}"><span class="sw" style="background:${c[1]}"></span></button>`).join('') + '<button data-r="ul">Underline</button>'
    : '<button data-r="cite">Copy with source</button><button data-r="lookup">Look up</button><button data-r="translate">Translate</button><button data-r="tonotes">Send to Notes</button><button data-r="findsel">Search</button>';
  box.insertAdjacentHTML('beforeend', `<div class="rsrow" data-k="${kind}">${html}</div>`);
  const b = box.querySelector(kind === 'hl' ? '[data-r="hlpick"]' : '[data-r="selmore"]'); b.setAttribute('aria-expanded', 'true'); b.classList.add('on');
}
function closeSel() { el.querySelectorAll('.rsel').forEach(x => x.remove()); try { sel && sel.contents.window.getSelection().removeAllRanges(); } catch (e) {} sel = null; }
function addMark(kind, colour, style, extra) {
  const h = Object.assign({ id: 'h' + X.uid(), bookId: B.id, passage: sel ? sel.text : '', colour: colour || 'y', note: '', date: X.today(), kind: kind || 'highlight', cfi: sel ? sel.cfi : '', chapter: chapterLabel(curLoc), style: style || '', void: '', updated: X.today() }, extra || {});
  X.D.highlights.push(h); X.touch('highlights'); drawMark(h); return h;
}
const cite = t => `“${t}”\n— ${B.author ? B.author + ', ' : ''}${B.title}${chapterLabel(curLoc) ? ', ' + chapterLabel(curLoc) : ''}`;
const dictUrl = w => 'https://www.google.com/search?q=' + encodeURIComponent('define ' + w);
async function copy(t) { try { await navigator.clipboard.writeText(t); X.say('Copied.'); } catch (e) { X.say("Couldn't copy. Select the text and copy it by hand."); } }
function askClaude(text, q) { window.open('https://claude.ai/new?q=' + encodeURIComponent(`I'm reading "${B.title}"${B.author ? ' by ' + B.author : ''}${chapterLabel(curLoc) ? ', ' + chapterLabel(curLoc) : ''}.\n\n${text ? 'Passage:\n"' + text + '"\n\n' : ''}${q || 'Explain this passage and how I could use it in teaching or preaching. Do not reveal anything from later in the book.'}`), '_blank', 'noopener'); }
function exportNotes() {
  const hs = marks().filter(m => !m.kind || m.kind === 'highlight').sort((a, b) => (a.cfi || '').localeCompare(b.cfi || '', undefined, { numeric: true }));
  if (!hs.length) { X.say('No highlights in this book yet.'); return; }
  let html = `<h1>${esc(B.title)} – highlights</h1><p>${esc(B.author || '')} · exported ${X.today()}</p>`; let ch = null;
  hs.forEach(h => { if (h.chapter !== ch) { ch = h.chapter; html += `<h2>${esc(ch || 'Highlights')}</h2>`; } html += `<blockquote><mark class="m-${esc(h.colour || 'y')}">${esc(h.passage)}</mark></blockquote>${h.note ? `<p>${esc(h.note)}</p>` : ''}`; });
  html += `<p>#book #highlights</p>`;
  X.newNote(B.title + ' – highlights', html, '3. Resources'); X.say('Saved to HQ Notes, in 3. Resources.');
}

/* ---------- read aloud (Kindle Assistive Reader / Apple speak screen) ---------- */
function speakPage() {
  if (!('speechSynthesis' in window)) { X.say('Read aloud is not available in this browser.'); speaking = false; return; }
  speechSynthesis.cancel();
  let text = '';
  if (pdf) { pdf.getPage(pdfPage).then(pg => pg.getTextContent()).then(tc => { const t = tc.items.map(i => i.str).join(' '); if (!t.trim()) { if (speaking) pdfGo(pdfPage + 1); return; } const u = new SpeechSynthesisUtterance(t); u.onend = () => { if (speaking) pdfGo(pdfPage + 1); }; speechSynthesis.speak(u); }); return; }
  try { const c = rend.getContents()[0]; const loc = rend.currentLocation(); const a = c.range(loc.start.cfi), b = c.range(loc.end.cfi); const r = c.document.createRange(); r.setStart(a.startContainer, a.startOffset); r.setEnd(b.endContainer, b.endOffset); text = r.toString(); } catch (e) { try { text = rend.getContents()[0].document.body.innerText.slice(0, 4000); } catch (e2) {} }
  if (!text.trim()) { if (speaking) rend.next(); return; }
  const u = new SpeechSynthesisUtterance(text); u.rate = 1; u.lang = (book.packaging && book.packaging.metadata.language) || 'en';
  u.onend = () => { if (speaking) rend.next(); };
  speechSynthesis.speak(u);
}
function ruler(on) { el.querySelectorAll('.rruler').forEach(x => x.remove()); if (on) $('#r-view').insertAdjacentHTML('beforeend', '<div class="rruler" style="top:40%"></div>'); }

/* ---------- bookmark ---------- */
function bmHere() { if (pdf) return marks().find(m => m.kind === 'bookmark' && m.cfi === 'pdf:' + pdfPage); const l = curLoc; if (!l || !l.start) return null; return marks().find(m => m.kind === 'bookmark' && m.cfi && (m.cfi === l.start.cfi || (l.end && book.locations && rend.epubcfi && within(m.cfi, l)))); }
function within(cfi, l) { try { const E = new window.ePub.CFI(); return E.compare(cfi, l.start.cfi) >= 0 && E.compare(cfi, l.end.cfi) <= 0; } catch (e) { return false; } }
function bmState() { const b = $('#r-bm'); if (b) b.classList.toggle('on', !!bmHere()); }
function toggleBm() {
  const ex = bmHere();
  if (ex) { ex.void = '1'; ex.updated = X.today(); X.touch('highlights'); X.say('Bookmark removed.'); }
  else { const l = curLoc || { start: { cfi: 'pdf:' + pdfPage } }; let snip = ''; try { snip = pdf ? 'Page ' + pdfPage : rend.getContents()[0].document.body.innerText.trim().slice(0, 80); } catch (e) {} X.D.highlights.push({ id: 'h' + X.uid(), bookId: B.id, passage: snip, colour: 'r', note: '', date: X.today(), kind: 'bookmark', cfi: l.start.cfi, chapter: chapterLabel(l), style: '', void: '', updated: X.today() }); X.touch('highlights'); X.say('Page bookmarked.'); }
  bmState();
}


/* ---------- PDF books (pdf.js): real printed pages, text you can select ---------- */
async function openPdf(buf) {
  status('Opening the PDF…');
  await load(PDFJS); window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFW;
  pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  B._toc = [];
  const v = $('#r-view'); v.innerHTML = '<div class="rpdf" id="r-pdf"></div>';
  const box = $('#r-pdf');
  pdfLayout();
  box.addEventListener('scroll', () => { lastAct = Date.now(); const pgs = box.querySelectorAll('.rpg'); const mid = box.scrollTop + box.clientHeight * 0.35; let n = 1; pgs.forEach((p, i) => { if (p.offsetTop <= mid) n = i + 1; }); if (n !== pdfPage) { const dt = (Date.now() - turnAt) / 1000; turnAt = Date.now(); if (dt > 4 && dt < 240) { S.spp = Math.round(S.spp * 0.85 + dt * 0.15); saveS(); } pdfPage = n; curLoc = { start: { cfi: 'pdf:' + n } }; place(); queueSave(); } }, { passive: true });
  let p0 = null;
  box.addEventListener('touchstart', e => { const t = e.touches[0]; p0 = e.touches.length === 1 && pdfZoom <= 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; }, { passive: true });
  box.addEventListener('touchend', e => { if (!p0) return; const t = e.changedTouches[0], dx = t.clientX - p0.x, dy = t.clientY - p0.y, dt = Date.now() - p0.at; p0 = null; if (getSelection().toString().trim()) return; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 800) { const n = pdfPage + (dx < 0 ? 1 : -1), d = el.querySelector(`.rpg[data-n="${n}"]`); if (d) box.scrollTo({ top: d.offsetTop - 8, behavior: 'smooth' }); } }, { passive: true });
  box.addEventListener('mouseup', pdfSel); box.addEventListener('touchend', () => setTimeout(pdfSel, 350));
  box.addEventListener('click', e => { if (!getSelection().toString() && !e.target.closest('.rsel')) { if (sel) closeSel(); else { chromeOn = !chromeOn; el.classList.toggle('bare', !chromeOn); } } });
  const start = /^pdf:\d+$/.test(B.cfi || '') ? Number(B.cfi.slice(4)) : 1;
  pdfPage = start; curLoc = { start: { cfi: 'pdf:' + start } };
  setTimeout(() => pdfGo(start, true), 50);
  locReady = true; place(); paint(); bmState();
  try { const ol = await pdf.getOutline(); if (ol) { const conv = async items => Promise.all(items.map(async i => { let n = null; try { const d = typeof i.dest === 'string' ? await pdf.getDestination(i.dest) : i.dest; if (d) n = (await pdf.getPageIndex(d[0])) + 1; } catch (e) {} return { label: i.title, href: n ? 'pdf:' + n : '', subitems: i.items && i.items.length ? await conv(i.items) : [] }; })); B._toc = await conv(ol); } } catch (e) {}
}
async function pdfLayout() {
  const box = $('#r-pdf'); if (!box || !pdf) return;
  const keep = pdfPage; const p1 = await pdf.getPage(1); const vp = p1.getViewport({ scale: 1 });
  const w = Math.min(box.clientWidth - 16, 900) * pdfZoom, ratio = vp.height / vp.width;
  box.innerHTML = Array.from({ length: pdf.numPages }, (_, i) => `<div class="rpg" data-n="${i + 1}" style="width:${w}px;height:${Math.round(w * ratio)}px"></div>`).join('');
  pdfObs && pdfObs.disconnect();
  pdfObs = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) drawPage(e.target); }), { root: box, rootMargin: '800px 0px' });
  box.querySelectorAll('.rpg').forEach(d => pdfObs.observe(d));
  pdfGo(keep, true);
}
async function drawPage(div) {
  if (div.dataset.done) return; div.dataset.done = '1';
  try {
    const n = Number(div.dataset.n), page = await pdf.getPage(n);
    const w = div.clientWidth, base = page.getViewport({ scale: 1 }), scale = w / base.width, vp = page.getViewport({ scale });
    div.style.height = Math.round(vp.height) + 'px';
    const c = document.createElement('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr); div.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
    const tl = document.createElement('div'); tl.className = 'textLayer'; tl.style.setProperty('--scale-factor', scale); div.appendChild(tl);
    const tc = await page.getTextContent();
    const task = window.pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }); if (task && task.promise) await task.promise;
  } catch (e) { div.dataset.done = ''; }
}
function pdfGo(n, quiet) {
  if (!pdf) return; n = Math.min(pdf.numPages, Math.max(1, Math.round(n) || 1));
  const d = el.querySelector(`.rpg[data-n="${n}"]`); if (d) $('#r-pdf').scrollTop = d.offsetTop - 8;
  pdfPage = n; curLoc = { start: { cfi: 'pdf:' + n } }; place(); if (!quiet) queueSave();
}
function pdfSel() {
  const s = getSelection(), t = s.toString().trim(); if (!t) return;
  const pg = s.anchorNode && s.anchorNode.parentElement && s.anchorNode.parentElement.closest('.rpg');
  if (pg) pdfPage = Number(pg.dataset.n);
  sel = { cfi: 'pdf:' + pdfPage, text: t.replace(/\s+/g, ' '), contents: { window } }; selBar();
}
function pdfToc() {
  const rows = []; const walk = (items, d) => items.forEach(i => { rows.push(`<button class="rrow" ${i.href ? `data-r="go" data-v="${esc(i.href)}"` : ''} style="padding-left:${4 + d * 16}px">${esc((i.label || '').trim())}${i.href ? `<small>p. ${i.href.slice(4)}</small>` : ''}</button>`); if (i.subitems && i.subitems.length) walk(i.subitems, d + 1); });
  walk(B._toc || [], 0);
  sheet(hd('Contents') + (rows.join('') || `<p>This PDF has no table of contents. Use Go to page instead (it has ${pdf.numPages} pages).</p>`));
}

function goTo(cfi) { if (String(cfi).startsWith('pdf:')) return pdfGo(Number(String(cfi).slice(4))); return rend.display(cfi); }

/* ---------- clicks ---------- */
async function onClick(e) {
  const t = e.target.closest('[data-r]'); if (!t) return; const r = t.dataset.r, v = t.dataset.v, id = t.dataset.id; lastAct = Date.now();
  const h = id && X.D.highlights.find(x => x.id === id);
  switch (r) {
    case 'close': return close();
    case 'x': return closeSheet();
    case 'aa': return aaSheet();
    case 'more': return moreSheet();
    case 'search': return searchSheet();
    case 'bm': return toggleBm();
    case 'back': if (history.length) goTo(history.pop()); else X.say('Nothing to go back to yet.'); return;
    case 'toc': return tocSheet();
    case 'notes': return notesSheet();
    case 'bms': return bmsSheet();
    case 'cards': cardI = 0; cardFlip = false; return cardsSheet();
    case 'flip': cardFlip = !cardFlip; return cardsSheet();
    case 'cardn': cardI++; cardFlip = false; if (cardI >= marks().filter(m => !m.kind || m.kind === 'highlight').length) cardI = 0; return cardsSheet();
    case 'cardp': cardI = Math.max(0, cardI - 1); cardFlip = false; return cardsSheet();
    case 'words': return wordsSheet();
    case 'goto': return gotoSheet();
    case 'dogo': { const pg = Number(el.querySelector('#r-pg').value), pc = Number(el.querySelector('#r-pc').value); if (pdf) { remember(); if (pg) pdfGo(pg); else if (el.querySelector('#r-pc').value !== '') pdfGo(Math.max(1, Math.round(pc / 100 * pdf.numPages))); closeSheet(); return; } if (!locReady) { X.say('Pages are still being worked out.'); return; } remember(); if (pg) rend.display(book.locations.cfiFromLocation(pg - 1)); else if (el.querySelector('#r-pc').value !== '') rend.display(book.locations.cfiFromPercentage(Math.min(100, Math.max(0, pc)) / 100)); else { X.say('Type a page or a percent first.'); return; } closeSheet(); return; }
    case 'go': remember(); closeSheet(); goTo(v); return;
    case 'jump': remember(); closeSheet(); goTo(v); return;
    case 'speak': speaking = !speaking; closeSheet(); if (speaking) { X.say('Reading aloud. Open the menu to stop.'); speakPage(); } else speechSynthesis.cancel(); return;
    case 'recap': closeSheet(); askClaude('', `Give me a short, spoiler-free recap of this book up to ${chapterLabel(curLoc) || 'where I am now'}${pdf ? ' (page ' + pdfPage + ' of ' + pdf.numPages + ')' : locReady ? ' (about ' + Math.round(book.locations.percentageFromCfi(curLoc.start.cfi) * 100) + '% through)' : ''}: the main argument or story so far, key people, and the ideas I should remember. Do not reveal anything from later chapters.`); return;
    case 'export': closeSheet(); return exportNotes();
    case 'copyall': return copy(marks().filter(m => !m.kind || m.kind === 'highlight').map(m => cite(m.passage) + (m.note ? '\nNote: ' + m.note : '')).join('\n\n'));
    case 'goal': return goalSheet();
    case 'savegoal': S.goal = Math.max(1, Number(el.querySelector('#r-g1').value) || 10); S.yearGoal = Math.max(1, Number(el.querySelector('#r-g2').value) || 24); saveS(); X.say('Goals saved.'); return moreSheet();
    case 'finish': { const f = B.finished ? '' : X.today(); B.finished = f; X.ls.set('hq-data', X.D); if (X.live()) X.post({ action: 'patch', name: 'books', id: B.id, fields: { finished: f, updated: X.today() } }).catch(err => X.say("Couldn't save: " + err.message)); X.say(f ? 'Marked as finished. Nice work.' : 'Back in Reading now.'); return moreSheet(); }
    case 'zoom': pdfZoom = Math.min(3, Math.max(0.5, pdfZoom + Number(v))); pdfLayout(); return aaSheet();
    case 'fs': S.size = Math.min(220, Math.max(60, S.size + Number(v))); saveS(); paint(); return aaSheet();
    case 'th': S.theme = v; saveS(); paint(); return markOn(t);
    case 'font': S.font = v; saveS(); paint(); return markOn(t);
    case 'fs': S.size = Math.max(60, Math.min(240, (Number(S.size) || 100) + Number(v))); saveS(); paint(); { const o = el.querySelector('#r-fsv'); if (o) o.textContent = S.size + '%'; } return;
    case 'anim': S.anim = v; saveS(); return markOn(t);
    case 'tog': S[v] = S[v] ? 0 : 1; saveS(); if (v === 'ruler') ruler(S.ruler); paint(); return aaSheet();
    case 'flow': if (S.flow !== v) { const at = curLoc && curLoc.start.cfi; S.flow = v; saveS(); rend.destroy(); makeRendition(); await rend.display(at); attach(); } return aaSheet();
    case 'reset': { const g = [S.goal, S.yearGoal]; S = Object.assign({}, DEF, { goal: g[0], yearGoal: g[1] }); saveS(); paint(); return aaSheet(); }
    /* selection actions */
    case 'hlpick': return selRow('hl');
    case 'selmore': return selRow('more');
    case 'hl': if (sel) { S.hlc = v; saveS(); addMark('highlight', v); closeSel(); } return;
    case 'ul': if (sel) { addMark('highlight', 'o', 'u'); closeSel(); } return;
    case 'addnote': if (sel) { const nh = addMark('highlight', 'y'); closeSel(); noteSheet(nh); } return;
    case 'copy': if (sel) { copy(sel.text); closeSel(); } return;
    case 'cite': if (sel) { copy(cite(sel.text)); closeSel(); } return;
    case 'lookup': if (sel) { const w = sel.text.split(/\s+/).slice(0, 4).join(' '); if (sel.text.split(/\s+/).length <= 3) { let sent = ''; try { sent = sel.contents.window.getSelection().anchorNode.parentElement.textContent.trim().slice(0, 220); } catch (er) {} X.D.highlights.push({ id: 'h' + X.uid(), bookId: B.id, passage: w, colour: '', note: sent, date: X.today(), kind: 'word', cfi: sel.cfi, chapter: chapterLabel(curLoc), style: '', void: '', updated: X.today() }); X.touch('highlights'); } window.open(dictUrl(w), '_blank', 'noopener'); closeSel(); } return;
    case 'translate': if (sel) { window.open('https://translate.google.com/?sl=auto&tl=id&op=translate&text=' + encodeURIComponent(sel.text), '_blank', 'noopener'); closeSel(); } return;
    case 'ask': if (sel) { askClaude(sel.text); closeSel(); } return;
    case 'tonotes': if (sel) { X.newNote(B.title + ' – note', `<h1>${esc(B.title)}</h1><blockquote>${esc(sel.text)}</blockquote><p>— ${esc(B.author || '')}${chapterLabel(curLoc) ? ', ' + esc(chapterLabel(curLoc)) : ''}</p><p><br></p>`, '3. Resources'); X.say('Sent to HQ Notes.'); closeSel(); } return;
    case 'findsel': if (sel) { const q = sel.text.slice(0, 60); closeSel(); searchSheet(q); } return;
    /* note sheet */
    case 'savenote': if (h) { h.note = el.querySelector('#r-note').value.trim(); h.updated = X.today(); X.touch('highlights'); closeSheet(); X.say('Note saved.'); } return;
    case 'asknote': if (h) askClaude(h.passage, h.note ? 'My note: ' + h.note + '\n\nHelp me develop this thought.' : undefined); return;
    case 'delhl': if (h) { undraw(h); h.void = '1'; h.updated = X.today(); X.touch('highlights'); closeSheet(); X.say('Highlight removed.'); } return;
    case 'recol': if (h) { undraw(h); h.colour = v; h.updated = X.today(); drawMark(h); X.touch('highlights'); noteSheet(h); } return;
    case 'ustyle': if (h) { undraw(h); h.style = h.style === 'u' ? '' : 'u'; h.updated = X.today(); drawMark(h); X.touch('highlights'); noteSheet(h); } return;
  }
}

function close() {
  try { clearTimeout(saveT); savePos(); } catch (e) {}
  clearInterval(minT); speaking = false; try { speechSynthesis.cancel(); } catch (e) {}
  document.removeEventListener('keydown', onKey);
  try { book && book.destroy(); } catch (e) {}
  try { pdfObs && pdfObs.disconnect(); pdf && pdf.destroy(); } catch (e) {} pdf = null; pdfObs = null;
  book = rend = null; if (el) el.remove(); el = null;
  document.documentElement.style.overflow = '';
  X.done && X.done();
}

window.HQReader = { open, close, goalStats: () => goalStats(), settings: () => Object.assign({}, DEF, (X && X.ls ? X.ls.get('hq-rd', {}) : {})) };
})();
