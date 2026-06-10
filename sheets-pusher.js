/**
 * sheets-pusher.js — mirrors pillar data into a Google Sheet for at-a-glance viewing.
 *
 * Design: PUSH from the VPS, INCREMENTAL (only new rows), running as its OWN lightweight
 * process — never in the trade-timing path. It reuses the /api/pillars endpoint's `from=`
 * bound to fetch only rows newer than what's already in the sheet.
 *
 * First run on an empty sheet backfills the full history (chunked); every run after that
 * appends just the new rows since last time.
 *
 * Schedule it as its own process (runs every minute, appends, exits):
 *   pm2 start sheets-pusher.js --name sheets-pusher --cron "* * * * *" --no-autorestart
 *   pm2 save
 */

const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SHEET_ID = process.env.SHEET_ID;                       // set in .env
const TAB = process.env.SHEET_TAB || 'Sheet1';          // worksheet/tab name
const KEY_FILE = path.join(__dirname, 'sheets-key.json');    // service-account JSON — GITIGNORE IT
const CURSOR_FILE = path.join(__dirname, 'sheets_cursor.json'); // last-pushed timestamp
const PILLARS_URL = 'http://137.184.36.230:3000/api/pillars';
const CHUNK = 5000;                                       // rows per append (handles the big first backfill)

const HEADER = ['qld_time', 'timestamp', 'eth_price', 'nq_price', 'yellow_count', 'funding_rate',
    'oi_total', 'oi_h1_change', 'oi_h4_change', 'vol_h1_change', 'ls_long_pct', 'ls_short_pct',
    'liq_total_1h', 'liq_long_pct', 'liq_total_4h', 'max_pain', 'max_pain_dist', 'pc_ratio', 'bias_score'];

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

function readCursorFile() {
    try { return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).last || null; }
    catch { return null; }
}
function writeCursorFile(ts) {
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ last: ts }));
}

async function ensureHeader(sheets) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A1:A1` });
    if (!r.data.values || r.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID, range: `${TAB}!A1`,
            valueInputOption: 'RAW', requestBody: { values: [HEADER] },
        });
    }
}

// Recover the cursor from the sheet itself if the local file is gone, so a lost cursor
// never re-dumps the entire history.
async function lastTimestampInSheet(sheets) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!B:B` });
    const vals = r.data.values || [];
    if (vals.length <= 1) return null;         // header only / empty
    return vals[vals.length - 1][0] || null;   // last timestamp value
}

async function main() {
    if (!SHEET_ID) throw new Error('SHEET_ID not set in .env');

    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

    await ensureHeader(sheets);

    let cursor = readCursorFile();
    if (!cursor) cursor = await lastTimestampInSheet(sheets);

    const url = cursor ? `${PILLARS_URL}?from=${encodeURIComponent(cursor)}` : PILLARS_URL;
    const csv = (await httpGet(url)).trim();
    if (!csv) { console.log('[SHEETS] endpoint returned nothing'); return; }

    const lines = csv.split('\n');
    lines.shift();   // drop the CSV header row

    const rows = [];
    let latest = cursor;
    for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        const cols = l.split(',');
        const utc = cols[1];                         // UTC timestamp column
        if (cursor && utc <= cursor) continue;       // strictly newer than what's already there
        rows.push(cols);
        latest = utc;
    }

    if (rows.length === 0) { console.log('[SHEETS] no new rows'); return; }

    for (let i = 0; i < rows.length; i += CHUNK) {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID, range: TAB,
            valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
            requestBody: { values: rows.slice(i, i + CHUNK) },
        });
    }
    writeCursorFile(latest);
    console.log(`[SHEETS] appended ${rows.length} rows (cursor -> ${latest})`);
}

main().catch(e => console.error('[SHEETS] ' + e.message));