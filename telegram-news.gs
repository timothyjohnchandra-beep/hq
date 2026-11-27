/**
 * Timothy HQ – Telegram bot + Gemini news (second file in the same Apps Script project as the bridge).
 * In script.google.com: Files › + › Script, name it "telegram-news", paste this file, save.
 * Script properties (Project Settings › Script properties): GEMINI_KEY (already used for sermons) and TELEGRAM_TOKEN (from @BotFather).
 * Then run setupTelegramAndNews once, open your bot in Telegram and press Start. Only the first chat that presses Start is accepted.
 * Uses TZ, readTab_, ss_, appendRows_, patchRow_, writeNote_, calendar_, brief_, parseRefs, refMatch, geminiModels_ and geminiJson_ from apps-script.gs.
 */

/* ---------- News: Gemini picks and summarises, links always come from the feeds ---------- */
const NEWS_FEEDS = {
  id: [
    'https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id',
    'https://news.google.com/rss/headlines/section/topic/NATION?hl=id&gl=ID&ceid=ID:id',
    'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=id&gl=ID&ceid=ID:id',
    'https://news.google.com/rss/search?q=gereja+OR+kristen+OR+PGI+OR+KWI+when:2d&hl=id&gl=ID&ceid=ID:id',
    'https://www.antaranews.com/rss/terkini.xml',
    'https://www.cnnindonesia.com/nasional/rss',
    'https://www.cnbcindonesia.com/news/rss'
  ],
  world: [
    'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=church+OR+christian+OR+vatican+OR+pope+when:2d&hl=en-US&gl=US&ceid=US:en',
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://www.aljazeera.com/xml/rss/all.xml',
    'https://religionnews.com/feed/'
  ]
};

function rssText_(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function rssItems_(xml, feedUrl) {   // plain parsing, so one broken feed never stops the others
  const tag = (block, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block); return m ? m[1] : ''; };
  const host = (/^https?:\/\/(?:www\.)?([^/]+)/.exec(feedUrl) || [])[1] || '';
  return (String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(b => {
    const rawDesc = tag(b, 'description');
    let title = rssText_(tag(b, 'title')), source = rssText_(tag(b, 'source'));
    if (!source && /news\.google/.test(host)) { const m = / - ([^-]+)$/.exec(title); if (m) source = m[1].trim(); }
    if (source) title = title.replace(new RegExp(' - ' + source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
    const link = rssText_(tag(b, 'link')) || ((/<link[^>]*href="([^"]+)"/i.exec(b) || [])[1] || '');
    const outlets = (rssText_(rawDesc).length && /<li|&lt;li/i.test(rawDesc)) ? (rawDesc.match(/<li|&lt;li/gi) || []).length : 1;
    return { title, source: source || host, link, date: new Date(rssText_(tag(b, 'pubDate')) || 0), desc: /news\.google/.test(host) ? '' : rssText_(rawDesc).slice(0, 220), outlets };
  }).filter(i => i.title && /^https?:\/\//.test(i.link));
}
function newsPool_(urls, log) {
  const cut = Date.now() - 36 * 3600e3, seen = {}, pool = [];
  urls.forEach(u => {
    try {
      const r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (HQ news)' } });
      if (r.getResponseCode() !== 200) { log.push('Feed skipped (' + r.getResponseCode() + '): ' + u); return; }
      rssItems_(r.getContentText(), u).filter(i => !(i.date.getTime() > 0) || i.date.getTime() > cut).slice(0, 25).forEach(i => {
        const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
        if (!seen[k]) { seen[k] = 1; pool.push(i); }
      });
    } catch (e) { log.push('Feed failed: ' + u + ' (' + (e.message || e) + ')'); }
  });
  return pool.slice(0, 90);
}
function newsPrompt_(region, pool, today) {
  const indo = region === 'id';
  return [
    'You are picking the top news for Timothy, an Executive Pastor and company director in Jakarta. Today is ' + today + ' (Asia/Jakarta).',
    'Below is a numbered list of headlines from the last ~36 hours (source, outlets = how many outlets cover it). Use ONLY these items. Never add facts that are not in the headline or description.',
    'Pick the 10 most prominent ' + (indo ? 'Indonesian' : 'world') + ' stories: prominence = covered by many outlets, appears in several feeds, national or global impact. One story per pick; merge duplicates.',
    'Reserved slots: at least 2 economy/business stories (tag "' + (indo ? 'Ekonomi' : 'Economy') + '") and at least 1 church/Christianity story (tag "' + (indo ? 'Gereja' : 'Church') + '") if a real one is in the list; otherwise use a general story. Other picks have tag "".',
    'For each pick write a short title and a 1–2 sentence summary in ' + (indo ? 'Bahasa Indonesia' : 'English') + ', in your own words. "item" = the number of the headline it comes from (choose the most reputable outlet when several cover it).',
    'Return JSON only: {"picks":[{"n":1,"tag":"","title":"","summary":"","item":0}]} ordered by prominence. Fewer than 10 is fine if the list is thin.',
    '',
    pool.map((i, k) => k + '. [' + i.source + (i.outlets > 1 ? ', outlets ' + i.outlets : '') + '] ' + i.title + (i.desc ? ' — ' + i.desc : '')).join('\n')
  ].join('\n');
}
function appendBriefs_(rows) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = ss_().getSheetByName('briefs');
    const head = s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getDisplayValues()[0];
    ['id', 'date', 'section', 'n', 'tag', 'title', 'summary', 'link', 'void'].forEach(k => { if (head.indexOf(k) < 0) { head.push(k); s.getRange(1, head.length).setValue(k); } });
    const body = rows.map(r => head.map(k => r[k] == null ? '' : String(r[k])));
    const rng = s.getRange(s.getLastRow() + 1, 1, body.length, head.length);
    rng.setNumberFormat('@'); rng.setValues(body);
  } finally { lock.releaseLock(); }
}
/** Daily ~5:20 a.m.: Top 10 Berita Indonesia + Top 10 World News into the briefs tab (sections id and world). */
function newsGemini(force) {
  force = force === true;
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('No Gemini key yet. Add GEMINI_KEY in Project Settings › Script properties.');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), log = [];
  const have = readTab_('briefs').filter(r => r.date === today && !r.void);
  const out = [];
  ['id', 'world'].forEach(region => {
    if (!force && have.some(r => r.section === region)) { log.push(region + ': already in today\'s brief'); return; }
    const pool = newsPool_(NEWS_FEEDS[region], log);
    if (pool.length < 5) { log.push(region + ': only ' + pool.length + ' headlines found, skipped'); return; }
    const res = geminiJson_(key, geminiModels_(key), newsPrompt_(region, pool, today));
    const picks = ((res && res.picks) || []).filter(p => pool[p.item] && p.title).slice(0, 10);
    picks.forEach((p, k) => out.push({ id: 'b-' + today + '-' + region + (k + 1), date: today, section: region, n: k + 1, tag: String(p.tag || '').replace(/[[\]]/g, ''),
      title: String(p.title).trim(), summary: String(p.summary || '').trim(), link: pool[p.item].link, void: '' }));
    log.push(region + ': ' + picks.length + ' stories from ' + pool.length + ' headlines');
  });
  if (force) out.forEach(r => log.push(r.section + ' ' + r.n + '. ' + (r.tag ? '[' + r.tag + '] ' : '') + r.title + ' – ' + r.link));   // test: show, don't save
  else if (out.length) appendBriefs_(out);
  Logger.log(log.join('\n'));
  return log;
}

/* ======================================================================================================
   TELEGRAM BOT (rebuilt 26 Nov 2026)
   One way in: pollTelegram every minute (getUpdates). A webhook to an Apps Script web app is unreliable
   (Google answers Telegram with a redirect, so messages are retried or lost, and the web app runs the
   *deployed* version, not the saved code). setupTelegramAndNews switches any old webhook off.

   Private chat with Timothy (TELEGRAM_CHAT):
     text / voice / forwarded message / photo of a receipt / PDF  → Gemini sorts it:
       task → HQ tasks · "Claude, …" → For Claude · idea → note for Claude · receipt → Money · question → answer from HQ
     /today /tasks /news /groups /recap /help
   Groups (Timothy adds the bot; groups he is not in are left automatically):
     the bot quietly keeps notes of the conversation (tg_log tab),
     /summary → summary, decisions and to-dos in bullets (saved to HQ Notes › Telegram/<group>; to-dos to tg_todos,
                Timothy's own to-dos also to his HQ tasks)
     /todo → open to-dos · /todo <text> → add one · /done 2 → tick off · ✅ buttons work for everyone in the group
   Automatic: 9 a.m. follow-up in each group for to-dos that are due or overdue (each item at most every 2 days);
              9 p.m. recap of busy groups to Timothy privately.
   ====================================================================================================== */
const TG_VERSION = '2026-11-27 18.00';

function tgProps_() { return PropertiesService.getScriptProperties(); }
function tg_(method, payload) {
  const token = tgProps_().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('No Telegram token yet. Add TELEGRAM_TOKEN in Project Settings › Script properties.');
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || r.getResponseCode()));
  return j.result;
}
function tgEsc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** Sends text (split at 3,800 characters) to a chat; buttons go on the last part. Default chat = Timothy. */
function tgSay_(text, chat, buttons) {
  chat = chat || tgProps_().getProperty('TELEGRAM_CHAT');
  if (!chat) return;
  const parts = []; let cur = '';
  String(text).split('\n').forEach(line => { if ((cur + line).length > 3800) { parts.push(cur); cur = ''; } cur += line + '\n'; });
  if (cur.trim()) parts.push(cur);
  parts.forEach((p, i) => {
    const payload = { chat_id: chat, text: p, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons && buttons.length && i === parts.length - 1) payload.reply_markup = { inline_keyboard: buttons };
    tg_('sendMessage', payload);
  });
}
function tgToday_(offsetDays) { return Utilities.formatDate(new Date(Date.now() + (offsetDays || 0) * 864e5), TZ, 'yyyy-MM-dd'); }
function tgId_() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function tgName_(u) { return u ? [u.first_name, u.last_name].filter(String).join(' ') || u.username || 'Someone' : 'Someone'; }

/* ---------- Gemini (text, voice, photo, PDF) ---------- */
function geminiParts_(parts, asJson, temp, fast) {   // fast = Lite models first (about 1 s), for replies Timothy is waiting for
  const key = tgProps_().getProperty('GEMINI_KEY');
  if (!key) throw new Error('No Gemini key yet. Add GEMINI_KEY in Project Settings › Script properties.');
  const props = tgProps_(), bad = JSON.parse(props.getProperty('geminiBad') || '{}'), noThink = JSON.parse(props.getProperty('geminiNoThink') || '{}');
  let last = '', models = geminiModels_(key);
  if (fast) models = models.filter(n => /lite/.test(n)).concat(models.filter(n => !/lite/.test(n)));
  for (const model of models) {
    for (let tries = 0; tries < 2; tries++) {
      const cfg = { temperature: temp == null ? 0.2 : temp }; if (asJson) cfg.responseMimeType = 'application/json';
      if (!noThink[model]) cfg.thinkingConfig = { thinkingLevel: 'low' };   // little thinking = quick answers
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-goog-api-key': key, 'X-Server-Timeout': fast ? '25' : '40' },   // a busy Gemini must not hold the poll for minutes
        payload: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: cfg }) });
      const code = r.getResponseCode(), txt = r.getContentText();
      if (code === 400 && !noThink[model] && /thinking/i.test(txt)) { noThink[model] = 1; props.setProperty('geminiNoThink', JSON.stringify(noThink)); tries--; continue; }
      if (code === 200) {
        props.setProperty('geminiGood', model);
        const out = ((((JSON.parse(txt).candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('').replace(/^\x60{3}(json|html)?|\x60{3}$/g, '').trim();
        return asJson ? JSON.parse(out || '{}') : out;
      }
      last = model + ' ' + code;
      if (code === 429 && /per ?day|PerDay|limit: 0|free_tier|quota/i.test(txt) && !/per ?minute|PerMinute/i.test(txt)) { bad[model] = Date.now(); props.setProperty('geminiBad', JSON.stringify(bad)); break; }
      if (code === 429) { Utilities.sleep(8000); continue; }
      if (code === 404 || code === 400 || code === 403) { bad[model] = Date.now(); props.setProperty('geminiBad', JSON.stringify(bad)); break; }
      break;   // 5xx: busy, try the next model
    }
  }
  throw new Error('Gemini is busy or out of free quota (' + last + '). Try again in a minute.');
}
function tgFileBlob_(fileId) {
  const f = tg_('getFile', { file_id: fileId });
  const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + tgProps_().getProperty('TELEGRAM_TOKEN') + '/' + f.file_path).getBlob();
  if (blob.getBytes().length > 15 * 1024 * 1024) throw new Error('That file is over 15 MB. Please send a smaller one.');
  return blob;
}
function tgMedia_(fileId, mime) { const b = tgFileBlob_(fileId); return { inline_data: { mime_type: mime || b.getContentType(), data: Utilities.base64Encode(b.getBytes()) } }; }

/* ---------- Bot-only Sheet tabs (made on first use; not loaded by the app) ---------- */
const TG_TABS = {
  tg_log: ['id', 'chat', 'group', 'date', 'time', 'ts', 'from', 'text', 'kind', 'file'],
  tg_todos: ['id', 'chat', 'group', 'task', 'owner', 'due', 'status', 'created', 'updated', 'nudged', 'source']
};
function tgTab_(name) {
  const ss = ss_(); let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.getRange(1, 1, 1, TG_TABS[name].length).setValues([TG_TABS[name]]); s.setFrozenRows(1); }
  return s;
}
function tgRows_(name) {
  const v = tgTab_(name).getDataRange().getDisplayValues(); if (v.length < 2) return [];
  const h = v[0]; return v.slice(1).filter(r => r[0]).map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => o[k] = r[j]); return o; });
}
function tgAppend_(name, rows) {
  if (!rows.length) return;
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = tgTab_(name), h = TG_TABS[name];
    const rng = s.getRange(s.getLastRow() + 1, 1, rows.length, h.length);
    rng.setNumberFormat('@'); rng.setValues(rows.map(r => h.map(k => r[k] == null ? '' : String(r[k]))));
  } finally { lock.releaseLock(); }
}
function tgSet_(name, id, fields) {
  const s = tgTab_(name), h = TG_TABS[name];
  const ids = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const row = ids.indexOf(String(id)) + 2; if (row < 2) return false;
  Object.keys(fields).forEach(k => { const c = h.indexOf(k); if (c >= 0) s.getRange(row, c + 1).setNumberFormat('@').setValue(String(fields[k])); });
  return true;
}

/* ---------- Groups the bot may stay in ---------- */
function tgGroups_() { return JSON.parse(tgProps_().getProperty('tgGroups') || '{}'); }
function tgSaveGroups_(g) { tgProps_().setProperty('tgGroups', JSON.stringify(g)); }
/** A group is allowed when Timothy added the bot or is a member. Anyone else's group: the bot leaves. */
function tgGroupOk_(chat) {
  const id = String(chat.id), g = tgGroups_();
  if (g[id]) { if (chat.title && g[id].title !== chat.title) { g[id].title = chat.title; tgSaveGroups_(g); } return true; }
  const owner = tgProps_().getProperty('TELEGRAM_CHAT'); if (!owner) return false;
  let ok = false;
  try { ok = ['creator', 'administrator', 'member', 'restricted'].indexOf(tg_('getChatMember', { chat_id: id, user_id: Number(owner) }).status) >= 0; } catch (e) {}
  if (!ok) { try { tg_('leaveChat', { chat_id: id }); } catch (e) {} return false; }
  g[id] = { title: chat.title || 'Group', since: tgToday_(), lastSummaryTs: 0 }; tgSaveGroups_(g);
  return true;
}
const TG_GROUP_HELP = [
  '<b>Hi! I\'m Timothy\'s note-taker.</b>',
  'I keep notes of this chat so nothing gets lost.',
  '/summary – summary, decisions and to-dos so far',
  '/todo – open to-dos · /todo <i>Kevin send the budget by Friday</i> – add one',
  '/done 2 – tick off to-do 2 (or tap ✅)',
  'Every morning I post a short follow-up for to-dos that are due.'
].join('\n');

const TG_HELP = [
  '<b>Timothy HQ bot</b> (' + TG_VERSION + ')',
  'Send text, a voice note, a forwarded message, a photo of a receipt or a PDF:',
  '• "Call Pak Budi Thursday" → a task on Thursday',
  '• "Claude, draft the KOMID outline" → your For Claude list',
  '• "Note: …" or "Catatan: …" → saved word for word in HQ Notes › Telegram',
  '• "Idea: sermon on Nehemiah 4" → a note in HQ Notes',
  '• a receipt photo → Money (cash out)',
  '• "What\'s on tomorrow?" / "Sermons on Nehemiah?" → an answer from HQ',
  '',
  '/today – brief · /tasks – open tasks · /news – news · /notes – today\'s chat notes now',
  'Every chat (this one and each group) gets one note per day in HQ Notes › Telegram, updated every hour.',
  '/groups – groups I take notes in · /recap – recap of all groups now',
  '',
  'Add me to a group and I take notes there: /summary, /todo, /done.'
].join('\n');

/* ---------- Every minute ---------- */
/** Runs every minute. While Timothy is chatting with the bot (3 minutes after his last private message) it keeps
 *  listening for ~50 s (Telegram long polling), so replies come in seconds instead of up to a minute.
 *  Idle minutes stay short (~1 s) to keep inside Google's daily limit for timer run time. */
function pollTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;   // the previous run is still listening
  try {
    const props = tgProps_(), start = Date.now();
    do {
      const awake = Number(props.getProperty('tgAwake') || 0) > Date.now();
      const wait = awake ? Math.max(0, Math.min(20, Math.floor((48000 - (Date.now() - start)) / 1000))) : 0;
      const log = [];
      const updates = tg_('getUpdates', { offset: Number(props.getProperty('tgOffset') || 0), timeout: wait, allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'] });
      updates.forEach(u => {
        props.setProperty('tgOffset', String(u.update_id + 1));   // saved first, so a failing message is never handled twice
        try { tgUpdate_(u, log); } catch (e) { Logger.log('Update ' + u.update_id + ' failed: ' + (e.message || e)); }
      });
      tgAppend_('tg_log', log);
    } while (Number(props.getProperty('tgAwake') || 0) > Date.now() && Date.now() - start < 45000);
  } finally { lock.releaseLock(); }
}
let tgHeard_ = '';   // what Gemini heard in a voice note, so the day's note keeps the words
function tgUpdate_(u, log) {
  const owner = tgProps_().getProperty('TELEGRAM_CHAT');
  if (u.my_chat_member) return tgMembership_(u.my_chat_member);
  if (u.callback_query) return tgCallback_(u.callback_query);
  const m = u.message || u.edited_message; if (!m || !m.chat) return;
  const type = m.chat.type, chat = String(m.chat.id), text = (m.text || m.caption || '').trim();
  if (type === 'private') {
    if (!owner && /^\/start/.test(text)) { tgProps_().setProperty('TELEGRAM_CHAT', chat); return tgSay_('Hi Timothy, this bot is now linked to your HQ.\n\n' + TG_HELP, chat); }
    if (chat !== owner) return;   // strangers in private are ignored
    tgProps_().setProperty('tgAwake', String(Date.now() + 3 * 60000));
    tgHeard_ = '';
    try { tgPrivate_(m); } catch (e) { tgSay_('Sorry, that didn\'t work: ' + tgEsc_(e.message || e)); }
    if (!/^\//.test(text) && !u.edited_message) {   // every private message also goes into today's "TJC PA" note
      const pv = m.voice || m.audio, pk = pv ? 'voice' : m.photo ? 'photo' : m.document ? 'file' : text ? 'text' : '';
      if (pk) { const d = new Date(m.date * 1000);
        log.push({ id: chat + ':' + m.message_id, chat, group: TG_PRIVATE, date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, TZ, 'HH:mm'), ts: m.date, from: 'Timothy',
          text: (m.forward_origin || m.forward_date ? '[forwarded] ' : '') + (tgHeard_ ? '[voice] ' + tgHeard_ : text || (pk === 'photo' ? '[photo]' : pk === 'file' ? '[file: ' + (m.document.file_name || '') + ']' : '')),
          kind: tgHeard_ ? 'text' : pk, file: pv && !tgHeard_ ? pv.file_id : '' }); }
    }
    return;
  }
  if (type !== 'group' && type !== 'supergroup') return;
  if (!tgGroupOk_(m.chat)) return;
  if (u.edited_message) return;   // keep the first version only
  const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
  if (cmd) {
    try { return tgGroupCommand_(m, cmd[1].toLowerCase(), cmd[2].trim()); }
    catch (e) { return tgSay_('Sorry, that didn\'t work: ' + tgEsc_(e.message || e), chat); }
  }
  const voice = m.voice || m.audio, kind = voice ? 'voice' : m.photo ? 'photo' : m.document ? 'file' : text ? 'text' : '';
  if (!kind) return;
  const d = new Date(m.date * 1000);
  log.push({ id: chat + ':' + m.message_id, chat, group: m.chat.title || '', date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, TZ, 'HH:mm'),
    ts: m.date, from: tgName_(m.from) + (String(m.from && m.from.id) === owner ? ' (Timothy)' : ''), text: (m.forward_origin || m.forward_date ? '[forwarded] ' : '') + (text || (kind === 'photo' ? '[photo]' : kind === 'file' ? '[file: ' + (m.document.file_name || '') + ']' : '')),
    kind, file: voice ? voice.file_id : '' });
}
function tgMembership_(cm) {
  const chat = cm.chat, st = cm.new_chat_member && cm.new_chat_member.status, id = String(chat.id);
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;
  const g = tgGroups_();
  if (st === 'left' || st === 'kicked') { if (g[id]) { delete g[id]; tgSaveGroups_(g); tgSay_('I was removed from <b>' + tgEsc_(chat.title) + '</b>. Notes so far stay in HQ.'); } return; }
  const owner = tgProps_().getProperty('TELEGRAM_CHAT');
  if (String(cm.from && cm.from.id) === owner) { g[id] = g[id] || { title: chat.title || 'Group', since: tgToday_(), lastSummaryTs: 0 }; tgSaveGroups_(g); }
  if (!tgGroupOk_(chat)) return;
  tgSay_(TG_GROUP_HELP, id);
  const me = tg_('getMe', {});
  tgSay_('Added to <b>' + tgEsc_(chat.title) + '</b>.' + (me.can_read_all_group_messages ? '' :
    '\n\n⚠️ I can only see commands there right now. In Telegram open @BotFather › /setprivacy › choose this bot › <b>Disable</b>, then remove me from the group and add me again.'));
}

/* ---------- Group commands, summaries and to-dos ---------- */
function tgGroupCommand_(m, cmd, arg) {
  const chat = String(m.chat.id);
  if (cmd === 'help' || cmd === 'start') return tgSay_(TG_GROUP_HELP, chat);
  if (cmd === 'summary' || cmd === 'notes' || cmd === 'ringkasan') { tg_('sendChatAction', { chat_id: chat, action: 'typing' }); return tgSummarise_(chat, true); }
  if (cmd === 'todo' || cmd === 'todos') return arg ? tgAddTodo_(m, arg) : tgSay_(tgTodoText_(chat), chat, tgTodoButtons_(chat));
  if (cmd === 'done') {
    const open = tgOpenTodos_(chat), n = Number(arg), t = open[n - 1];
    if (!t) return tgSay_('Which one? Send /todo to see the numbers, then e.g. /done 2.', chat);
    tgTick_(t, tgName_(m.from)); return tgSay_('✅ Done: ' + tgEsc_(t.task), chat);
  }
}
function tgOpenTodos_(chat) { return tgRows_('tg_todos').filter(t => t.chat === chat && t.status !== 'done' && t.status !== 'void'); }
function tgDueLabel_(d) { if (!d) return ''; const t = tgToday_(); if (d < t) return ' · <b>overdue</b> (' + d + ')'; if (d === t) return ' · due today'; return ' · due ' + Utilities.formatDate(new Date(d + 'T12:00:00'), TZ, 'EEE d MMM'); }
function tgTodoText_(chat) {
  const open = tgOpenTodos_(chat);
  if (!open.length) return 'No open to-dos here. 🎉';
  return '<b>Open to-dos</b>\n' + open.map((t, i) => (i + 1) + '. ' + tgEsc_(t.task) + (t.owner ? ' — <i>' + tgEsc_(t.owner) + '</i>' : '') + tgDueLabel_(t.due)).join('\n');
}
function tgTodoButtons_(chat, list) {
  const open = list || tgOpenTodos_(chat), rows = [];
  open.slice(0, 12).forEach((t, i) => { if (i % 4 === 0) rows.push([]); rows[rows.length - 1].push({ text: '✅ ' + (i + 1), callback_data: 'gdone:' + t.id }); });
  return rows;
}
function tgTick_(t, who) {
  tgSet_('tg_todos', t.id, { status: 'done', updated: tgToday_() });
  if (/^hq:/.test(t.source)) { try { patchRow_('tasks', t.source.slice(3), { status: 'done', updated: tgToday_() }); } catch (e) {} }
}
function tgIsTimothy_(owner) { const o = String(owner || '').trim(); return /\b(timothy|tjc)\b/i.test(o) || /^(tim|me|saya|aku|gue)$/i.test(o); }
/** Saves to-dos: Timothy's own also become HQ tasks, so they show on his Today screen. */
function tgStoreTodos_(chat, group, todos, source) {
  const today = tgToday_(), rows = [], hq = [];
  todos.filter(t => t && t.task).forEach(t => {
    const id = tgId_(), due = /^\d{4}-\d{2}-\d{2}$/.test(t.due || '') ? t.due : '';
    let src = source || '';
    if (tgIsTimothy_(t.owner)) { const tid = 'tg' + id; src = 'hq:' + tid;
      hq.push({ id: tid, title: String(t.task).trim(), world: ['church', 'company', 'personal'].indexOf(t.world) >= 0 ? t.world : 'church', date: due || today, part: 'morning', status: '', for: '', type: '',
        notes: 'From Telegram group "' + group + '"', void: '', created: today, updated: today }); }
    rows.push({ id, chat, group, task: String(t.task).trim(), owner: String(t.owner || '').trim(), due, status: 'open', created: today, updated: today, nudged: '', source: src });
  });
  tgAppend_('tg_todos', rows); if (hq.length) appendTasks_(hq);
  return rows;
}
function tgAddTodo_(m, arg) {
  const chat = String(m.chat.id);
  const res = geminiParts_([{ text: [
    'Turn this into ONE to-do. Today is ' + Utilities.formatDate(new Date(), TZ, 'EEEE yyyy-MM-dd') + ' (Asia/Jakarta). Keep the language (Indonesian/English).',
    'owner = the person who must do it if named, else "' + tgName_(m.from) + '"; due = yyyy-mm-dd if a day or date is given (resolve "Jumat", "besok", "next week"), else "".',
    'Return JSON only: {"task":"","owner":"","due":""}', 'Text: ' + arg].join('\n') }], true, 0.1);
  const row = tgStoreTodos_(chat, m.chat.title || '', [res.task ? res : { task: arg, owner: tgName_(m.from), due: '' }])[0];
  tgSay_('📌 Added: ' + tgEsc_(row.task) + (row.owner ? ' — <i>' + tgEsc_(row.owner) + '</i>' : '') + tgDueLabel_(row.due), chat, [[{ text: '✅ Done', callback_data: 'gdone:' + row.id }]]);
}
/** Summary since the last one (or the last 24 hours), with decisions and to-dos. toGroup=false sends it to Timothy only. */
function tgSummarise_(chat, toGroup) {
  const g = tgGroups_(), info = g[chat] || { title: 'Group', lastSummaryTs: 0 };
  const since = Math.max(Number(info.lastSummaryTs || 0), Math.floor(Date.now() / 1000) - 24 * 3600);
  const msgs = tgRows_('tg_log').filter(r => r.chat === chat && Number(r.ts) > since).slice(-400);
  if (msgs.length < (toGroup ? 2 : 5)) { if (toGroup) tgSay_('Not much to summarise yet' + (info.lastSummaryTs ? ' since the last summary' : ' from the last 24 hours') + '.', chat); return null; }
  const parts = [{ text: '' }]; let voices = 0;
  msgs.forEach(r => { if (r.kind === 'voice' && r.file && voices < 6) { try { parts.push({ text: 'Voice note from ' + r.from + ' at ' + r.time + ':' }); parts.push(tgMedia_(r.file, 'audio/ogg')); voices++; } catch (e) {} } });
  parts[0].text = [
    'You are the note-taker for Timothy (Executive Pastor at GPKdI BCC Jakarta, director of two companies) in the Telegram group "' + info.title + '".',
    'Today is ' + Utilities.formatDate(new Date(), TZ, 'EEEE yyyy-MM-dd') + ' (Asia/Jakarta). Write in the main language of the chat (Indonesian or English).',
    'Use ONLY what is in the messages (and the attached voice notes, in order). Never invent names, dates or decisions.',
    'summary: 2–5 short bullet points of what was discussed. decisions: what was agreed. todos: concrete next actions — task starts with a verb, owner = the person named or who offered (exact name as in the chat; "Timothy" for him), due = yyyy-mm-dd when a day/date is said (resolve relative days from today) else "", world = church|company|personal.',
    'questions: things asked that nobody answered yet.',
    'Return JSON only: {"title":"short title of the conversation","summary":[""],"decisions":[""],"todos":[{"task":"","owner":"","due":"","world":"church"}],"questions":[""]}',
    '', 'Messages:', msgs.map(r => '[' + r.date + ' ' + r.time + '] ' + r.from + ': ' + (r.kind === 'voice' ? '(voice note, attached)' : r.text)).join('\n')
  ].join('\n');
  const res = geminiParts_(parts, true, 0.2);
  const todos = tgStoreTodos_(chat, info.title, res.todos || []);
  const list = a => (a || []).filter(String);
  const html = [
    '<b>📝 ' + tgEsc_(info.title) + ' – ' + tgEsc_(res.title || 'notes') + '</b>', '<i>' + msgs[0].date + ' ' + msgs[0].time + ' → ' + msgs[msgs.length - 1].date + ' ' + msgs[msgs.length - 1].time + ' · ' + msgs.length + ' messages</i>',
    list(res.summary).length ? '\n<b>Summary</b>\n' + list(res.summary).map(x => '• ' + tgEsc_(x)).join('\n') : '',
    list(res.decisions).length ? '\n<b>Decisions</b>\n' + list(res.decisions).map(x => '• ' + tgEsc_(x)).join('\n') : '',
    todos.length ? '\n<b>To-do</b>\n' + todos.map((t, i) => (i + 1) + '. ' + tgEsc_(t.task) + (t.owner ? ' — <i>' + tgEsc_(t.owner) + '</i>' : '') + tgDueLabel_(t.due)).join('\n') : '',
    list(res.questions).length ? '\n<b>Still open</b>\n' + list(res.questions).map(x => '• ' + tgEsc_(x)).join('\n') : ''
  ].filter(String).join('\n');
  let noteLink = ''; try { noteLink = tgDailyNotes_([tgToday_()], true, chat).length ? 'ok' : ''; } catch (e) { Logger.log('Day note: ' + e.message); }
  info.lastSummaryTs = Number(msgs[msgs.length - 1].ts); g[chat] = info; tgSaveGroups_(g);
  if (toGroup) tgSay_(html, chat, tgTodoButtons_(chat, todos));
  else tgSay_(html + (noteLink ? '\n\nToday\'s note: HQ Notes › Telegram › ' + tgEsc_(info.title) + '.' : ''), null, todos.length ? tgTodoButtons_(chat, todos) : null);
  return html;
}
/** Each summary becomes an HQ note in the folder Telegram/<group>, with a checklist of the to-dos and the chat underneath. */
function tgSaveNote_(group, res, todos, msgs) {
  try {
    const id = 'tg-' + tgId_(), today = tgToday_(), title = group + ' – ' + (res.title || 'notes') + ' (' + today + ')';
    const ul = a => '<ul>' + a.map(x => '<li>' + tgEsc_(x) + '</li>').join('') + '</ul>';
    const html = '<h1>' + tgEsc_(title) + '</h1>' +
      ((res.summary || []).length ? '<h2>Summary</h2>' + ul(res.summary) : '') +
      ((res.decisions || []).length ? '<h2>Decisions</h2>' + ul(res.decisions) : '') +
      (todos.length ? '<h2>To-do</h2><ul class="check">' + todos.map(t => '<li>' + tgEsc_(t.task + (t.owner ? ' — ' + t.owner : '') + (t.due ? ' (due ' + t.due + ')' : '')) + '</li>').join('') + '</ul>' : '') +
      ((res.questions || []).length ? '<h2>Still open</h2>' + ul(res.questions) : '') +
      '<hr><h3>Chat</h3>' + msgs.map(r => '<p><b>' + tgEsc_(r.from) + '</b> <small>' + r.date + ' ' + r.time + '</small><br>' + tgEsc_(r.text) + '</p>').join('');
    const link = writeNote_(id, title, html);
    appendRows_('notes_index', [{ id, title, para: 'Areas', type: 'Work', date: today, driveLink: link, tags: 'telegram', void: '', kind: 'note', folder: 'Telegram/' + group.replace(/\//g, '-'),
      text: [title].concat(res.summary || []).join(' ').slice(0, 300), hasCheck: todos.length ? '1' : '', updated: today }]);
    return link;
  } catch (e) { Logger.log('Note not saved: ' + e.message); return ''; }
}

/* ---------- Hourly: 9 a.m. follow-ups in groups, 9 p.m. recap to Timothy ---------- */
function tgHourly() {
  const props = tgProps_(), hour = Number(Utilities.formatDate(new Date(), TZ, 'H')), today = tgToday_();
  if (hour === 9 && props.getProperty('tgFollowSent') !== today) { props.setProperty('tgFollowSent', today); tgFollowUp_(); }
  if (hour === 21 && props.getProperty('tgRecapSent') !== today) { props.setProperty('tgRecapSent', today); tgRecapAll_(false); }
  try { tgDailyNotes_(hour < 2 ? [tgToday_(-1), today] : [today]); } catch (e) { Logger.log('Day notes failed: ' + e.message); }
}

/* ---------- One HQ note per chat per day (groups + Timothy's own chat with the bot) ---------- */
const TG_PRIVATE = 'TJC PA';
/** For each chat with messages on these dates: one note "<chat> – Fri 27 Nov 2026" in Notes › Telegram › <chat>,
 *  with summary, decisions, to-dos, open questions and the whole chat. Rebuilt only when new messages came in. */
function tgDailyNotes_(dates, force, onlyChat) {
  const props = tgProps_(), built = JSON.parse(props.getProperty('tgDaily') || '{}'), done = [], started = Date.now();
  const rows = tgRows_('tg_log').filter(r => dates.indexOf(r.date) >= 0 && (!onlyChat || r.chat === onlyChat));
  const chats = {}; rows.forEach(r => (chats[r.chat + '|' + r.date] = chats[r.chat + '|' + r.date] || []).push(r));
  Object.keys(chats).forEach(key => {
    const msgs = chats[key].sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!force && built[key] === msgs.length) return;
    if (Date.now() - started > 240000) return;   // leave the rest for the next hour
    const [chat, date] = key.split('|'), mine = msgs[0].group === TG_PRIVATE, name = mine ? TG_PRIVATE : (msgs[msgs.length - 1].group || 'Group');
    msgs.forEach(r => { if (r.kind === 'voice' && r.file && Date.now() - started < 200000) { try {   // hear each voice note once and keep the words
      const heard = geminiParts_([{ text: 'Transcribe this voice note word for word in its own language (Indonesian, English or mixed). Return only the words.' }, tgMedia_(r.file, 'audio/ogg')], false, 0);
      r.text = '[voice] ' + heard.trim(); r.kind = 'text'; tgSet_('tg_log', r.id, { text: r.text, kind: 'text' });
    } catch (e) { Logger.log('Voice ' + r.id + ': ' + e.message); } } });
    const chatText = msgs.map(r => '[' + r.time + '] ' + r.from + ': ' + (r.kind === 'voice' ? '(voice note, not transcribed yet)' : r.text)).join('\n');
    let res = {};
    try {
      res = geminiParts_([{ text: [
        mine ? 'These are Timothy\'s own messages to his assistant bot on ' + date + ' (notes, ideas, tasks, questions). He is Executive Pastor at GPKdI BCC Jakarta and director of two companies.'
             : 'You are the note-taker for Timothy (Executive Pastor at GPKdI BCC Jakarta, director of two companies) in the Telegram group "' + name + '" on ' + date + '.',
        'Write in the main language of the messages (Indonesian or English). Use ONLY what is in them. Never invent names, dates, numbers or decisions; keep lists of names complete and exact.',
        'title: a short title for the day. summary: 2–6 short bullets of what was said or noted. decisions: what was agreed. todos: next actions (start with a verb; owner = person named, "Timothy" for him; due yyyy-mm-dd if a day is said, resolve relative days from ' + date + '). questions: asked but not answered.',
        'Return JSON only: {"title":"","summary":[""],"decisions":[""],"todos":[{"task":"","owner":"","due":""}],"questions":[""]}',
        '', 'Messages:', chatText.slice(0, 60000)].join('\n') }], true, 0.2);
    } catch (e) { res = { summary: ['(Summary not ready: ' + e.message + '. The chat is below; it will try again next hour.)'] }; }
    const day = Utilities.formatDate(new Date(date + 'T12:00:00'), TZ, 'EEE d MMM yyyy'), title = name + ' – ' + day;
    const list = a => (a || []).filter(x => x && String(x).trim());
    const ul = a => '<ul>' + list(a).map(x => '<li>' + tgEsc_(x) + '</li>').join('') + '</ul>';
    const todos = (res.todos || []).filter(t => t && t.task);
    const html = '<h1>' + tgEsc_(title) + '</h1>' +
      (res.title ? '<p><b>' + tgEsc_(res.title) + '</b> · ' + msgs.length + ' messages · ' + msgs[0].time + '–' + msgs[msgs.length - 1].time + '</p>' : '') +
      (list(res.summary).length ? '<h2>Summary</h2>' + ul(res.summary) : '') +
      (list(res.decisions).length ? '<h2>Decisions</h2>' + ul(res.decisions) : '') +
      (todos.length ? '<h2>To-do</h2><ul class="check">' + todos.map(t => '<li>' + tgEsc_(t.task + (t.owner ? ' — ' + t.owner : '') + (t.due ? ' (due ' + t.due + ')' : '')) + '</li>').join('') + '</ul>' : '') +
      (list(res.questions).length ? '<h2>Still open</h2>' + ul(res.questions) : '') +
      '<hr><h3>' + (mine ? 'Everything I sent' : 'Chat') + '</h3>' + msgs.map(r => '<p><b>' + tgEsc_(r.from) + '</b> <small>' + r.time + '</small><br>' + tgEsc_(r.text).replace(/\n/g, '<br>') + '</p>').join('');
    const id = 'tgd-' + chat.replace(/^-/, 'g') + '-' + date.replace(/-/g, '');
    const link = writeNote_(id, title, html);
    patchRow_('notes_index', id, { title, para: 'Areas', type: mine ? 'Personal' : 'Work', date, driveLink: link, tags: 'telegram', void: '', kind: 'note',
      folder: 'Telegram/' + name.replace(/\//g, '-'), text: [title, res.title || ''].concat(list(res.summary)).join(' ').slice(0, 300), hasCheck: todos.length ? '1' : '', updated: tgToday_() });
    built[key] = msgs.length; done.push(title);
  });
  Object.keys(built).forEach(k => { if (k.split('|')[1] < tgToday_(-3)) delete built[k]; });
  props.setProperty('tgDaily', JSON.stringify(built));
  return done;
}
function tgFollowUp_() {
  const today = tgToday_(), twoDaysAgo = tgToday_(-2), g = tgGroups_(), mine = [];
  const open = tgRows_('tg_todos').filter(t => t.status === 'open' && g[t.chat]);
  const byChat = {};
  open.forEach(t => {
    const due = t.due && t.due <= today, stale = !t.due && t.created <= tgToday_(-3);
    if ((due || stale) && (!t.nudged || t.nudged <= twoDaysAgo)) (byChat[t.chat] = byChat[t.chat] || []).push(t);
  });
  Object.keys(byChat).forEach(chat => {
    const list = byChat[chat];
    try {
      tgSay_('<b>⏰ Follow-up</b>\n' + list.map((t, i) => (i + 1) + '. ' + tgEsc_(t.task) + (t.owner ? ' — <i>' + tgEsc_(t.owner) + '</i>' : '') + tgDueLabel_(t.due)).join('\n') + '\n\nDone already? Tap ✅.', chat, tgTodoButtons_(chat, list));
      list.forEach(t => tgSet_('tg_todos', t.id, { nudged: today }));
      mine.push('<b>' + tgEsc_(g[chat].title) + '</b>: ' + list.length + ' followed up');
    } catch (e) { mine.push(tgEsc_(g[chat].title) + ': could not post (' + tgEsc_(e.message) + ')'); }
  });
  if (mine.length) tgSay_('Group follow-ups sent this morning:\n' + mine.join('\n'));
}
function tgRecapAll_(always) {
  const g = tgGroups_(), done = [];
  Object.keys(g).forEach(chat => { try { if (tgSummarise_(chat, false)) done.push(g[chat].title); } catch (e) { tgSay_('Recap of ' + tgEsc_(g[chat].title) + ' failed: ' + tgEsc_(e.message)); } });
  if (always && !done.length) tgSay_(Object.keys(g).length ? 'Nothing new to recap in your groups.' : 'I\'m not in any group yet. Add me to one and I\'ll take notes there.');
}

/* ---------- Buttons ---------- */
function tgCallback_(cb) {
  const owner = tgProps_().getProperty('TELEGRAM_CHAT'), msg = cb.message || {}, chat = String(msg.chat && msg.chat.id || '');
  const [action, id, extra] = String(cb.data || '').split(':');
  const answer = t => tg_('answerCallbackQuery', { callback_query_id: cb.id, text: t || '' });
  if (action === 'gdone') {   // group to-do: anyone in an allowed group may tick it
    if (!(chat === owner || tgGroups_()[chat])) return answer();
    const t = tgRows_('tg_todos').filter(x => x.id === id)[0];
    if (!t) return answer('Not found');
    if (t.status === 'done') return answer('Already done ✓');
    tgTick_(t, tgName_(cb.from)); answer('Done ✓');
    if (msg.chat && msg.chat.type !== 'private') tgSay_('✅ ' + tgEsc_(tgName_(cb.from)) + ' ticked off: ' + tgEsc_(t.task), chat);
    return;
  }
  if (chat !== owner) return answer();
  const today = tgToday_();
  if (action === 'tmr') {
    const tmr = tgToday_(1); patchRow_('tasks', id, { date: tmr, updated: today }); answer('Moved to tomorrow');
    tg_('editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: '📅 Moved to ' + tmr, callback_data: 'noop' }, { text: '🗑 Undo', callback_data: 'del:' + id }]] } });
  } else if (action === 'wld') {
    const worlds = ['company', 'church', 'personal'], next = worlds[(worlds.indexOf(extra) + 1) % 3];
    patchRow_('tasks', id, { world: next, updated: today }); answer('Now: ' + next);
    tg_('editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: tgTaskButtons_(id, next) } });
  } else if (action === 'del') {
    patchRow_(extra === 'cash' ? 'cash_entries' : extra === 'note' ? 'notes_index' : 'tasks', id, { void: '1', updated: today }); answer('Removed from HQ');
    tg_('editMessageText', { chat_id: chat, message_id: msg.message_id, text: '<s>' + tgEsc_(msg.text || '') + '</s>\n<i>(removed)</i>', parse_mode: 'HTML' });
  } else if (action === 'done') {
    patchRow_('tasks', id, { status: 'done', updated: today }); answer('Done ✓');
    tg_('editMessageReplyMarkup', { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: 'noop' }]] } });
  } else if (action === 'news') { answer(); tgSay_(briefText_(true)); }
  else answer();
}
function tgTaskButtons_(id, world) {
  return [[{ text: '✅ Done', callback_data: 'done:' + id }, { text: '📅 Tomorrow', callback_data: 'tmr:' + id }, { text: '🌍 ' + world, callback_data: 'wld:' + id + ':' + world }, { text: '🗑 Undo', callback_data: 'del:' + id }]];
}

/* ---------- Private chat with Timothy ---------- */
function tgPrivate_(m) {
  const text = (m.text || m.caption || '').trim();
  if (/^\/(start|help)/.test(text)) return tgSay_(TG_HELP);
  if (/^\/today/.test(text)) return tgSay_(briefText_(false), null, [[{ text: '📰 Full news', callback_data: 'news' }]]);
  if (/^\/news/.test(text)) return tgSay_(briefText_(true));
  if (/^\/tasks/.test(text)) return tgSay_(todayTasksText_());
  if (/^\/groups/.test(text)) { const g = tgGroups_(), ks = Object.keys(g); return tgSay_(ks.length ? '<b>Groups I take notes in</b>\n' + ks.map(k => '• ' + tgEsc_(g[k].title) + ' – ' + tgOpenTodos_(k).length + ' open to-dos').join('\n') : 'No groups yet. Add me to a group and I take notes there.'); }
  if (/^\/recap/.test(text)) { tg_('sendChatAction', { chat_id: m.chat.id, action: 'typing' }); return tgRecapAll_(true); }
  if (/^\/(notes|daily)/.test(text)) { tg_('sendChatAction', { chat_id: m.chat.id, action: 'typing' }); const done = tgDailyNotes_([tgToday_()], true);
    return tgSay_(done.length ? '📒 Today\'s notes are up to date in HQ Notes › Telegram:\n' + done.map(x => '• ' + tgEsc_(x)).join('\n') : 'No chat messages logged yet today.'); }
  const voice = m.voice || m.audio, photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1] : null;
  const doc = m.document && /^(application\/pdf|image\/)/.test(m.document.mime_type || '') ? m.document : null;
  const fwd = !!(m.forward_date || m.forward_origin);
  if (!text && !voice && !photo && !doc) return tgSay_('I can take text, voice notes, forwarded messages, photos of receipts and PDFs.');
  const noteCmd = text.match(/^(?:note|notes|catatan|\/note)\s*[:：\-–]?\s*([\s\S]*)$/i);
  if (noteCmd && (/^\/note/i.test(text) || /^(note|notes|catatan)\s*[:：\-–]/i.test(text))) {   // "Note: …" = saved word for word, no guessing
    const body = noteCmd[1].trim();
    if (!body) return tgSay_('Send the note after "Note:", for example:\nNote: Discipleship Core – Evan, Gerry …');
    const lines = body.split('\n'), title = lines[0].replace(/^[-•*]\s*/, '').trim().slice(0, 80);
    return tgNoteSaid_(tgSaveCapture_(title, lines.length > 1 ? lines.slice(1).join('\n') : '', /gereja|church|komid|khotbah|sermon|doa|prayer|discipleship|pemuridan|pelayan|retreat|ibadah/i.test(body) ? 'church' : /pt |cwm|peregrine|citra|supplier|invoice|kantor|office/i.test(body) ? 'company' : 'personal', fwd ? 'forwarded' : ''));
  }
  tg_('sendChatAction', { chat_id: m.chat.id, action: 'typing' });
  const parts = [{ text: tgPrompt_(text, fwd, !!photo, !!doc) }];
  if (voice) parts.push(tgMedia_(voice.file_id, voice.mime_type || 'audio/ogg'));
  if (photo) parts.push(tgMedia_(photo.file_id, 'image/jpeg'));
  if (doc) parts.push(tgMedia_(doc.file_id, doc.mime_type));
  const res = geminiParts_(parts, true, 0.1, true);
  if (voice && res.transcript) tgHeard_ = String(res.transcript);
  if (res.intent === 'question') return tgSay_(answerHqQuestion_(res.query || text || res.transcript, res.domain || 'all'));
  if (res.intent === 'expense' && res.expense && Number(String(res.expense.amount).replace(/[^\d.]/g, ''))) return tgExpense_(res.expense);
  const items = (res.items || []).filter(i => i && i.title).slice(0, 5);
  if (!items.length) return tgSay_('I couldn\'t find a task, note or question in that.' + (res.transcript ? '\n<i>I heard: ' + tgEsc_(res.transcript) + '</i>' : ''));
  const today = tgToday_(), how = voice ? ' (voice)' : photo ? ' (photo)' : doc ? ' (PDF)' : fwd ? ' (forwarded)' : '';
  const lines = [];
  if (voice && res.transcript) lines.push('<i>"' + tgEsc_(res.transcript) + '"</i>\n');
  if (res.summary) lines.push('📋 ' + tgEsc_(res.summary) + '\n');
  const notes = items.filter(i => i.kind === 'note').map(i => tgSaveCapture_(String(i.title).trim(),
    [i.notes, voice && res.transcript ? 'Voice note: "' + res.transcript + '"' : ''].filter(x => x).join('\n\n'), i.world, how.replace(/[() ]/g, '')));
  notes.forEach(n => lines.push(n.link ? '📝 <b>' + tgEsc_(n.title) + '</b> — saved in Notes › Telegram' : '⚠️ <b>' + tgEsc_(n.title) + '</b> — could not save to Notes: ' + tgEsc_(n.error)));
  const rows = items.filter(i => i.kind !== 'note').map(i => ({
    id: tgId_(), title: String(i.title).trim(), world: ['church', 'company', 'personal'].indexOf(i.world) >= 0 ? i.world : 'personal',
    date: /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : (i.kind === 'task' ? today : ''),
    part: ['morning', 'noon', 'evening'].indexOf(i.part) >= 0 ? i.part : 'morning', status: '',
    for: i.kind === 'task' ? '' : 'claude', type: i.kind === 'task' ? '' : 'task',
    notes: [i.notes, 'From Telegram' + how].filter(x => x).join(' · '), void: '', created: today, updated: today }));
  if (rows.length) appendTasks_(rows);
  rows.forEach(r => lines.push('✓ <b>' + tgEsc_(r.title) + '</b> — ' + (r.for ? 'for Claude' : (r.date === today ? 'today' : r.date)) + ' · ' + r.world));
  const one = notes.length + rows.length === 1;
  tgSay_(lines.join('\n'), null, one && rows.length && !rows[0].for ? tgTaskButtons_(rows[0].id, rows[0].world)
    : one && notes[0].link ? [[{ text: '🗑 Undo', callback_data: 'del:' + notes[0].id + ':note' }]] : null);
}
/** A note from Timothy's private chat becomes a real HQ note in the folder "Telegram" (lists kept as lists). */
function tgSaveCapture_(title, body, world, how) {
  const id = 'tg-' + tgId_(), today = tgToday_();
  title = title || 'Note from Telegram (' + today + ')';
  let html = '<h1>' + tgEsc_(title) + '</h1>', list = '';
  const flush = () => { if (list) { html += '<ul>' + list + '</ul>'; list = ''; } };
  String(body || '').split('\n').forEach(l => {
    const t = l.trim();
    if (/^[-•*]\s+/.test(t)) list += '<li>' + tgEsc_(t.replace(/^[-•*]\s+/, '')) + '</li>';
    else { flush(); html += t ? '<p>' + tgEsc_(t) + '</p>' : '<p><br></p>'; }
  });
  flush();
  html += '<p><small>From Telegram' + (how ? ' (' + tgEsc_(how) + ')' : '') + ' · ' + Utilities.formatDate(new Date(), TZ, 'd MMM yyyy HH:mm') + '</small></p>';
  try {
    const link = writeNote_(id, title, html);
    appendRows_('notes_index', [{ id, title, para: 'Areas', type: world === 'company' ? 'Work' : world === 'church' ? 'Church' : 'Personal', date: today, driveLink: link, tags: 'telegram', void: '', kind: 'note',
      folder: 'Telegram', text: (title + ' ' + String(body || '').replace(/\s+/g, ' ')).slice(0, 300), hasCheck: '', updated: today }]);
    return { id, title, link };
  } catch (e) { Logger.log('Telegram note not saved: ' + e.message); return { id, title, link: '', error: e.message }; }
}
function tgNoteSaid_(n) {
  if (!n.link) return tgSay_('⚠️ I couldn\'t save that to Notes: ' + tgEsc_(n.error) + '\nNothing was lost — your message is still here in the chat. Try again in a minute.');
  tgSay_('📝 Saved in HQ Notes › Telegram\n<b>' + tgEsc_(n.title) + '</b>', null, [[{ text: '🗑 Undo', callback_data: 'del:' + n.id + ':note' }]]);
}
function tgPrompt_(text, fwd, hasPhoto, hasDoc) {
  return [
    'Timothy (Executive Pastor at GPKdI BCC Jakarta, director of PT Citra Warna Mulia Tama and PT Peregrine Indo Chemica) sent this to his HQ assistant.',
    text ? 'Message: "' + text + '"' : 'See the attached media (Indonesian, English or mixed).',
    fwd ? 'It is a FORWARDED message: put a 1–2 sentence gist in "summary" and pull out concrete tasks or notes.' : '',
    hasPhoto ? 'A PHOTO is attached. If it is a receipt, invoice or bill: intent "expense" with merchant, total amount (digits only), date (yyyy-mm-dd) and category.' : '',
    hasDoc ? 'A PDF/document is attached: summarise it in "summary" and pull out action items or notes.' : '',
    'Today is ' + Utilities.formatDate(new Date(), TZ, 'EEEE yyyy-MM-dd HH:mm') + ' (Asia/Jakarta).',
    'intent: "question" (he asks about his schedule, tasks, emails, sermons, notes; query = the question), "expense", or "capture".',
    'For capture, up to 5 items: kind = "task" (Timothy must do it) | "claude" (he asks Claude to do/prepare something, e.g. starts with Claude / minta Claude) | "note" (idea, sermon seed, summary to keep);',
    'title short, tasks start with a verb, keep his language; date yyyy-mm-dd when a day is given (resolve "Kamis", "besok", "next week") else ""; part morning|noon|evening or "";',
    'world = church (ministry, sermons, KOMID, prayer, church people) | company (the two companies, suppliers, finance) | personal (family, home, health, errands); notes = useful detail or "".',
    'Return JSON only: {"intent":"capture","domain":"calendar|tasks|sermons|notes|email|all","query":"","transcript":"<voice only>","summary":"","expense":{"merchant":"","amount":"","date":"","category":""},"items":[{"kind":"task","title":"","date":"","part":"","world":"personal","notes":""}]}'
  ].filter(String).join('\n');
}
function tgExpense_(e) {
  const today = tgToday_(), books = readTab_('cashbooks').filter(b => !b.void);
  let book = books[0];
  if (!book) { book = { id: 'cb-' + tgId_(), name: 'Personal', world: 'personal', currency: 'IDR', order: '1', created: today, void: '' }; appendRows_('cashbooks', [book]); }
  const id = 'ce-' + tgId_(), amount = String(e.amount).replace(/[^\d.]/g, '');
  appendRows_('cash_entries', [{ id, bookId: book.id, type: 'out', amount, date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : today,
    time: Utilities.formatDate(new Date(), TZ, 'HH:mm'), remark: String(e.merchant || 'Receipt').trim() + ' (from Telegram)', category: String(e.category || 'General'), mode: '', party: String(e.merchant || ''),
    attachment: '', created: today, updated: today, void: '' }]);
  tgSay_('🧾 <b>Cash out</b> in ' + tgEsc_(book.name) + ': ' + tgEsc_(e.merchant || 'Receipt') + ' – Rp ' + Number(amount).toLocaleString('id-ID') + ' · ' + tgEsc_(e.category || 'General'),
    null, [[{ text: '🗑 Undo', callback_data: 'del:' + id + ':cash' }]]);
}
/** Answers a question from HQ data only (calendar, tasks, sermons, notes, inbox). */
function answerHqQuestion_(query, domain) {
  const ctx = ['Now: ' + Utilities.formatDate(new Date(), TZ, 'EEEE yyyy-MM-dd HH:mm') + ' (Asia/Jakarta)'];
  const want = (d, re) => domain === d || domain === 'all' || re.test(query);
  if (want('calendar', /jadwal|schedule|calendar|acara|meeting|besok|tomorrow|today|hari ini|leave|berangkat/i)) { try {
    const evs = calendar_(3).filter(e => !e.birthday).slice(0, 20);
    if (evs.length) ctx.push('CALENDAR (3 days):\n' + evs.map(e => '- ' + String(e.start).slice(0, 16).replace('T', ' ') + '–' + String(e.end).slice(11, 16) + ' ' + e.title + (e.location ? ' @ ' + e.location : '') + (e.leave ? ' [leave by ' + String(e.leave).slice(11, 16) + ']' : '')).join('\n'));
  } catch (e) {} }
  if (want('tasks', /task|tugas|todo|to-do|kerjaan|claude|pending/i)) { try {
    const t = readTab_('tasks').filter(x => !x.void && x.status !== 'done').slice(-30);
    if (t.length) ctx.push('OPEN TASKS:\n' + t.map(x => '- [' + (x.world || 'personal') + '] ' + x.title + (x.date ? ' (' + x.date + ')' : '') + (x.for ? ' [for ' + x.for + ']' : '')).join('\n'));
    const g = tgRows_('tg_todos').filter(x => x.status === 'open');
    if (g.length) ctx.push('GROUP TO-DOS (Telegram):\n' + g.map(x => '- [' + x.group + '] ' + x.task + (x.owner ? ' — ' + x.owner : '') + (x.due ? ' (' + x.due + ')' : '')).join('\n'));
  } catch (e) {} }
  if (want('sermons', /sermon|khotbah|kotbah|preach|ayat|pasal|kitab|theme|series/i)) { try {
    const q = query.toLowerCase(), refs = parseRefs(query);
    const s = readTab_('sermons').filter(x => !x.void).filter(x => (refs.length && x.refs && refs.some(r => String(x.refs).split(/[;\s]+/).some(a => a && refMatch(a, r) >= 2))) ||
      q.split(/\s+/).filter(w => w.length > 3).some(w => (x.title + ' ' + x.themes + ' ' + x.series + ' ' + x.bigIdea + ' ' + x.refs).toLowerCase().indexOf(w) >= 0)).slice(0, 10);
    if (s.length) ctx.push('SERMONS:\n' + s.map(x => '- ' + (x.date || '?') + ' "' + x.title + '" (' + (x.context || '') + ', ' + (x.refs || '') + ') – ' + (x.bigIdea || '')).join('\n'));
  } catch (e) {} }
  if (want('notes', /note|catatan|idea|ide|save|simpan|where|mana/i)) { try {
    const w = query.toLowerCase().split(/\s+/).filter(x => x.length > 3);
    const all = readTab_('notes_index').filter(x => !x.void && x.kind === 'note');
    const n = all.filter(x => w.some(k => (x.title + ' ' + x.text + ' ' + x.folder).toLowerCase().indexOf(k) >= 0)).slice(0, 8);
    if (n.length) ctx.push('NOTES:\n' + n.map(x => '- [' + (x.folder || 'Notes') + '] ' + x.title + ': ' + String(x.text || '').slice(0, 200)).join('\n'));
    const recent = all.filter(x => x.folder === 'Telegram').slice(-5);
    if (recent.length) ctx.push('LATEST NOTES SAVED FROM TELEGRAM (in HQ Notes › Telegram):\n' + recent.map(x => '- ' + x.date + ' ' + x.title).join('\n'));
    const fc = readTab_('tasks').filter(x => !x.void && x.for === 'claude' && x.type === 'note').slice(-5);
    if (fc.length) ctx.push('OLDER NOTES ON THE FOR CLAUDE LIST (not in Notes):\n' + fc.map(x => '- ' + x.title).join('\n'));
  } catch (e) {} }
  if (want('email', /email|mail|inbox/i)) { try {
    const b = brief_(); if (b.important && b.important.length) ctx.push('IMPORTANT UNREAD EMAIL:\n' + b.important.map(e => '- ' + e.from + ': ' + e.subject).join('\n'));
  } catch (e) {} }
  return geminiParts_([{ text: ['You are Timothy\'s HQ assistant on Telegram. Answer briefly using ONLY the HQ context below; if it is not there, say so.',
    'Format with Telegram HTML only (<b>, <i>) and "• " bullets. Answer in the language of the question.', '', 'Question: ' + query, '', ctx.join('\n\n')].join('\n') }], false, 0.3, true)
    .replace(/<(?!\/?(b|i|u|s|a|code|pre)\b)[^>]*>/g, '');   // Telegram rejects other tags
}
function todayTasksText_() {
  const today = tgToday_(), t = readTab_('tasks').filter(x => !x.void && x.status !== 'done' && !x.for && x.date && x.date <= today);
  return t.length ? '<b>Open tasks (' + t.length + ')</b>\n' + t.slice(0, 25).map(x => '• ' + tgEsc_(x.title) + (x.date < today ? ' <i>(' + x.date + ')</i>' : '') + ' · ' + tgEsc_(x.world || 'personal')).join('\n') : 'No open tasks for today. 🎉';
}
function appendTasks_(rows) { appendRows_('tasks', rows); }   // added at the end; the bridge keeps rows the app doesn't know yet

/* ---------- Morning brief to Telegram ---------- */
function briefText_(newsOnly, rows) {
  const today = tgToday_();
  rows = rows || readTab_('briefs').filter(r => r.date === today && !r.void);
  const sec = s => rows.filter(r => r.section === s).sort((a, b) => Number(a.n) - Number(b.n));
  const a = (r, t) => r.link ? '<a href="' + tgEsc_(r.link) + '">' + tgEsc_(t) + '</a>' : tgEsc_(t);
  const out = [], head = sec('headline')[0];
  if (!newsOnly) {
    out.push('<b>Good morning, Timothy</b>' + (head ? '\n' + a(head, head.title || 'Open the full brief') : ''));
    const pr = sec('priority'), km = sec('keymail'), at = sec('attention');
    if (pr.length) out.push('\n<b>Today\'s priorities</b>\n' + pr.map(r => r.n + '. ' + a(r, r.title) + (r.summary ? ' – ' + tgEsc_(r.summary) : '')).join('\n'));
    if (km.length) out.push('\n<b>Key emails</b>\n' + km.map(r => '• ' + (r.tag ? '[' + tgEsc_(r.tag) + '] ' : '') + a(r, r.title) + (r.summary ? ' – ' + tgEsc_(r.summary) : '')).join('\n'));
    if (at.length) out.push('\n<b>Needs attention</b>\n' + at.map(r => '• ' + a(r, r.title)).join('\n'));
    if (!head) out.push('\nClaude\'s priorities aren\'t in yet.');
  }
  const news = (s, label, k) => { const l = sec(s).slice(0, k); if (l.length) out.push('\n<b>' + label + '</b>\n' + l.map(r => r.n + '. ' + (r.tag ? '[' + tgEsc_(r.tag) + '] ' : '') + a(r, r.title) + (newsOnly && r.summary ? '\n   ' + tgEsc_(r.summary) : '')).join('\n')); };
  news('id', 'Berita Indonesia', newsOnly ? 10 : 3);
  news('world', 'World news', newsOnly ? 10 : 3);
  return out.length ? out.join('\n') : 'Nothing in today\'s brief yet.';
}
/** Every 15 min from 6 to 10 a.m.: sends the brief once Claude has written it (or the news alone at 9 if Claude hasn't). */
function pushBrief() {
  const props = tgProps_(), now = new Date(), today = tgToday_(), hour = Number(Utilities.formatDate(now, TZ, 'H'));
  if (hour < 6 || hour > 10 || props.getProperty('tgBriefSent') === today || !props.getProperty('TELEGRAM_CHAT')) return;
  const rows = readTab_('briefs').filter(r => r.date === today && !r.void);
  if (!rows.some(r => r.section === 'headline') && hour < 9) return;
  if (!rows.length) return;
  tgSay_(briefText_(false, rows), null, [[{ text: '📰 Full news', callback_data: 'news' }]]);
  props.setProperty('tgBriefSent', today);
}

/** Run once (and again after any change to the triggers). Switches off an old webhook and sets the four timers. */
function setupTelegramAndNews() {
  const props = tgProps_();
  if (!props.getProperty('GEMINI_KEY')) throw new Error('Add GEMINI_KEY in Project Settings › Script properties first.');
  const me = tg_('getMe', {});
  tg_('deleteWebhook', { drop_pending_updates: false });   // polling and a webhook cannot run together
  ScriptApp.getProjectTriggers().filter(t => ['newsGemini', 'pollTelegram', 'pushBrief', 'tgHourly'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('newsGemini').timeBased().everyDays(1).atHour(5).nearMinute(20).inTimezone(TZ).create();
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('pushBrief').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('tgHourly').timeBased().everyHours(1).create();
  tg_('setMyCommands', { commands: [
    { command: 'today', description: 'Today\'s brief' }, { command: 'tasks', description: 'Open tasks for today' }, { command: 'news', description: 'Top news' },
    { command: 'groups', description: 'Groups I take notes in' }, { command: 'recap', description: 'Recap all groups now' }, { command: 'help', description: 'How to use me' } ], scope: { type: 'all_private_chats' } });
  tg_('setMyCommands', { commands: [
    { command: 'summary', description: 'Summary, decisions and to-dos' }, { command: 'todo', description: 'Open to-dos, or add one' },
    { command: 'done', description: 'Tick off a to-do: /done 2' }, { command: 'help', description: 'What I do here' } ], scope: { type: 'all_group_chats' } });
  tgTab_('tg_log'); tgTab_('tg_todos');
  const msg = 'Ready (' + TG_VERSION + '). Bot @' + me.username + ' reads messages every minute.' + (me.can_read_all_group_messages ? '' : ' To take notes in groups, turn privacy off in @BotFather (/setprivacy › Disable).');
  Logger.log(msg); return msg;
}
/** Optional test: builds today's news now and shows it in the log, without saving it. */
function testNews() { return newsGemini(true); }
/** Optional check: is a webhook still set, and are messages waiting? */
function telegramStatus() { const w = tg_('getWebhookInfo', {}); const msg = 'Webhook: ' + (w.url || 'off') + ' · waiting: ' + w.pending_update_count + (w.last_error_message ? ' · last error: ' + w.last_error_message : ''); Logger.log(msg); return msg; }
