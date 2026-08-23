/**
 * PREDATOR MORNING BOT v2 - the ledger's voice.
 *
 * ONE Claude API call per day, 07:05 Qld (just after FlatByTime/close), delivering
 * the full morning brief to Telegram:
 *   - MACRO: M2 tide, latest calendar results, disruption scan, kill switches
 *     (the original macro-bot checks, unchanged in spirit)
 *   - THE DAY REVIEWED: funding arc + character (loading/pinned/oscillating/drained),
 *     digest fires with context, liquidation totals both sides
 *   - GAMMA INTEL: cage width, put-wall-to-flip distance, compression read
 *   - TOMORROW: bias + what would make the gate arm
 * Still writes macro_bias.json (regime-engine compatible, same fields + extras).
 *
 * Run:  pm2 start predator-macro-bot.js --name predator-morning
 * Test: node predator-macro-bot.js --now     (one immediate run, then exits)
 */
'use strict';
require('dotenv').config();
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const BIAS_FILE = path.join(__dirname, 'macro_bias.json');
const CALENDAR_FILE = path.join(__dirname, 'economic-calendar.json');
const DIR = __dirname;
const RUN_HOUR_QLD = 7, RUN_MIN_QLD = 5;   // 07:05 Qld daily

// ─── calendar ────────────────────────────────────────────────────────────────
let calendarEvents = [];
try {
    const raw = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    if (Array.isArray(raw)) calendarEvents = raw;
    else if (raw && Array.isArray(raw.events)) calendarEvents = raw.events;
    else if (raw && Array.isArray(raw.calendar)) calendarEvents = raw.calendar;
    else if (raw && typeof raw === 'object') {
        const firstArray = Object.values(raw).find(v => Array.isArray(v));
        if (firstArray) calendarEvents = firstArray;
    }
} catch (e) { }

function getCalendarContext() {
    const now = new Date();
    const back = new Date(now.getTime() - 14 * 864e5);
    const fwd = new Date(now.getTime() + 14 * 864e5);
    const recent = calendarEvents.filter(e => { const d = new Date(e.date); return d >= back && d <= now; });
    const upcoming = calendarEvents.filter(e => { const d = new Date(e.date); return d > now && d <= fwd; });
    return { recent, upcoming };
}

// ─── local data gathering (all free, all best-effort) ────────────────────────
function qldStr(ms) {
    return new Date(ms + 36e6).toISOString().slice(0, 16).replace('T', ' ');
}
function latestFile(re) {
    const fs_ = fs.readdirSync(DIR).filter(f => re.test(f)).sort();
    return fs_.length ? path.join(DIR, fs_[fs_.length - 1]) : null;
}

function getDigest() {
    return new Promise((resolve) => {
        const req = http.get('http://localhost:3000/api/digest', { timeout: 8000 }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function getFires() {
    // replay the last 24h through the digest itself - the machine's own account
    try {
        const to = new Date(Date.now() + 36e6).toISOString().slice(0, 10);          // today Qld
        const from = new Date(Date.now() + 36e6 - 864e5).toISOString().slice(0, 10); // yesterday Qld
        const out = execSync(`node ${path.join(DIR, 'predator-digest.js')} --replay ${from} ${to}`,
            { timeout: 300000, encoding: 'utf8' });
        const lines = out.split('\n').filter(l => /SHORT|LONG/.test(l) && /dOIc/.test(l));
        return lines.length ? lines.join('\n') : 'No fires in the last 24h.';
    } catch (e) { return 'Replay unavailable: ' + e.message; }
}

function getFundingArc() {
    // last 24h of funding closes, sampled ~every 30 min, + summary stats
    const f = latestFile(/^eth_pillars_v3_\d{4}-\d{2}\.csv$/);
    if (!f) return { text: 'no pillar file', stats: null };
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('timestamp'), fo = hdr.indexOf('funding_close');
    const cutoff = Date.now() - 24 * 3600e3;
    const pts = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(','); if (c.length < 16) continue;
        const ms = Date.parse(c[ti]); if (!isFinite(ms) || ms < cutoff) continue;
        const fr = parseFloat(c[fo]); if (!isFinite(fr)) continue;
        pts.push([ms, fr]);
    }
    if (!pts.length) return { text: 'no rows in last 24h', stats: null };
    const sampled = pts.filter((_, i) => i % 30 === 0);
    const vals = pts.map(p => p[1]);
    const stats = {
        first: vals[0], last: vals[vals.length - 1],
        min: Math.min(...vals), max: Math.max(...vals),
        zeroCrossings: vals.slice(1).filter((v, i) => (v >= 0) !== (vals[i] >= 0)).length
    };
    const text = sampled.map(p => qldStr(p[0]) + ' ' + p[1].toFixed(6)).join('\n');
    return { text, stats };
}

function getLiqTotals() {
    const f = latestFile(/^eth_liquidations_v2_\d{4}-\d{2}\.csv$/);
    if (!f) return 'no liq file';
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hdr = lines[0].split(',');
    const ti = hdr.indexOf('log_time'), ui = hdr.indexOf('usd_value'), si = hdr.indexOf('side');
    const cutoff = Date.now() - 24 * 3600e3;
    let longUsd = 0, shortUsd = 0, n = 0;
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(','); if (c.length < 7) continue;
        const ms = Date.parse(c[ti]); if (!isFinite(ms) || ms < cutoff) continue;
        const usd = parseFloat(c[ui]); if (!isFinite(usd)) continue;
        const side = parseInt(c[si]);
        if (side === 1) longUsd += usd; else if (side === 2) shortUsd += usd;
        n++;
    }
    return `24h liquidations: LONGS $${(longUsd / 1e6).toFixed(1)}M, SHORTS $${(shortUsd / 1e6).toFixed(1)}M, events ${n}`;
}

function getGamma() {
    const f = latestFile(/^eth_gamma_v1_\d{4}-\d{2}\.csv$/);
    if (!f) return 'no gamma file';
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length < 2) return 'no gamma rows';
    // cols: qld_time,timestamp,spot,net_gex_usd_1pct,zero_gamma,call_wall,put_wall,n_strikes
    const last = lines[lines.length - 1].split(',');
    const spot = parseFloat(last[2]), zg = parseFloat(last[4]), cw = parseFloat(last[5]), pw = parseFloat(last[6]);
    if (!(spot > 0)) return 'gamma row unreadable';
    const cageWidthPct = (cw > 0 && pw > 0) ? ((cw - pw) / spot * 100).toFixed(2) : 'n/a';
    const putToFlipPct = (pw > 0 && zg > 0) ? ((zg - pw) / spot * 100).toFixed(2) : 'n/a';
    const regime = zg > 0 ? (spot > zg ? 'POSITIVE gamma (treacle/chop)' : 'NEGATIVE gamma (grease/cascade)') : 'n/a';
    // 7-day-ago comparison for compression read
    let weekAgoWidth = 'n/a';
    const weekCut = Date.now() - 7 * 864e5;
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        const ms = Date.parse(c[1]);
        if (isFinite(ms) && ms >= weekCut) {
            const s = parseFloat(c[2]), cw2 = parseFloat(c[5]), pw2 = parseFloat(c[6]);
            if (s > 0 && cw2 > 0 && pw2 > 0) weekAgoWidth = ((cw2 - pw2) / s * 100).toFixed(2);
            break;
        }
    }
    return `spot ${spot.toFixed(0)}, zero-gamma ${zg.toFixed(0)}, call wall ${cw.toFixed(0)}, put wall ${pw.toFixed(0)} | ` +
        `regime: ${regime} | cage width ${cageWidthPct}% of spot (7d ago: ${weekAgoWidth}%) | put-wall to flip: ${putToFlipPct}%`;
}

// ─── executions: the strategy's actual fills (posted by PredatorHunt) ────────
function getExecutions() {
    try {
        const f = path.join(DIR, 'executions.csv');
        if (!fs.existsSync(f)) return 'No executions banked yet.';
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
        return lines.length <= 1 ? 'No executions banked yet.'
            : lines[0] + '\n' + lines.slice(-20).join('\n');
    } catch (e) { return 'executions unreadable: ' + e.message; }
}

// ─── the diary: ledger-notes.md, the system's judgment memory ────────────────
const LEDGER_FILE = path.join(DIR, 'ledger-notes.md');
let pendingSuggestion = null;   // bot-drafted diary entry awaiting operator 'yes'
function getLedger() {
    try {
        let t = fs.readFileSync(LEDGER_FILE, 'utf8');
        if (t.length > 14000) t = t.slice(0, 7000) + '\n[...ledger truncated...]\n' + t.slice(-7000);
        return t;
    } catch (e) { return '(no ledger-notes.md found)'; }
}
function appendLedger(note) {
    const stamp = new Date(Date.now() + 36e6).toISOString().slice(0, 16).replace('T', ' ');
    fs.appendFileSync(LEDGER_FILE, '- [' + stamp + ' Qld] ' + note.trim() + '\n');
}

// ─── the one daily prompt ────────────────────────────────────────────────────
function buildPrompt(local) {
    const cal = getCalendarContext();
    const recentEvents = cal.recent.length ? cal.recent.map(e => `  - ${e.date}: ${e.event} (${e.time} ET)`).join('\n') : '  None in last 2 weeks';
    const upcomingEvents = cal.upcoming.length ? cal.upcoming.map(e => `  - ${e.date}: ${e.event} (${e.time} ET)`).join('\n') : '  None in next 2 weeks';
    let previousBias = 'UNKNOWN', previousReason = '';
    try { const p = JSON.parse(fs.readFileSync(BIAS_FILE, 'utf8')); previousBias = p.bias || 'UNKNOWN'; previousReason = p.summary || ''; } catch (e) { }

    return `You are the morning reviewer for PREDATOR HUNT, an ETH-derivatives-driven MNQ futures system. It is just after the 07:00 Qld market close. Produce the daily brief.

═══ THE TRADING DIARY (accumulated judgment — this outranks your own inferences) ═══
${getLedger()}
THE SIT-DOWN DOCTRINE IS THE SYSTEM'S HIGHEST-VALUE DISCIPLINE: board sweep 2026-08-21 measured the operator's manual Tier-A/B sit-downs as worth +877 ticks over the Jul-Aug era (the backtest, which traded through NFP/CPI/PPI, lost -877 on exactly those five trades). Your sit_down_today field is therefore the most consequential line in this brief — err toward YES when a Tier A/B event is in range, and state times in Qld.

Use the diary: grade fires against its specimens and open questions (e.g. fuel-remaining at entry), apply its regime taxonomy and corrections, never re-report an already-graded fire as new, and never invent rules it does not contain.

THE SYSTEM'S THESIS (your grading rubric): "Whose tank is full?" Funding rate measures the crowded side; the crowded side is fuel; sustained moves burn the majority. The GATE arms only at funding extremes (>=95th pct of 14d, sign-guarded) or via the burn latch (recent >=92nd pct visit + active same-side liquidations). The TRIGGER needs a unanimous three-sign episode (OI-contracts direction + CVD delta + liq side) at announcement size. Sit-outs are the product. Funding character types: LOADING (sustained directional climb), PINNED (held at extreme), OSCILLATING (range-bouncing, zero-crossings, no commitment), DRAINED/VACUUM (near zero after an unwind).

═══ TODAY'S LOCAL DATA (already gathered, do not search for this) ═══

FUNDING ARC (last 24h, Qld time):
${local.fundingArc.text}
Stats: first ${local.fundingArc.stats ? local.fundingArc.stats.first : 'n/a'}, last ${local.fundingArc.stats ? local.fundingArc.stats.last : 'n/a'}, min ${local.fundingArc.stats ? local.fundingArc.stats.min : 'n/a'}, max ${local.fundingArc.stats ? local.fundingArc.stats.max : 'n/a'}, zero-crossings ${local.fundingArc.stats ? local.fundingArc.stats.zeroCrossings : 'n/a'}

DIGEST FIRES (last 24h, the machine's own replay):
${local.fires}

CURRENT DIGEST SNAPSHOT:
${JSON.stringify(local.digest)}

LIQUIDATIONS:
${local.liqs}

STRATEGY EXECUTIONS (actual fills from NinjaTrader - grade the ENVELOPE, not just the signal):
${local.executions}

GAMMA CAGE:
${local.gamma}

═══ MACRO CHECKS (use web search for these) ═══

CHECK 1 - M2 MONEY SUPPLY: latest US M2 from FRED. Expanding vs 3 months ago = supports LONG; contracting = SHORT.

CHECK 2 - CALENDAR RESULTS:
Recent scheduled events:
${recentEvents}
Upcoming events:
${upcomingEvents}
Search official sources (BLS.gov, BEA.gov, FederalReserve.gov) for actual results of the most recent events. CPI/PPI below forecast = LONG, above = SHORT. NFP hot = SHORT, cooling = LONG. FOMC dovish = LONG, hawkish = SHORT.

CHECK 3 - DISRUPTIONS (past 12h): geopolitical escalation, surprise central bank moves, bank/corporate shocks, energy disruptions, bond stress.
KILL SWITCHES: 30y UST > 5.5%? CPI trending > 5%? Unemployment > 5%?

PREVIOUS BIAS: ${previousBias} - ${previousReason}

═══ OUTPUT ═══
Respond with EXACTLY this JSON, nothing else, no markdown fences:

{
    "bias": "LONG or SHORT or SIDELINES",
    "m2_status": "EXPANDING or CONTRACTING",
    "m2_detail": "one sentence",
    "calendar_event": "most recent event name",
    "calendar_result": "one sentence",
    "disruption": "CLEAR or DISRUPTED",
    "disruption_detail": "one sentence or 'No disruptions detected'",
    "kill_switches": { "bonds_30y_above_5_5": false, "cpi_above_5": false, "unemployment_above_5": false },
    "confidence": "HIGH or MEDIUM or LOW",
    "summary": "two sentences on the macro picture",
    "funding_character": "LOADING or PINNED or OSCILLATING or DRAINED or MIXED",
    "day_review": "3-4 sentences: what the tank did (with Qld times), what the machine fired or correctly refused and why per the rubric, and whether the day was legible or static",
    "gamma_read": "1-2 sentences: cage width vs last week (compressed = conviction absent), regime side, anything notable",
    "tomorrow": "2 sentences: the loading-day bias for the session ahead and what would make the gate arm (e.g. 'funding needs to hold above X to rank 95th')",
    "sit_down_today": "YES or NO — the single most important field. Answer YES if ANY of these hold for the Qld session that begins today: (a) a Tier A event (FOMC, CPI) prints during this session or within the following 12 hours; (b) a Tier B event (PPI, GDP) prints in that window; (c) a kill-switch input is within 5% of its threshold (30y UST >5.2%, CPI YoY >4.75%, unemployment >4.75%); (d) a standing watch item escalated materially in the last 24h (fresh Hormuz/Iran kinetic escalation, yen intervention or BoJ surprise, bond-market dislocation). Answer NO otherwise. Do not hedge — the operator needs a binary.",
    "sit_down_reason": "one sentence naming the SPECIFIC trigger if YES (event + exact Qld date/time), or the clearance if NO (e.g. 'no Tier A/B until GDP Aug 27; kill switches clear; no fresh escalation')",
    "next_landmine_qld": "the next Tier A/B event with its date AND time converted to Qld (UTC+10), e.g. 'GDP Thu 27 Aug 22:30 Qld (Tier A)'",
    "upcoming_landmine": "next Tier A/B macro event and date, or 'none scheduled'",
    "diary_suggestion": "ONE candidate diary entry (a judgment worth remembering permanently: a new specimen, a pattern recurrence, a grade) written as a single complete sentence - or 'none' if today produced nothing diary-worthy. Do not repeat entries the diary already contains."
}`;
}

// ─── Claude API (web search enabled) ─────────────────────────────────────────
function callClaude(prompt) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 4000,
            messages: [{ role: 'user', content: prompt }],
            tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        });
        const options = {
            hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body)
            }, timeout: 180000
        };
        const req = https.request(options, (res) => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) return reject(new Error(parsed.error.message));
                    const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                    resolve(text);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
        req.write(body); req.end();
    });
}

function parseResponse(text) {
    try {
        const cleaned = text.replace(/```json|```/g, '').trim();
        const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
        if (a < 0 || b < 0) return null;
        const r = JSON.parse(cleaned.slice(a, b + 1));
        if (!r.bias || !r.day_review) return null;
        return r;
    } catch (e) { return null; }
}

function saveBias(bias) {
    try {
        bias.updated = new Date().toISOString();
        fs.writeFileSync(BIAS_FILE, JSON.stringify(bias, null, 2));
    } catch (e) { console.error('[MORNING] bias save failed: ' + e.message); }
}

function tgSendRaw(payload) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const req = https.request(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
            });
        req.on('error', () => resolve(null));
        req.write(body); req.end();
    });
}

async function sendTelegram(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    // try Markdown first; if Telegram rejects (e.g. unbalanced _ or * in echoed text),
    // resend as plain text so confirmations can never silently vanish
    const r = await tgSendRaw({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
    if (!r || !r.ok) {
        const r2 = await tgSendRaw({ chat_id: CHAT_ID, text: msg });
        if (!r2 || !r2.ok) console.error('[MORNING] telegram send failed twice: ' + JSON.stringify(r2 || r));
    }
}

// ─── the daily run ───────────────────────────────────────────────────────────
async function morningRun() {
    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    console.log(`\n[MORNING] ═══ Brief run ${now} ═══`);
    try {
        console.log('[MORNING] gathering local data...');
        const local = {
            digest: await getDigest(),
            fires: getFires(),
            fundingArc: getFundingArc(),
            liqs: getLiqTotals(),
            executions: getExecutions(),
            gamma: getGamma()
        };
        console.log('[MORNING] calling Claude...');
        let r = null;
        for (let attempt = 1; attempt <= 3 && !r; attempt++) {
            try {
                const extra = attempt > 1 ? '\n\nREMINDER: respond with ONLY the JSON object, no prose, no markdown fences.' : '';
                const response = await callClaude(buildPrompt(local) + extra);
                r = parseResponse(response);
                if (!r) console.error('[MORNING] attempt ' + attempt + ': unparseable, ' + (attempt < 3 ? 'retrying...' : 'giving up on JSON'));
            } catch (e) { console.error('[MORNING] attempt ' + attempt + ' failed: ' + e.message); }
            if (!r && attempt < 3) await new Promise(res => setTimeout(res, 30000));
        }
        if (!r) {
            // never leave the operator briefless: send the raw weather instead
            const d = local.digest || {};
            const g = d.gate || {};
            await sendTelegram('🐅 *MORNING BRIEF (fallback - analyst unavailable)*\n' +
                'Gate: ' + (g.armed || '?') + '  fr ' + (g.level != null ? g.level : '?') + '  rank ' + (g.rank != null ? (+g.rank).toFixed(2) : '?') + '\n' +
                'Funding 24h: ' + (local.fundingArc.stats ? JSON.stringify(local.fundingArc.stats) : 'n/a') + '\n' +
                'Fires:\n' + local.fires + '\n' +
                local.liqs + '\n' + 'Executions:\n' + local.executions);
            console.error('[MORNING] fallback brief sent');
            return;
        }
        saveBias(r);

        const emoji = r.bias === 'LONG' ? '🟢' : r.bias === 'SHORT' ? '🔴' : '🟡';
        const charEmoji = { LOADING: '🔋', PINNED: '📌', OSCILLATING: '🔄', DRAINED: '🪫', MIXED: '🌫' }[r.funding_character] || '❓';
        const sitDown = (r.sit_down_today || '').toUpperCase().startsWith('Y');
        await sendTelegram([
            `🐅 *PREDATOR MORNING BRIEF* — ${new Date(Date.now() + 36e6).toISOString().slice(0, 10)}`,
            ``,
            sitDown
                ? `🛑 *SIT DOWN TODAY — DISABLE THE STRATEGY*\n${r.sit_down_reason || ''}`
                : `✅ *HUNT PERMITTED* — ${r.sit_down_reason || 'no macro blocker'}`,
            `⏭ Next landmine: ${r.next_landmine_qld || r.upcoming_landmine || '?'}`,
            ``,
            `${charEmoji} *Tank:* ${r.funding_character}`,
            `${r.day_review}`,
            ``,
            `🎛 *Gamma:* ${r.gamma_read}`,
            ``,
            `${emoji} *Macro bias:* ${r.bias} (${r.confidence})`,
            `${r.summary}`,
            `📊 M2: ${r.m2_status} | 📅 ${r.calendar_event}: ${r.calendar_result}`,
            `⚡ ${r.disruption}: ${r.disruption_detail}`,
            `🔒 Kill switches: ${Object.values(r.kill_switches || {}).some(v => v) ? '⚠️ ACTIVE' : '✅ clear'}`,
            ``,
            `🌄 *Tomorrow:* ${r.tomorrow}`,
            `💣 *Landmine:* ${r.upcoming_landmine}`,
        ].join('\n'));
        if (r.diary_suggestion && r.diary_suggestion.trim().toLowerCase() !== 'none') {
            pendingSuggestion = r.diary_suggestion.trim();
            await sendTelegram('📔 *Suggest for the diary:*\n' + pendingSuggestion + "\n\nReply *yes* to file, or ignore to discard.");
        }
        console.log(`[MORNING] ═══ Brief sent. Tank: ${r.funding_character}, bias: ${r.bias} ═══`);
    } catch (e) {
        console.error('[MORNING] error: ' + e.message);
    }
}

// ─── interactive Q&A: text the bot, it answers from the archive ─────────────
let tgOffset = 0;
function tgGetUpdates() {
    return new Promise((resolve) => {
        const req = https.get(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?timeout=25&offset=${tgOffset}`,
            { timeout: 30000 },
            res => {
                let d = ''; res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
            });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function answerQuestion(question) {
    const local = {
        digest: await getDigest(),
        fires: getFires(),
        fundingArc: getFundingArc(),
        liqs: getLiqTotals(),
        executions: getExecutions(),
        gamma: getGamma()
    };
    const prompt = `You are the desk assistant for PREDATOR HUNT (ETH-derivatives -> MNQ futures system, thesis: "whose tank is full?" - funding extremes mark the crowded/burnable side). The operator (Glen, Queensland, UTC+10) has texted you a question. Answer it directly and concisely using the local data below. Use Qld times. If the data below cannot answer it, say so plainly rather than guessing. Only use web search if the question is clearly about external/market news rather than the system's own data.

THE TRADING DIARY (accumulated judgment - outranks your own inference; cite it):
${getLedger()}

LOCAL DATA:
FUNDING ARC (last 24h): ${local.fundingArc.text}
Stats: ${JSON.stringify(local.fundingArc.stats)}
FIRES (last 24h replay): ${local.fires}
CURRENT DIGEST: ${JSON.stringify(local.digest)}
LIQUIDATIONS: ${local.liqs}
STRATEGY EXECUTIONS (actual NinjaTrader fills): ${local.executions}
GAMMA: ${local.gamma}

OPERATOR'S QUESTION: ${question}

Reply in plain text (no JSON, no markdown headers), under 200 words, direct answer first.`;
    return await callClaude(prompt);
}

async function pollTelegram() {
    try {
        const upd = await tgGetUpdates();
        if (upd && upd.ok && Array.isArray(upd.result)) {
            for (const u of upd.result) {
                tgOffset = u.update_id + 1;
                const msg = u.message;
                if (!msg || !msg.text) continue;
                if (String(msg.chat.id) !== String(CHAT_ID)) continue;
                const q = msg.text.trim();
                // "yes" ratifies a pending bot-drafted diary suggestion
                if (pendingSuggestion && /^(yes|y|file it|approved?)$/i.test(q)) {
                    appendLedger('[bot-suggested, operator-ratified] ' + pendingSuggestion);
                    await sendTelegram('📔 Filed to the diary:\n' + pendingSuggestion);
                    pendingSuggestion = null;
                    continue;
                }
                // "ledger: <note>" files an observation into the diary from the phone
                const lm = q.match(/^\/?ledger[:\s]+([\s\S]+)/i);
                if (lm) {
                    appendLedger(lm[1]);
                    await sendTelegram('📔 Filed to the diary:\n' + lm[1].trim());
                    continue;
                }
                if (q.startsWith('/')) continue;   // ignore other commands
                console.log('[MORNING] Q: ' + q);
                await sendTelegram('🐅 thinking...');
                try {
                    const a = await answerQuestion(q);
                    await sendTelegram(a && a.trim() ? a.trim() : 'No answer came back - try rephrasing.');
                } catch (e) {
                    await sendTelegram('Error answering: ' + e.message);
                }
            }
        }
    } catch (e) { console.error('[MORNING] poll error: ' + e.message); }
    setTimeout(pollTelegram, 3000);
}

// ─── scheduling: daily at 07:05 Qld ─────────────────────────────────────────
function msUntilNextRun() {
    const nowUtc = Date.now();
    const qldNow = new Date(nowUtc + 36e6);
    const next = new Date(qldNow);
    next.setUTCHours(RUN_HOUR_QLD, RUN_MIN_QLD, 0, 0);
    if (next.getTime() <= qldNow.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - qldNow.getTime();
}

(async () => {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  PREDATOR MORNING BOT v2 - one brief, 07:05 Qld daily      ║');
    console.log('║  Macro + tank review + fires + gamma cage, one API ping    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`  API Key:  ${ANTHROPIC_API_KEY ? 'loaded' : 'MISSING'}`);
    console.log(`  Telegram: ${TELEGRAM_TOKEN ? 'loaded' : 'MISSING'}`);
    console.log(`  Calendar: ${calendarEvents.length} events`);
    if (!ANTHROPIC_API_KEY) { console.error('[MORNING] no ANTHROPIC_API_KEY in .env'); process.exit(1); }

    if (process.argv.includes('--now')) {
        await morningRun();
        console.log('[MORNING] --now run complete, exiting.');
        process.exit(0);
    }

    pollTelegram();
    console.log('[MORNING] interactive Q&A live - text the bot any question');
    const wait = msUntilNextRun();
    console.log(`[MORNING] next brief in ${(wait / 3600e3).toFixed(1)}h (07:05 Qld)`);
    setTimeout(async function tick() {
        await morningRun();
        setTimeout(tick, 24 * 3600e3);
    }, wait);
})().catch(e => { console.error('[MORNING] fatal: ' + e.message); });

process.on('unhandledRejection', (err) => console.error('[MORNING] unhandled: ' + (err.message || err)));
