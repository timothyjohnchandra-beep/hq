/**
 * Timothy HQ – Telegram bot + Gemini news (second file in the same Apps Script project as the bridge).
 * In script.google.com: Files › + › Script, name it "telegram-news", paste this file, save.
 * Script properties (Project Settings › Script properties): GEMINI_KEY (already used for sermons) and TELEGRAM_TOKEN (from @BotFather).
 * Then run setupTelegramAndNews once, open your bot in Telegram and press Start. Only the first chat that presses Start is accepted.
 * Uses TZ, readTab_, ss_, geminiModels_ and geminiJson_ from apps-script.gs.
 */
const TG_VERSION = '2026-11-24 15.00';

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

/* ---------- Telegram ---------- */
function tg_(method, payload) {
  const token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!token) throw new Error('No Telegram token yet. Add TELEGRAM_TOKEN in Project Settings › Script properties.');
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || r.getResponseCode()));
  return j.result;
}
function tgEsc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tgSay_(text, chat) {
  chat = chat || PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT');
  if (!chat) return;
  const parts = [];
  let cur = '';
  String(text).split('\n').forEach(line => { if ((cur + line).length > 3800) { parts.push(cur); cur = ''; } cur += line + '\n'; });
  if (cur.trim()) parts.push(cur);
  parts.forEach(p => tg_('sendMessage', { chat_id: chat, text: p, parse_mode: 'HTML', disable_web_page_preview: true }));
}
const TG_HELP = [
  '<b>Timothy HQ bot</b>',
  'Send a message or a voice note and it goes into HQ:',
  '• "Call Pak Budi Thursday" → a task on Thursday',
  '• "Claude, draft the KOMID outline" → your For Claude list',
  '• "Idea: sermon on Nehemiah 4" → a note for Claude',
  '/today – today\'s brief   /news – news only   /help – this list',
  'Every morning you get the brief here once Claude has written it.'
].join('\n');

/** Every minute: read new messages (only from Timothy's chat) and act on them. */
function pollTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const updates = tg_('getUpdates', { offset: Number(props.getProperty('tgOffset') || 0), timeout: 0, allowed_updates: ['message'] });
    updates.forEach(u => {
      props.setProperty('tgOffset', String(u.update_id + 1));   // saved first, so a failing message is never handled twice
      const m = u.message; if (!m || !m.chat) return;
      const owner = props.getProperty('TELEGRAM_CHAT'), chat = String(m.chat.id);
      if (!owner && /^\/start/.test(m.text || '')) { props.setProperty('TELEGRAM_CHAT', chat); tgSay_('Hi Timothy, this bot is now linked to your HQ.\n\n' + TG_HELP, chat); return; }
      if (chat !== owner) return;   // anyone else is ignored
      try { tgHandle_(m); } catch (e) { tgSay_('Sorry, that didn\'t work: ' + tgEsc_(e.message || e)); }
    });
  } finally { lock.releaseLock(); }
}
function tgHandle_(m) {
  const text = (m.text || m.caption || '').trim();
  if (/^\/(start|help)/.test(text)) return tgSay_(TG_HELP);
  if (/^\/today/.test(text)) return tgSay_(briefText_(false));
  if (/^\/news/.test(text)) return tgSay_(briefText_(true));
  const voice = m.voice || m.audio;
  if (!text && !voice) return tgSay_('I can take text and voice notes for now.');
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  const parts = [{ text: tgPrompt_(text) }];
  if (voice) {
    const f = tg_('getFile', { file_id: voice.file_id });
    const blob = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN') + '/' + f.file_path).getBlob();
    parts.push({ inline_data: { mime_type: voice.mime_type || 'audio/ogg', data: Utilities.base64Encode(blob.getBytes()) } });
  }
  const res = geminiParts_(key, parts);
  const items = (res.items || []).filter(i => i && i.title).slice(0, 5);
  if (!items.length) return tgSay_('I couldn\'t find a task or note in that.' + (res.transcript ? '\nI heard: ' + tgEsc_(res.transcript) : ''));
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = items.map(i => ({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: String(i.title).trim(),
    world: ['church', 'company', 'personal'].indexOf(i.world) >= 0 ? i.world : 'personal',
    date: /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : (i.kind === 'task' ? today : ''),
    part: ['morning', 'noon', 'evening'].indexOf(i.part) >= 0 ? i.part : 'morning', status: '',
    for: i.kind === 'task' ? '' : 'claude', type: i.kind === 'task' ? '' : (i.kind === 'note' ? 'note' : 'task'),
    notes: [i.notes, 'From Telegram' + (voice ? ' (voice)' : '')].filter(x => x).join(' · '), void: '', created: today, updated: today
  }));
  appendTasks_(rows);
  tgSay_((voice && res.transcript ? '<i>' + tgEsc_(res.transcript) + '</i>\n\n' : '') + rows.map(r =>
    '✓ ' + tgEsc_(r.title) + ' — ' + (r.for ? (r.type === 'note' ? 'note for Claude' : 'for Claude') : (r.date === today ? 'today' : r.date)) + ' · ' + r.world).join('\n'));
}
function tgPrompt_(text) {
  const now = new Date();
  return [
    'Timothy (Executive Pastor at GPKdI BCC Jakarta, director of two companies) sent this to his HQ assistant' + (text ? ': "' + text + '"' : ' as the attached voice note (Indonesian, English or mixed).'),
    'Today is ' + Utilities.formatDate(now, TZ, 'EEEE yyyy-MM-dd') + ', Asia/Jakarta. Turn it into HQ items. Keep his wording and language; fix only obvious transcription slips.',
    'Each item: kind = "task" (something Timothy must do), "claude" (he asks Claude to do or prepare something, e.g. starts with Claude / minta Claude / for Claude), or "note" (an idea, thought or sermon seed to keep);',
    'title = short, starts with a verb for tasks; date = yyyy-mm-dd when he gives a day or date (resolve "Thursday", "besok", "minggu depan" from today), else ""; part = morning|noon|evening if he says a time of day, else "";',
    'world = church (ministry, sermons, KOMID, prayer, people at church), company (PT Citra Warna Mulia Tama, PT Peregrine Indo Chemica, suppliers, finance) or personal (family, home, health, errands); notes = useful extra detail or "".',
    'Return JSON only: {"transcript":"<what was said, voice only, else empty>","items":[{"kind":"task","title":"","date":"","part":"","world":"personal","notes":""}]}. Up to 5 items; an empty list if there is nothing to keep.'
  ].join('\n');
}
function geminiParts_(key, parts) {   // like geminiJson_, but can send a voice note along with the prompt
  if (!key) throw new Error('No Gemini key yet.');
  let last = '';
  for (const model of geminiModels_(key)) {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }) });
    const txt = r.getContentText();
    if (r.getResponseCode() === 200) {
      const p = ((((JSON.parse(txt).candidates || [])[0] || {}).content || {}).parts || []);
      return JSON.parse(p.map(x => x.text || '').join('').replace(/^```(json)?|```$/g, '').trim() || '{}');
    }
    last = model + ' ' + r.getResponseCode();
  }
  throw new Error('Gemini is busy or out of quota (' + last + '). Try again in a minute.');
}
function appendTasks_(rows) {   // added at the end; the bridge keeps rows the app doesn't know yet, so a device never wipes them
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = ss_().getSheetByName('tasks');
    const head = s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getDisplayValues()[0];
    Object.keys(rows[0]).forEach(k => { if (head.indexOf(k) < 0) { head.push(k); s.getRange(1, head.length).setValue(k); } });
    const body = rows.map(r => head.map(k => r[k] == null ? '' : String(r[k])));
    const rng = s.getRange(s.getLastRow() + 1, 1, body.length, head.length);
    rng.setNumberFormat('@'); rng.setValues(body);
  } finally { lock.releaseLock(); }
}

/* ---------- Morning brief to Telegram ---------- */
function briefText_(newsOnly, rows) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
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
  const props = PropertiesService.getScriptProperties();
  const now = new Date(), today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd'), hour = Number(Utilities.formatDate(now, TZ, 'H'));
  if (hour < 6 || hour > 10 || props.getProperty('tgBriefSent') === today || !props.getProperty('TELEGRAM_CHAT')) return;
  const rows = readTab_('briefs').filter(r => r.date === today && !r.void);
  if (!rows.some(r => r.section === 'headline') && hour < 9) return;
  tgSay_(briefText_(false, rows));
  props.setProperty('tgBriefSent', today);
}

/** Run once after adding the two Script properties. */
function setupTelegramAndNews() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GEMINI_KEY')) throw new Error('Add GEMINI_KEY in Project Settings › Script properties first.');
  const me = tg_('getMe', {});
  ScriptApp.getProjectTriggers().filter(t => ['newsGemini', 'pollTelegram', 'pushBrief'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('newsGemini').timeBased().everyDays(1).atHour(5).nearMinute(20).inTimezone(TZ).create();
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('pushBrief').timeBased().everyMinutes(15).create();
  const msg = 'Ready (' + TG_VERSION + '). Open Telegram, search @' + me.username + ', press Start.';
  Logger.log(msg); return msg;
}
/** Optional test: builds today's news now and shows it in the log, without saving it. */
function testNews() { return newsGemini(true); }
