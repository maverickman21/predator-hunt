// ─── PREDATOR MACRO BOT v1.0 — CLAUDE-POWERED MACRO ANALYST ─────────────────
// Runs every hour. Asks Claude one question: LONG, SHORT, or SIDELINES?
// Three checks: M2 tide, calendar direction, disruption scan.
// Writes macro_bias.json for regime engine. Sends Telegram on bias change.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SCAN_INTERVAL = 60 * 60 * 1000; // 1 hour
const BIAS_FILE = path.join(__dirname, 'macro_bias.json');
const CALENDAR_FILE = path.join(__dirname, 'economic-calendar.json');

// ─── Load calendar for context ───────────────────────────────────────────────
let calendarEvents = [];
try {
    const calendarData = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    calendarEvents = calendarData.events || calendarData;
    console.log(`[MACRO BOT] Loaded ${calendarEvents.length} calendar events`);
} catch (e) {
    console.log('[MACRO BOT] No calendar file found, continuing without');
}

// Find recent and upcoming events for context
function getCalendarContext() {
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const twoWeeksAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const recent = calendarEvents.filter(e => {
        const d = new Date(e.date);
        return d >= twoWeeksAgo && d <= now;
    });

    const upcoming = calendarEvents.filter(e => {
        const d = new Date(e.date);
        return d > now && d <= twoWeeksAhead;
    });

    return { recent, upcoming };
}

// ─── Build the prompt ────────────────────────────────────────────────────────
function buildPrompt() {
    const calendar = getCalendarContext();

    const recentEvents = calendar.recent.length > 0
        ? calendar.recent.map(e => `  - ${e.date}: ${e.event} (${e.time} ET)`).join('\n')
        : '  None in last 2 weeks';

    const upcomingEvents = calendar.upcoming.length > 0
        ? calendar.upcoming.map(e => `  - ${e.date}: ${e.event} (${e.time} ET)`).join('\n')
        : '  None in next 2 weeks';

    // Load previous bias for context
    let previousBias = 'UNKNOWN';
    let previousReason = '';
    try {
        const prev = JSON.parse(fs.readFileSync(BIAS_FILE, 'utf8'));
        previousBias = prev.bias || 'UNKNOWN';
        previousReason = prev.summary || '';
    } catch (e) { }

    return `You are a macro economic analyst for an algorithmic NQ futures trading system. Your job is to answer ONE question: Should we be LONG, SHORT, or SIDELINES on NQ futures right now?

You must perform three checks in order:

CHECK 1 — M2 MONEY SUPPLY (The Tide):
Search for the latest US M2 money supply data from FRED (Federal Reserve Economic Data).
Is M2 expanding or contracting compared to 3 months ago?
If expanding = supports LONG. If contracting = supports SHORT.

CHECK 2 — LAST ECONOMIC CALENDAR EVENT (The Direction):
Recent scheduled events:
${recentEvents}

Upcoming events:
${upcomingEvents}

Search for the ACTUAL RESULTS of the most recent events listed above. Go to the official sources:
- BLS.gov for CPI, PPI, NFP data
- BEA.gov for GDP data
- FederalReserve.gov for FOMC decisions

For each recent event, was the actual result:
- CPI/PPI: Actual BELOW forecast = cooling inflation = LONG. Actual ABOVE forecast = hot inflation = SHORT.
- NFP: Actual much ABOVE forecast = economy too hot, Fed stays hawkish = SHORT. Actual BELOW = economy cooling, Fed can cut = LONG.
- FOMC: Dovish language or rate cut = LONG. Hawkish language or rate hike = SHORT.
- GDP: Above forecast = LONG. Below forecast = SHORT.

CHECK 3 — UNKNOWN UNKNOWNS (Disruption Scanner):
Search for any breaking financial or geopolitical news from the past 4 hours that could disrupt markets. Look for:
- Geopolitical escalation (wars, sanctions, trade disputes)
- Surprise central bank actions
- Major corporate events (bank failures, earnings shocks)
- Oil/energy supply disruptions
- Bond market stress (30-year yield spiking)

Also check the three KILL SWITCHES:
1. Is the US 30-year Treasury yield above 5.5%? (Bond market revolt)
2. Is CPI trending above 5% with no signs of cooling? (Inflation spiral)
3. Is unemployment spiking above 5%? (Passive flow reversal)

PREVIOUS BIAS: ${previousBias}
PREVIOUS REASONING: ${previousReason}

NOW — Based on all three checks, respond with EXACTLY this JSON format and nothing else. No markdown, no backticks, no explanation outside the JSON:

{
    "bias": "LONG or SHORT or SIDELINES",
    "m2_status": "EXPANDING or CONTRACTING",
    "m2_detail": "one sentence about M2",
    "calendar_event": "name of most recent event",
    "calendar_result": "one sentence about the result and direction",
    "disruption": "CLEAR or DISRUPTED",
    "disruption_detail": "one sentence or 'No disruptions detected'",
    "kill_switches": {
        "bonds_30y_above_5_5": false,
        "cpi_above_5": false,
        "unemployment_above_5": false
    },
    "confidence": "HIGH or MEDIUM or LOW",
    "summary": "Two sentence summary of the overall macro picture and why the bias is what it is."
}`;
}

// ─── Call Claude API with web search ─────────────────────────────────────────
function callClaude(prompt) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            tools: [
                {
                    type: 'web_search_20250305',
                    name: 'web_search',
                }
            ],
            messages: [
                { role: 'user', content: prompt }
            ],
        });

        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            timeout: 120000, // 2 min timeout for web search
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(`API error: ${parsed.error.message}`));
                        return;
                    }
                    // Extract text from response content blocks
                    const textBlocks = (parsed.content || [])
                        .filter(b => b.type === 'text')
                        .map(b => b.text);
                    resolve(textBlocks.join('\n'));
                } catch (e) {
                    reject(new Error(`Parse error: ${e.message}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`Request error: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(body);
        req.end();
    });
}

// ─── Parse Claude's response ─────────────────────────────────────────────────
function parseResponse(text) {
    try {
        // Clean up any markdown formatting
        let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        
        // Claude often wraps JSON in explanation text — extract the JSON object
        const jsonStart = cleaned.indexOf('{');
        const jsonEnd = cleaned.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
        }
        
        const result = JSON.parse(cleaned);

        // Validate required fields
        if (!result.bias || !['LONG', 'SHORT', 'SIDELINES'].includes(result.bias)) {
            throw new Error(`Invalid bias: ${result.bias}`);
        }

        return result;
    } catch (e) {
        console.error(`[MACRO BOT] Failed to parse response: ${e.message}`);
        console.error(`[MACRO BOT] Raw response: ${text.slice(0, 500)}`);
        return null;
    }
}

// ─── Save bias to file ───────────────────────────────────────────────────────
function saveBias(bias) {
    bias.timestamp = new Date().toISOString();
    try {
        fs.writeFileSync(BIAS_FILE, JSON.stringify(bias, null, 2));
        console.log(`[MACRO BOT] Saved bias: ${bias.bias} (${bias.confidence})`);
    } catch (e) {
        console.error(`[MACRO BOT] Failed to save: ${e.message}`);
    }
}

// ─── Load previous bias ──────────────────────────────────────────────────────
function loadPreviousBias() {
    try {
        if (fs.existsSync(BIAS_FILE)) {
            return JSON.parse(fs.readFileSync(BIAS_FILE, 'utf8'));
        }
    } catch (e) { }
    return null;
}

// ─── Telegram ────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return Promise.resolve();
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
    return new Promise((resolve) => {
        const req = https.request(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 },
            (res) => { res.resume(); resolve(); }
        );
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ─── Main scan ───────────────────────────────────────────────────────────────
async function scan() {
    const now = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
    console.log(`\n[MACRO BOT] ═══ Scanning ${now} ═══`);

    try {
        const prompt = buildPrompt();
        console.log('[MACRO BOT] Calling Claude API with web search...');

        const response = await callClaude(prompt);
        const result = parseResponse(response);

        if (!result) {
            console.error('[MACRO BOT] Failed to get valid response, keeping previous bias');
            return;
        }

        // Check for bias change
        const previous = loadPreviousBias();
        const biasChanged = !previous || previous.bias !== result.bias;

        // Save new bias
        saveBias(result);

        // Log details
        console.log(`[MACRO BOT] M2: ${result.m2_status} — ${result.m2_detail}`);
        console.log(`[MACRO BOT] Calendar: ${result.calendar_event} — ${result.calendar_result}`);
        console.log(`[MACRO BOT] Disruption: ${result.disruption} — ${result.disruption_detail}`);
        console.log(`[MACRO BOT] Kill switches: Bonds=${result.kill_switches?.bonds_30y_above_5_5} CPI=${result.kill_switches?.cpi_above_5} Unemp=${result.kill_switches?.unemployment_above_5}`);
        console.log(`[MACRO BOT] ═══ BIAS: ${result.bias} (${result.confidence}) ═══`);

        // Telegram on bias change
        if (biasChanged) {
            const emoji = result.bias === 'LONG' ? '🟢' : result.bias === 'SHORT' ? '🔴' : '🟡';
            const prevEmoji = previous ? (previous.bias === 'LONG' ? '🟢' : previous.bias === 'SHORT' ? '🔴' : '🟡') : '⚪';
            await sendTelegram([
                `${emoji} *MACRO BIAS CHANGE: ${previous ? previous.bias : 'NONE'} → ${result.bias}*`,
                `Confidence: ${result.confidence}`,
                ``,
                `📊 *M2:* ${result.m2_status}`,
                `${result.m2_detail}`,
                ``,
                `📅 *Calendar:* ${result.calendar_event}`,
                `${result.calendar_result}`,
                ``,
                `⚡ *Disruptions:* ${result.disruption}`,
                `${result.disruption_detail}`,
                ``,
                `🔒 *Kill Switches:* ${Object.values(result.kill_switches || {}).some(v => v) ? '⚠️ ACTIVE' : '✅ All clear'}`,
                ``,
                `${result.summary}`,
            ].join('\n')).catch(() => { });
        }

        // Always send hourly status (brief)
        if (!biasChanged) {
            const emoji = result.bias === 'LONG' ? '🟢' : result.bias === 'SHORT' ? '🔴' : '🟡';
            // Only log to console, don't spam Telegram every hour
            // Uncomment below if you want hourly Telegram updates:
            await sendTelegram(`${emoji} Macro: ${result.bias} (${result.confidence}) — ${result.summary}`);
        }

    } catch (e) {
        console.error(`[MACRO BOT] Error: ${e.message}`);
        // Don't change bias on error — keep previous
    }
}

// ─── Startup ─────────────────────────────────────────────────────────────────
(async () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  PREDATOR MACRO BOT v1.0 — CLAUDE-POWERED ANALYST         ║');
    console.log('║  M2 + Calendar + Disruption Scanner                       ║');
    console.log('║  Writes macro_bias.json for Regime Engine                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  API Key:        ${ANTHROPIC_API_KEY ? '✅ Loaded' : '❌ Missing — set ANTHROPIC_API_KEY in .env'}`);
    console.log(`  Telegram:       ${TELEGRAM_TOKEN ? '✅ Loaded' : '❌ Missing'}`);
    console.log(`  Calendar:       ${calendarEvents.length} events loaded`);
    console.log(`  Scan Interval:  ${SCAN_INTERVAL / 1000 / 60} minutes`);
    console.log(`  Bias File:      ${BIAS_FILE}`);
    console.log('');

    if (!ANTHROPIC_API_KEY) {
        console.error('[MACRO BOT] ❌ No ANTHROPIC_API_KEY in .env — cannot start');
        console.error('[MACRO BOT] Get your key from https://console.anthropic.com');
        process.exit(1);
    }

    // Run immediately on startup
    await scan();

    // Then run every hour
    console.log(`[MACRO BOT] Next scan in ${SCAN_INTERVAL / 1000 / 60} minutes\n`);
    setInterval(async () => {
        try { await scan(); } catch (e) { console.error(`[MACRO BOT] Scan error: ${e.message}`); }
    }, SCAN_INTERVAL);
})().catch(err => {
    console.error(`[MACRO BOT] Fatal: ${err.message}`);
    console.error(err.stack);
});

process.on('unhandledRejection', (err) => console.error(`[MACRO BOT] Unhandled: ${err.message || err}`));
process.on('uncaughtException', (err) => { console.error(`[MACRO BOT] Uncaught: ${err.message}`); console.error(err.stack); });