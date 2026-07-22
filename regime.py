import json
from datetime import datetime, timedelta

d = json.load(open('/root/predator-hunt/regime_history.json'))
today = (datetime.utcnow() + timedelta(hours=10)).strftime('%Y-%m-%d')

print(f'=== REGIME CHANGES {today} (QLD TIME) ===')
count = 0
for r in d['regime_changes']:
    utc = datetime.strptime(r['timestamp'][:19], '%Y-%m-%dT%H:%M:%S')
    qld = utc + timedelta(hours=10)
    if qld.strftime('%Y-%m-%d') != today:
        continue
    count += 1
    emoji = '🟢' if r['to'] == 'LONG' else '🔴' if r['to'] == 'SHORT' else '⚪'
    print(f'  {qld.strftime("%I:%M %p")} | {emoji} {r["from"]} → {r["to"]}')
    print(f'    H4: {r["h4"]} | H1: {r["h1_consecutive"]} scans')
    print(f'    Liq: {r["liq_pct"]:.1f}% | Vol Δ: {r["liq_vol_magnitude"]:.3f}')
    print(f'    Corr: {r["correlation"]*100:.0f}% | ETH ${r["eth_price"]:.0f} | NQ {r["nq_price"]}')
    print()

if count == 0:
    print('  No regime changes today')
