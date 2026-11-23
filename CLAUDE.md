# Timothy HQ – rules for Claude

Personal daily app for Timothy (Executive Pastor, GPKdI BCC; director of PT Citra Warna Mulia Tama and PT Peregrine Indo Chemica). He is the only user.

## How we work
1. Simplest setup that works. Do the building yourself; give Timothy numbered, phone-friendly steps only when he must act.
2. Mockup first for anything big (new tab, redesign); wait for his pick. "Build it" = build with sensible defaults, ask afterwards.
3. Never replace the design. Improve on top of it (Apple Notes feel: white sheets, grouped lists, notes yellow #ffd60a, Inter).
4. Nothing fails silently: every sync, calendar or save failure shows a plain message saying why.
5. Never lose history: rows are marked `void`, not deleted. The script keeps `_bak_<tab>` (10 min) and `_day_<tab>` (daily) copies.
6. Check GitHub, Drive, Sheets and connectors yourself before asking Timothy to do something.
7. Copy in plain, warm, human English. No buzzwords.
8. Save his decisions to memory.

## Architecture
- `index.html`: the whole app (plain HTML/CSS/JS, no build). Tabs: Today, Notes, Money, People, Library, Settings. Library lists the `books` tab (id = Drive file id; category = 01–14 code matching Claude/Library folders; minutes, summary, usefulFor, keyPoints split by " | ") grouped by category, with Open Library covers cached per device, tap-to-expand details and search. `reader.js` (loaded on demand, epub.js + JSZip from jsDelivr) is the EPUB reader: Apple Books layout (close top-left, bookmark top-right, back bottom-left, ⋯ menu bottom-right, progress bar), themes Original/Quiet/Paper/Bold/Calm/Focus/Night, fonts, size, line/letter spacing, margins, justify, pages or scroll, contents, search, go to page/%, highlights (5 colours, underline) and notes, bookmarks, study cards, vocabulary (Kindle), reading ruler, read aloud, copy with source, translate, Ask Claude / Story so far (opens Claude), send highlights to Notes, reading goals with streak (reading_log tab), time left in chapter/book. Books are cached on the device in Cache API `hq-books` (sw.js must not delete it). Highlights tab: kind = highlight|bookmark|word, cfi, chapter, style (u = underline). Money is a Cashbook-style ledger (books, cash in/out, category, payment mode, running balance, filters, report with CSV/print); Today shows a Cashbook card, the News brief card (latest date in the `briefs` tab: section headline|attention|id|world, n, tag, title, summary, link) and a "For Claude" list. The Claude button (floating on phones, in the sidebar on wide screens) saves tasks/notes with `for=claude`, `type=task|note` in the tasks tab and can open claude.ai/new prefilled.
- `sw.js`: network first, cached copy offline; never caches Google calls. Bump `CACHE` when shell files change.
- `manifest.webmanifest` + `icons/`: installable on iPhone, iPad, Android, Mac. Icon (Timothy's pick, 22 Nov 2026): "TJC" in thin Montserrat (weight 250) with a thin line under it, black #111 on warm white #faf8f0. Montserrat is for the icon only; the app text stays Inter.
- `apps-script.gs`: the only API. Deployed as a Web app by Timothy (Execute as me, Anyone). GET `?action=all|read|calendar|brief|note|verse|contacts|book|ping&token=` (book = base64 EPUB, max 40 MB); POST `{token, action: save|note|addEvent|attach|patch}` (patch = change cells of one row by id; the reader uses it so it never rewrites the whole books tab). Travel times come from Maps in the script, from home or the previous event; leave-by = start − drive − 10 min.
- Data: Google Sheet "HQ Data" (tabs: tasks, people, notes_index, places, habits, books, highlights, cashbooks, cash_entries, briefs, reading_log, meetings). Note bodies are HTML files in Drive "Claude/HQ Notes" (attachments in "Claude/HQ Notes/Attachments"). Everything Claude creates in Drive goes inside the "Claude" folder. All values stored as text; dates yyyy-mm-dd.
- The script URL and token live only in the app's Settings (localStorage on each device). Without them the app shows sample data.
- Claude in chat reads and updates the Sheet through the Google Sheets connector.

## Notes = Apple Notes, newest release wins
Built so far (iOS 15–27): nested folders, Pinned, Recently Deleted, date groups, #tags, Smart Folders (#tag, @person, is:checklist, is:attachment, is:pinned, edited:Nd), links between notes + backlinks, @mentions linked to People, Title/Heading/Subheading/Body/Monostyled, B/I/U/S, highlights + text colours, bullet/dash/numbered/checklist, indent, quote, tables, divider lines, section links, collapsible headings, Markdown copy/paste, photos/scan/files, audio recording + transcript, dictation.
Not built: locked notes, Math Notes, sketching, shared notes, Quick Note.
A monthly scheduled task checks Apple's latest Notes features and adds small missing ones; anything big goes to Timothy as a proposal first.

## Library sorting (bridge script)
`sortNewBooks` runs hourly (and from Library's "Check Drive now", GET action=sortbooks): every new EPUB anywhere in Drive goes to Claude/Library/<category> by title keywords and is added to the books tab (format, added). Under [Teaching] = copy (tracked so it copies once); elsewhere = move. PDFs are only picked up inside Library or Papers folders. Claude/Papers/<paper title>/ holds sources for a paper: EPUBs, PDFs or Drive shortcuts to Library books stay there and get `paper` (semicolon list) in the books tab; Library shows a "Paper: …" group and "Add to a paper" sets the same field. The reader opens PDFs with pdf.js (real page numbers, text selection, highlights stored as cfi `pdf:N`, chapter `p. N`). Unclear titles land in "00 New – to sort" for Claude to place by hand. Categories: 01 OT, 02 NT, 03 Theology, 04 Holy Spirit/Pentecost/Revival, 05 Discipleship & Spiritual Formation, 06 Church & Pastoral Leadership, 07 Counseling, 08 Apologetics, 09 Leadership & Business, 10 Personal Growth, 11 Money & Giving, 12 Marriage/Family/Youth, 13 Fiction, 14 History/Economics, 99 Duplicates & files to check.

## Meetings (Fireflies → Drive)
`exportFireflies` in the bridge script (every 3 days at 4 a.m. via `setupMeetingsTrigger`, or GET action=meetings) reads Fireflies' GraphQL API with the key in Script properties `FIREFLIES_KEY`, saves each transcribed meeting as a Google Doc (summary, action items, notes, transcript with times) in Claude/Meetings/<year>/, and adds a row to the `meetings` tab. With `FIREFLIES_DELETE=yes` it then deletes the meeting from Fireflies to free minutes (only after the Doc exists). Fireflies' free plan never transcribes recordings past the minute limit ("skipped"); those have no text to export. An HQ Meetings view is still to be built (mockup first).

## Notes import and verse search
`importNotes` (bridge, one-time, re-runnable in 4½-min rounds) brings the Apple Notes export (Drive "iCloud", folders kept) and Google Keep export (Drive "Google/Notes", sorted into subfolders by `KEEP_SORT`/`KEEP_WORDS`) into HQ Notes as `md-<fileId>` rows with tag `imported`. Notes matching `SENSITIVE`/long digit runs are left out (Keep ones moved to "Private – not in HQ"). `parseRefs` (Indonesian TB + English book names) fills the `refs` column (e.g. `JHN.3.16-18`); `indexVerses` backfills older notes. In Notes, searching a reference ("yoh 3:16", "Filipi") shows the verse panel: this verse / same chapter / same book, Summarise with Claude, Start a new sermon.

## Sermon map
View `sermons` (from Notes › Sermon map and Today › Quick links). Rows: `sermons` tab (id, noteId, title, date, place, context, series, refs, themes, theology, points " | ", bigIdea, preacher = "me" or name, docLink, void, updated, checked), filled by Claude from sermon notes/Docs; notes in folders matching /sermon|khotbah|preach|teaching|pengajaran/ without a row still show (title, date, verses). Filters: Mine/Others/Both, Place, Context, Theme, Theology, Year, Book (Bible map), search or verse. "Summarise with Claude" sends the filtered list.

## NotebookLM
`notebooks` tab (id, title, url, kind commentary|sermon|study, books = codes like "1KI 2KI", refs, topics). Personal NotebookLM has no API: HQ shows matching notebooks in the verse panel and Sermon map (book filter) with links, and "Ask my notebooks" opens Claude with the notebook list (Claude asks each via Chrome) and saves a For Claude task. Only Timothy's own work (Q&A, notes, outputs) may be copied out, never the commentary books.

## Email sorting
Separate Apps Script project "HQ Email Sort": `sortInbox` labels, marks read and archives bank mail (Banks/BCA, Permata, Bank Jago, BSI) and Promotions; subjects with approval/tagihan/payroll/bulk stay in the inbox. `setupDailyTrigger` = daily ~4 a.m.

## Never put in this repo
Tokens, the Sheet ID, ID numbers, bank/card numbers, member names, phone numbers, financial figures, pastoral notes. Those live only in the Sheet. The repo is public.

## Next up (agreed, not built yet)
Voice notes with transcription; handwriting scan; Claude session notes written to Drive; Gmail summary by Claude each morning; sermon pipeline; weekly review; family time blocks (Wed/Thu evenings).
