#!/usr/bin/env python3
"""Build the app's data files from the 2024-25 spreadsheet.

Usage: python3 tools/prep_data.py path/to/24-25_NBA.xlsx

Writes:
  data/season-2024-25.json   last season's picks and results (the "Last season" tab)
  data/sample-schedule.json  a sample 2026-27 slate (24-25 matchups shifted 104 weeks)
                             used only in demo mode; live mode pulls the real schedule
"""
import json, re, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import openpyxl

TEAMS = {
 'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN','Charlotte Hornets':'CHA',
 'Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE','Dallas Mavericks':'DAL','Denver Nuggets':'DEN',
 'Detroit Pistons':'DET','Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
 'Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM','Miami Heat':'MIA',
 'Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN','New Orleans Pelicans':'NOP','New York Knicks':'NYK',
 'Oklahoma City Thunder':'OKC','Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX',
 'Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS','Toronto Raptors':'TOR',
 'Utah Jazz':'UTA','Washington Wizards':'WAS',
}
ET = ZoneInfo('America/New_York')

def parse_dt(date_str, time_str):
    d = datetime.strptime(date_str, '%a, %b %d, %Y')
    m = re.match(r'(\d+):(\d+)([ap])', time_str)
    h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3)
    if ap == 'p' and h != 12: h += 12
    if ap == 'a' and h == 12: h = 0
    return d.replace(hour=h, minute=mi, tzinfo=ET)

def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb['Regular Season']
    games, history = [], []
    for r in ws.iter_rows(min_row=3, values_only=True):
        date, start, away, home, arena, note, sel, line, ou, up_team, kp_team, winner, margin, up_pts, kp_pts = r[:15]
        if not away or away not in TEAMS: continue
        tip = parse_dt(date, start)
        g = {'date': tip.strftime('%Y-%m-%d'), 'tipoff': tip.isoformat(), 'away': TEAMS[away], 'home': TEAMS[home],
             'arena': arena, 'cup': bool(note and 'Tournament' in note)}
        games.append(g)
        if winner and sel in ('UP', 'KP'):
            history.append({**g, 'selector': sel, 'line': line, 'ou': ou,
                            'picks': {'UP': TEAMS.get(up_team), 'KP': TEAMS.get(kp_team)},
                            'winner': TEAMS[winner], 'margin': margin,
                            'points': {'UP': up_pts or 0, 'KP': kp_pts or 0}})
    history.sort(key=lambda g: g['tipoff'])
    totals = {'UP': sum(h['points']['UP'] for h in history), 'KP': sum(h['points']['KP'] for h in history)}
    out = {'season': '2024-25', 'players': {'UP': 'UP', 'KP': 'KP'}, 'totals': totals,
           'games_scored': len(history), 'games': history}
    json.dump(out, open('data/season-2024-25.json', 'w'), separators=(',', ':'))
    print('24-25 history:', len(history), 'games', totals)

    # Sample 2026-27 schedule: shift every 24-25 game forward 104 weeks (keeps weekdays).
    shift = timedelta(weeks=104)
    sample = []
    for g in games:
        tip = datetime.fromisoformat(g['tipoff']).astimezone(ET)
        local = tip.replace(tzinfo=None) + shift
        tip2 = local.replace(tzinfo=ET)
        sample.append({'id': f"demo:{tip2.strftime('%Y%m%d')}-{g['away']}-{g['home']}", 'date': tip2.strftime('%Y-%m-%d'),
                       'tipoff': tip2.isoformat(), 'away': g['away'], 'home': g['home'], 'arena': g['arena'], 'cup': g['cup']})
    sample.sort(key=lambda g: g['tipoff'])
    json.dump({'note': 'SAMPLE schedule for demo mode: 2024-25 matchups shifted 104 weeks. Live mode replaces this with the real 2026-27 schedule.',
               'games': sample}, open('data/sample-schedule.json', 'w'), separators=(',', ':'))
    print('sample schedule:', len(sample), 'games', sample[0]['date'], '->', sample[-1]['date'])

if __name__ == '__main__':
    main(sys.argv[1])
