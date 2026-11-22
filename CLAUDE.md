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
- `index.html`: the whole app (plain HTML/CSS/JS, no build). Tabs: Today, Notes, Money, People, Library, Settings. Money is a Cashbook-style ledger (books, cash in/out, category, payment mode, running balance, filters, report with CSV/print); Today shows a Cashbook card.
- `sw.js`: network first, cached copy offline; never caches Google calls. Bump `CACHE` when shell files change.
- `manifest.webmanifest` + `icons/`: installable on iPhone, iPad, Android, Mac.
- `apps-script.gs`: the only API. Deployed as a Web app by Timothy (Execute as me, Anyone). GET `?action=all|read|calendar|brief|note|verse|contacts|ping&token=`; POST `{token, action: save|note|addEvent|attach}`. Travel times come from Maps in the script, from home or the previous event; leave-by = start − drive − 10 min.
- Data: Google Sheet "HQ Data" (tabs: tasks, people, notes_index, places, habits, books, highlights, cashbooks, cash_entries). Note bodies are HTML files in Drive "Claude/HQ Notes" (attachments in "Claude/HQ Notes/Attachments"). Everything Claude creates in Drive goes inside the "Claude" folder. All values stored as text; dates yyyy-mm-dd.
- The script URL and token live only in the app's Settings (localStorage on each device). Without them the app shows sample data.
- Claude in chat reads and updates the Sheet through the Google Sheets connector.

## Notes = Apple Notes, newest release wins
Built so far (iOS 15–27): nested folders, Pinned, Recently Deleted, date groups, #tags, Smart Folders (#tag, @person, is:checklist, is:attachment, is:pinned, edited:Nd), links between notes + backlinks, @mentions linked to People, Title/Heading/Subheading/Body/Monostyled, B/I/U/S, highlights + text colours, bullet/dash/numbered/checklist, indent, quote, tables, divider lines, section links, collapsible headings, Markdown copy/paste, photos/scan/files, audio recording + transcript, dictation.
Not built: locked notes, Math Notes, sketching, shared notes, Quick Note.
A monthly scheduled task checks Apple's latest Notes features and adds small missing ones; anything big goes to Timothy as a proposal first.

## Library sorting (bridge script)
`sortNewBooks` runs nightly (~3 a.m.): every new EPUB anywhere in Drive goes to Claude/Library/<category> by title keywords. Under [Teaching] = copy (tracked so it copies once); elsewhere = move. Unclear titles land in "00 New – to sort" for Claude to place by hand. Categories: 01 OT, 02 NT, 03 Theology, 04 Holy Spirit/Pentecost/Revival, 05 Discipleship & Spiritual Formation, 06 Church & Pastoral Leadership, 07 Counseling, 08 Apologetics, 09 Leadership & Business, 10 Personal Growth, 11 Money & Giving, 12 Marriage/Family/Youth, 13 Fiction, 14 History/Economics, 99 Duplicates & files to check.

## Never put in this repo
Tokens, the Sheet ID, ID numbers, bank/card numbers, member names, phone numbers, financial figures, pastoral notes. Those live only in the Sheet. The repo is public.

## Next up (agreed, not built yet)
EPUB reader with highlights; voice notes with transcription; handwriting scan; Claude session notes written to Drive; Gmail summary by Claude each morning; sermon pipeline; weekly review; family time blocks (Wed/Thu evenings).
