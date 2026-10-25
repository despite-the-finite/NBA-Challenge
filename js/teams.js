// The 30 NBA teams. `espn` is the abbreviation ESPN uses in its API and logo CDN; `conf` is the
// conference (the NBA Cup groups and bracket are split by conference).
export const TEAMS = {
  ATL: { name: 'Hawks', city: 'Atlanta', espn: 'atl', color: '#C8102E', conf: 'East' },
  BOS: { name: 'Celtics', city: 'Boston', espn: 'bos', color: '#007A33', conf: 'East' },
  BKN: { name: 'Nets', city: 'Brooklyn', espn: 'bkn', color: '#3a3a3a', conf: 'East' },
  CHA: { name: 'Hornets', city: 'Charlotte', espn: 'cha', color: '#00788C', conf: 'East' },
  CHI: { name: 'Bulls', city: 'Chicago', espn: 'chi', color: '#CE1141', conf: 'East' },
  CLE: { name: 'Cavaliers', city: 'Cleveland', espn: 'cle', color: '#860038', conf: 'East' },
  DAL: { name: 'Mavericks', city: 'Dallas', espn: 'dal', color: '#00538C', conf: 'West' },
  DEN: { name: 'Nuggets', city: 'Denver', espn: 'den', color: '#FEC524', conf: 'West' },
  DET: { name: 'Pistons', city: 'Detroit', espn: 'det', color: '#1D42BA', conf: 'East' },
  GSW: { name: 'Warriors', city: 'Golden State', espn: 'gs', color: '#1D428A', conf: 'West' },
  HOU: { name: 'Rockets', city: 'Houston', espn: 'hou', color: '#CE1141', conf: 'West' },
  IND: { name: 'Pacers', city: 'Indiana', espn: 'ind', color: '#FDBB30', conf: 'East' },
  LAC: { name: 'Clippers', city: 'LA', espn: 'lac', color: '#C8102E', conf: 'West' },
  LAL: { name: 'Lakers', city: 'Los Angeles', espn: 'lal', color: '#552583', conf: 'West' },
  MEM: { name: 'Grizzlies', city: 'Memphis', espn: 'mem', color: '#5D76A9', conf: 'West' },
  MIA: { name: 'Heat', city: 'Miami', espn: 'mia', color: '#98002E', conf: 'East' },
  MIL: { name: 'Bucks', city: 'Milwaukee', espn: 'mil', color: '#00471B', conf: 'East' },
  MIN: { name: 'Timberwolves', city: 'Minnesota', espn: 'min', color: '#236192', conf: 'West' },
  NOP: { name: 'Pelicans', city: 'New Orleans', espn: 'no', color: '#85714D', conf: 'West' },
  NYK: { name: 'Knicks', city: 'New York', espn: 'ny', color: '#F58426', conf: 'East' },
  OKC: { name: 'Thunder', city: 'Oklahoma City', espn: 'okc', color: '#007AC1', conf: 'West' },
  ORL: { name: 'Magic', city: 'Orlando', espn: 'orl', color: '#0077C0', conf: 'East' },
  PHI: { name: '76ers', city: 'Philadelphia', espn: 'phi', color: '#006BB6', conf: 'East' },
  PHX: { name: 'Suns', city: 'Phoenix', espn: 'phx', color: '#E56020', conf: 'West' },
  POR: { name: 'Trail Blazers', city: 'Portland', espn: 'por', color: '#E03A3E', conf: 'West' },
  SAC: { name: 'Kings', city: 'Sacramento', espn: 'sac', color: '#5A2D81', conf: 'West' },
  SAS: { name: 'Spurs', city: 'San Antonio', espn: 'sa', color: '#8a8d90', conf: 'West' },
  TOR: { name: 'Raptors', city: 'Toronto', espn: 'tor', color: '#CE1141', conf: 'East' },
  UTA: { name: 'Jazz', city: 'Utah', espn: 'utah', color: '#002B5C', conf: 'West' },
  WAS: { name: 'Wizards', city: 'Washington', espn: 'wsh', color: '#002B5C', conf: 'East' },
};

export const ESPN_TO_CODE = Object.fromEntries(Object.entries(TEAMS).map(([code, t]) => [t.espn.toUpperCase(), code]));

export function teamLogo(code) {
  const t = TEAMS[code];
  return t ? `https://a.espncdn.com/i/teamlogos/nba/500/${t.espn}.png` : '';
}

export function teamName(code, style = 'short') {
  const t = TEAMS[code];
  if (!t) return code || '—';
  return style === 'full' ? `${t.city} ${t.name}` : t.name;
}
