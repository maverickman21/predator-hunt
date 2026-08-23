# PREDATOR HUNT — TRADING DIARY (v2, ratified board #1, 2026-08-21)
*Active memory. Read by the morning bot and Q&A on every call. Superseded/answered material lives in ledger-archive-2026-08.md (never loaded into prompts).*
*Constitution ratified 2026-07-19. Amendment only by: ledger evidence → board → sweep → re-ratify. Next board: 18 Sept 2026.*

## THESIS
"Whose tank is full?" Funding marks the crowded side; the crowd is fuel; sustained moves burn the majority.
**Gate** (funding rank: instant P95 + sign guard, or latch = P92 visit within 24 NQ-hours + draining + smoke ≥P80) → **Trigger** (unanimous three-sign vote — OI-contracts + CVD delta + liq side — at announcement size: thumb ≥0.90 of 90min AND floor ≥0.60 of 24 NQ-hours) → **Envelope** (what a mistake costs).
Sit-outs are the product. Adaptive units, frozen rules. **Coin-denominated OI only** for direction; USD OI is the price echo.
Asymmetric vote by design: SHORT needs *destruction* (cascades self-sustain); LONG needs *creation* (squeezes need new money or they're hollow).

## LIVE CONFIG (from 2026-08-24 — live capital)
Mode=Live · 1 micro MNQ · **PT 2000 / SL 300** · UseFlatByTime=FALSE (session-close backstop) · **NoNewEntriesAfterQldHour=0** (provisional, graded 18 Sept) · StandDownAfterTarget=ON · bells SHADOW.
Blackout 05:00–08:00 Qld (digest-enforced). Trading day = 08:00→07:00 Qld.
**PAUSE-AND-REVIEW TRIGGER: −1,500 ticks from equity peak OR 5 consecutive losses** → stop, re-run sweep, check plumbing, resume deliberately.

## RECORD
Sim month (27 Jul – 20 Aug): **12 trades, 5W–7L (41.7%), +4,699 ticks**, PF 3.24, avg win 1,360 / avg loss 300 (4.53:1), max drawdown 1,061.
Wide backtest (6 Jul – 20 Aug, 26 trades, one config): **+9,983 ticks**, PF ~3.0. With sit-downs + clock cutoff applied: ≈ **+11,779**, 16 trades, 50%.

## BOARD #1 VERDICTS — tested and buried
- **Fuel gauge / burn-phase: REJECTED.** Every threshold destroyed value on both samples (−927 to −8,805; killed up to 7 winners incl. four 2,000t harvests). Phase does not predict: winners at 0%, 19%, 43%, 53%, 68%, 77% drained; losers across the same range. **Do not resurrect without a new mechanism.**
- **Liquidation-coherence (3h crowd-side smoke): REJECTED.** +900 on 12 trades, −172 on 26. Small-sample coincidence, caught before shipping.
- **Rank clauses (thumb/floor minimums): REJECTED** (−2,258, −1,014). All combinations worse than their parts — complexity penalty confirmed twice.
- **Envelope CONFIRMED unchanged:** PT 2000 (lowering to 1500 costs 661t — July's harvests need the full target); SL 300 (worst surviving winner drew down 246 — do not tighten below ~275); session-close backstop is the de facto regime-adaptive harvester (+139 / +1,388 / +1,272 in the desert with no rule change).
- **Clock cutoff ADOPTED provisionally** (00:00–08:00 blocked): +1,188 in wide sweep; every graveyard-hours entry in the live era stopped.
- **SIT-DOWN DOCTRINE = highest-value discipline, measured at +877 ticks** (the backtest traded NFP/CPI/PPI and lost exactly that on those five trades).

## OPEN QUESTIONS (live research — no code until evidence + board)
1. **Duty cycle** — what governs harvest weeks vs desert weeks? (a) macro event-density, (b) chronic war/uncertainty fog, (c) endogenous cycle (harvests liquidate the crowd; craters refill slowly), (d) seasonality (thin August books, US congressional recess). 6–12 month timescale; tags already accumulating.
2. **Long-side weakness** — 1W–4L on longs across both samples; every harvest has been a short. Consistent with structural long-bias. **Untested exposure if macro flips to a true bear regime.**
3. **Tier-two annex** — small targets (300–500t) on contested-tank moves; includes the "fuel-less monster print" class (announcement-grade creation with no tank; Aug 4 ran 3–4,000t). Tag and measure for months before any charter.
4. **Exit chain** — bells shadow until ~20 specimens. Bell C candidate (funding crosses zero against position → flat). Counter-evidence on file: Jul 28 false-alarm exhibit, where the unanimous tell-stack was wrong and envelope patience beat every proposed exit by 1,200–1,700t.
5. **Bybit / 24-7 book** — the same edge with the session constraint deleted. Value is regime-conditional (~zero in deserts, real in harvest weather). Gated by capital and overnight margin.
6. **Pyramiding** — one-shot rule holds. Tag suppressed add-fires and their counterfactuals before any hearing.

## FIELD GUIDE
- **THE OVERLAP** — fuel + announcement + session window. The seed planter. All three must align.
- **HOLLOW RALLY** (unowned float) — price trends up *while funding drains*: covering + harvesting = evacuation. Candles say demand, plumbing says departure. Never a harvestable burn.
- **SINGLE-LEG ARC** — full pin → near-zero drain: tank non-reloadable within that arc.
- **BREATHING ARC** — partial drain then re-inhale: tank structurally intact, retains spring.
- **VACUUM / DRAINED** — funding near zero, no crowd either side. Micro-negatives in a positive-dominant window can arm LONG falsely; contracts-veto usually holds (failed once, Aug 14, −300).
- **THE LAST SQUEEZE** — final short-covering wave (green candles + short liqs) fizzling on no remaining fuel: marks the exhaustion top.
- **PIN-SHADOW** — a full cap-pin raises the 14d P95 bar for ~2 weeks behind it; the latch's 24h memory is the designed compensation.
- **ARM-KISS** — gate arms briefly, no qualifying episode. Costs nothing. Bot cannot see arms; the panel is truth.
- **CONTRACTION REGIME** — ranges compress to ~1,000–1,500t, OI book shrinks, funding can't hold loads. The desert.
- **BURN vs EVACUATION texture** — drains with victims vs authored/silent drains. Failed as a coded filter; remains a reading aid.
- **VELOCITY** — time in market is risk. Burn-texture moves complete fast (2,000t in ~2hrs vs 16hr grinds).

## STANDING RULES (bot + operator)
- **All times in Qld (UTC+10).** Convert from ts_utc before narrating; state both if ambiguous; compute day-of-week from the Qld date.
- **Liq-side reading:** for a SHORT position/arm — SHORT liqs = the squeeze that LOADED the tank; LONG liqs = the burn we're waiting for. Mirror for LONGs.
- **executions.csv outranks replay fires** for the live record. Match across UTC/Qld before declaring a fire unfilled. Never re-report a graded fire as new.
- **Panel-witnessed gate state outranks bot inference**, in both directions.
- **The bot cannot see its own logs, code or scheduler.** Ops questions go to pm2; its ops diagnoses are confabulation.
- **Points vs ticks:** MNQ trades in quarter-point ticks (347 points = 1,388 ticks). Check before reporting P&L.
- **Replays are a noisy proxy** — 5-minute grid vs the live 60-second digest; with a 300t stop this flips outcomes (cost ~2,300t on one July trade). The live record is superior evidence.
- **Standing macro watch** (report daily until retired): Iran/Hormuz · Yen/JGB carry-unwind · 30y vs the 5.5% kill switch.
- **Kill-switch definitions:** the inflation switch keys on **headline CPI YoY**, not the GDP-embedded PCE deflator.
- **Calendar expires 23 Dec 2026** — top up at the December board or January opens blind.

## OPERATOR DOCTRINE
- **200-trade frame:** one trade ≈ 0.5% of a year's edge. Release outcomes.
- **Decision vs outcome (Duke):** legislate against decision errors, never against bad luck.
- **Opportunity cost is invisible and unbounded; stops are visible and bounded.** Count both columns.
- **"I need to make fewer decisions"** — every filter's true yield is decision-surface reduction.
- **Delete doctrine:** the answer is usually deletion. The system shrank under testing.
- **Yautja code:** hunt alone, study the prey, strike once, worthy quarry only, return each cycle with new tech.

## OPERATOR NOTES (inbox — appended via Telegram "ledger:")
- [2026-08-22 08:34 Qld] SIT-DOWN condition (c) CORRECTED — kill-switch PROXIMITY is not a sit-down trigger. The 30y has sat 5.18-5.33% for three weeks; a 5.2% trigger makes the verdict permanently YES and destroys its signal value (cry-wolf). Replace (c) with: sit down only if a kill switch is BREACHED (30y >5.5%, headline CPI YoY >5%, unemployment >5%) OR a kill-switch input moves >15bp in 24h (dislocation, not level). Conditions (a) Tier A within 12h, (b) Tier B within 12h, (d) fresh escalation within 24h are unchanged. Elevated-but-stable macro is CONTEXT, not a blocker.
- [2026-08-23 07:41 Qld] [bot-suggested, operator-ratified] 38-print exchange-cap pin (0.01000, 22–23 Aug Qld) with gate rank at 0.829 — confirms that a sustained cap-pin does not automatically push rank to P95 within a 14-day window when prior prints were lower; tank is full but gate stays dark, adding a clean specimen of 'fuel without a gate' in a contraction/desert regime.
- [2026-08-23 07:43 Qld] PIN-SHADOW PARADOX (23 Aug) — funding pinned at the EXCHANGE CAP (0.01000, 38 consecutive prints, zero variance) yet rank only 0.829: when a fortnight is dominated by cap-prints, being at the maximum possible value is no longer top-5% of its own window. Percentile machinery's one structural blind spot — you cannot rank above a ceiling you are already pinned to. Consequence: latch is the only available door in cap-pinned regimes. BOARD #2 CANDIDATE (do not code now): should the existing SATURATED flag constitute an arm independent of rank? Mechanism-derived (a capped tank is by definition maximally crowded), addresses a demonstrated blind spot rather than an imagined one. Test against the wide sample at board #2.
