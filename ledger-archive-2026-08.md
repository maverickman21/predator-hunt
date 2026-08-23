# PREDATOR HUNT — ARCHIVE: JULY–AUGUST 2026 (sim month + board #1)
*Evidentiary record. NOT loaded into bot prompts. Read at board meetings.*

## THE 12 LIVE SIM TRADES (27 Jul – 20 Aug 2026, Sim101, 1 micro MNQ)
| # | Side | Entry Qld | Entry | Exit | Ticks | MAE | MFE | Exit type |
|---|------|-----------|-------|------|-------|-----|-----|-----------|
| 1 | Short | 27-07 11:39 | 28607.25 | 28682.25 | −300 | 302 | 141 | stop |
| 2 | Short | 27-07 22:42 | 28665.00 | 28164.75 | **+2001** | 151 | 2001 | target |
| 3 | Short | 28-07 00:39 | 28039.25 | 28114.25 | −300 | 301 | 403 | stop |
| 4 | Short | 28-07 08:42 | 28135.50 | 27635.50 | **+2000** | 238 | 2022 | target |
| 5 | Short | 03-08 08:42 | 28608.00 | 28683.00 | −300 | 345 | 286 | stop |
| 6 | Short | 08-08 03:05 | 29744.00 | 29819.00 | −300 | 305 | 269 | stop |
| 7 | Short | 10-08 10:35 | 29852.25 | 29927.25 | −300 | 301 | 257 | stop |
| 8 | Short | 11-08 01:05 | 29801.00 | 29766.25 | +139 | 231 | 313 | session close |
| 9 | Long | 14-08 23:33 | 30228.50 | 30153.50 | −300 | 300 | 209 | stop |
| 10 | Short | 18-08 12:59 | 29908.25 | 29561.25 | **+1388** | 78 | 1577 | session close |
| 11 | Short | 20-08 08:10 | 29606.75 | 29682.00 | −301 | 302 | 64 | stop |
| 12 | Short | 20-08 13:15 | 29625.25 | 29307.25 | **+1272** | 246 | 1691 | session close |

**Totals:** 12 trades, 5W–7L (41.7%), **+4,699 ticks / $2,349.50**. PF 3.24 · Sharpe 1.04 · avg win 1,360 · avg loss −300 · ratio 4.53 · max DD −1,061 · max consec losses 3 · avg time in market 386 min · avg MAE 258 / MFE 769 / ETD 378.

## BOARD #1 SWEEP RESULTS
**Sample A — 12 live trades. Sample B — 26 trades** (24 from the wide backtest Jul 6–Aug 18 under one config + 2 live from Aug 20; baseline +9,983).

| Clause | Sample A (12) | Sample B (26) | Verdict |
|--------|---------------|---------------|---------|
| Burn-phase >60% drained | −927, kills 2 | −1,558, kills 3 | REJECTED |
| Burn-phase >50% | −627, kills 2 | −3,554, kills 4 | REJECTED |
| Burn-phase >40% | −4,628, kills 4 | −8,805, kills 7 | REJECTED |
| Max-rank (thumb ≥0.99) | −810, kills 2 | −2,258, kills 4 | REJECTED |
| Floor ≥0.90 | −371, kills 1 | −1,014, kills 2 | REJECTED |
| Texture ≥$1M crowd-side 3h | **+900, kills 0** | **−172, kills 1** | REJECTED (small-sample) |
| Texture ≥$5M | −4,028 | −9,931 | REJECTED |
| **Clock: no 00:00–04:00** | +461 | **+1,188** | **ADOPTED (provisional)** |
| Max-rank + burn-phase | −1,598 | −4,127 | REJECTED |
| Max-rank + texture | +90 | −2,734 | REJECTED |
| Max-rank + clock | −210 | −1,042 | REJECTED |

**Phase vs outcome (sample B):** winners at 0%, 19%, 43%, 45%, 47%, 53%, 68%, 77%, 92% drained; losers at 0%, 3%, 20%, 29%, 35%, 41%, 63%, 67%, 69%, 70%, 78%, 78%, 80%. **No sorting power.**

**Sit-down value:** the backtest traded through NFP night and both sides of CPI/PPI (trades #15, #19, #20, #21, #22) for a combined **−877 ticks**. The operator's manual Tier-A/B sit-downs were worth **+877** over the era.

**Envelope validation:** target 1,500 = −661 vs actual (caps both July harvests); target 1,200 = −1,861. Stop: worst *surviving* winner MAE = 246, so any stop below ~275 kills a 1,272t winner.

## OPS INCIDENTS
1. **Gamma crash-loop (13 Aug).** V8 heap ceiling (480MB default) hit by slow steady-state leak + 56MB chain-file boot parse; ~2,800 restarts 04:00–14:50 Qld. Zero data lost (sidecar kept banking; 45-snapshot backlog reprocessed on recovery). Fix: 700MB heap + Sunday 05:00 cron restart. Root fix (stream boot parse, leak hunt) still queued.
2. **Chain fetch gap (18 Aug, 19:07–20:22 Qld).** Six consecutive `FETCH FAILED: bad payload — snapshot skipped`, self-recovered. Upstream Deribit issue; sidecar behaved correctly (validated, refused to write garbage, kept schedule). Queued: `chain_gaps_24h` + gamma-staleness lines in the brief.
3. **Replay liq-window bug (21 Aug — the big one).** `loadLiqs(Math.min(days, 30))` capped liquidation loading at 30 days *from the wall clock*, so any replay of dates older than 30 days silently loaded zero liqs → smoke test always failed → **every historical latch fire vanished**. Symptom: July 6–21 produced 19 fires in July and 0 in August. Found because the operator asked "can we test this over a wider bracket?" Fixed by anchoring the liq window to the replay range (`from − 10 days`); July 6–21 then reproduced bit-for-bit. **The live path was never affected.**
4. **Telegram Markdown failures.** Underscore-bearing notes (`ts_utc`, `digest_fires.csv`) silently failed to send confirmations while the appends succeeded. Fixed with plaintext fallback.
5. **OOM (24 Jul).** Zero swap on a 961MB droplet; 2GB swapfile installed; restart counters frozen since.

## SUPERSEDED HYPOTHESES (kept so they aren't re-invented)
- **Conviction ladder** (0–40% full throttle / 40–60% modest gear / >60% sit down) — dead with the fuel gauge.
- **Gearbox targets scaled to regime** — unnecessary; the session-close backstop already performs regime-adaptive harvesting.
- **Refuel-check clause** (funding rising during drain) — rejected at proposal: unknowable at entry, hindsight-only.
- **Vacuum clause** (rank negatives against negatives) — held as a stamp, never coded; sample-dependent by construction and would need to span a regime change to calibrate. Realised cost of the flaw to date: one −300 stop.
- **Max-pain gravity, whale-tracking, Duke-Score continuous conviction** — all deleted pre-constitution.

## KEY SPECIMENS (narrative, for pattern recall)
- **Jul 27–29 double harvest:** saturated 0.0100 pin → pre-burn entry stopped (−304) → re-armed → 22:42 latch entry at ~36% drained → **+2,001 target hit at 00:25 while the operator slept**; next session 08:42 → **+2,000**. The system's proof of concept.
- **Aug 8 NFP night:** crowd pinned the cap *into* the print (thesis: jobs data doesn't reprice big books). Shock (−23K vs +80K) ignited the burn on schedule; second-order rate-cut bid caused the whipsaw. Era-record print (−17,867 contracts, thumb 1.0/floor 1.0) fired at 00:10 — **the backtest shows it stopped in 9 minutes.** Sit-down vindicated.
- **Aug 14 PPI night:** second era-record print (−17,867 / −$478M, ranks 1.0/1.0) at 02:40 — audited as a −320 whipsaw stop. Sit-down invoice #2 dissolved.
- **Aug 18:** first live win of the desert (+1,388) at 55% drained with 443 liq events — the specimen that first dented the burn-phase law.
- **Aug 20:** two fires, same tank, same hour, both pre-burn zero-drain: thumb 0.944 stopped (−301), thumb 1.0 paid (+1,272). Looked like a controlled experiment; the wide sweep showed it was noise.
- **Jul 28 false-alarm exhibit:** Bell C crossing + opposite-side FIRE + put-wall migration + treacle all fired against an open short. Envelope patience beat every proposed exit by 1,200–1,700 ticks.
- **April hearing (Apr–May archive):** frozen July rules replayed over an inverted regime (negative extremes to −0.0183, LONG-armed 500–630 min/day) read it correctly with signs flipped. Two-regime, two-polarity validation. **April 14 = Deadlock Exhibit A** (funding pinned 0.0062→0.0100 long-crowded, market popped long anyway).

## MACRO CONTEXT OF THE ERA (Aug 2026)
Hawkish FOMC hold 9-3 (three hike dissents, Warsh no guidance) · Q2 GDP +1.5% vs 2.1% · NFP −23K vs +80K with 103K revisions · CPI 3.4% inline · PPI 0.0% vs +0.2% · 30y UST to a 19-year high ~5.33% · Hormuz closed 166+ days · yen to ~164 then a record joint US–Japan intervention (~$59bn + ~$34bn) with FIMA repo used to avoid Japanese UST selling · US congressional recess · thin summer books. Result: the contraction regime — ranges compressing from 3,300t to 1,000t, OI book shrinking, funding unable to hold loads.
