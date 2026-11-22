/**
 * Timothy HQ – bridge between the app and Google (Sheet, Calendar, Gmail, Maps, Drive).
 * Paste into script.google.com, fill in SHEET_ID and TOKEN, then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). Never commit a filled-in copy.
 */
const SHEET_ID = 'PASTE_SHEET_ID_HERE';
const TOKEN = 'PASTE_YOUR_SECRET_TOKEN_HERE';
const TZ = 'Asia/Jakarta';
const ROOT_FOLDER = 'Claude';      // everything HQ creates lives inside this Drive folder
const NOTES_FOLDER = 'HQ Notes';
const BUFFER_MIN = 10;               // extra minutes added before every leave-by time
const TABS = ['tasks', 'people', 'notes_index', 'places', 'habits', 'books', 'highlights', 'cashbooks', 'cash_entries'];

function doGet(e) {
  return handle_(() => {
    const p = e.parameter;
    auth_(p.token);
    const a = p.action || 'read';
    if (a === 'ping') return { ok: true, tabs: TABS };
    if (a === 'read') return { ok: true, rows: readTab_(p.name) };
    if (a === 'all') { const out = {}; TABS.forEach(t => out[t] = readTab_(t)); return { ok: true, data: out }; }
    if (a === 'calendar') return { ok: true, events: calendar_(Number(p.days || 2)) };
    if (a === 'brief') return { ok: true, brief: brief_() };
    if (a === 'note') return { ok: true, html: readNote_(p.id) };
    if (a === 'verse') return { ok: true, verse: verse_() };
    if (a === 'contacts') return { ok: true, contacts: contacts_() };
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

/** Run once from the editor to check everything is wired up. */
function test() {
  Logger.log(JSON.stringify(readTab_('places')));
  Logger.log(JSON.stringify(calendar_(1)).slice(0, 2000));
  Logger.log(JSON.stringify(brief_()));
  Logger.log(JSON.stringify(verse_()));
}
