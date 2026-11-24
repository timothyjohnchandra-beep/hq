/**
 * Timothy HQ – bridge between the app and Google (Sheet, Calendar, Gmail, Maps, Drive).
 * Paste into script.google.com, fill in SHEET_ID and TOKEN, then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). Never commit a filled-in copy.
 */
const SHEET_ID = 'PASTE_SHEET_ID_HERE';
const TOKEN = 'PASTE_YOUR_SECRET_TOKEN_HERE';
const TZ = 'Asia/Jakarta';
const SCRIPT_VERSION = '2026-11-24 15.00'; // shown in HQ › Settings, so you can tell which copy is deployed
const ROOT_FOLDER = 'Claude';      // everything HQ creates lives inside this Drive folder
const NOTES_FOLDER = 'HQ Notes';
const BUFFER_MIN = 10;               // extra minutes added before every leave-by time
const TABS = ['tasks', 'people', 'notes_index', 'places', 'habits', 'books', 'highlights', 'cashbooks', 'cash_entries', 'briefs', 'reading_log', 'meetings', 'sermons', 'notebooks'];

function doGet(e) {
  return handle_(() => {
    const p = e.parameter;
    auth_(p.token);
    const a = p.action || 'read';
    if (a === 'ping') return { ok: true, tabs: TABS, version: SCRIPT_VERSION };
    if (a === 'read') return { ok: true, rows: readTab_(p.name) };
    if (a === 'all') { const out = {}; TABS.forEach(t => { try { out[t] = readTab_(t); } catch (e) { out[t] = []; } }); return { ok: true, data: out }; }   // a missing tab never blocks the app
    if (a === 'calendar') return { ok: true, events: calendar_(Number(p.days || 2)) };
    if (a === 'brief') return { ok: true, brief: brief_() };
    if (a === 'note') return { ok: true, html: readNote_(p.id) };
    if (a === 'verse') return { ok: true, verse: verse_() };
    if (a === 'img') return img_(p.id);
    if (a === 'contacts') return { ok: true, contacts: contacts_() };
    if (a === 'book') return bookFile_(p.id);
    if (a === 'sortbooks') return { ok: true, log: sortNewBooks() };
    if (a === 'meetings') return { ok: true, log: exportFireflies() };
    if (a === 'sortsermons') return { ok: true, log: sortSermons() };
    throw new Error('Unknown action: ' + a);
  });
}

function doPost(e) {
  return handle_(() => {
    const b = JSON.parse(e.postData.contents);
    auth_(b.token);
    if (b.action === 'save') { writeTab_(b.name, b.rows); return { ok: true, saved: b.rows.length }; }
    if (b.action === 'note') return { ok: true, driveLink: writeNote_(b.id, b.title, b.html) };
    if (b.action === 'addEvent') return { ok: true, id: addEvent_(b) };
    if (b.action === 'attach') return { ok: true, url: attach_(b) };
    if (b.action === 'patch') return { ok: true, row: patchRow_(b.name, b.id, b.fields) };
    throw new Error('Unknown action: ' + b.action);
  });
}

function handle_(fn) {
  let out;
  try { out = fn(); } catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function auth_(t) { if (!t || t !== TOKEN) throw new Error('Wrong or missing token. Check Settings in the app.'); }
function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function sheet_(name) {
  if (TABS.indexOf(name) < 0) throw new Error('Unknown tab: ' + name);
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('Tab missing in HQ Data: ' + name);
  return s;
}

/* ---------- Sheet ---------- */
function readTab_(name) {
  const s = sheet_(name);
  const v = s.getDataRange().getDisplayValues();
  if (v.length < 2) return [];
  const h = v[0];
  return v.slice(1).filter(r => r.some(c => c !== '')).map(r => {
    const o = {}; h.forEach((k, i) => { if (k) o[k] = r[i]; }); return o;
  });
}

function writeTab_(name, rows) {
  if (!Array.isArray(rows)) throw new Error('Nothing to save.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const s = sheet_(name);
    backup_(s);
    const head = s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getDisplayValues()[0].filter(String);
    rows.forEach(r => Object.keys(r).forEach(k => { if (head.indexOf(k) < 0) head.push(k); }));
    if (name === 'notes_index' || name === 'tasks') {   // keep rows added meanwhile by the import, Telegram or another device (HQ never deletes rows, it voids them)
      const seen = {}; rows.forEach(r => seen[r.id] = 1);
      readTab_(name).forEach(r => { if (r.id && !seen[r.id]) { rows.push(r); Object.keys(r).forEach(k => { if (head.indexOf(k) < 0) head.push(k); }); } });
    }
    const body = rows.map(r => head.map(k => r[k] == null ? '' : String(r[k])));
    s.clearContents();
    s.getRange(1, 1, 1, head.length).setValues([head]);
    if (body.length) {
      const rng = s.getRange(2, 1, body.length, head.length);
      rng.setNumberFormat('@');          // store everything as text
      rng.setValues(body);
    }
  } finally { lock.releaseLock(); }
}

/** Keeps two safety copies: _bak_<tab> (at most every 10 min) and _day_<tab> (once a day). */
function backup_(s) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now(), name = s.getName();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const lastBak = Number(props.getProperty('bak_' + name) || 0);
  if (now - lastBak > 10 * 60 * 1000) { copy_(s, '_bak_' + name); props.setProperty('bak_' + name, String(now)); }
  if (props.getProperty('day_' + name) !== today) { copy_(s, '_day_' + name); props.setProperty('day_' + name, today); }
}
function copy_(s, target) {
  const ss = s.getParent();
  const old = ss.getSheetByName(target);
  if (old) ss.deleteSheet(old);
  s.copyTo(ss).setName(target).hideSheet();
}

/* ---------- Calendar + travel time ---------- */
function calendar_(days) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 864e5);
  const home = placeAddress_('home');
  const out = [];
  CalendarApp.getAllCalendars().forEach(cal => {
    const calName = cal.getName();
    const birthdayCal = /birth|ulang|ultah/i.test(calName);
    cal.getEvents(start, end).forEach(ev => {
      out.push({
        id: ev.getId(), title: ev.getTitle(), calendar: calName,
        allDay: ev.isAllDayEvent(), birthday: birthdayCal || /birthday|ultah|ulang tahun/i.test(ev.getTitle()),
        start: ev.getStartTime().toISOString(), end: ev.getEndTime().toISOString(),
        location: ev.getLocation() || ''
      });
    });
  });
  out.sort((a, b) => a.start.localeCompare(b.start));
  // Travel: from the previous located event if it ends within 3 hours, otherwise from home.
  let prev = null;
  out.forEach(ev => {
    if (ev.allDay || !ev.location) return;
    let origin = home;
    if (prev && new Date(ev.start) - new Date(prev.end) < 3 * 36e5 && new Date(ev.start) >= new Date(prev.end)) origin = prev.location;
    if (origin && origin !== ev.location) {
      const min = travelMinutes_(origin, ev.location, new Date(ev.start));
      if (min != null) {
        ev.travelMin = min;
        ev.from = origin === home ? 'home' : prev.title;
        ev.leave = new Date(new Date(ev.start).getTime() - (min + BUFFER_MIN) * 6e4).toISOString();
      }
    }
    prev = ev;
  });
  return out;
}

function travelMinutes_(from, to, arrive) {
  const cache = CacheService.getScriptCache();
  const key = Utilities.base64EncodeWebSafe(from + '|' + to + '|' + arrive.getHours()).slice(0, 200);
  const hit = cache.get(key);
  if (hit) return Number(hit);
  try {
    const f = Maps.newDirectionFinder().setOrigin(from).setDestination(to).setMode(Maps.DirectionFinder.Mode.DRIVING);
    const depart = new Date(arrive.getTime() - 60 * 6e4);
    if (depart > new Date()) f.setDepart(depart);
    const r = f.getDirections();
    const leg = r.routes && r.routes[0] && r.routes[0].legs[0];
    if (!leg) return null;
    const sec = (leg.duration_in_traffic || leg.duration).value;
    const min = Math.round(sec / 60);
    cache.put(key, String(min), 6 * 3600);
    return min;
  } catch (err) { return null; }
}

function placeAddress_(id) {
  const p = readTab_('places').filter(r => r.id === id)[0];
  return p ? p.address : '';
}

function addEvent_(b) {
  const start = new Date(b.date + 'T' + b.start + ':00+07:00');
  const end = new Date(start.getTime() + Number(b.minutes || 120) * 6e4);
  const ev = CalendarApp.getDefaultCalendar().createEvent(b.title, start, end, { location: b.location || '' });
  ev.addPopupReminder(30);
  return ev.getId();
}

/* ---------- Gmail brief ---------- */
function brief_() {
  const unread = GmailApp.search('in:inbox is:unread', 0, 100).length;
  const imp = GmailApp.search('in:inbox is:unread is:important -category:promotions -category:social', 0, 6);
  const card = t => { const m = t.getMessages().pop(); return { from: m.getFrom().replace(/<.*>/, '').replace(/"/g, '').trim(), subject: t.getFirstMessageSubject(), date: m.getDate().toISOString(), link: 'https://mail.google.com/mail/u/0/#inbox/' + t.getId() }; };
  // Email list for Today: newest unread first, each with the gist (the start of the latest message, without quoted replies).
  const list = GmailApp.search('in:inbox is:unread -category:promotions -category:social', 0, 15).map(t => {
    const m = t.getMessages().pop(), c = card(t);
    let body = '';
    try { body = m.getPlainBody() || ''; } catch (e) {}
    body = body.split(/\n\s*(On .{0,200}wrote:|From: .+\n(Sent|Date): |-{2,}\s*Original Message|Pada .{0,200}menulis:|>)/)[0];
    body = body.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    c.gist = body.length > 700 ? body.slice(0, 700).replace(/\s+\S*$/, '') + '…' : body;
    c.count = t.getMessageCount(); c.important = t.hasStarredMessages() || t.isImportant();
    try { c.files = m.getAttachments().map(a => a.getName()).slice(0, 5); } catch (e) { c.files = []; }
    return c;
  });
  return { unread: unread, important: imp.map(card), emails: list };
}

/* A picture from Drive for a note, sent through the bridge so it shows on iPhone too
   (Safari blocks Google's sign-in cookie for drive.google.com pictures inside the app). */
function img_(id) {
  if (!/^[\w-]{20,}$/.test(String(id || ''))) throw new Error('Unknown picture.');
  const f = DriveApp.getFileById(id), mime = f.getMimeType();
  if (!/^image\//.test(mime)) throw new Error('That file is not a picture.');
  let blob = null;
  try {
    const auth = { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
    const meta = JSON.parse(UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=thumbnailLink', auth).getContentText());
    if (meta.thumbnailLink) { const r = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s1600'), auth); if (r.getResponseCode() === 200) blob = r.getBlob(); }
  } catch (e) {}
  if (!blob) { if (f.getSize() > 8e6) throw new Error('That picture is too large to show here. Open it in Drive.'); blob = f.getBlob(); }
  return { ok: true, mime: blob.getContentType() || mime, data: Utilities.base64Encode(blob.getBytes()) };
}

/* ---------- Notes bodies in Drive ---------- */
function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function rootFolder_() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER);
}
function notesFolder_() {
  const root = rootFolder_();
  const inRoot = root.getFoldersByName(NOTES_FOLDER);
  if (inRoot.hasNext()) return inRoot.next();
  const anywhere = DriveApp.getFoldersByName(NOTES_FOLDER);   // older setups: move it into Claude
  if (anywhere.hasNext()) { const f = anywhere.next(); f.moveTo(root); return f; }
  return root.createFolder(NOTES_FOLDER);
}
function attach_(b) {
  if (!b.data) throw new Error('No file came through.');
  const blob = Utilities.newBlob(Utilities.base64Decode(b.data), b.mime || 'application/octet-stream', b.name || 'attachment');
  const f = sub_(notesFolder_(), 'Attachments').createFile(blob);
  return f.getUrl();
}
function readNote_(id) {
  const it = notesFolder_().getFilesByName(id + '.html');
  return it.hasNext() ? it.next().getBlob().getDataAsString() : '';
}
function writeNote_(id, title, html) {
  if (!id) throw new Error('Note has no id.');
  const folder = notesFolder_();
  const it = folder.getFilesByName(id + '.html');
  let f;
  if (it.hasNext()) { f = it.next(); f.setContent(html); }
  else f = folder.createFile(id + '.html', html, MimeType.HTML);
  f.setDescription(title || '');
  return f.getUrl();
}

/* ---------- Verse of the Day ---------- */
function verse_() {
  const cache = CacheService.getScriptCache();
  const key = 'votd_' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  let v = null;
  try {   // YouVersion's own Verse of the Day page
    const html = UrlFetchApp.fetch('https://www.bible.com/verse-of-the-day', { muteHttpExceptions: true, followRedirects: true }).getContentText();
    const m = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) || html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    const img = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    const ref = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (m) v = { text: decode_(m[1]), ref: ref ? decode_(ref[1]).replace(/\s*[|-].*$/, '') : '', image: img ? img[1] : '', source: 'YouVersion', link: 'https://www.bible.com/verse-of-the-day' };
  } catch (e) {}
  if (!v) {
    try {   // backup source
      const j = JSON.parse(UrlFetchApp.fetch('https://beta.ourmanna.com/api/v1/get?format=json&order=daily', { muteHttpExceptions: true }).getContentText());
      const d = j.verse.details;
      v = { text: d.text, ref: d.reference + ' (' + d.version + ')', image: '', source: 'OurManna', link: 'https://www.bible.com/verse-of-the-day' };
    } catch (e) {}
  }
  if (!v) throw new Error('Could not fetch the verse of the day right now.');
  cache.put(key, JSON.stringify(v), 6 * 3600);
  return v;
}
function decode_(s) { return s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

/* ---------- Google Contacts (needs the People API service: Services + People API) ---------- */
function contacts_() {
  if (typeof People === 'undefined') throw new Error('Turn on the People API service in the script editor (Services, then People API).');
  const out = []; let token;
  do {
    const r = People.People.Connections.list('people/me', { pageSize: 1000, pageToken: token, personFields: 'names,phoneNumbers,birthdays' });
    (r.connections || []).forEach(c => {
      const name = c.names && c.names[0] && c.names[0].displayName;
      if (!name) return;
      const phone = c.phoneNumbers && c.phoneNumbers[0] && (c.phoneNumbers[0].canonicalForm || c.phoneNumbers[0].value) || '';
      const b = c.birthdays && c.birthdays[0] && c.birthdays[0].date;
      out.push({ name: name, phone: phone, birthday: b && b.month ? (b.year || 1900) + '-' + ('0' + b.month).slice(-2) + '-' + ('0' + b.day).slice(-2) : '' });
    });
    token = r.nextPageToken;
  } while (token);
  return out;
}

/* ---------- Library: sort new EPUBs automatically (nightly) ----------
 * Any new EPUB anywhere in Drive is filed into Claude/Library/<category>.
 * Books under a [Teaching] folder are COPIED (the original stays put); all others are MOVED.
 * Books it cannot place go to "00 New – to sort" for Claude to look at.
 * Run setupBookTrigger once to switch on the nightly run (about 3 a.m. Jakarta).
 */
const LIB_FOLDERS = ['00 New – to sort', '01 Bible – Old Testament', '02 Bible – New Testament', '03 Theology & Bible Study', '04 Holy Spirit, Pentecost & Revival', '05 Discipleship & Spiritual Formation', '06 Church & Pastoral Leadership', '07 Counseling & Care', '08 Apologetics & Faith Questions', '09 Leadership & Business', '10 Personal Growth & Psychology', '11 Money & Giving', '12 Marriage, Family & Youth', '13 Fiction', '14 History, Economics & World Affairs', '99 Duplicates & files to check'];
const OT = 'genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs|ecclesiastes|song of songs|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|old testament|hebrew bible|pentateuch|wisdom books';
const NT = 'matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation|new testament|gospels?|paul';
const COMMENTARY = /commentar|nicot|nicnt|nigtc|pntc|pillar|tntc|totc|tyndale|wbc|word biblical|expositor|niv application|apollos|holman|zecnt|baker exegetical|bible speaks|for you\b/i;
const RULES = [
  ['04', /holy spirit|pentecost|revival|charismatic|spiritual gifts|baptism in the spirit|roh kudus|mighty wind/i],
  ['07', /counsel|inner healing|trauma|grief|soul care/i],
  ['08', /apologet|case for|historical jesus|real jesus|islam|muhammad|allah|atheis|mere christianity|what'?s so great about god|god and christianity|wrestle with god/i],
  ['05', /disciple|spiritual disciplines?|spiritual formation|willard|renovat|hearing god|pursuit of god|prayer|devotion|celebration of discipline|true spirituality|respectable sins/i],
  ['06', /church|pastor|pastoral|ministry|ministries|preach|sermon|mission|shepherd|elders?\b|fivefold|body of christ|communicating for a change|culture of honor/i],
  ['03', /theolog|doctrine|trinity|catechism|systematic|justification|sanctification|hermeneutic|read the bible|grace|tithing|tolerance/i],
  ['11', /money|wealth|financ|rich|invest|budget|debt|tithe|bank/i],
  ['12', /marriage|married|family|parent|kids|children|\bdad\b|\bmom\b|youth|teen|generation z|gen z|love as a way|love language/i],
  ['09', /leader|leadership|manage|business|startup|marketing|strategy|art of war|sun tzu|maxwell|sinek|godin|entrepreneur|company|e-myth|zero to one|infinite game|originals/i],
  ['10', /habit|mindset|psycholog|productiv|think|grit|success|human nature|rules of life|5 ?am|procrastinat|dopamine|body language|irrational|freak|gladwell|range\b|let them|relentless|life skills/i],
  ['14', /history|politic|econom|world order|nations|capital in|power\b|sniper|prophet/i],
  ['13', /jeffrey archer|baldacci|patterson|grisham|dashner|maze runner|novel|a romance of/i]
];
function libFolder_(code) {
  const lib = sub_(rootFolder_(), 'Library');
  const name = LIB_FOLDERS.filter(n => n.indexOf(code + ' ') === 0)[0];
  return sub_(lib, name);
}
function classifyBook_(title) {
  const t = title.toLowerCase();
  if (COMMENTARY.test(t) || new RegExp('^\\(?(\\d\\s?)?(' + OT + '|' + NT + ')\\s*(\\d|$|-|:|\\()', 'i').test(t)) {
    if (new RegExp('\\b(' + OT + ')\\b', 'i').test(t)) return '01';
    if (new RegExp('\\b(' + NT + ')\\b', 'i').test(t)) return '02';
  }
  for (const [code, re] of RULES) if (re.test(t)) return code;
  return '00';
}
function cleanBookName_(name) {
  return name.replace(/\.epub$/i, '').replace(/[_ ]?\(?(z[-_ ]?library|libgen|1lib|z-lib|anna'?s[-_ ]archive|pdfdrive)[^)]*\)?.*$/i, '')
    .replace(/_/g, ' ').replace(/^copy of /i, '').replace(/\s+/g, ' ').trim().replace(/[ ,-]+$/, '') + '.epub';
}
function isUnder_(file, folderId) {
  const seen = {}, queue = [];
  const ps = file.getParents(); while (ps.hasNext()) queue.push(ps.next());
  while (queue.length) {
    const f = queue.shift(); if (seen[f.getId()]) continue; seen[f.getId()] = 1;
    if (f.getId() === folderId) return true;
    const up = f.getParents(); while (up.hasNext()) queue.push(up.next());
  }
  return false;
}
function bookTitle_(name) { return name.replace(/\.(epub|pdf)$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }
function bookFormat_(f) { return /pdf/i.test(f.getMimeType()) || /\.pdf$/i.test(f.getName()) ? 'pdf' : 'epub'; }
function folderCode_(file) {
  const ps = file.getParents(); while (ps.hasNext()) { const m = /^(\d\d) /.exec(ps.next().getName()); if (m) return m[1]; } return '00';
}
/** Adds a book to the HQ Library list (books tab), or adds a paper name to a book already there. */
function registerBook_(known, file, code, paper) {
  const id = file.getId(), today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (known[id] !== undefined) {
    if (!paper) return false;
    const list = String(known[id] || '').split(';').map(x => x.trim()).filter(String);
    if (list.indexOf(paper) >= 0) return false;
    list.push(paper); known[id] = list.join('; ');
    patchRow_('books', id, { paper: known[id], updated: today }); return true;
  }
  known[id] = paper || '';
  patchRow_('books', id, { title: bookTitle_(file.getName()), author: '', category: code, position: '0', format: bookFormat_(file), paper: paper || '', added: today, updated: today });
  return true;
}
function knownBooks_() {
  const s = sheet_('books'), v = s.getDataRange().getDisplayValues(), h = v[0], pi = h.indexOf('paper'), out = {};
  v.slice(1).forEach(r => { if (r[0]) out[r[0]] = pi >= 0 ? r[pi] : ''; }); return out;
}
/** Hourly (and from the app's "Check Drive" button): files new books and lists them in HQ. */
function sortNewBooks() {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty('booksSince') || new Date(Date.now() - 2 * 864e5).toISOString();
  const root = rootFolder_(), lib = sub_(root, 'Library'), papers = sub_(root, 'Papers');
  const teachIt = DriveApp.getFoldersByName('[Teaching]');
  const teachId = teachIt.hasNext() ? teachIt.next().getId() : '';
  const copied = JSON.parse(props.getProperty('booksCopied') || '{}');
  const known = knownBooks_(), started = new Date().toISOString(), log = [];
  // 1. Paper folders: Claude/Papers/<paper title>/ — EPUBs and PDFs stay there and are tagged with that paper.
  const walk = (fo, paper) => {
    const fs = fo.getFiles();
    while (fs.hasNext()) { let f = fs.next();
      if (f.getMimeType() === 'application/vnd.google-apps.shortcut') { try { f = DriveApp.getFileById(f.getTargetId()); } catch (e) { continue; } } // shortcut to a Library book
      if (!/\.(epub|pdf)$/i.test(f.getName()) && !/epub|pdf/.test(f.getMimeType())) continue;
      if (registerBook_(known, f, classifyBook_(f.getName()), paper)) log.push('Added to paper "' + paper + '": ' + f.getName()); }
    const sf = fo.getFolders(); while (sf.hasNext()) walk(sf.next(), paper);
  };
  const pf = papers.getFolders(); while (pf.hasNext()) { const folder = pf.next(); walk(folder, folder.getName()); }
  // 2. New EPUBs anywhere else in Drive are filed into the Library and listed.
  const it = DriveApp.searchFiles('mimeType = "application/epub+zip" and trashed = false and createdDate > "' + since + '"');
  while (it.hasNext()) {
    const f = it.next();
    if (isUnder_(f, papers.getId())) continue;
    if (isUnder_(f, lib.getId())) { if (registerBook_(known, f, folderCode_(f), '')) log.push('Listed ' + f.getName()); continue; }
    const code = classifyBook_(f.getName()), dest = libFolder_(code), name = cleanBookName_(f.getName());
    if (teachId && isUnder_(f, teachId)) {
      if (copied[f.getId()]) continue;
      const c = f.makeCopy(name, dest); copied[f.getId()] = c.getId(); registerBook_(known, c, code, ''); log.push('Copied ' + name + ' → ' + dest.getName());
    } else {
      f.moveTo(dest); if (f.getName() !== name) f.setName(name); registerBook_(known, f, code, ''); log.push('Moved ' + name + ' → ' + dest.getName());
    }
  }
  // 3. PDFs put inside a Library folder are listed too. PDFs elsewhere in Drive are left alone.
  const pit = DriveApp.searchFiles('mimeType = "application/pdf" and trashed = false and createdDate > "' + since + '"');
  while (pit.hasNext()) { const f = pit.next(); if (isUnder_(f, lib.getId()) && registerBook_(known, f, folderCode_(f), '')) log.push('Listed PDF ' + f.getName()); }
  props.setProperty('booksCopied', JSON.stringify(copied));
  props.setProperty('booksSince', started);
  Logger.log(log.length ? log.join('\n') : 'No new books.');
  return log;
}
function setupBookTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sortNewBooks').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sortNewBooks').timeBased().everyHours(1).create();
}

/* ---------- Sermon Docs → Claude/Sermons/<context folder> ----------
   Claude fills the sermons tab (and sermon_moves for briefs / unclear Docs, columns id, folder) but its Drive
   connection cannot move files, so this does the moving, as Timothy. Hourly via setupSermonTrigger, or GET action=sortsermons.
   Only Docs Timothy owns are moved; anything already somewhere inside Claude/Sermons is left where it is. */
const SERMON_FOLDER_FOR = { 'sunday service': '01', 'youth': '02', 'encounter night': '03', 'prayer / mik': '03',
  'equipping': '04', 'bible study': '04', 'guest preaching': '05', 'retreat': '06', 'conference': '06',
  'special service': '07', 'theme & brief': '08', 'other preacher': '09' };
function sortSermons() {
  const props = PropertiesService.getScriptProperties();
  const done = JSON.parse(props.getProperty('sermonsMoved') || '{}');
  const sermons = sub_(rootFolder_(), 'Sermons'), byCode = {};
  const fi = sermons.getFolders(); while (fi.hasNext()) { const fo = fi.next(), m = /^(\d\d) /.exec(fo.getName()); if (m) byCode[m[1]] = fo; }
  const me = Session.getEffectiveUser().getEmail(), log = [], todo = [];
  const docId = s => { const m = /\/d\/([\w-]{20,})/.exec(s || ''); return m ? m[1] : ''; };
  const v = sheet_('sermons').getDataRange().getDisplayValues(), h = v[0];
  const c = k => h.indexOf(k);
  v.slice(1).forEach(r => {
    if (!r[0] || r[c('void')]) return;
    const id = docId(r[c('docLink')]) || String(r[0]).replace(/^s-/, '');
    const who = String(r[c('preacher')] || '').trim().toLowerCase();
    const code = who && who !== 'me' ? '09' : SERMON_FOLDER_FOR[String(r[c('context')] || '').trim().toLowerCase()] || '00';
    todo.push([id, code]);
  });
  const mv = ss_().getSheetByName('sermon_moves');   // id | folder (two digits), for Docs that get no sermons row
  if (mv) mv.getDataRange().getDisplayValues().slice(1).forEach(r => { const fo = String(r[1] || '').trim(); if (r[0] && /^\d{1,2}$/.test(fo)) todo.push([String(r[0]).replace(/^s-/, ''), ('0' + fo).slice(-2)]); });   // "skip" rows are only a note
  const start = Date.now();
  todo.forEach(([id, code]) => {
    if (done[id] || Date.now() - start > 270000) return;   // stay under Apps Script's 6-minute limit; the next run carries on
    try {
      const f = DriveApp.getFileById(id);
      if (f.getOwner() && f.getOwner().getEmail() !== me) { done[id] = 'not yours'; log.push('Skipped (not your file): ' + f.getName()); return; }
      if (isUnder_(f, sermons.getId())) { done[id] = 'already'; return; }
      const dest = byCode[code] || byCode['00'];
      if (!dest) throw new Error('no folder ' + code + ' in Claude/Sermons');
      f.moveTo(dest); done[id] = code; log.push('Moved ' + f.getName() + ' → ' + dest.getName());
    } catch (e) { log.push('Could not move ' + id + ': ' + (e.message || e)); }
  });
  props.setProperty('sermonsMoved', JSON.stringify(done));
  Logger.log(log.length ? log.join('\n') : 'No sermon Docs to move.');
  return log;
}
function setupSermonTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'sortSermons').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sortSermons').timeBased().everyHours(1).create();
  return sortSermons();
}

/* ---------- Sermon Docs indexed by Gemini (Timothy's choice, 24 Nov 2026) ----------
   Hourly: finds new sermon Docs, has Gemini read each one and fill a sermons row, then sortSermons moves them.
   Needs Script property GEMINI_KEY (set with setGeminiKey). Optional GEMINI_MODEL to force a model.
   Docs that are not sermons are noted in sermon_moves with folder "skip" so they are read only once. */
const SERMON_TITLE_WORDS = ['Sermon', 'Khotbah', 'Kotbah', 'Firman', 'Equipping', 'BUILD', 'BBS', 'Retreat', 'EN ', 'MIK', 'Encounter',
  'Doa', 'Paskah', 'Natal', 'Christmas', 'Easter', 'Devotion', 'Ibadah', 'Tema', 'Brief', 'Pemberkatan', 'Wedding', 'Preaching'];
const SERMON_SKIP = /commentary|tyndale|word biblical|niv application|new international|new american|interpretation|\[?mom\]?\b|notulen|sinode|\[artikel\]|^artikel|survey|rundown|\btor\b|surat|invoice|budget|anggaran|\bhq\b/i;
const SERMON_CONTEXTS = ['Sunday service', 'Youth', 'Encounter Night', 'Prayer / MIK', 'Equipping', 'Bible study', 'Guest preaching', 'Retreat', 'Conference', 'Special service', 'Other preacher'];
function geminiModels_(key) {   // Hydrogen/Flash models this key can use, newest first; the one that last worked goes first
  const props = PropertiesService.getScriptProperties();
  const fixed = props.getProperty('GEMINI_MODEL'); if (fixed) return [fixed];
  let list = JSON.parse(props.getProperty('geminiModels') || '{}');
  if (!list.names || Date.now() - list.at > 864e5) {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error('Gemini did not accept the key (' + r.getResponseCode() + '). Run setGeminiKey again with a fresh key from aistudio.google.com.');
    const ver = n => { const m = /gemini-(\d+(?:\.\d+)?)-(flash|hydrogen)/.exec(n); return m ? Number(m[1]) : 0; };
    const names = (JSON.parse(r.getContentText()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0).map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini-[\d.]+-(flash|hydrogen)(-lite)?$/.test(n))   // stable Hydrogen (Gemini 4's name for Flash), Flash and their Lite versions
      .sort((x, y) => ver(y) - ver(x) || (/lite/.test(x) ? 1 : -1));
    if (!names.length) throw new Error('No Gemini Hydrogen or Flash model found for this key.');
    list = { names, at: Date.now() }; props.setProperty('geminiModels', JSON.stringify(list));
  }
  const good = props.getProperty('geminiGood'), bad = JSON.parse(props.getProperty('geminiBad') || '{}');
  const ok = list.names.filter(n => !(bad[n] && Date.now() - bad[n] < 864e5));   // a model out of free quota rests for a day
  return good && ok.indexOf(good) >= 0 ? [good].concat(ok.filter(n => n !== good)) : ok;
}
function geminiJson_(key, models, prompt) {
  const props = PropertiesService.getScriptProperties(), bad = JSON.parse(props.getProperty('geminiBad') || '{}');
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } };
  let last = '';
  for (const model of models) {
    if (bad[model] && Date.now() - bad[model] < 864e5) continue;
    for (let tries = 0; tries < 2; tries++) {
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
      const code = r.getResponseCode(), txt = r.getContentText();
      if (code === 200) {
        props.setProperty('geminiGood', model); props.setProperty('geminiBad', JSON.stringify(bad));
        const parts = ((((JSON.parse(txt).candidates || [])[0] || {}).content || {}).parts || []);
        return JSON.parse(parts.map(p => p.text || '').join('').replace(/^```(json)?|```$/g, '').trim());
      }
      last = model + ' ' + code + ': ' + (((JSON.parse(txt || '{}').error) || {}).message || txt).slice(0, 160);
      if (code === 429 && /per ?day|PerDay|limit: 0|free_tier|quota/i.test(txt) && !/per ?minute|PerMinute/i.test(txt)) { bad[model] = Date.now(); break; }   // no free quota today → next model
      if (code === 429 || code >= 500) { Utilities.sleep(15000); continue; }   // per-minute limit or busy: wait once
      if (code === 404 || code === 400 || code === 403) { bad[model] = Date.now(); break; }   // model not available to this key
      throw new Error('Gemini error ' + last);
    }
  }
  props.setProperty('geminiBad', JSON.stringify(bad));
  throw new Error('Gemini is busy or out of free quota (' + last + '). Will try again next hour.');
}
function sermonPrompt_(fileName, text) {
  return [
    'You index sermon Google Docs for Timothy, Executive Pastor of GPKdI BCC (Jakarta). Read the Doc and answer with ONE JSON object only.',
    'Keys: kind, title, date, place, context, series, refs, themes, theology, points, bigIdea, preacher.',
    'kind: "sermon" (a message or teaching outline), "brief" (yearly theme, sermon brief, series planning), "others" (notes or feedback on other people\'s practice sermons), "unclear" (cannot tell), or "not_sermon" (minutes, admin, run sheet, liturgy guide, article, commentary, book, finance, anything else).',
    'Only for kind "sermon" fill the rest; otherwise leave them "". Never invent anything: if unsure, use "".',
    'title: the message title as preached, from the Doc text, not file-name tags like [Sermon]. date: yyyy-mm-dd from the file name or Doc. place: e.g. "GPKdI BCC", "DYC", church or event name.',
    'context: exactly one of ' + SERMON_CONTEXTS.join(', ') + '. Rules: youth at BCC (DYC, KOMID, Teens) = Youth even on Sunday; a youth message at another church = Guest preaching; a retreat or camp = Retreat; EN = Encounter Night; MIK, Doa, prayer meetings = Prayer / MIK; Equipping, BUILD, classes, training, preaching class = Equipping; school chapel or devotions (BBS, Immanuel), weddings, Easter, Christmas, funerals, house blessings, panti jompo = Special service; a sermon by someone else = Other preacher.',
    'series: yearly theme or series if named (e.g. DEEPER 2025, ENABLE). refs: the main Bible passages the Doc actually cites, as codes BOOK.CH.V or BOOK.CH.V-V separated by "; ", main text first, max 8. Use USFM codes: ' + BIBLE.map(b => b[0]).join(' ') + '. Indonesian names: Kej GEN, Kel EXO, Ul DEU, Hak JDG, 1Raj 1KI, 2Raj 2KI, 1Taw 1CH, Ayb JOB, Mzm PSA, Ams PRO, Pkh ECC, Yes ISA, Yer JER, Yeh EZK, Yl JOL, Yun JON, Za ZEC, Mrk MRK, Luk LUK, Yoh JHN, Kis ACT, Rm ROM, 1Kor 1CO, 2Kor 2CO, Ef EPH, Flp PHP, Kol COL, Ibr HEB, Yak JAS, 1Ptr 1PE, 1Yoh 1JN, Why REV.',
    'themes: 3-5 short English themes separated by "; ". theology: 1-3 short theological categories separated by "; ".',
    'points: the main points exactly as he wrote them (keep his wording and language), separated by " | ". bigIdea: one English sentence in your own words.',
    'preacher: "me" if Timothy preached it, otherwise the other preacher\'s name. Never copy quotations from commentaries.',
    '', 'File name: ' + fileName, 'Doc text:', text
  ].join('\n');
}
function cleanSermon_(o) {
  const codes = {}; BIBLE.forEach(b => codes[b[0]] = 1);
  const s = v => String(v == null ? '' : Array.isArray(v) ? v.join(' | ') : v).trim();
  const refs = s(o.refs).split(/\s*;\s*/).map(r => r.trim().toUpperCase()).filter(r => /^([1-3]?[A-Z]{2,3})\.\d+(\.\d+(-\d+)?)?$/.test(r) && codes[r.split('.')[0]]).slice(0, 8);
  const ctx = SERMON_CONTEXTS.find(c => c.toLowerCase() === s(o.context).toLowerCase()) || '';
  return { title: s(o.title), date: /^\d{4}-\d{2}-\d{2}$/.test(s(o.date)) ? s(o.date) : '', place: s(o.place), context: ctx, series: s(o.series),
    refs: refs.join('; '), themes: s(o.themes), theology: s(o.theology), points: s(o.points), bigIdea: s(o.bigIdea), preacher: s(o.preacher) || 'me' };
}
function indexSermonsGemini() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('No Gemini key yet. Run setGeminiKey first.');
  const models = geminiModels_(key), started = Date.now(), log = ['Gemini models to try: ' + models.join(', ')];
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), known = {};
  sheet_('sermons').getRange('A:A').getDisplayValues().forEach(r => { if (r[0]) known[String(r[0]).replace(/^s-/, '')] = 1; });
  const mvS = ss_().getSheetByName('sermon_moves') || ss_().insertSheet('sermon_moves');
  if (!mvS.getLastRow()) mvS.appendRow(['id', 'folder', 'title', 'added']);
  mvS.getRange('A:A').getDisplayValues().forEach(r => { if (r[0]) known[r[0]] = 1; });
  const sermonsId = sub_(rootFolder_(), 'Sermons').getId();
  // One fast Drive API list instead of DriveApp, which needs an extra call per file.
  const auth = { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  const q = "mimeType = 'application/vnd.google-apps.document' and trashed = false and 'me' in owners and (" +
    SERMON_TITLE_WORDS.map(w => "name contains '" + w + "'").join(' or ') + " or fullText contains 'khotbah' or fullText contains 'firman')";
  const found = []; let page = '';
  do {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)&q=' +
      encodeURIComponent(q) + (page ? '&pageToken=' + encodeURIComponent(page) : ''), auth);
    if (r.getResponseCode() !== 200) throw new Error('Drive search failed (' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 200));
    const j = JSON.parse(r.getContentText()); (j.files || []).forEach(f => { if (!known[f.id]) found.push(f); }); page = j.nextPageToken || '';
  } while (page);
  found.sort((a, b) => b.modifiedTime < a.modifiedTime ? -1 : 1);   // newest first (Drive can't sort full-text searches)
  const rows = [], moves = [];
  let done = 0, left = 0, stop = false;
  for (const f of found) {
    const id = f.id, name = f.name;
    if (SERMON_SKIP.test(name)) { moves.push({ id, folder: 'skip', title: name, added: today }); continue; }   // cheap: no Gemini call
    if (stop || Date.now() - started > 270000 || done >= 25) { left++; continue; }   // Apps Script stops at 6 min; the next hour carries on
    if (isUnder_(DriveApp.getFileById(id), sermonsId)) { moves.push({ id, folder: 'skip', title: name + ' (already in Sermons)', added: today }); continue; }
    try {
      const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain', auth);
      if (r.getResponseCode() !== 200) throw new Error('could not read the Doc (' + r.getResponseCode() + ')');
      const text = r.getContentText().slice(0, 40000);
      const o = geminiJson_(key, models, sermonPrompt_(name, text)); done++;
      const kind = String(o.kind || '').toLowerCase();
      if (kind === 'sermon') {
        const c = cleanSermon_(o);
        if (!c.context && !c.title) { moves.push({ id, folder: '00', title: name, added: today }); log.push('To check: ' + name); }
        else { rows.push(Object.assign({ id: 's-' + id, noteId: '', docLink: 'https://docs.google.com/document/d/' + id + '/edit', void: '', updated: today, checked: '' }, c)); log.push('Indexed: ' + name + ' → ' + (c.context || '?')); }
      } else if (kind === 'brief') { moves.push({ id, folder: '08', title: name, added: today }); log.push('Theme/brief: ' + name); }
      else if (kind === 'others') { moves.push({ id, folder: '09', title: name, added: today }); log.push('Others\' sermons: ' + name); }
      else if (kind === 'unclear') { moves.push({ id, folder: '00', title: name, added: today }); log.push('To check: ' + name); }
      else moves.push({ id, folder: 'skip', title: name, added: today });
      Utilities.sleep(4000);   // stay inside Gemini's free-tier rate limit
    } catch (e) { log.push('Failed: ' + name + ' – ' + (e.message || e)); if (/busy|quota|key/i.test(e.message || '')) { stop = true; left++; } }
  }
  appendRows_('sermons', rows);
  if (moves.length) { const rng = mvS.getRange(mvS.getLastRow() + 1, 1, moves.length, 4); rng.setNumberFormat('@'); rng.setValues(moves.map(m => [m.id, m.folder, m.title, m.added])); }
  log.push(rows.length + ' sermons indexed, ' + moves.filter(m => m.folder !== 'skip').length + ' briefs/others/to check, ' + left + ' left for later.');
  try { log.push.apply(log, sortSermons()); } catch (e) { log.push('Moving failed: ' + (e.message || e)); }
  Logger.log(log.join('\n'));
  return log;
}
function setupGeminiSermons() {   // one hourly job: index with Gemini, then move
  ScriptApp.getProjectTriggers().filter(t => ['sortSermons', 'indexSermonsGemini'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('indexSermonsGemini').timeBased().everyHours(1).create();
  return indexSermonsGemini();
}

/** Change a few cells of one row (found by id) without rewriting the tab. Used for reading position. */
function patchRow_(name, id, fields) {
  if (!id || !fields) throw new Error('Nothing to change.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const s = sheet_(name);
    const head = s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getDisplayValues()[0];
    Object.keys(fields).forEach(k => { if (head.indexOf(k) < 0) { head.push(k); s.getRange(1, head.length).setValue(k); } });
    const ids = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]) : [];
    let row = ids.indexOf(String(id)) + 2;
    if (row < 2) { row = s.getLastRow() + 1; s.getRange(row, 1).setNumberFormat('@').setValue(String(id)); }
    Object.keys(fields).forEach(k => s.getRange(row, head.indexOf(k) + 1).setNumberFormat('@').setValue(fields[k] == null ? '' : String(fields[k])));
    return row;
  } finally { lock.releaseLock(); }
}

/* ---------- EPUB reader: hand one book file to the app ---------- */
function bookFile_(id) {
  if (!id) throw new Error('No book chosen.');
  const f = DriveApp.getFileById(id);
  const name = f.getName();
  const pdf = f.getMimeType() === 'application/pdf' || /\.pdf$/i.test(name);
  if (!pdf && f.getMimeType() !== 'application/epub+zip' && !/\.epub$/i.test(name)) throw new Error('HQ can open EPUB and PDF books only. Open this file in Drive instead.');
  const size = f.getSize();
  if (size > 40 * 1024 * 1024) throw new Error('This book is ' + Math.round(size / 1048576) + ' MB, too big to open in HQ. Open it in Drive instead.');
  return { ok: true, name: name, size: size, format: pdf ? 'pdf' : 'epub', data: Utilities.base64Encode(f.getBlob().getBytes()) };
}


/* ---------- Fireflies → Drive (Claude/Meetings) + meetings tab ---------- */
// Put your Fireflies API key in Project Settings › Script properties as FIREFLIES_KEY (never in the code).
// Set FIREFLIES_DELETE to yes only after you've checked the first exports: then each exported meeting is removed
// from Fireflies to free your minutes. Everything stays in Drive and in HQ.
function ffQuery_(query, variables) {
  const key = PropertiesService.getScriptProperties().getProperty('FIREFLIES_KEY');
  if (!key) throw new Error('Add your Fireflies API key in Project Settings › Script properties as FIREFLIES_KEY.');
  const r = UrlFetchApp.fetch('https://api.fireflies.ai/graphql', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify({ query: query, variables: variables || {} }) });
  const j = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() >= 300 || j.errors) throw new Error('Fireflies: ' + ((j.errors && j.errors[0] && j.errors[0].message) || ('error ' + r.getResponseCode())));
  return j.data;
}
const FF_FIELDS = 'id title date duration transcript_url organizer_email participants summary { overview short_summary shorthand_bullet action_items keywords } sentences { speaker_name text start_time }';
function ffTime_(s) { s = Math.floor(Number(s) || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' : '') + (h && m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x; }
function ffDoc_(t, folder) {
  const d = new Date(Number(t.date)), day = Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), time = Utilities.formatDate(d, TZ, 'HH:mm');
  const doc = DocumentApp.create(day + ' – ' + (t.title || 'Meeting'));
  const b = doc.getBody(), S = t.summary || {};
  b.appendParagraph(t.title || 'Meeting').setHeading(DocumentApp.ParagraphHeading.TITLE);
  b.appendParagraph(day + ' ' + time + ' · ' + Math.round(Number(t.duration) || 0) + ' min' + (t.participants && t.participants.length ? ' · ' + t.participants.join(', ') : ''));
  b.appendParagraph('Original in Fireflies: ' + (t.transcript_url || ''));
  const sec = (h, txt) => { if (!txt) return; b.appendParagraph(h).setHeading(DocumentApp.ParagraphHeading.HEADING1); String(txt).split('\n').forEach(l => { if (l.trim()) b.appendParagraph(l.replace(/\*\*/g, '')); }); };
  sec('Summary', S.short_summary || S.overview);
  sec('Overview', S.short_summary ? S.overview : '');
  sec('Action items', S.action_items);
  sec('Notes', S.shorthand_bullet);
  if (S.keywords && S.keywords.length) b.appendParagraph('Keywords: ' + [].concat(S.keywords).join(', '));
  b.appendParagraph('Transcript').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  let last = null, para = '';
  (t.sentences || []).forEach(s => { if (s.speaker_name !== last) { if (para) b.appendParagraph(para); para = '[' + ffTime_(s.start_time) + '] ' + (s.speaker_name || 'Speaker') + ': ' + s.text; last = s.speaker_name; } else para += ' ' + s.text; });
  if (para) b.appendParagraph(para);
  if (!(t.sentences || []).length) b.appendParagraph('Fireflies had no transcript for this recording.');
  doc.saveAndClose();
  const f = DriveApp.getFileById(doc.getId()); f.moveTo(folder);
  return { id: doc.getId(), url: doc.getUrl(), day: day };
}
/** Every 3 days: copy new Fireflies meetings (summary + transcript) to Drive and the meetings tab, then (if allowed) free the minutes. */
function exportFireflies() {
  const props = PropertiesService.getScriptProperties(), done = JSON.parse(props.getProperty('ffDone') || '{}');
  const del = String(props.getProperty('FIREFLIES_DELETE') || '').toLowerCase() === 'yes';
  const root = sub_(rootFolder_(), 'Meetings'), log = [];
  const list = []; for (let skip = 0; skip < 500; skip += 50) { const d = ffQuery_('query($s:Int){ transcripts(limit:50, skip:$s){ id title date duration } }', { s: skip }); const ts = (d && d.transcripts) || []; list.push.apply(list, ts); if (ts.length < 50) break; }
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), t0 = Date.now();
  for (const m of list) {
    if (Date.now() - t0 > 4.5 * 60 * 1000) { log.push('Paused to stay within Google\'s time limit. The rest go next run.'); break; }
    let rec = done[m.id];
    if (!rec) {
      const t = (ffQuery_('query($id:String!){ transcript(id:$id){ ' + FF_FIELDS + ' } }', { id: m.id }) || {}).transcript;
      if (!t) continue;
      if (!(t.sentences || []).length && !(t.summary && (t.summary.short_summary || t.summary.overview))) { log.push('Skipped (not transcribed by Fireflies): ' + (t.title || m.id)); continue; }
      const year = sub_(root, Utilities.formatDate(new Date(Number(t.date)), TZ, 'yyyy'));
      const doc = ffDoc_(t, year), S = t.summary || {};
      patchRow_('meetings', m.id, { date: doc.day, title: t.title || '', minutes: String(Math.round(Number(t.duration) || 0)), people: (t.participants || []).join(', '), summary: String(S.short_summary || S.overview || '').slice(0, 2000), actions: String(S.action_items || '').replace(/\*\*/g, '').slice(0, 3000), keywords: [].concat(S.keywords || []).join(', '), docId: doc.id, docLink: doc.url, source: 'fireflies', exported: today, removedFromFireflies: '', void: '' });
      rec = done[m.id] = { doc: doc.id, at: today }; props.setProperty('ffDone', JSON.stringify(done));
      log.push('Saved: ' + doc.day + ' ' + (t.title || ''));
    }
    if (del && rec && !rec.deleted) {
      try { DriveApp.getFileById(rec.doc).getName(); ffQuery_('mutation($id:String!){ deleteTranscript(id:$id){ id } }', { id: m.id }); rec.deleted = today; props.setProperty('ffDone', JSON.stringify(done)); patchRow_('meetings', m.id, { removedFromFireflies: today }); log.push('Freed in Fireflies: ' + (m.title || m.id)); }
      catch (e) { log.push('Could not remove from Fireflies: ' + (m.title || m.id) + ' (' + e.message + ')'); }
    }
  }
  Logger.log(log.join('\n') || 'Nothing new in Fireflies.');
  return log;
}
function setupMeetingsTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'exportFireflies').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('exportFireflies').timeBased().everyDays(3).atHour(4).inTimezone(TZ).create();
}

/** Run once from the editor to check everything is wired up. */
function test() {
  Logger.log(JSON.stringify(readTab_('places')));
  Logger.log(JSON.stringify(calendar_(1)).slice(0, 2000));
  Logger.log(JSON.stringify(brief_()));
  Logger.log(JSON.stringify(verse_()));
}

/* ---------- One-time import: Apple Notes (iCloud export) and Google Keep notes → HQ Notes ----------
   Run importNotes from the editor. It works in rounds of about 4½ minutes; run it again until the log says "All done".
   Originals stay where they are. Notes holding card or account numbers, passwords or PINs are left out of HQ
   (Keep ones are moved into "Private – not in HQ"). Already-imported notes are skipped, so running it again is safe. */
const IMPORT_SOURCES = [
  { name: 'iCloud', path: ['iCloud'], prefix: '' },            // Apple Notes export, keeps its folders
  { name: 'Google Keep', path: ['Google', 'Notes'], prefix: 'Google Keep' }
];
const PRIVATE_FOLDER = 'Private – not in HQ';
const SENSITIVE = /password|passwd|kata ?sandi|\bpin\b|access ?(id|code)|kartu kredit|credit card|\bcvv\b|\botp\b|mandiri mobile|e-?banking|\bm-?banking|\b(ktp|nik|npwp|paspor|passport|no\.? ?rek|rekening|account (no|number)|swift|iban)\b\W{0,20}\d[\d .\-]{5,}/i;   // ID words only count when a number follows
const DIGITS = /(?<![\w.,\/])\d(?:[ \-]?\d){9,18}(?![\w.,\/])/;   // long bare numbers: cards, accounts, IDs
/* Plain words only: no picture names, links or file codes (those are full of digits but harmless). */
function plainForCheck_(md) {
  return String(md || '').replace(/\\(.)/g, '$1').replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ').replace(/(https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ').replace(/\b(19|20)\d\d[-\/.]\d\d?[-\/.]\d\d?\b/g, ' ');
}
function sensitive_(title, text) {
  const t = String(title || '').replace(/\.md$/, ''), b = plainForCheck_(text);
  if (/^[\d\s\-.]{6,}$/.test(t)) return true;
  return SENSITIVE.test(t) || SENSITIVE.test(b) || DIGITS.test(t) || DIGITS.test(b);
}
function folderByPath_(path) {
  let it = DriveApp.getFoldersByName(path[0]), f = null;
  while (it.hasNext()) { const c = it.next(); if (c.getParents().hasNext() && c.getParents().next().getId() === DriveApp.getRootFolder().getId()) { f = c; break; } if (!f) f = c; }
  for (let i = 1; f && i < path.length; i++) { const s = f.getFoldersByName(path[i]); f = s.hasNext() ? s.next() : null; }
  return f;
}
/* Google Keep notes: sorted into subfolders (titles from Timothy's export; anything else goes by keywords). */
const KEEP_SORT = {
  'Church & Ministry': ['1 Tim 4-12', '1 percent faith', 'Fil-2-2', 'Wahtu 3-2', 'Haggai', 'Ps- 34-17-22', 'Jabesh gilead', 'Khotbah Isti', 'Lesson 1 - Siapa itu Roh Kudus', 'Let your glory fall in this place', 'Percaya SAJA!', 'Setiap kali menerima kebaikan Tuhan yang baru - Tuhan disenangkan', 'Tuhan di pihakmu', 'Fight till the end', 'Sederhana', 'Scope pelayanan kitA blm in- depth', 'Session 6 - 40 days of purpose', 'Games dari felicia hartono', 'Games ibadah games', 'Smk - aku jaga mereka punya saat teduh', 'Smk - kelas susulan + retreat', 'SmK latihan kelulusan', 'Komsel Entrepreneur', 'Karin - bahasa Roh--', 'caca - lokasi dan timing retreat', 'Adea terobosan - yang bisa untukdipercaya', '1-Apakah sudah ada komunitas abbalove', 'It doesny matter where you came from', '2 ekstrim-', '52 detik', 'Keuangan yang Merdeka', 'Pijat - 70', 'Nama sekolah', 'Dua sahabat', '1- 17 july'],
  'Company – Paint & Coatings': ['4 - 1 - 1', '5 thn', 'Berat asahi', 'Chrome', 'CitrawarnaHR', 'Diskusi pabrik', 'Dvd 10', 'Foto Karakter Harga Distributor-', 'Harga dari garuda', 'Hariyadi-', 'Ko indra', 'Locker', 'Magos', 'Manual - 10-5', 'Meet sigit pas pengiriman - update sales', 'Meiden', 'NC kelas nippe', 'Ppg plan', 'Sticker - angkot', 'Toko udh lama belom', 'Uming', 'Uming-1', 'kenny', 'Wika', 'Trial-slama ini lab sja', 'Mcb 25 A 3 pass untuk chiller', 'Mcb marine garyn 2A', 'Filter cuno', 'Jumat - maintenance', 'Pembersih kaca super', 'Product', 'Categories', 'Oct 2012 - 6714', '3-415 register', 'Time management', 'Bikin form request hutang'],
  'Leadership & People': ['Join apindo', 'How to put value on an employee-', 'Lack of development with current salary', 'Call bernardus', 'Elevate', 'Birkman Test', 'Indonesian glassdoor', 'Industrial system and engineering', 'CBC', 'Kepada Pak Paulus,', 'Daftar STADA-SHRI'],
  'Business Ideas': ['Bitcoin', 'Budibagus-com', 'Salesjitu-com', 'Waralabaku-com'],
  'Personal & Family': ['21 dec', '22nov', '3 green tea', 'Grandma- teh tarik', 'Frame for mom n dad, buku maximized manhood for edward', 'Asuransi avanza', 'Mobil', 'Softlens', 'Lunasi hutang', 'Given to uming - 1000', 'Hutang tim', 'Bandulu water sport', 'Hotel CIputra', 'Link dropbox foto', 'Official Transcript!', 'Install Office for MAC 2013', 'DM', 'Satellite M50', 'Encephalis herpes', '16 arumugam rd', 'Lembah Petualangan'],
  'People & Lists': ['1- Jonathan Aristo Suwarna', 'Aris', 'Hani', '3Divas', 'Participants-', 'Juven', 'Ko Yoh']
};
const KEEP_WORDS = [
  ['Church & Ministry', /tuhan|yesus|roh kudus|khotbah|ibadah|komsel|pelayanan|doa|retreat|gereja|alkitab|ayat|smk|\b(mat|mrk|luk|yoh|kis|rom|kor|gal|ef|fil|kol|tes|tim|ibr|yak|pet|why|kej|kel|im|bil|ul|yos|hak|rut|sam|raj|taw|ezr|neh|est|ayb|mzm|ams|pkh|kid|yes|yer|rat|yeh|dan|hos|yl|am|ob|yun|mi|nah|hab|zef|hag|za|mal|ps)\.? ?\d/i],
  ['Company – Paint & Coatings', /epoxy|asahi|cat\b|paint|pabrik|harga|kaleng|customer|order|stok|supplier|ppn|invoice|sales|pallet|palet|compressor|kompressor|coating|dempul/i],
  ['Leadership & People', /employee|karyawan|hr\b|recruit|interview|salary|gaji|leadership|personality/i],
  ['Personal & Family', /parkir|makan|dinner|oma|grandma|mom|dad|mobil|asuransi|hotel|liburan|holiday/i]
];
function keepFolderFor_(title, text) {
  const t = title.replace(/\.md$/, '');
  for (const k in KEEP_SORT) if (KEEP_SORT[k].indexOf(t) >= 0) return k;
  for (const [k, re] of KEEP_WORDS) if (re.test(t + ' ' + text)) return k;
  return 'Other';
}
function mdToHtml_(md, imgs) {
  const esc = s => s.replace(/&(?!(nbsp|amp|lt|gt|quot);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, a, src) => { const id = imgs[decodeURIComponent(src).split('/').pop()]; return id ? `<img src="https://drive.google.com/thumbnail?id=${id}&amp;sz=w1200" alt="${a}">` : ''; })
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>').replace(/\[([^\]]+)\]\([a-z]+:[^)]*\)/gi, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, src) => { const id = imgs[decodeURIComponent(src).split('/').pop()]; return id ? `<a class="att" href="https://drive.google.com/file/d/${id}/view" contenteditable="false">📎 ${a}</a>` : a; })   // files kept beside the note in the export
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\\([#!*_\[\]().\-+>`~|&])/g, '$1');
  md = String(md || '').replace(/\\([\\`*_{}\[\]()#+\-.!|>~&<])/g, '$1');   // Apple Notes export escapes Markdown characters
  const lines = md.replace(/\r/g, '').split('\n'); let out = '', list = null;
  const close = () => { if (list) { out += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (/^\s*$/.test(l)) { close(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { close(); const n = Math.min(3, m[1].length); out += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) { close(); out += '<hr>'; continue; }
    if ((m = l.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/))) { if (list !== 'ul class="check"') { close(); out += '<ul class="check">'; list = 'ul class="check"'; } out += `<li${m[1] !== ' ' ? ' class="on"' : ''}>${inline(m[2])}</li>`; continue; }
    if ((m = l.match(/^\s*[-*+]\s+(.*)$/))) { if (list !== 'ul') { close(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { close(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { close(); out += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (/^\|.*\|\s*$/.test(l)) { close(); const rows = []; while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { if (!/^\|[\s:\-|]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map(c => `<td>${inline(c.trim())}</td>`).join('')); i++; } i--; out += `<table>${rows.map(r => `<tr>${r}</tr>`).join('')}</table>`; continue; }
    close(); const para = inline(l.replace(/\s{2,}$/, '')).trim(); if (para) out += `<p>${para}</p>`;
  }
  close();
  return out.replace(/<\/ul class="check">/g, '</ul>');
}
function typeFor_(path) {
  if (/sermon|teaching|bcc|sinode|dyc|mission|tema|church|ministry|devotion|prayer/i.test(path)) return 'Church';
  if (/cwm|pik|company|paint|leadership|business/i.test(path)) return 'Work';
  return 'Personal';
}
function importNotes() {
  const t0 = Date.now(), log = [], props = PropertiesService.getScriptProperties();
  const rows = readTab_('notes_index'), have = {}, folders = {};
  rows.forEach(r => { have[r.id] = 1; if (r.kind === 'folder') folders[r.folder] = 1; });
  const add = [], addFolder = p => { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) { const q = parts.slice(0, i).join('/'); if (!folders[q]) { folders[q] = 1; add.push({ id: 'f-imp-' + Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, q).map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('').slice(0, 16), kind: 'folder', folder: q, title: parts[i - 1], date: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), void: '' }); } } };
  let skipped = 0, privateN = 0, done = true;
  for (const src of IMPORT_SOURCES) {
    const root = folderByPath_(src.path);
    if (!root) { log.push('Could not find the folder ' + src.path.join('/') + ' in Drive.'); continue; }
    let priv = null;
    if (src.name === 'Google Keep') {   // notes held back by an older, stricter check go back to be sorted
      const pf = root.getFoldersByName(PRIVATE_FOLDER);
      if (pf.hasNext()) { const fs = pf.next().getFiles(); while (fs.hasNext()) { const f = fs.next(); if (/\.md$/i.test(f.getName()) && !sensitive_(f.getName(), f.getBlob().getDataAsString())) f.moveTo(root); } }
    }
    const walk = (folder, rel) => {
      const name = folder.getName();
      if (/^(images|attachments|recently deleted)$/i.test(name) && rel) return true;
      if (name === PRIVATE_FOLDER) return true;
      const imgs = {};
      ['images', 'attachments'].forEach(n => { const it = folder.getFoldersByName(n); while (it.hasNext()) { const fi = it.next().getFiles(); while (fi.hasNext()) { const f = fi.next(); imgs[f.getName()] = f.getId(); } } });
      const files = folder.getFiles();
      while (files.hasNext()) {
        if (Date.now() - t0 > 3.5 * 60 * 1000) return false;   // leave time to save before Google's 6-minute limit
        const f = files.next(); if (!/\.md$/i.test(f.getName())) continue;
        const id = 'md-' + f.getId(); if (have[id]) continue;
        const md = f.getBlob().getDataAsString(), title = f.getName().replace(/\.md$/i, '').trim();
        if (sensitive_(title, md)) {
          if (src.name === 'Google Keep') { priv = priv || sub_(root, PRIVATE_FOLDER); f.moveTo(priv); }
          privateN++; log.push('Kept out (private): ' + title); continue;
        }
        let path = (src.prefix ? src.prefix + (rel ? '/' : '') : '') + rel;
        if (src.name === 'Google Keep' && !rel) { const k = keepFolderFor_(f.getName(), md.slice(0, 2000)); const dest = sub_(root, k); f.moveTo(dest); path = 'Google Keep/' + k; }
        if (!path) path = 'Notes';
        addFolder(path);
        const html = mdToHtml_(md, imgs), text = md.replace(/[#*_>`\\\[\]()!|-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
        const day = Utilities.formatDate(f.getLastUpdated(), TZ, 'yyyy-MM-dd');
        const link = writeNote_(id, title, html);
        add.push({ id: id, kind: 'note', title: title, folder: path, para: '', type: typeFor_(path), people: '', date: day, driveLink: link, tags: 'imported', void: '', pinned: '', text: text, refs: parseRefs(title + '\n' + md).join(' '), updated: day });
        have[id] = 1;
        if (add.length % 40 === 0) { appendRows_('notes_index', add.splice(0)); }
      }
      const subs = folder.getFolders();
      while (subs.hasNext()) { const s = subs.next(); if (!walk(s, (rel ? rel + '/' : '') + s.getName())) return false; }
      return true;
    };
    if (!walk(root, '')) { done = false; break; }
  }
  if (add.length) appendRows_('notes_index', add);
  const n = readTab_('notes_index').filter(r => r.tags === 'imported').length;
  log.unshift(done ? `All done. ${n} notes are in HQ Notes; ${privateN} private notes left out this round.` : `Paused to stay within Google's time limit (${n} notes in so far). Run importNotes again to continue.`);
  Logger.log(log.join('\n'));
  return log;
}
/* Run once after the import fix of 23 Nov: rewrites imported notes so their pictures and formatting show. Safe to run again. */
function fixImportedNotes() {
  const t0 = Date.now(), done = PropertiesService.getScriptProperties();
  const rows = readTab_('notes_index').filter(r => r.kind === 'note' && r.tags === 'imported' && /^md-/.test(r.id));
  let n = 0, left = 0;
  rows.forEach(r => {
    if (done.getProperty('fix1-' + r.id)) return;
    if (Date.now() - t0 > 4.5 * 60 * 1000) { left++; return; }
    try {
      const f = DriveApp.getFileById(r.id.slice(3)), imgs = {}, par = f.getParents().next();
      ['images', 'attachments'].forEach(nm => { const it = par.getFoldersByName(nm); while (it.hasNext()) { const fi = it.next().getFiles(); while (fi.hasNext()) { const x = fi.next(); imgs[x.getName()] = x.getId(); } } });
      writeNote_(r.id, r.title, mdToHtml_(f.getBlob().getDataAsString(), imgs)); n++;
    } catch (e) {}
    done.setProperty('fix1-' + r.id, '1');
  });
  Logger.log(left ? `Fixed ${n}; ${left} to go. Run fixImportedNotes again.` : `All done. Fixed ${n} notes.`); return left;
}

/* Adds rows at the bottom of a tab without rewriting it. */
function appendRows_(name, rows) {
  if (!rows.length) return;
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const s = sheet_(name);
    const head = s.getRange(1, 1, 1, Math.max(1, s.getLastColumn())).getDisplayValues()[0].filter(String);
    rows.forEach(r => Object.keys(r).forEach(k => { if (head.indexOf(k) < 0) { head.push(k); s.getRange(1, head.length).setValue(k); } }));
    const body = rows.map(r => head.map(k => r[k] == null ? '' : String(r[k])));
    const rng = s.getRange(s.getLastRow() + 1, 1, body.length, head.length);
    rng.setNumberFormat('@'); rng.setValues(body);
  } finally { lock.releaseLock(); }
}

/* Bible references (Indonesian TB + English). parseRefs('Yoh 3:16-18; Fil 2:2') → ['JHN.3.16-18','PHP.2.2'] */
const BIBLE = [
 ['GEN','Kejadian|Kej|Genesis|Gen'],['EXO','Keluaran|Kel|Exodus|Exod|Ex'],['LEV','Imamat|Im|Leviticus|Lev'],['NUM','Bilangan|Bil|Numbers|Num'],['DEU','Ulangan|Ul|Deuteronomy|Deut|Dt'],
 ['JOS','Yosua|Yos|Joshua|Josh'],['JDG','Hakim-hakim|Hakim|Hak|Judges|Judg'],['RUT','Rut|Ruth'],['1SA','1 Samuel|1 Sam|1Sam'],['2SA','2 Samuel|2 Sam|2Sam'],
 ['1KI','1 Raja-raja|1 Raj|1Raj|1 Kings|1 Kgs'],['2KI','2 Raja-raja|2 Raj|2Raj|2 Kings|2 Kgs'],['1CH','1 Tawarikh|1 Taw|1Taw|1 Chronicles|1 Chr'],['2CH','2 Tawarikh|2 Taw|2Taw|2 Chronicles|2 Chr'],
 ['EZR','Ezra|Ezr'],['NEH','Nehemia|Nehemiah|Neh'],['EST','Ester|Esther|Est|Esth'],['JOB','Ayub|Ayb|Job'],['PSA','Mazmur|Mzm|Psalms|Psalm|Psa|Ps'],['PRO','Amsal|Ams|Proverbs|Prov'],
 ['ECC','Pengkhotbah|Pkh|Ecclesiastes|Eccl|Ecc'],['SNG','Kidung Agung|Kid|Song of Songs|Song of Solomon'],['ISA','Yesaya|Yes|Isaiah|Isa'],['JER','Yeremia|Yer|Jeremiah|Jer'],['LAM','Ratapan|Rat|Lamentations|Lam'],
 ['EZK','Yehezkiel|Yeh|Ezekiel|Ezek'],['DAN','Daniel|Dan'],['HOS','Hosea|Hos'],['JOL','Yoel|Yl|Joel'],['AMO','Amos|Am'],['OBA','Obaja|Ob|Obadiah|Obad'],['JON','Yunus|Yun|Jonah'],
 ['MIC','Mikha|Mi|Micah|Mic'],['NAM','Nahum|Nah'],['HAB','Habakuk|Habakkuk|Hab'],['ZEP','Zefanya|Zef|Zephaniah|Zeph'],['HAG','Hagai|Hag|Haggai'],['ZEC','Zakharia|Za|Zechariah|Zech'],['MAL','Maleakhi|Mal|Malachi'],
 ['MAT','Matius|Mat|Matthew|Matt|Mt'],['MRK','Markus|Mrk|Mark|Mk'],['LUK','Lukas|Luk|Luke|Lk'],['JHN','Yohanes|Yoh|John|Jn'],['ACT','Kisah Para Rasul|Kisah Rasul|Kis|Acts'],['ROM','Roma|Rm|Rom|Romans'],
 ['1CO','1 Korintus|1 Kor|1Kor|1 Corinthians|1 Cor|1Cor'],['2CO','2 Korintus|2 Kor|2Kor|2 Corinthians|2 Cor|2Cor'],['GAL','Galatia|Gal|Galatians'],['EPH','Efesus|Ef|Ephesians|Eph'],['PHP','Filipi|Flp|Fil|Philippians|Phil'],
 ['COL','Kolose|Kol|Colossians|Col'],['1TH','1 Tesalonika|1 Tes|1Tes|1 Thessalonians|1 Thess'],['2TH','2 Tesalonika|2 Tes|2Tes|2 Thessalonians|2 Thess'],['1TI','1 Timotius|1 Tim|1Tim|1 Timothy'],['2TI','2 Timotius|2 Tim|2Tim|2 Timothy'],
 ['TIT','Titus|Tit'],['PHM','Filemon|Flm|Philemon|Phlm'],['HEB','Ibrani|Ibr|Hebrews|Heb'],['JAS','Yakobus|Yak|James|Jas'],['1PE','1 Petrus|1 Ptr|1 Pet|1Pet|1 Peter'],['2PE','2 Petrus|2 Ptr|2 Pet|2Pet|2 Peter'],
 ['1JN','1 Yohanes|1 Yoh|1Yoh|1 John|1 Jn'],['2JN','2 Yohanes|2 Yoh|2Yoh|2 John'],['3JN','3 Yohanes|3 Yoh|3Yoh|3 John'],['JUD','Yudas|Yud|Jude'],['REV','Wahyu|Why|Revelation|Rev']];
const BOOKNAME = {}; const BOOKALT = [];
BIBLE.forEach(([c, n]) => { const ns = n.split('|'); BOOKNAME[c] = ns[0]; ns.forEach(x => BOOKALT.push([x, c])); });
BOOKALT.sort((a, b) => b[0].length - a[0].length);
const SHORTRISK = /^(Am|Im|Ul|Mi|Ob|Za|Yl|Ex|Yes|Kid|Rat|Dan|Job|Mark|Ruth|Rut|Kis|Kel|Hak|Rm|Ef|Col|Jn|Mt|Mk|Lk|Dt|Ps)$/;   // need chapter:verse
const REF_RE = new RegExp('(?<![A-Za-z])(' + BOOKALT.map(b => b[0].replace(/[-]/g, '\\-').replace(/ /g, '\\s?')).join('|') + ')\\.?\\s?(\\d{1,3})(?:\\s?[:.]\\s?(\\d{1,3})(?:\\s?[-–]\\s?(\\d{1,3}))?)?(?![\\d])', 'g');
function bookCode(name) { const k = name.replace(/\s+/g, ' ').toLowerCase(); const hit = BOOKALT.find(b => b[0].toLowerCase() === k || b[0].replace(/ /g, '').toLowerCase() === k.replace(/ /g, '')); return hit ? hit[1] : ''; }
function parseRefs(text) {
  const out = []; let m; const s = String(text || ''); REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(s))) {
    const name = m[1].replace(/\s+/g, ' '), code = bookCode(name); if (!code) continue;
    if (!m[3] && (SHORTRISK.test(name.replace(/\s/g, '')) || name.length <= 3)) continue;
    const ch = +m[2]; if (!ch || ch > 150) continue;
    out.push(code + '.' + ch + (m[3] ? '.' + (+m[3]) + (m[4] && +m[4] > +m[3] ? '-' + (+m[4]) : '') : ''));
  }
  return [...new Set(out)];
}
/* How closely ref a (from a note) matches query ref q: 3 same verse/overlap, 2 same chapter, 1 same book, 0 none. */
function refMatch(a, q) {
  const [ab, ac, av] = a.split('.'), [qb, qc, qv] = q.split('.'); if (ab !== qb) return 0; if (!qc) return 3; if (ac !== qc) return 1; if (!qv) return 3; if (!av) return 2;
  const r = x => { const [f, t] = x.split('-').map(Number); return [f, t || f]; }; const [a1, a2] = r(av), [q1, q2] = r(qv);
  return a1 <= q2 && q1 <= a2 ? 3 : 2;
}
function refLabel(r) { const [b, c, v] = r.split('.'); return BOOKNAME[b] + (c ? ' ' + c + (v ? ':' + v : '') : ''); }

/* Records the Bible references in every HQ note (column "refs"), so searching a verse finds all your notes on it.
   importNotes does this for imported notes; run indexVerses once for the notes that were already in HQ. Safe to run again. */
function indexVerses() {
  const t0 = Date.now(), s = sheet_('notes_index');
  const v = s.getDataRange().getDisplayValues(); const h = v[0];
  let rc = h.indexOf('refs'); if (rc < 0) { rc = h.length; s.getRange(1, rc + 1).setValue('refs'); }
  const ic = h.indexOf('id'), kc = h.indexOf('kind'), tc = h.indexOf('title'); let n = 0, left = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i][kc] !== 'note' || (v[i][rc] || '') !== '') continue;
    if (Date.now() - t0 > 4.5 * 60 * 1000) { left++; continue; }
    const html = readNote_(v[i][ic]); const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const r = parseRefs(v[i][tc] + '\n' + text).join(' ');
    s.getRange(i + 1, rc + 1).setNumberFormat('@').setValue(r || '-'); n++;
  }
  Logger.log(left ? `Indexed ${n} notes; ${left} to go. Run indexVerses again.` : `All done. Indexed ${n} notes.`); return left;
}

/* Runs the notes import, then fixImportedNotes, then indexVerses, every 10 minutes until all three say All done, then switches itself off. Start with startAutoNotes. */
function startAutoNotes() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'autoNotes').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoNotes').timeBased().everyMinutes(10).create();
}
function autoNotes() {
  const p = PropertiesService.getScriptProperties(), step = p.getProperty('autoNotesStep') || 'import';
  const stop = () => ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'autoNotes').forEach(t => ScriptApp.deleteTrigger(t));
  if (step === 'import') { const log = importNotes(); if (/^All done/.test(log[0])) p.setProperty('autoNotesStep', 'fix'); return; }
  if (step === 'fix') { if (!fixImportedNotes()) p.setProperty('autoNotesStep', 'index'); return; }
  if (step === 'index') { if (!indexVerses()) { p.setProperty('autoNotesStep', 'done'); stop(); } return; }
  stop();
}
/* Counts the note files waiting in the export folders, so we know how many the import should end up with. */
function countNotes() {
  const out = [];
  IMPORT_SOURCES.forEach(src => {
    const root = folderByPath_(src.path); if (!root) { out.push(src.path.join('/') + ': not found'); return; }
    const c = { md: 0, priv: 0, other: {}, folders: 0 };
    const walk = (f, inPriv) => { c.folders++; const nm = f.getName(); if (/^(images|attachments)$/i.test(nm)) return;
      const fs = f.getFiles(); while (fs.hasNext()) { const x = fs.next(), n = x.getName(); if (/\.md$/i.test(n)) { if (inPriv) c.priv++; else c.md++; } else { const e = (n.match(/\.([a-z0-9]+)$/i) || [,'(none)'])[1].toLowerCase(); c.other[e] = (c.other[e] || 0) + 1; } }
      const ss = f.getFolders(); while (ss.hasNext()) { const s = ss.next(); walk(s, inPriv || s.getName() === PRIVATE_FOLDER); } };
    walk(root, false);
    out.push(src.path.join('/') + ': ' + c.md + ' notes, ' + c.priv + ' in private folder, ' + c.folders + ' folders, other files ' + JSON.stringify(c.other));
  });
  const rows = readTab_('notes_index'); out.push('In HQ now: ' + rows.filter(r => r.tags === 'imported').length + ' imported, ' + rows.filter(r => r.kind === 'note').length + ' notes in total');
  Logger.log(out.join('\n'));
}
