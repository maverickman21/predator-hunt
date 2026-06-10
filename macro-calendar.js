// ─── MACRO ECONOMIC CALENDAR MODULE ──────────────────────────────────────────
// Reads economic-calendar.json and provides:
//  - isMacroEventDay() — is today a high-impact event day?
//  - getTodayEvents() — list of today's events with times
//  - getNextEvent() — nearest upcoming event
//  - checkAndAlert() — send Telegram warning before event
//
// All times internally in UTC. Converts to Brisbane (UTC+10) for display.
// Event times in JSON are US Eastern (UTC-4 for EDT, UTC-5 for EST).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const CALENDAR_FILE = path.join(__dirname, 'economic-calendar.json');
let calendar = { events: [] };
let lastAlertDate = '';  // prevent duplicate daily alerts

// Load calendar
function load() {
    try {
        if (fs.existsSync(CALENDAR_FILE)) {
            calendar = JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
            console.log(`  [MACRO] Loaded ${calendar.events.length} economic events`);
        } else {
            console.log('  [MACRO] No economic-calendar.json found');
        }
    } catch (e) {
        console.log(`  [MACRO] Error loading calendar: ${e.message}`);
    }
}

// Parse event date + time into UTC Date
// Event times are US Eastern — currently EDT (UTC-4)
function parseEventTime(event) {
    const [year, month, day] = event.date.split('-').map(Number);
    const [hour, min] = event.time.split(':').map(Number);
    // EDT offset = -4 hours from UTC
    const utc = new Date(Date.UTC(year, month - 1, day, hour + 4, min));
    return utc;
}

// Get today's date in US Eastern time (for matching event dates)
function getTodayET() {
    const now = new Date();
    // Convert UTC to ET by subtracting 4 hours (EDT)
    const et = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    return et.toISOString().slice(0, 10);
}

// Get today's events
function getTodayEvents() {
    const today = getTodayET();
    return calendar.events.filter(e => e.date === today);
}

// Is today a macro event day?
function isMacroEventDay() {
    return getTodayEvents().length > 0;
}

// Get the next upcoming event (within 24 hours)
function getNextEvent() {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    for (const event of calendar.events) {
        const eventTime = parseEventTime(event).getTime();
        const diff = eventTime - now;
        if (diff > 0 && diff < dayMs) {
            return {
                ...event,
                utcTime: new Date(eventTime),
                hoursAway: (diff / (60 * 60 * 1000)).toFixed(1),
                brisbaneTime: new Date(eventTime + 10 * 60 * 60 * 1000)
                    .toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: true }),
            };
        }
    }
    return null;
}

// Get event happening RIGHT NOW (within 5 minutes of release)
function getActiveEvent() {
    const now = Date.now();
    for (const event of calendar.events) {
        const eventTime = parseEventTime(event).getTime();
        const diff = Math.abs(now - eventTime);
        if (diff < 5 * 60 * 1000) { // within 5 minutes
            return event;
        }
    }
    return null;
}

// Check and return alert message if macro event day
// Called once per pillar snapshot — sends daily warning
function checkAndAlert(sendTelegram) {
    const today = getTodayET();
    if (today === lastAlertDate) return null; // already alerted today

    const events = getTodayEvents();
    if (events.length === 0) return null;

    lastAlertDate = today;

    const lines = events.map(e => {
        const brisTime = parseEventTime(e);
        const timeStr = brisTime.toLocaleTimeString('en-AU', {
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: 'Australia/Brisbane'
        });
        return `  📅 ${e.event} — ${e.name} @ ${e.time} ET (${timeStr} AEST)`;
    });

    const msg = [
        `⚠️ *MACRO EVENT DAY*`,
        `Correlation may break — blockchain signals unreliable for NQ`,
        ``,
        ...lines,
        ``,
        `Rule: Watch for actual vs forecast. Direction = surprise direction.`,
    ].join('\n');

    if (sendTelegram) {
        sendTelegram(msg).catch(() => { });
    }

    console.log(`\n  [MACRO] ⚠️ EVENT DAY: ${events.map(e => e.event).join(', ')}`);

    return { isMacroDay: true, events };
}

// Get macro context for regime engine
// Returns object with macro awareness for current state
function getMacroContext() {
    const events = getTodayEvents();
    const nextEvent = getNextEvent();
    const activeEvent = getActiveEvent();

    return {
        isMacroDay: events.length > 0,
        events,
        nextEvent,
        activeEvent,
        eventCount: events.length,
        // Summary for logs
        summary: events.length > 0
            ? `MACRO DAY: ${events.map(e => e.event).join(', ')}`
            : 'No macro events',
    };
}

// Initialize
load();

module.exports = {
    load,
    isMacroEventDay,
    getTodayEvents,
    getNextEvent,
    getActiveEvent,
    checkAndAlert,
    getMacroContext,
};
