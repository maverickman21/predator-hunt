// Run with: node /root/predator-hunt/fix_deribit_expiry.js

const fs = require('fs');
const filePath = '/root/predator-hunt/ETHERIUM-PREDATOR-V2.js';
let code = fs.readFileSync(filePath, 'utf8');

const oldExpiry = `        // Find nearest expiry with meaningful OI
        const expiries = [...new Set(options.map(o => o.expiry))];
        // Sort expiries — they look like "2APR26", "4APR26", "25APR26"
        // Pick the nearest one with at least 20 options
        let bestExpiry = null;
        for (const exp of expiries) {
            const count = options.filter(o => o.expiry === exp).length;
            if (count >= 10) { bestExpiry = exp; break; }
        }
        if (!bestExpiry) bestExpiry = expiries[0];`;

const newExpiry = `        // Find nearest expiry with meaningful OI — prefer within 14 days
        const expiries = [...new Set(options.map(o => o.expiry))];
        
        // Parse expiry strings like "2APR26" or "25SEP26" into dates
        const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
        function parseExpiry(exp) {
            const match = exp.match(/^(\\d{1,2})([A-Z]{3})(\\d{2})$/);
            if (!match) return new Date(9999,0,1);
            const day = parseInt(match[1]);
            const mon = months[match[2]];
            const year = 2000 + parseInt(match[3]);
            return new Date(year, mon !== undefined ? mon : 0, day);
        }
        
        // Sort expiries by date (nearest first)
        const sortedExpiries = expiries
            .map(exp => ({ exp, date: parseExpiry(exp) }))
            .sort((a, b) => a.date - b.date);
        
        const now = new Date();
        const fourteenDays = 14 * 24 * 60 * 60 * 1000;
        
        // First try: nearest expiry within 14 days with at least 10 options
        let bestExpiry = null;
        for (const { exp, date } of sortedExpiries) {
            if (date.getTime() - now.getTime() > fourteenDays) break;
            if (date.getTime() < now.getTime()) continue; // skip expired
            const count = options.filter(o => o.expiry === exp).length;
            if (count >= 10) { bestExpiry = exp; break; }
        }
        
        // Fallback: nearest expiry with at least 10 options (any timeframe)
        if (!bestExpiry) {
            for (const { exp, date } of sortedExpiries) {
                if (date.getTime() < now.getTime()) continue;
                const count = options.filter(o => o.expiry === exp).length;
                if (count >= 10) { bestExpiry = exp; break; }
            }
        }
        if (!bestExpiry) bestExpiry = sortedExpiries[0] ? sortedExpiries[0].exp : expiries[0];`;

if (code.includes('Pick the nearest one with at least 20 options')) {
    code = code.replace(oldExpiry, newExpiry);
    fs.writeFileSync(filePath, code);
    console.log('DERIBIT EXPIRY PATCHED — now prefers nearest weekly within 14 days');
} else {
    console.log('Code not found — may already be patched or changed');
}