/**
 * Timothy HQ – bridge between the app and Google (Sheet, Calendar, Gmail, Maps, Drive).
 * Paste into script.google.com, fill in SHEET_ID and TOKEN, then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). Never commit a filled-in copy.
 */
const SHEET_ID = 'PASTE_SHEET_ID_HERE';
const TOKEN = 'PASTE_YOUR_SECRET_TOKEN_HERE';
const TZ = 'Asia/Jakarta';
const SCRIPT_VERSION = '2026-11-22 18:00'; // shown in HQ › Settings, so you can tell which copy is deployed
const ROOT_FOLDER = 'Claude';      // everything HQ creates lives inside this Drive folder
const NOTES_FOLDER = 'HQ Notes';
const BUFFER_MIN = 10;               // extra minutes added before every leave-by time
const TABS = ['tasks', 'people', 'notes_index', 'places', 'habits', 'books', 'highlights', 'cashbooks', 'cash_entries', 'briefs', 'reading_log', 'meetings'];

function doGet(e) {
  return handle_(() => {
    const p = e.parameter;
    auth_(p.token);
    const a = p.action || 'read';
    if (a === 'ping') return { ok: true, tabs: TABS, version: SCRIPT_VERSION };
    if (a === 'read') return { ok: true, rows: readTab_(p.name) };
    if (a === 'all') { const out = {}; TABS.forEach(t => out[t] = readTab_(t)); return { ok: true, data: out }; }
    if (a === 'calendar') return { ok: true, events: calendar_(Number(p.days || 2)) };
    if (a === 'brief') return { ok: true, brief: brief_() };
    if (a === 'note') return { ok: true, html: readNote_(p.id) };
    if (a === 'verse') return { ok: true, verse: verse_() };
    if (a === 'contacts') return { ok: true, contacts: contacts_() };
    if (a === 'book') return bookFile_(p.id);
    if (a === 'sortbooks') return { ok: true, log: sortNewBooks() };
    if (a === 'meetings') return { ok: true, log: exportFireflies() };
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
  return {
    unread: unread,
    important: imp.map(t => {
      const m = t.getMessages().pop();
      return { from: m.getFrom().replace(/<.*>/, '').replace(/"/g, '').trim(), subject: t.getFirstMessageSubject(), date: m.getDate().toISOString(), link: 'https://mail.google.com/mail/u/0/#inbox/' + t.getId() };
    })
  };
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
