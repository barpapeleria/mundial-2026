/* ============================================================
   Mundial 2026 · Backend en tiempo real (SSE)
   ------------------------------------------------------------
   - Hace de proxy contra football-data.org (la API key NUNCA
     llega al navegador).
   - Sondea la API cada POLL_MS, normaliza la respuesta a un
     "snapshot" y lo empuja a los clientes por Server-Sent Events.
   - Detecta goles comparando marcadores entre sondeos y emite
     un evento 'goal' aparte (para los toasts en vivo).
   - Si no hay token o la API falla, no rompe: el cliente
     cae a la simulacion solo.
   ============================================================ */
'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');

const PORT    = process.env.PORT || 3000;
const TOKEN   = (process.env.FOOTBALL_DATA_TOKEN || '').trim();
const COMP    = (process.env.COMPETITION || 'WC').trim();
const POLL_MS = Math.max(15000, +(process.env.POLL_MS || 20000));
const API     = 'https://api.football-data.org/v4';

const app = express();

const ALLOWED_ORIGINS = new Set([
  'https://bar-papeleria-mundial-2026.netlify.app',
  'https://bar-papeleria.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- estado del servidor ---------- */
let clients = [];
let lastSnapshot = null;
let lastScores = {};      // matchId -> "home-away"
let matchClockState = {}; // matchId -> { lastStatus, secondHalfStartedAt }

/* ---------- SSE ---------- */
function send(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  clients.forEach(c => { try { send(c, event, data); } catch (_) {} });
}

app.get('/events', (req, res) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  clients.push(res);

  send(res, 'hello', { hasToken: !!TOKEN, competition: COMP, pollMs: POLL_MS });
  if (lastSnapshot) send(res, 'snapshot', lastSnapshot);

  const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(ka);
    clients = clients.filter(c => c !== res);
  });
});

app.get('/health', (_req, res) => res.json({
  ok: true, hasToken: !!TOKEN, clients: clients.length, lastSnapshot: !!lastSnapshot,
}));

/* ============================================================
   Llamadas a la API (resilientes: una falla no tumba al resto)
   ============================================================ */
/* football-data.org free tier: 10 req/min. Leemos los headers que el
   propio proveedor recomienda mirar para no chocar con el limitador. */
let rate = { remaining: 10, reset: 60 };
async function apiGetSafe(pathname) {
  if (!TOKEN) return null;
  try {
    const r = await fetch(`${API}/${pathname}`, { headers: { 'X-Auth-Token': TOKEN } });
    const rem = r.headers.get('X-Requests-Available-Minute');
    const rst = r.headers.get('X-RequestCounter-Reset');
    if (rem != null) rate.remaining = +rem;
    if (rst != null) rate.reset = +rst;
    if (r.status === 429) { console.warn(`[api] 429 rate-limited; reinicia en ${rate.reset}s`); return null; }
    if (!r.ok) { console.error(`[api] ${pathname} -> HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    console.error(`[api] ${pathname} -> ${e.message}`);
    return null;
  }
}

/* ============================================================
   Normalizacion football-data.org  ->  snapshot del cliente
   ============================================================ */
const STAGE_LABEL = {
  GROUP_STAGE: 'Fase de grupos',
  LAST_32: '16avos de final',
  ROUND_OF_32: '16avos de final',
  LAST_16: 'Octavos de final',
  ROUND_OF_16: 'Octavos de final',
  QUARTER_FINALS: 'Cuartos de final',
  QUARTER_FINAL: 'Cuartos de final',
  SEMI_FINALS: 'Semifinales',
  SEMI_FINAL: 'Semifinales',
  THIRD_PLACE: 'Tercer puesto',
  FINAL: 'Final',
};
const STAGE_BRACKET = {
  LAST_32: 'r32', ROUND_OF_32: 'r32',
  LAST_16: 'r16', ROUND_OF_16: 'r16',
  QUARTER_FINALS: 'qf', QUARTER_FINAL: 'qf',
  SEMI_FINALS: 'sf', SEMI_FINAL: 'sf',
  FINAL: 'final',
};
const STAGE_ORDER = ['GROUP_STAGE', 'LAST_32', 'ROUND_OF_32', 'LAST_16', 'ROUND_OF_16',
  'QUARTER_FINALS', 'QUARTER_FINAL', 'SEMI_FINALS', 'SEMI_FINAL', 'FINAL'];

/* nombre (en ingles, como los devuelve la API) -> emoji de bandera */
const FLAGS = {
  // Grupo A
  'Mexico':'🇲🇽','South Africa':'🇿🇦','South Korea':'🇰🇷','Korea Republic':'🇰🇷','Czechia':'🇨🇿','Czech Republic':'🇨🇿',
  // Grupo B
  'Canada':'🇨🇦','Bosnia and Herzegovina':'🇧🇦','Bosnia-Herzegovina':'🇧🇦','Qatar':'🇶🇦','Switzerland':'🇨🇭',
  // Grupo C
  'Brazil':'🇧🇷','Morocco':'🇲🇦','Haiti':'🇭🇹','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  // Grupo D
  'United States':'🇺🇸','USA':'🇺🇸','Paraguay':'🇵🇾','Australia':'🇦🇺','Turkey':'🇹🇷','Türkiye':'🇹🇷','Turkiye':'🇹🇷',
  // Grupo E
  'Germany':'🇩🇪','Curaçao':'🇨🇼','Curacao':'🇨🇼','Ivory Coast':'🇨🇮',"Cote d'Ivoire":'🇨🇮','Ecuador':'🇪🇨',
  // Grupo F
  'Netherlands':'🇳🇱','Japan':'🇯🇵','Sweden':'🇸🇪','Tunisia':'🇹🇳',
  // Grupo G
  'Belgium':'🇧🇪','Egypt':'🇪🇬','Iran':'🇮🇷','IR Iran':'🇮🇷','New Zealand':'🇳🇿',
  // Grupo H
  'Spain':'🇪🇸','Cape Verde':'🇨🇻','Cape Verde Islands':'🇨🇻','Cabo Verde':'🇨🇻','Saudi Arabia':'🇸🇦','Uruguay':'🇺🇾',
  // Grupo I
  'France':'🇫🇷','Senegal':'🇸🇳','Iraq':'🇮🇶','Norway':'🇳🇴',
  // Grupo J
  'Argentina':'🇦🇷','Algeria':'🇩🇿','Austria':'🇦🇹','Jordan':'🇯🇴',
  // Grupo K
  'Portugal':'🇵🇹','DR Congo':'🇨🇩','Congo DR':'🇨🇩','Democratic Republic of the Congo':'🇨🇩','Uzbekistan':'🇺🇿','Colombia':'🇨🇴',
  // Grupo L
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Croatia':'🇭🇷','Ghana':'🇬🇭','Panama':'🇵🇦',
};
/* nombre de la API (ingles) -> nombre en espanol */
const NAME_ES = {
  'Mexico':'México','South Africa':'Sudáfrica','South Korea':'Corea del Sur','Korea Republic':'Corea del Sur','Czechia':'República Checa','Czech Republic':'República Checa',
  'Canada':'Canadá','Bosnia and Herzegovina':'Bosnia y Herzegovina','Bosnia-Herzegovina':'Bosnia y Herzegovina','Qatar':'Catar','Switzerland':'Suiza',
  'Brazil':'Brasil','Morocco':'Marruecos','Haiti':'Haití','Scotland':'Escocia',
  'United States':'Estados Unidos','USA':'Estados Unidos','Paraguay':'Paraguay','Australia':'Australia','Turkey':'Turquía','Türkiye':'Turquía','Turkiye':'Turquía',
  'Germany':'Alemania','Curaçao':'Curazao','Curacao':'Curazao','Ivory Coast':'Costa de Marfil',"Cote d'Ivoire":'Costa de Marfil','Ecuador':'Ecuador',
  'Netherlands':'Países Bajos','Japan':'Japón','Sweden':'Suecia','Tunisia':'Túnez',
  'Belgium':'Bélgica','Egypt':'Egipto','Iran':'Irán','IR Iran':'Irán','New Zealand':'Nueva Zelanda',
  'Spain':'España','Cape Verde':'Cabo Verde','Cape Verde Islands':'Cabo Verde','Saudi Arabia':'Arabia Saudita','Uruguay':'Uruguay',
  'France':'Francia','Senegal':'Senegal','Iraq':'Irak','Norway':'Noruega',
  'Argentina':'Argentina','Algeria':'Argelia','Austria':'Austria','Jordan':'Jordania',
  'Portugal':'Portugal','DR Congo':'RD Congo','Congo DR':'RD Congo','Democratic Republic of the Congo':'RD Congo','Uzbekistan':'Uzbekistán','Colombia':'Colombia',
  'England':'Inglaterra','Croatia':'Croacia','Ghana':'Ghana','Panama':'Panamá',
};
function tref(team) {
  if (!team) return null;
  const en = team.name || team.shortName || team.tla;
  if (!en) return null;   // placeholder de la API sin equipo definido todavía
  return { name: NAME_ES[en] || en, flag: FLAGS[en] || '', crest: team.crest || '' };
}
function groupLetter(g) {            // "GROUP_A" -> "A"
  if (!g) return null;
  const m = String(g).match(/([A-L])\s*$/i);
  return m ? m[1].toUpperCase() : null;
}

function rankRow(a, b) {
  if ((b.points||0) !== (a.points||0)) return (b.points||0) - (a.points||0);
  if ((b.goalDifference||0) !== (a.goalDifference||0)) return (b.goalDifference||0) - (a.goalDifference||0);
  return (b.goalsFor||0) - (a.goalsFor||0);
}

/* Estructura OFICIAL de los 16avos del Mundial 2026 (cruces por posición de grupo).
   W = ganador, R = segundo, T = tercero (con su lista de grupos elegibles). */
const R32_STRUCT = [
  { home:{t:'R',g:'A'}, away:{t:'R',g:'B'} },                              // 73
  { home:{t:'W',g:'E'}, away:{t:'T',elig:['A','B','C','D','F']} },         // 74
  { home:{t:'W',g:'F'}, away:{t:'R',g:'C'} },                              // 75
  { home:{t:'W',g:'C'}, away:{t:'R',g:'F'} },                              // 76
  { home:{t:'W',g:'I'}, away:{t:'T',elig:['C','D','F','G','H']} },         // 77
  { home:{t:'R',g:'E'}, away:{t:'R',g:'I'} },                              // 78
  { home:{t:'W',g:'A'}, away:{t:'T',elig:['C','E','F','H','I']} },         // 79
  { home:{t:'W',g:'L'}, away:{t:'T',elig:['E','H','I','J','K']} },         // 80
  { home:{t:'W',g:'D'}, away:{t:'T',elig:['B','E','F','I','J']} },         // 81
  { home:{t:'W',g:'G'}, away:{t:'T',elig:['A','E','H','I','J']} },         // 82
  { home:{t:'R',g:'K'}, away:{t:'R',g:'L'} },                              // 83
  { home:{t:'W',g:'H'}, away:{t:'R',g:'J'} },                              // 84
  { home:{t:'W',g:'B'}, away:{t:'T',elig:['E','F','G','I','J']} },         // 85
  { home:{t:'W',g:'J'}, away:{t:'R',g:'H'} },                              // 86  <- Argentina (1°J) vs 2°H
  { home:{t:'W',g:'K'}, away:{t:'T',elig:['D','E','I','J','L']} },         // 87
  { home:{t:'R',g:'D'}, away:{t:'R',g:'G'} },                              // 88
];

/* Asigna los grupos de los 8 terceros clasificados a los 8 cruces "ganador vs 3°"
   respetando la elegibilidad oficial (matching bipartito, garantiza solución válida). */
function matchThirdsToSlots(thirdGroups, slots) {
  const slotByGroup = {};
  for (const g of thirdGroups) slotByGroup[g] = slots.filter(s => s.elig.includes(g)).map(s => s.i);
  const assignOfSlot = {};
  function aug(g, seen) {
    for (const si of (slotByGroup[g] || [])) {
      if (seen.has(si)) continue;
      seen.add(si);
      if (assignOfSlot[si] === undefined || aug(assignOfSlot[si], seen)) { assignOfSlot[si] = g; return true; }
    }
    return false;
  }
  // más restringidos primero -> resultado estable
  const order = [...thirdGroups].sort((a, b) => (slotByGroup[a].length) - (slotByGroup[b].length));
  for (const g of order) aug(g, new Set());
  return assignOfSlot;
}

function buildProjectedBracket(standingsData) {
  const standings = (standingsData && standingsData.standings) || [];
  const byGroup = {};
  for (const s of standings) {
    if (s.type && s.type !== 'TOTAL') continue;
    const g = groupLetter(s.group);
    if (g) byGroup[g] = s.table || [];
  }
  const groups = Object.keys(byGroup);
  if (groups.length < 12) return null;

  // 8 mejores terceros (por puntos, dif. de gol, goles a favor)
  const thirds = groups.map(g => ({ g, row: byGroup[g][2] })).filter(x => x.row);
  thirds.sort((a, b) => rankRow(a.row, b.row));
  const qualThirdGroups = thirds.slice(0, 8).map(x => x.g);

  const slots = [];
  R32_STRUCT.forEach((m, i) => { if (m.away.t === 'T') slots.push({ i, elig: m.away.elig }); });
  const assignOfSlot = matchThirdsToSlots(qualThirdGroups, slots);

  const pick = (sel) => {
    const t = byGroup[sel.g];
    if (!t) return null;
    if (sel.t === 'W') return t[0] && t[0].team;
    if (sel.t === 'R') return t[1] && t[1].team;
    return null;
  };
  return R32_STRUCT.map((m, i) => {
    const homeTeam = pick(m.home);
    let awayTeam;
    if (m.away.t === 'T') { const g = assignOfSlot[i]; awayTeam = g ? (byGroup[g][2] && byGroup[g][2].team) : null; }
    else awayTeam = pick(m.away);
    return {
      home: tref(homeTeam), away: tref(awayTeam),
      hg: 0, ag: 0, pen: null, minute: null, minLabel: null, status: 'queued', winner: null,
    };
  });
}

const GOAL_EVENT_STATUSES = new Set(['IN_PLAY', 'LIVE']);
const LIVE_STATUSES = new Set(['IN_PLAY', 'PAUSED', 'LIVE']);

function buildSnapshot(matchesData, standingsData, scorersData) {
  const matches = (matchesData && matchesData.matches) || [];

  /* ---- grupos ---- */
  const groups = {};
  const standings = (standingsData && standingsData.standings) || [];
  for (const s of standings) {
    if (s.type && s.type !== 'TOTAL') continue;
    const letter = groupLetter(s.group);
    if (!letter) continue;
    groups[letter] = (s.table || []).map(row => ({
      team: tref(row.team),
      pj: row.playedGames || 0,
      g: row.won || 0, e: row.draw || 0, p: row.lost || 0,
      gf: row.goalsFor || 0, gc: row.goalsAgainst || 0,
      dg: (row.goalDifference != null) ? row.goalDifference : (row.goalsFor || 0) - (row.goalsAgainst || 0),
      pts: row.points || 0,
    }));
  }

  /* ---- goleadores ---- */
  const scorers = ((scorersData && scorersData.scorers) || []).map(sc => ({
    name: (sc.player && sc.player.name) || '—',
    team: tref(sc.team),
    goals: sc.goals || 0,
  })).filter(s => s.goals > 0);

  /* ---- partidos en vivo ---- */
  const liveStatuses = LIVE_STATUSES;
  const live = matches.filter(m => LIVE_STATUSES.has(m.status)).map(m => {
    const lm = liveMinute(m);
    return {
      home: tref(m.homeTeam), away: tref(m.awayTeam),
      hg: scoreOf(m, 'home'), ag: scoreOf(m, 'away'),
      minute: lm.min, minLabel: lm.label,
      group: groupLetter(m.group),
      status: 'live',
    };
  });

  /* ---- llaves (knockout) ---- */
  const bracket = { r32: [], r16: [], qf: [], sf: [], final: [] };
  for (const m of matches) {
    const key = STAGE_BRACKET[m.stage];
    if (!key) continue;
    const finished = m.status === 'FINISHED';
    const hg = scoreOf(m, 'home'), ag = scoreOf(m, 'away');
    const pen = penaltiesOf(m);
    const isLive = liveStatuses.has(m.status);
    const lm = isLive ? liveMinute(m) : { min: null, label: null };
    const w = finished ? winnerName(m, hg, ag, pen) : null;
    bracket[key].push({
      home: tref(m.homeTeam), away: tref(m.awayTeam),
      hg, ag, pen,
      minute: lm.min, minLabel: lm.label,
      status: finished ? 'finished' : (isLive ? 'live' : 'queued'),
      winner: w ? (NAME_ES[w] || w) : null,
    });
  }

  /* ---- etapa actual + campeon ---- */
  let stage = 'Fase de grupos';
  let bestIdx = -1;
  for (const m of matches) {
    if (m.status === 'SCHEDULED' || m.status === 'TIMED') continue;
    const idx = STAGE_ORDER.indexOf(m.stage);
    if (idx > bestIdx) { bestIdx = idx; stage = STAGE_LABEL[m.stage] || stage; }
  }
  let champion = null;
  const finalM = matches.find(m => m.stage === 'FINAL' && m.status === 'FINISHED');
  if (finalM) {
    const hg = scoreOf(finalM, 'home'), ag = scoreOf(finalM, 'away');
    const w = winnerName(finalM, hg, ag, penaltiesOf(finalM));
    champion = tref(w === (finalM.homeTeam && finalM.homeTeam.name) ? finalM.homeTeam : finalM.awayTeam);
  }

  // La API trae los 16avos como placeholders SIN equipos hasta que la fase
  // de grupos termina. Mientras no estén los 16 cruces con equipos reales,
  // proyectamos con quienes estarían clasificando según las posiciones de HOY.
  let projected = false;
  const r32WithTeams = bracket.r32.filter(m => m.home && m.away).length;
  if (r32WithTeams < 16) {
    const proj = buildProjectedBracket(standingsData);
    if (proj) { bracket.r32 = proj; projected = true; }
  }
  return { source: 'live', stage, groups, scorers, live, bracket, champion, projected, ts: Date.now() };
}

function scoreOf(m, side) {
  const ft = m.score && m.score.fullTime;
  if (ft && ft[side] != null) return ft[side];
  return 0;
}
function penaltiesOf(m) {
  const p = m.score && m.score.penalties;
  if (p && p.home != null && p.away != null) return [p.home, p.away];
  return null;
}
function winnerName(m, hg, ag, pen) {
  if (hg > ag) return m.homeTeam && m.homeTeam.name;
  if (ag > hg) return m.awayTeam && m.awayTeam.name;
  if (pen) return pen[0] > pen[1] ? (m.homeTeam && m.homeTeam.name) : (m.awayTeam && m.awayTeam.name);
  return null;
}

/* El free tier de football-data no siempre manda el minuto real.
   - Si la API marca PAUSED, mostramos "Entretiempo".
   - Si alguna vez manda m.minute, usamos ese valor real.
   - Si detectamos el paso de PAUSED -> IN_PLAY/LIVE, guardamos cuándo arrancó el 2º tiempo
     y desde ahí estimamos el minuto.
   - Si el servidor arrancó tarde y no vio ese cambio, mostramos "2º tiempo"
     para no inventar un minuto desfasado. */
function liveMinute(m) {
  const key = String(m.id);
  const prev = matchClockState[key] || {};
  const status = m.status;

  const hasHalfTimeScore =
    m.score &&
    m.score.halfTime &&
    m.score.halfTime.home != null &&
    m.score.halfTime.away != null;

  // Si está en entretiempo, lo mostramos claro y no seguimos contando.
  if (status === 'PAUSED') {
    matchClockState[key] = {
      ...prev,
      lastStatus: status
    };

    return { min: 45, label: 'Entretiempo' };
  }

  // Si la API alguna vez mandara minuto real, usamos eso.
  if (m.minute != null && m.minute !== '') {
    matchClockState[key] = {
      ...prev,
      lastStatus: status
    };

    return { min: +m.minute, label: m.minute + "'" };
  }

  // Si detectamos que volvió de PAUSED a IN_PLAY/LIVE y ya hay score de entretiempo,
  // guardamos el arranque real del segundo tiempo.
  if (
    hasHalfTimeScore &&
    (status === 'IN_PLAY' || status === 'LIVE') &&
    prev.lastStatus === 'PAUSED' &&
    !prev.secondHalfStartedAt
  ) {
    matchClockState[key] = {
      ...prev,
      lastStatus: status,
      secondHalfStartedAt: Date.now()
    };
  } else {
    matchClockState[key] = {
      ...prev,
      lastStatus: status
    };
  }

  const state = matchClockState[key];

  // Segundo tiempo: si sabemos cuándo arrancó, calculamos desde ahí.
  if (hasHalfTimeScore && state.secondHalfStartedAt) {
    const elapsedSecondHalf = Math.floor((Date.now() - state.secondHalfStartedAt) / 60000);
    const min = Math.min(90, 45 + Math.max(1, elapsedSecondHalf));

    return { min, label: '~' + min + "'" };
  }

  // Si ya está en segundo tiempo pero el server arrancó tarde y no vio el cambio PAUSED -> IN_PLAY,
  // mejor no inventar un minuto malo.
  if (hasHalfTimeScore) {
    return { min: null, label: '2º tiempo' };
  }

  // Primer tiempo: estimamos por hora de inicio.
  const ko = Date.parse(m.utcDate);
  if (!ko) return { min: null, label: 'EN VIVO' };

  const elapsed = Math.floor((Date.now() - ko) / 60000);
  if (elapsed < 0) return { min: null, label: 'EN VIVO' };

  if (elapsed <= 45) {
    const min = Math.max(1, elapsed);
    return { min, label: '~' + min + "'" };
  }

  return { min: 45, label: 'Entretiempo' };
}

/* ---- deteccion de goles entre sondeos ---- */
function detectGoals(matches) {
  for (const m of matches) {
    const hg = scoreOf(m, 'home'), ag = scoreOf(m, 'away');
    const key = String(m.id);
    const prev = lastScores[key];
    const cur = `${hg}-${ag}`;

    // Si el partido no está realmente en vivo, solo sincronizamos el marcador.
    // No mostramos toast de gol para partidos finalizados, programados o corregidos tarde por la API.
    if (!GOAL_EVENT_STATUSES.has(m.status)) {
      lastScores[key] = cur;
      continue;
    }

    if (prev !== undefined && prev !== cur) {
      const [ph, pa] = prev.split('-').map(Number);
      if (hg > ph) emitGoal(m.homeTeam, m, hg, ag);
      if (ag > pa) emitGoal(m.awayTeam, m, hg, ag);
    }
    lastScores[key] = cur;
  }
}
function emitGoal(team, m, hg, ag) {
  broadcast('goal', {
    matchId: m.id,
    status: m.status,	  
    team: tref(team),
    home: tref(m.homeTeam), away: tref(m.awayTeam),
    hg, ag,
  });
}

/* ============================================================
   Poller
   ============================================================ */
/* ============================================================
   Fotos de jugadores (Wikipedia) — football-data.org no las trae.
   Se cachean por nombre (incluye cache negativo) para no repetir.
   ============================================================ */
const photoCache = {};
async function fetchT(url, opts = {}, ms = 5000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}
const WIKI_HEADERS = { 'User-Agent': 'Mundial2026App/1.0 (demo; contacto: local)' };
async function wikiSummaryImg(title) {
  try {
    const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}?redirect=true`;
    const r = await fetchT(u, { headers: WIKI_HEADERS });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.type === 'disambiguation') return null;
    return (j.thumbnail && j.thumbnail.source) || (j.originalimage && j.originalimage.source) || null;
  } catch (_) { return null; }
}
async function wikiSearchTitle(name) {
  try {
    const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + ' footballer')}&format=json&srlimit=1&origin=*`;
    const r = await fetchT(u, { headers: WIKI_HEADERS });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j.query && j.query.search && j.query.search[0];
    return hit ? hit.title : null;
  } catch (_) { return null; }
}
async function getPhoto(name) {
  if (name in photoCache) return photoCache[name];
  photoCache[name] = null; // reserva para evitar refetch concurrente
  let url = await wikiSummaryImg(name);
  if (!url) { const t = await wikiSearchTitle(name); if (t) url = await wikiSummaryImg(t); }
  photoCache[name] = url;
  return url;
}
async function attachPhotos(scorers) {
  await Promise.all((scorers || []).map(async s => { s.photo = await getPhoto(s.name); }));
}

let pollCount = 0;
const cache = { matches: null, standings: null, scorers: null };
async function poll() {
  if (!TOKEN) return;
  // Partidos: en cada sondeo (es lo que cambia rapido en vivo).
  const matchesData = await apiGetSafe(`competitions/${COMP}/matches`);
  if (matchesData) cache.matches = matchesData;

  // Posiciones y goleadores: cada 3 sondeos (~60s) y solo si hay cupo.
  // Asi consumimos ~5 req/min de las 10 permitidas, con margen.
  if (pollCount % 3 === 0 && rate.remaining >= 3) {
    const sd = await apiGetSafe(`competitions/${COMP}/standings`);
    if (sd) cache.standings = sd;
    const scd = await apiGetSafe(`competitions/${COMP}/scorers?limit=100`);
    if (scd) cache.scorers = scd;
  }
  pollCount++;

  if (!cache.matches && !cache.standings && !cache.scorers) {
    broadcast('apiError', { message: 'Sin respuesta de la API (token/quota/competicion).' });
    return;
  }
  detectGoals((cache.matches && cache.matches.matches) || []);
  const snap = buildSnapshot(cache.matches, cache.standings, cache.scorers);
  await attachPhotos(snap.scorers);   // caras de los goleadores (Wikipedia, cacheado)
  lastSnapshot = snap;
  broadcast('snapshot', snap);
  console.log(`[poll #${pollCount}] live/quota: ${rate.remaining} req restantes este minuto`);
}

/* ============================================================
   Arranque
   ============================================================ */
app.listen(PORT, () => {
  console.log(`\n  Mundial 2026 · servidor en  http://localhost:${PORT}`);
  if (TOKEN) {
    console.log(`  Feed REAL activo (football-data.org / ${COMP}) — sondeo cada ${POLL_MS / 1000}s\n`);
    poll();
    setInterval(poll, POLL_MS);
  } else {
    console.log(`  Sin FOOTBALL_DATA_TOKEN -> el cliente usara la SIMULACION (modo demo).`);
    console.log(`  Carga tu token en .env para datos en vivo reales.\n`);
  }
});
