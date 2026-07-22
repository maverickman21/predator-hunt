import json
from datetime import datetime, timedelta

d = json.load(open('/root/predator-hunt/regime_history.json'))
today = (datetime.utcnow() + timedelta(hours=10)).strftime('%Y-%m-%d')

print(f'=== CLUSTERS {today} (QLD TIME) ===')
for e in d['eth_events']:
    utc = datetime.strptime(e['timestamp'][:19], '%Y-%m-%dT%H:%M:%S')
    qld = utc + timedelta(hours=10)
    if qld.strftime('%Y-%m-%d') != today:
        continue
    arrow = '⬆️' if e['direction'] == 'UP' else '⬇️'
    print(f'  {qld.strftime("%I:%M %p")} | {arrow} {e["direction"]:4} | ETH ${e["eth_price"]:.0f} | NQ {e["nq_price"]} | {e["pairs"]}p | {e["regime"]}')
