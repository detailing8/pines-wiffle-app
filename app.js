(function () {
  'use strict';

  // ─── AFFILIATE CONFIG ─────────────────────────────────────────────────────────
  // Paste your affiliate IDs here once approved. Leave blank to use plain links.
  //
  // Amazon Associates:  affiliate-program.amazon.com  → your tag looks like "pineswiffle-20"
  // Target (Impact):    impact.com  → search "Target Affiliates" → your ID is a number
  // Walmart (Impact):   impact.com  → search "Walmart" → your ID is a number
  // Dick's (CJ):        cj.com      → search "Dick's Sporting Goods" → grab your PID

  const AFFILIATES = {
    amazon:  '',   // e.g. 'pineswiffle-20'
    target:  '',   // e.g. '1234567'  (Impact publisher ID)
    walmart: '',   // e.g. '1234567'  (Impact publisher ID)
    dicks:   '',   // e.g. '1234567'  (CJ PID)
  };

  function amazonUrl(query) {
    const base = 'https://www.amazon.com/s?k=' + encodeURIComponent(query);
    return AFFILIATES.amazon ? base + '&tag=' + AFFILIATES.amazon : base;
  }
  function targetUrl(query) {
    const base = 'https://www.target.com/s?searchTerm=' + encodeURIComponent(query);
    return AFFILIATES.target
      ? 'https://goto.target.com/c/' + AFFILIATES.target + '/wiffle?' + encodeURIComponent(base)
      : base;
  }
  function walmartUrl(query) {
    const base = 'https://www.walmart.com/search?q=' + encodeURIComponent(query);
    return AFFILIATES.walmart
      ? 'https://goto.walmart.com/c/' + AFFILIATES.walmart + '/wiffle?' + encodeURIComponent(base)
      : base;
  }
  function dicksUrl(query) {
    const base = 'https://www.dickssportinggoods.com/search?searchTerm=' + encodeURIComponent(query);
    return AFFILIATES.dicks
      ? base + '&PID=' + AFFILIATES.dicks
      : base;
  }

  // ─── UTILITIES ───────────────────────────────────────────────────────────────

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function fmt(num, denom) {
    if (denom === 0) return '.000';
    const val = (num / denom).toFixed(3);
    return val.startsWith('1') ? '1.000' : val.replace(/^0/, '');
  }

  // ─── DEFAULT STATE ────────────────────────────────────────────────────────────

  function defaultState(innings) {
    const n = innings || 5;
    return {
      gameId:       uid(),
      date:         new Date().toISOString(),
      totalInnings: n,
      currentInning: 1,
      currentHalf:  'top',   // top = away bats, bottom = home bats
      outs:         0,
      status:       'active',
      teams: {
        away: { name: 'Away Team' },
        home: { name: 'Home Team' },
      },
      inningScores: Array.from({ length: n }, () => ({ away: 0, home: 0 })),
      players:  {},   // { [id]: { id, name, number, position, team, order } }
      atBats:   [],   // { id, playerId, result, rbi, inning, half, ts }
      gameHistory:   [],
      bases:    [false, false, false],  // [1st, 2nd, 3rd]
      currentBatterId: null,
      lineupPos: { away: 0, home: 0 }, // batting order position per team
    };
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────

  const STORE_KEY = 'pines-wiffle-v1';

  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
    broadcastLiveUpdate();
  }

  function broadcastLiveUpdate() {
    if (liveChannel) {
      try { liveChannel.postMessage({ type: 'update', state, umpBalls, umpStrikes }); } catch (_) {}
    }
    broadcastToPeers();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Patch any missing fields from a fresh default
        return Object.assign(defaultState(parsed.totalInnings), parsed);
      }
    } catch (_) {}
    return defaultState();
  }

  let state = loadState();

  // ─── COMPUTED ────────────────────────────────────────────────────────────────

  function teamRuns(team) {
    return state.inningScores.reduce((s, inn) => s + (inn[team] || 0), 0);
  }

  function teamHits(team) {
    return Object.values(state.players)
      .filter(p => p.team === team)
      .reduce((s, p) => s + playerStats(p.id).H, 0);
  }

  function computeStatsFromAbs(abs) {
    let AB = 0, H = 0, s1 = 0, s2 = 0, s3 = 0, HR = 0,
        RBI = 0, BB = 0, HBP = 0, K = 0, SF = 0;
    for (const ab of abs) {
      const r = ab.result;
      if (r !== 'BB' && r !== 'HBP') AB++;
      if      (r === '1B')  { H++; s1++; }
      else if (r === '2B')  { H++; s2++; }
      else if (r === '3B')  { H++; s3++; }
      else if (r === 'HR')  { H++; HR++; }
      else if (r === 'BB')  BB++;
      else if (r === 'HBP') HBP++;
      else if (r === 'K')   K++;
      else if (r === 'SF')  SF++;
      RBI += (ab.rbi || 0);
    }
    const PA = AB + BB + HBP + SF;
    const TB = s1 + s2 * 2 + s3 * 3 + HR * 4;
    return {
      AB, H, s1, s2, s3, HR, RBI, BB, HBP, K, SF,
      AVG: fmt(H, AB),
      OBP: fmt(H + BB + HBP, PA),
      SLG: fmt(TB, AB),
    };
  }

  function playerStats(id) {
    return computeStatsFromAbs(state.atBats.filter(ab => ab.playerId === id));
  }

  // ─── CAREER STATS ─────────────────────────────────────────────────────────────

  function careerStatsForPlayer(name) {
    const key = name.toLowerCase();
    const allAbs = [];
    const gamesSeen = new Set();

    // Current game
    Object.values(state.players)
      .filter(p => p.name.toLowerCase() === key)
      .forEach(p => {
        const abs = state.atBats.filter(ab => ab.playerId === p.id);
        if (abs.length) gamesSeen.add(state.gameId);
        allAbs.push(...abs);
      });

    // History games
    (state.gameHistory || []).forEach(g => {
      Object.values(g.players || {})
        .filter(p => p.name.toLowerCase() === key)
        .forEach(p => {
          const abs = (g.atBats || []).filter(ab => ab.playerId === p.id);
          if (abs.length) gamesSeen.add(g.gameId);
          allAbs.push(...abs);
        });
    });

    return { G: gamesSeen.size, ...computeStatsFromAbs(allAbs) };
  }

  function getAllCareerPlayerNames() {
    const seen = new Map(); // lowercase → display name
    Object.values(state.players).forEach(p => seen.set(p.name.toLowerCase(), p.name));
    (state.gameHistory || []).forEach(g => {
      Object.values(g.players || {}).forEach(p => {
        if (!seen.has(p.name.toLowerCase())) seen.set(p.name.toLowerCase(), p.name);
      });
    });
    return Array.from(seen.values());
  }

  function renderCareerStats() {
    const tbody = document.getElementById('career-body');
    const names = getAllCareerPlayerNames();

    if (names.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">No history yet — finish a game and save it</td></tr>';
      return;
    }

    const rows = names
      .map(name => ({ name, s: careerStatsForPlayer(name) }))
      .filter(r => r.s.AB > 0)
      .sort((a, b) => parseFloat('0' + b.s.AVG.replace(/^\./, '0.')) - parseFloat('0' + a.s.AVG.replace(/^\./, '0.')));

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">No at-bats recorded yet</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    rows.forEach(({ name, s }) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="name-col">${esc(name)}</td>` +
        `<td class="career-g">${s.G}</td>` +
        `<td>${s.AB}</td><td>${s.H}</td><td>${s.AVG}</td>` +
        `<td>${s.HR}</td><td>${s.RBI}</td><td>${s.BB}</td><td>${s.K}</td>` +
        `<td>${s.OBP}</td><td>${s.SLG}</td>`;
      tbody.appendChild(tr);
    });
  }

  function battingTeam() {
    return state.currentHalf === 'top' ? 'away' : 'home';
  }

  // ─── LINEUP ORDER HELPERS ────────────────────────────────────────────────────

  function getLineup(team) {
    return Object.values(state.players)
      .filter(p => p.team === team && p.playing !== false)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }

  function currentBatterForTeam(team) {
    const lineup = getLineup(team);
    if (!lineup.length) return null;
    if (!state.lineupPos) state.lineupPos = { away: 0, home: 0 };
    return lineup[(state.lineupPos[team] || 0) % lineup.length] || null;
  }

  function onDeckBatterForTeam(team) {
    const lineup = getLineup(team);
    if (lineup.length < 2) return null;
    if (!state.lineupPos) state.lineupPos = { away: 0, home: 0 };
    return lineup[((state.lineupPos[team] || 0) + 1) % lineup.length] || null;
  }

  function advanceBatterOrder(team) {
    const lineup = getLineup(team);
    if (!lineup.length) return;
    if (!state.lineupPos) state.lineupPos = { away: 0, home: 0 };
    state.lineupPos[team] = ((state.lineupPos[team] || 0) + 1) % lineup.length;
    state.currentBatterId = currentBatterForTeam(team)?.id || null;
  }

  function stepBatterOrder(team, dir) { // dir: +1 next, -1 prev
    const lineup = getLineup(team);
    if (!lineup.length) return;
    if (!state.lineupPos) state.lineupPos = { away: 0, home: 0 };
    state.lineupPos[team] = ((state.lineupPos[team] || 0) + dir + lineup.length) % lineup.length;
    state.currentBatterId = currentBatterForTeam(team)?.id || null;
  }

  function movePlayerInOrder(id, dir) { // dir: -1 up, +1 down
    const p = state.players[id];
    if (!p) return;
    const sorted = Object.values(state.players)
      .filter(q => q.team === p.team)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    sorted.forEach((q, i) => { state.players[q.id].order = i; });
    const idx = sorted.findIndex(q => q.id === id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    state.players[sorted[idx].id].order    = swapIdx;
    state.players[sorted[swapIdx].id].order = idx;
    saveState();
    renderLineup();
  }

  function renderBatterDisplay() {
    const team   = battingTeam();
    const batter = currentBatterForTeam(team);
    const onDeck = onDeckBatterForTeam(team);

    const display = document.getElementById('gc-batter-display');
    const deckEl  = document.getElementById('gc-ondeck');
    const sel     = document.getElementById('batter-select');

    if (batter) {
      display.innerHTML =
        (batter.number ? `<span class="gc-b-badge">#${esc(batter.number)}</span> ` : '') +
        `<span class="gc-b-name">${esc(batter.name)}</span>`;
      sel.value = batter.id;
      state.currentBatterId = batter.id;
    } else {
      display.innerHTML = '<span class="gc-b-empty">No lineup set</span>';
      sel.value = '';
      state.currentBatterId = null;
    }

    if (deckEl) {
      deckEl.textContent = onDeck
        ? 'On Deck: ' + (onDeck.number ? '#' + onDeck.number + ' ' : '') + onDeck.name
        : '';
    }
  }

  // ─── VIEWER FLAG ─────────────────────────────────────────────────────────────

  let isViewer = false;

  // ─── PEER-TO-PEER LIVE (PeerJS) ───────────────────────────────────────────────

  function genRoomCode() {
    return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  }

  let roomCode = localStorage.getItem('pines-room-code') || genRoomCode();
  if (!/^\d{4}$/.test(roomCode)) roomCode = genRoomCode();
  localStorage.setItem('pines-room-code', roomCode);

  // Public TURN relay (Open Relay Project) on port 443, so the connection
  // still works on cellular/locked-down networks that block plain UDP.
  const PEER_ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  };

  let hostPeer   = null;
  let guestConns = [];

  function initHostPeer() {
    if (typeof Peer === 'undefined') return;
    if (hostPeer && !hostPeer.destroyed) return;

    hostPeer = new Peer('pw-' + roomCode.toLowerCase(), { config: PEER_ICE_CONFIG });

    hostPeer.on('open', () => {
      const ind = document.getElementById('live-indicator');
      ind.innerHTML = '&#9679; LIVE &middot; <span class="live-code">' + roomCode + '</span>';
      ind.classList.remove('hidden');
    });

    hostPeer.on('connection', conn => {
      guestConns.push(conn);
      conn.on('open', () => {
        try { conn.send({ state, umpBalls, umpStrikes }); } catch (_) {}
      });
      conn.on('close', () => { guestConns = guestConns.filter(c => c !== conn); });
      conn.on('error', () => { guestConns = guestConns.filter(c => c !== conn); });
    });

    hostPeer.on('error', err => {
      document.getElementById('live-indicator').classList.add('hidden');
      if (err.type === 'unavailable-id') {
        // Room code collision — generate a new one and retry
        roomCode = genRoomCode();
        localStorage.setItem('pines-room-code', roomCode);
        hostPeer = null;
        setTimeout(initHostPeer, 1000);
      }
    });

    hostPeer.on('disconnected', () => {
      try { hostPeer.reconnect(); } catch (_) {}
    });
  }

  // Screen lock / app switch drops the signaling socket on mobile — reconnect on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && hostPeer && hostPeer.disconnected && !hostPeer.destroyed) {
      try { hostPeer.reconnect(); } catch (_) {}
    }
  });

  function broadcastToPeers() {
    guestConns = guestConns.filter(c => c.open);
    guestConns.forEach(conn => {
      try { conn.send({ state, umpBalls, umpStrikes }); } catch (_) {}
    });
  }

  function resetRoomCode() {
    roomCode = genRoomCode();
    localStorage.setItem('pines-room-code', roomCode);
    if (hostPeer) { try { hostPeer.destroy(); } catch (_) {} }
    hostPeer = null;
    guestConns = [];
    document.getElementById('live-indicator').classList.add('hidden');
    setTimeout(initHostPeer, 600);
  }

  // ─── LIVE BROADCAST ──────────────────────────────────────────────────────────

  let liveChannel = null;
  try {
    liveChannel = new BroadcastChannel('pines-wiffle-live');
    liveChannel.addEventListener('message', e => {
      if (e.data.type === 'update') {
        state = Object.assign(defaultState(e.data.state.totalInnings), e.data.state);
        umpBalls   = e.data.umpBalls   || 0;
        umpStrikes = e.data.umpStrikes || 0;
        renderLiveView();
      }
    });
  } catch (_) {}

  // Local schedule storage (fallback when no Firebase)
  let schedule = loadSchedule();

  function loadSchedule() {
    try {
      return JSON.parse(localStorage.getItem('pines-wiffle-schedule') || '[]');
    } catch (_) { return []; }
  }

  function saveScheduleLocal() {
    try { localStorage.setItem('pines-wiffle-schedule', JSON.stringify(schedule)); } catch (_) {}
  }

  // ─── SHARE URL ───────────────────────────────────────────────────────────────

  function makeShareUrl() {
    const data = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    return location.origin + location.pathname + '?share=' + data;
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  function renderAll() {
    renderScoreboard();
    renderGameBar();
    renderQuickScore();
    renderBatterSelect();
    renderPlayLog();
    renderLineup();
    renderStats();
    renderHistory();
    renderUpcomingBanner();
    renderBases();
    renderLiveView();
    renderUmpire();
    renderBatterDisplay();
  }

  function nextUpcomingGame() {
    const now = Date.now();
    return schedule
      .filter(g => new Date(g.date + 'T' + (g.time || '23:59')).getTime() >= now)
      .sort((a, b) => new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00')))[0] || null;
  }

  function renderUpcomingBanner() {
    const banner = document.getElementById('upcoming-banner');
    const next = nextUpcomingGame();
    if (!next) { banner.classList.add('hidden'); return; }

    const d = new Date(next.date + 'T' + (next.time || '12:00'));
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = next.time ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

    document.getElementById('upcoming-title').textContent = `${next.away} vs ${next.home}`;
    document.getElementById('upcoming-meta').textContent =
      [dateStr, timeStr, next.location].filter(Boolean).join(' · ');
    banner.classList.remove('hidden');
  }

  function renderSchedule() {
    const list = document.getElementById('schedule-list');

    const sorted = [...schedule].sort((a, b) =>
      new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00'))
    );

    if (sorted.length === 0) {
      list.innerHTML = '<p class="empty">No games scheduled</p>';
      return;
    }

    const now = Date.now();
    list.innerHTML = '';
    sorted.forEach(g => {
      const dt = new Date(g.date + 'T' + (g.time || '12:00'));
      const isPast = dt.getTime() < now;
      const dateStr = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      const timeStr = g.time ? dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

      const div = document.createElement('div');
      div.className = 'schedule-item' + (isPast ? ' past' : '');
      div.innerHTML =
        `<div class="schedule-date-badge">${dateStr}</div>` +
        `<div class="schedule-matchup">${esc(g.away)} <span style="color:var(--text-muted)">vs</span> ${esc(g.home)}</div>` +
        `<div class="schedule-details">` +
          (timeStr   ? `<span class="schedule-detail">&#128336; ${timeStr}</span>` : '') +
          (g.location ? `<span class="schedule-detail">&#128205; ${esc(g.location)}</span>` : '') +
          (g.notes    ? `<span class="schedule-detail">&#128221; ${esc(g.notes)}</span>` : '') +
        `</div>` +
        `<div class="schedule-actions">` +
          `<button class="btn btn-xs btn-ghost" data-action="edit-game" data-id="${g.id}">Edit</button>` +
          `<button class="btn btn-xs btn-danger" data-action="del-game" data-id="${g.id}">Delete</button>` +
        `</div>`;
      list.appendChild(div);
    });
  }

  function renderScoreboard() {
    const { totalInnings, currentInning, currentHalf, inningScores, teams } = state;

    // Headers
    const hdrs = document.getElementById('sb-inning-headers');
    hdrs.innerHTML = '';
    for (let i = 1; i <= totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell-header';
      el.textContent = i;
      hdrs.appendChild(el);
    }

    // Away scores
    const awayEl = document.getElementById('sb-away-scores');
    awayEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'top') el.classList.add('active');
      el.textContent = inningScores[i]?.away ?? 0;
      awayEl.appendChild(el);
    }

    // Home scores
    const homeEl = document.getElementById('sb-home-scores');
    homeEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'bottom') el.classList.add('active');
      el.textContent = inningScores[i]?.home ?? 0;
      homeEl.appendChild(el);
    }

    document.getElementById('sb-away-name').textContent = teams.away.name;
    document.getElementById('sb-home-name').textContent = teams.home.name;
    document.getElementById('sb-away-runs').textContent = teamRuns('away');
    document.getElementById('sb-home-runs').textContent = teamRuns('home');
    document.getElementById('sb-away-hits').textContent = teamHits('away');
    document.getElementById('sb-home-hits').textContent = teamHits('home');

    // GC hero score bar
    document.getElementById('gc-away-name').textContent  = teams.away.name;
    document.getElementById('gc-home-name').textContent  = teams.home.name;
    document.getElementById('gc-away-score').textContent = teamRuns('away');
    document.getElementById('gc-home-score').textContent = teamRuns('home');
  }

  function renderGameBar() {
    const { currentInning, currentHalf, outs } = state;
    const inningText = ordinal(currentInning) + ' ' + (currentHalf === 'top' ? '▲' : '▼');
    document.getElementById('inning-label').textContent = inningText;
    document.getElementById('gc-inning').textContent = inningText;

    for (let i = 1; i <= 3; i++) {
      document.getElementById('out' + i).classList.toggle('filled', i <= outs);
      document.getElementById('gc-out' + i).classList.toggle('filled', i <= outs);
    }
    document.getElementById('gc-outs-count').textContent = outs;
  }

  function renderQuickScore() {
    document.getElementById('qs-away-name').textContent = state.teams.away.name;
    document.getElementById('qs-home-name').textContent = state.teams.home.name;
    document.getElementById('qs-away-score').textContent = teamRuns('away');
    document.getElementById('qs-home-score').textContent = teamRuns('home');
  }

  function renderBatterSelect() {
    const sel = document.getElementById('batter-select');
    const team = battingTeam();
    const players = getLineup(team);
    const current = currentBatterForTeam(team);

    sel.innerHTML = '<option value="">Manual override\u2026</option>';
    players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.number ? '#' + p.number + ' ' : '') + p.name;
      if (current && p.id === current.id) opt.selected = true;
      sel.appendChild(opt);
    });
    renderBatterDisplay();
  }

  function renderPlayLog() {
    const log = document.getElementById('play-log');
    if (state.atBats.length === 0) {
      log.innerHTML = '<p class="empty">No plays logged yet</p>';
      return;
    }
    log.innerHTML = '';
    const recents = [...state.atBats].reverse().slice(0, 20);
    recents.forEach((ab, ri) => {
      const realIdx = state.atBats.length - 1 - ri;
      const p = state.players[ab.playerId];
      const pName = p ? p.name : 'Unknown';
      const teamName = p ? state.teams[p.team].name : '';

      const r = ab.result;
      let cls = 'badge-hit';
      if (r === 'HR') cls = 'badge-hr';
      else if (['K', 'Out', 'SF', 'E'].includes(r)) cls = 'badge-out';
      else if (['BB', 'HBP'].includes(r)) cls = 'badge-walk';

      const div = document.createElement('div');
      div.className = 'play-item';
      div.innerHTML =
        `<span class="play-badge ${cls}">${r}</span>` +
        `<div class="play-info">` +
          `<div class="play-player">${esc(pName)}</div>` +
          `<div class="play-meta">${esc(teamName)} &middot; Inn ${ab.inning}${ab.half === 'top' ? '▲' : '▼'}` +
          (ab.rbi ? ` &middot; ${ab.rbi} RBI` : '') + `</div>` +
        `</div>` +
        `<button class="play-del" data-idx="${realIdx}">&#10005;</button>`;
      log.appendChild(div);
    });
  }

  // Escape HTML to avoid XSS from player names
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let lineupTeam = 'away';

  function renderLineup() {
    document.getElementById('lineup-title').textContent = state.teams[lineupTeam].name;
    const list = document.getElementById('lineup-list');
    const allTeamPlayers = Object.values(state.players)
      .filter(p => p.team === lineupTeam)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    const otherTeam = lineupTeam === 'away' ? 'home' : 'away';
    const otherName = state.teams[otherTeam].name;

    if (allTeamPlayers.length === 0) {
      list.innerHTML = '<p class="empty">No players yet</p>';
      return;
    }
    list.innerHTML = '';

    const playing    = allTeamPlayers.filter(p => p.playing !== false);
    const notPlaying = allTeamPlayers.filter(p => p.playing === false);

    function makeRow(p) {
      const isPlaying = p.playing !== false;
      const div = document.createElement('div');
      div.className = 'lineup-item' + (isPlaying ? '' : ' inactive');
      const orderPos = playing.indexOf(p) + 1; // batting order position (1-based, only for playing)
      div.innerHTML =
        `<button class="player-act-btn player-playing-btn ${isPlaying ? 'on' : ''}" data-action="toggle-playing" data-id="${p.id}" title="${isPlaying ? 'Mark not playing' : 'Mark playing'}">` +
          (isPlaying ? '&#10003;' : '&#9711;') +
        `</button>` +
        (isPlaying ? `<span class="player-order-num">${orderPos}</span>` : '') +
        `<span class="player-num">${esc(p.number || '—')}</span>` +
        `<span class="player-name">${esc(p.name)}</span>` +
        (p.position ? `<span class="player-pos">${esc(p.position)}</span>` : '') +
        `<div class="player-acts">` +
          (isPlaying ? `<button class="player-act-btn order-btn" data-action="move-up" data-id="${p.id}" title="Move up in order">&#8593;</button>` : '') +
          (isPlaying ? `<button class="player-act-btn order-btn" data-action="move-down" data-id="${p.id}" title="Move down in order">&#8595;</button>` : '') +
          (p.song ? `<button class="player-act-btn song-icon" data-action="play-song" data-id="${p.id}" title="Play walkup song">&#127925;</button>` : '') +
          `<button class="player-act-btn switch-team-btn" data-action="switch-team" data-id="${p.id}" title="Move to ${otherName}">&#8644;</button>` +
          `<button class="player-act-btn" data-action="edit" data-id="${p.id}">&#9998;</button>` +
          `<button class="player-act-btn del" data-action="del" data-id="${p.id}">&#128465;</button>` +
        `</div>`;
      list.appendChild(div);
    }

    if (playing.length > 0) {
      const hdr = document.createElement('div');
      hdr.className = 'lineup-section-hdr';
      hdr.textContent = 'Playing';
      list.appendChild(hdr);
      playing.forEach(makeRow);
    }
    if (notPlaying.length > 0) {
      const hdr = document.createElement('div');
      hdr.className = 'lineup-section-hdr inactive-hdr';
      hdr.textContent = 'Not Playing';
      list.appendChild(hdr);
      notPlaying.forEach(makeRow);
    }
  }

  let statsTeam = 'away';
  let statsGameIdx = -1; // -1 = current game, 0+ = history index

  function getStatsGame() {
    if (statsGameIdx >= 0 && state.gameHistory && state.gameHistory[statsGameIdx]) {
      return state.gameHistory[statsGameIdx];
    }
    return state;
  }

  function renderGameSelector() {
    const sel = document.getElementById('stats-game-select');
    const prev = sel.value;
    sel.innerHTML = '<option value="-1">Current Game</option>';
    if (state.gameHistory && state.gameHistory.length > 0) {
      [...state.gameHistory].reverse().forEach((g, ri) => {
        const realIdx = state.gameHistory.length - 1 - ri;
        const awayR = g.inningScores.reduce((s, i) => s + (i.away || 0), 0);
        const homeR = g.inningScores.reduce((s, i) => s + (i.home || 0), 0);
        const date  = new Date(g.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const opt = document.createElement('option');
        opt.value = realIdx;
        opt.textContent = date + ' — ' + g.teams.away.name + ' ' + awayR + '–' + homeR + ' ' + g.teams.home.name;
        sel.appendChild(opt);
      });
    }
    // Restore selection if still valid
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  function renderStats() {
    const game   = getStatsGame();
    const tbody  = document.getElementById('batting-body');
    let players  = Object.values(game.players || {});
    if (statsTeam !== 'all') players = players.filter(p => p.team === statsTeam);
    players.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    if (players.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">No players</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    players.forEach(p => {
      const abs = (game.atBats || []).filter(a => a.playerId === p.id);
      const s   = computeStatsFromAbs(abs);
      const tr  = document.createElement('tr');
      tr.innerHTML =
        `<td class="name-col">${esc(p.name)}</td>` +
        `<td>${s.AB}</td><td>${s.H}</td><td>${s.AVG}</td>` +
        `<td>${s.HR}</td><td>${s.RBI}</td><td>${s.BB}</td><td>${s.K}</td>` +
        `<td>${s.OBP}</td><td>${s.SLG}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderHistory() {
    const list = document.getElementById('history-list');
    if (!state.gameHistory || state.gameHistory.length === 0) {
      list.innerHTML = '<p class="empty">No past games</p>';
      return;
    }
    list.innerHTML = '';
    [...state.gameHistory].reverse().forEach((g, ri) => {
      const realIdx = state.gameHistory.length - 1 - ri;
      const awayR = g.inningScores.reduce((s, i) => s + (i.away || 0), 0);
      const homeR = g.inningScores.reduce((s, i) => s + (i.home || 0), 0);
      const date  = new Date(g.date).toLocaleDateString();
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML =
        `<div class="history-score">${esc(g.teams.away.name)} ${awayR} – ${homeR} ${esc(g.teams.home.name)}</div>` +
        `<div class="history-meta">${date} &middot; ${g.status === 'final' ? 'Final' : 'In Progress'}</div>` +
        `<button class="btn btn-xs btn-ghost" data-action="recap" data-idx="${realIdx}">&#128202; Recap</button>`;
      list.appendChild(div);
    });
  }

  function renderBases() {
    const bases = state.bases || [false, false, false];
    document.querySelectorAll('.base-toggle-btn').forEach(btn => {
      btn.classList.toggle('on', bases[parseInt(btn.dataset.base)]);
    });
    // GC diamond
    ['gc-base-1', 'gc-base-2', 'gc-base-3'].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('occupied', bases[i]);
    });
  }

  function renderLiveView() {
    const bases = state.bases || [false, false, false];
    const { totalInnings, currentInning, currentHalf, inningScores, teams } = state;

    // Scores & names
    document.getElementById('lv-away-name').textContent  = teams.away.name;
    document.getElementById('lv-home-name').textContent  = teams.home.name;
    document.getElementById('lv-away-score').textContent = teamRuns('away');
    document.getElementById('lv-home-score').textContent = teamRuns('home');

    // Inning + outs
    document.getElementById('lv-inning').innerHTML =
      ordinal(currentInning) + ' ' + (currentHalf === 'top' ? '&#9650;' : '&#9660;');
    for (let i = 1; i <= 3; i++) {
      document.getElementById('lv-od-' + i).classList.toggle('filled', i <= state.outs);
    }

    // BSO
    document.getElementById('lv-balls').textContent    = umpBalls;
    document.getElementById('lv-strikes').textContent  = umpStrikes;
    document.getElementById('lv-outs-num').textContent = state.outs;

    // Base diamond
    document.getElementById('lv-base-1').classList.toggle('occupied', bases[0]);
    document.getElementById('lv-base-2').classList.toggle('occupied', bases[1]);
    document.getElementById('lv-base-3').classList.toggle('occupied', bases[2]);

    // Current batter card
    const batter = state.currentBatterId ? state.players[state.currentBatterId] : null;
    if (batter) {
      const s = playerStats(batter.id);
      document.getElementById('lv-batter-name').textContent =
        (batter.number ? '#' + batter.number + ' ' : '') + batter.name;
      document.getElementById('lv-batter-stats').textContent =
        s.AVG + ' AVG \u00b7 ' + s.HR + ' HR \u00b7 ' + s.RBI + ' RBI';
    } else {
      document.getElementById('lv-batter-name').innerHTML = '&mdash;';
      document.getElementById('lv-batter-stats').textContent = '';
    }

    // Scoreboard
    const hdrs = document.getElementById('lv-sb-inning-headers');
    hdrs.innerHTML = '';
    for (let i = 1; i <= totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell-header';
      el.textContent = i;
      hdrs.appendChild(el);
    }
    const awayEl = document.getElementById('lv-sb-away-scores');
    awayEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'top') el.classList.add('active');
      el.textContent = inningScores[i]?.away ?? 0;
      awayEl.appendChild(el);
    }
    const homeEl = document.getElementById('lv-sb-home-scores');
    homeEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'bottom') el.classList.add('active');
      el.textContent = inningScores[i]?.home ?? 0;
      homeEl.appendChild(el);
    }
    document.getElementById('lv-sb-away-name').textContent   = teams.away.name;
    document.getElementById('lv-sb-home-name').textContent   = teams.home.name;
    document.getElementById('lv-sb-away-runs').textContent   = teamRuns('away');
    document.getElementById('lv-sb-home-runs').textContent   = teamRuns('home');
    document.getElementById('lv-sb-away-hits').textContent   = teamHits('away');
    document.getElementById('lv-sb-home-hits').textContent   = teamHits('home');

    // Recent plays (no delete button)
    const log = document.getElementById('lv-play-log');
    if (state.atBats.length === 0) {
      log.innerHTML = '<p class="empty">No plays yet</p>';
      return;
    }
    log.innerHTML = '';
    [...state.atBats].reverse().slice(0, 10).forEach(ab => {
      const p = state.players[ab.playerId];
      const pName = p ? p.name : 'Unknown';
      const r = ab.result;
      let cls = 'badge-hit';
      if (r === 'HR') cls = 'badge-hr';
      else if (['K', 'Out', 'SF', 'E'].includes(r)) cls = 'badge-out';
      else if (['BB', 'HBP'].includes(r)) cls = 'badge-walk';
      const div = document.createElement('div');
      div.className = 'play-item';
      div.innerHTML =
        `<span class="play-badge ${cls}">${r}</span>` +
        `<div class="play-info">` +
          `<div class="play-player">${esc(pName)}</div>` +
          `<div class="play-meta">Inn ${ab.inning}${ab.half === 'top' ? '▲' : '▼'}` +
          (ab.rbi ? ` \u00b7 ${ab.rbi} RBI` : '') + `</div>` +
        `</div>`;
      log.appendChild(div);
    });
  }

  function renderLeaderboard() {
    const players = Object.values(state.players);

    const categories = [
      { id: 'lb-avg',  label: 'AVG', key: s => parseFloat(s.AVG.replace(/^\./, '0.')), fmt: s => s.AVG, minAB: 1 },
      { id: 'lb-hr',   label: 'HR',  key: s => s.HR,  fmt: s => s.HR,  minAB: 0 },
      { id: 'lb-rbi',  label: 'RBI', key: s => s.RBI, fmt: s => s.RBI, minAB: 0 },
      { id: 'lb-hits', label: 'H',   key: s => s.H,   fmt: s => s.H,   minAB: 0 },
      { id: 'lb-obp',  label: 'OBP', key: s => parseFloat(s.OBP.replace(/^\./, '0.')), fmt: s => s.OBP, minAB: 1 },
      { id: 'lb-slg',  label: 'SLG', key: s => parseFloat(s.SLG.replace(/^\./, '0.')), fmt: s => s.SLG, minAB: 1 },
    ];

    const rankClasses = ['gold', 'silver', 'bronze'];
    const rankSymbols = ['1', '2', '3', '4', '5'];

    categories.forEach(cat => {
      const el = document.getElementById(cat.id);
      const ranked = players
        .map(p => ({ p, s: playerStats(p.id) }))
        .filter(({ s }) => s.AB >= cat.minAB || cat.minAB === 0)
        .filter(({ s }) => cat.key(s) > 0)
        .sort((a, b) => cat.key(b.s) - cat.key(a.s))
        .slice(0, 5);

      if (ranked.length === 0) {
        el.innerHTML = '<li class="lb-empty">No data yet</li>';
        return;
      }
      el.innerHTML = '';
      ranked.forEach(({ p, s }, i) => {
        const li = document.createElement('li');
        li.className = 'lb-item';
        li.innerHTML =
          `<span class="lb-rank ${rankClasses[i] || ''}">${rankSymbols[i]}</span>` +
          `<span class="lb-name">${esc(p.name)}</span>` +
          `<span class="lb-val">${cat.fmt(s)}</span>`;
        el.appendChild(li);
      });
    });
  }

  function renderGear() {
    function gearLink(icon, name, desc, url) {
      return `<a class="gear-item" href="${url}" target="_blank" rel="noopener noreferrer">` +
        `<div class="gear-icon">${icon}</div>` +
        `<div class="gear-info"><div class="gear-name">${name}</div><div class="gear-desc">${desc}</div></div>` +
        `<div class="gear-arrow">&#8250;</div>` +
        `</a>`;
    }

    document.getElementById('gear-bats').innerHTML = [
      gearLink('&#9733;', 'Official Wiffle Ball Site', 'Bats, balls, and sets direct from the source', 'https://www.wiffle.com'),
      gearLink('&#128230;', 'Amazon — Wiffle Ball Bats', 'Wide selection, fast shipping, Prime eligible', amazonUrl('wiffle ball bat')),
      gearLink('&#127919;', 'Target — Wiffle Ball Bats', 'In-store pickup or delivery available', targetUrl('wiffle ball bat')),
      gearLink('&#128717;', 'Walmart — Wiffle Ball Bats', 'Budget-friendly options, store pickup available', walmartUrl('wiffle ball bat')),
      gearLink('&#127944;', "Dick's Sporting Goods", 'Sports-focused selection, in-store and online', dicksUrl('wiffle ball')),
    ].join('');

    document.getElementById('gear-sets').innerHTML = [
      gearLink('&#128230;', 'Amazon — Wiffle Ball Sets', 'Complete bat and ball combo sets', amazonUrl('wiffle ball set')),
      gearLink('&#128230;', 'Amazon — Bulk Wiffle Balls', 'Stock up — bulk packs for leagues', amazonUrl('wiffle balls bulk')),
      gearLink('&#127919;', 'Target — Wiffle Ball Sets', 'Sets with bases and everything you need', targetUrl('wiffle ball set')),
    ].join('');
  }

  // ─── UMPIRE MODE ─────────────────────────────────────────────────────────────

  let umpBalls   = 0;
  let umpStrikes = 0;
  let lastCallTimer = null;

  function renderUmpire() {
    // GC BSO numbers
    document.getElementById('gc-balls').textContent   = umpBalls;
    document.getElementById('gc-strikes').textContent = umpStrikes;
  }

  function umpShowCall(text, cls) {
    const el = document.getElementById('ump-last-call');
    el.textContent = text;
    el.className = 'ump-last-call ' + cls;
    if (lastCallTimer) clearTimeout(lastCallTimer);
    lastCallTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function umpLogAtBat(result, rbi) {
    const pid = document.getElementById('batter-select').value;
    if (!pid) return;
    state.atBats.push({
      id: uid(), playerId: pid, result, rbi: rbi || 0,
      inning: state.currentInning, half: state.currentHalf, ts: Date.now(),
    });
    advanceBatterOrder(battingTeam());
    saveState();
    renderScoreboard();
    renderQuickScore();
    renderPlayLog();
    renderLiveView();
    renderUmpire();
    renderBatterSelect();
  }

  function umpResetCount() {
    umpBalls = 0;
    umpStrikes = 0;
    renderUmpire();
  }

  function umpAdvanceOuts() {
    state.outs = Math.min(3, state.outs + 1);
    if (state.outs >= 3) {
      setTimeout(() => {
        if (confirm('3 outs — advance to next half-inning?')) {
          if (state.currentHalf === 'top') {
            state.currentHalf = 'bottom';
          } else {
            state.currentInning = Math.min(state.currentInning + 1, state.totalInnings);
            state.currentHalf = 'top';
          }
          state.outs = 0;
          saveState();
          renderScoreboard();
          renderGameBar();
          renderUmpire();
          renderBatterSelect();
        }
      }, 300);
    }
    saveState();
    renderGameBar();
    renderUmpire();
  }

  // ─── WALKUP SONGS ────────────────────────────────────────────────────────────

  function ytVideoId(url) {
    if (!url) return null;
    // youtu.be/ID
    let m = url.match(/youtu\.be\/([^?&]+)/);
    if (m) return m[1];
    // youtube.com/watch?v=ID
    m = url.match(/[?&]v=([^?&]+)/);
    if (m) return m[1];
    // youtube.com/embed/ID
    m = url.match(/embed\/([^?&]+)/);
    if (m) return m[1];
    return null;
  }

  function playSong(playerId) {
    const player = state.players[playerId];
    if (!player || !player.song) return;
    const vid = ytVideoId(player.song);
    if (!vid) return;

    const iframe = document.getElementById('yt-player');
    iframe.src = 'https://www.youtube.com/embed/' + vid + '?autoplay=1&enablejsapi=1';

    document.getElementById('now-playing-name').textContent = player.name;
    document.getElementById('now-playing').classList.remove('hidden');
    document.body.classList.add('song-playing');
  }

  function stopSong() {
    document.getElementById('yt-player').src = '';
    document.getElementById('now-playing').classList.add('hidden');
    document.body.classList.remove('song-playing');
  }

  document.getElementById('song-stop').addEventListener('click', stopSong);


  // ─── BASE RUNNERS ────────────────────────────────────────────────────────────

  document.querySelectorAll('.base-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.bases) state.bases = [false, false, false];
      const idx = parseInt(btn.dataset.base);
      state.bases[idx] = !state.bases[idx];
      saveState();
      renderBases();
      renderLiveView();
    });
  });

  document.getElementById('bases-clear').addEventListener('click', () => {
    state.bases = [false, false, false];
    saveState();
    renderBases();
    renderLiveView();
  });

  // ─── AT-BAT ENTRY STATE ──────────────────────────────────────────────────────

  let selectedResult = null;
  let rbiCount = 0;

  function resetAtBatUI() {
    document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('rbi-row').classList.add('hidden');
    document.getElementById('batter-select').value = '';
    document.getElementById('rbi-count').textContent = '0';
    selectedResult = null;
    rbiCount = 0;
  }

  // ─── EVENT WIRING ────────────────────────────────────────────────────────────

  // Tab nav
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'stats')       { renderGameSelector(); statsTeam === 'career' ? renderCareerStats() : renderStats(); }
      if (btn.dataset.tab === 'lineup')      renderLineup();
      if (btn.dataset.tab === 'history')     renderHistory();
      if (btn.dataset.tab === 'leaderboard') renderLeaderboard();
      if (btn.dataset.tab === 'schedule')    renderSchedule();
      if (btn.dataset.tab === 'gear')        renderGear();
      if (btn.dataset.tab === 'live')        renderLiveView();
    });
  });

  // Inning navigation
  document.getElementById('next-half').addEventListener('click', () => {
    if (state.currentHalf === 'top') {
      state.currentHalf = 'bottom';
    } else {
      if (state.currentInning < state.totalInnings) {
        state.currentInning++;
        state.currentHalf = 'top';
      } else {
        state.status = 'final';
      }
    }
    state.outs = 0;
    state.bases = [false, false, false];
    state.currentBatterId = null;
    umpResetCount();
    saveState();
    renderScoreboard();
    renderGameBar();
    renderBatterSelect();
    renderBases();
    renderLiveView();
    resetAtBatUI();
  });

  document.getElementById('prev-half').addEventListener('click', () => {
    if (state.currentHalf === 'bottom') {
      state.currentHalf = 'top';
    } else if (state.currentInning > 1) {
      state.currentInning--;
      state.currentHalf = 'bottom';
    }
    state.outs = 0;
    state.bases = [false, false, false];
    state.currentBatterId = null;
    saveState();
    renderScoreboard();
    renderGameBar();
    renderBatterSelect();
    renderBases();
    renderLiveView();
    resetAtBatUI();
  });

  // Outs
  document.getElementById('add-out-btn').addEventListener('click', () => {
    state.outs = Math.min(3, state.outs + 1);
    saveState();
    renderGameBar();
  });
  document.getElementById('undo-out-btn').addEventListener('click', () => {
    state.outs = Math.max(0, state.outs - 1);
    saveState();
    renderGameBar();
  });

  // ─── UMPIRE EVENTS ───────────────────────────────────────────────────────────

  document.getElementById('ump-ball').addEventListener('click', () => {
    umpBalls++;
    if (umpBalls >= 4) {
      umpShowCall('BALL 4 — WALK', 'call-event');
      umpLogAtBat('BB', 0);
      umpResetCount();
    } else {
      umpShowCall('BALL ' + umpBalls, 'call-ball');
      renderUmpire();
    }
    broadcastLiveUpdate(); renderLiveView();
  });

  document.getElementById('ump-strike').addEventListener('click', () => {
    umpStrikes++;
    if (umpStrikes >= 3) {
      umpShowCall('STRIKE 3 — OUT!', 'call-strike');
      umpLogAtBat('K', 0);
      umpAdvanceOuts();
      umpResetCount();
    } else {
      umpShowCall('STRIKE ' + umpStrikes, 'call-strike');
      renderUmpire();
    }
    broadcastLiveUpdate(); renderLiveView();
  });

  document.getElementById('ump-foul').addEventListener('click', () => {
    // Foul = strike unless already 2 strikes
    if (umpStrikes < 2) {
      umpStrikes++;
      umpShowCall('FOUL — STRIKE ' + umpStrikes, 'call-foul');
    } else {
      umpShowCall('FOUL BALL', 'call-foul');
    }
    renderUmpire();
    broadcastLiveUpdate(); renderLiveView();
  });

  document.getElementById('ump-out').addEventListener('click', () => {
    umpShowCall('OUT!', 'call-out');
    umpLogAtBat('Out', 0);
    umpAdvanceOuts();
    umpResetCount();
    broadcastLiveUpdate(); renderLiveView();
  });

  document.getElementById('ump-reset').addEventListener('click', () => {
    umpResetCount();
    umpShowCall('Count Reset', 'call-event');
    broadcastLiveUpdate(); renderLiveView();
  });

  // Batting order navigation
  document.getElementById('prev-batter').addEventListener('click', () => {
    stepBatterOrder(battingTeam(), -1);
    saveState();
    renderBatterSelect();
    broadcastLiveUpdate(); renderLiveView();
  });
  document.getElementById('next-batter').addEventListener('click', () => {
    stepBatterOrder(battingTeam(), 1);
    saveState();
    renderBatterSelect();
    broadcastLiveUpdate(); renderLiveView();
  });


  // Quick score
  document.querySelectorAll('.btn-score').forEach(btn => {
    btn.addEventListener('click', () => {
      const team = btn.dataset.team;
      const dir  = parseInt(btn.dataset.dir);
      const idx  = state.currentInning - 1;
      state.inningScores[idx][team] = Math.max(0, (state.inningScores[idx][team] || 0) + dir);
      saveState();
      renderScoreboard();
      renderQuickScore();
    });
  });

  // Manual batter override: sync lineup position and play walkup song
  document.getElementById('batter-select').addEventListener('change', () => {
    const pid = document.getElementById('batter-select').value || null;
    if (pid) {
      const team = battingTeam();
      const lineup = getLineup(team);
      const idx = lineup.findIndex(p => p.id === pid);
      if (idx >= 0) {
        if (!state.lineupPos) state.lineupPos = { away: 0, home: 0 };
        state.lineupPos[team] = idx;
      }
      playSong(pid);
    } else {
      stopSong();
    }
    state.currentBatterId = pid;
    renderBatterDisplay();
    broadcastLiveUpdate();
    renderLiveView();
  });

  // Result buttons
  document.querySelectorAll('.result-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!document.getElementById('batter-select').value) {
        document.getElementById('batter-select').focus();
        document.getElementById('batter-select').style.borderColor = 'var(--danger)';
        setTimeout(() => document.getElementById('batter-select').style.borderColor = '', 1200);
        return;
      }
      document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedResult = btn.dataset.result;
      rbiCount = 0;
      document.getElementById('rbi-count').textContent = '0';
      document.getElementById('rbi-row').classList.remove('hidden');
    });
  });

  document.getElementById('rbi-plus').addEventListener('click', () => {
    rbiCount = Math.min(4, rbiCount + 1);
    document.getElementById('rbi-count').textContent = rbiCount;
  });
  document.getElementById('rbi-minus').addEventListener('click', () => {
    rbiCount = Math.max(0, rbiCount - 1);
    document.getElementById('rbi-count').textContent = rbiCount;
  });

  document.getElementById('log-btn').addEventListener('click', () => {
    const pid = document.getElementById('batter-select').value;
    if (!pid || !selectedResult) return;

    state.atBats.push({
      id:       uid(),
      playerId: pid,
      result:   selectedResult,
      rbi:      rbiCount,
      inning:   state.currentInning,
      half:     state.currentHalf,
      ts:       Date.now(),
    });

    // Auto-increment outs
    if (['K', 'Out', 'SF', 'E'].includes(selectedResult)) {
      state.outs = Math.min(3, state.outs + 1);
    }

    advanceBatterOrder(battingTeam());
    saveState();
    renderScoreboard();
    renderGameBar();
    renderPlayLog();
    resetAtBatUI();
    renderBatterSelect();
  });

  // Delete play
  document.getElementById('play-log').addEventListener('click', e => {
    const btn = e.target.closest('.play-del');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    state.atBats.splice(idx, 1);
    saveState();
    renderScoreboard();
    renderPlayLog();
  });

  // ─── LINEUP EVENTS ───────────────────────────────────────────────────────────

  document.querySelectorAll('#tab-lineup .team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-lineup .team-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      lineupTeam = btn.dataset.team;
      renderLineup();
    });
  });

  let editingPlayerId = null;

  document.getElementById('add-player-btn').addEventListener('click', () => {
    editingPlayerId = null;
    document.getElementById('player-modal-title').textContent = 'Add Player';
    document.getElementById('pm-name').value = '';
    document.getElementById('pm-number').value = '';
    document.getElementById('pm-position').value = '';
    document.getElementById('pm-song').value = '';
    openModal('player-modal');
    setTimeout(() => document.getElementById('pm-name').focus(), 80);
  });

  document.getElementById('pm-save').addEventListener('click', () => {
    const name = document.getElementById('pm-name').value.trim();
    if (!name) { document.getElementById('pm-name').focus(); return; }

    const id = editingPlayerId || uid();
    const existing = editingPlayerId ? state.players[editingPlayerId] : null;
    state.players[id] = {
      id,
      name,
      number:   document.getElementById('pm-number').value.trim(),
      position: document.getElementById('pm-position').value,
      song:     document.getElementById('pm-song').value.trim(),
      team:     lineupTeam,
      order:    existing ? existing.order : Object.values(state.players).filter(p => p.team === lineupTeam).length,
      playing:  existing ? existing.playing : true,
    };

    saveState();
    renderLineup();
    renderBatterSelect();
    closeModal('player-modal');
  });
  document.getElementById('pm-cancel').addEventListener('click', () => closeModal('player-modal'));

  document.getElementById('lineup-list').addEventListener('click', e => {
    const btn = e.target.closest('.player-act-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'move-up') {
      movePlayerInOrder(id, -1);
    } else if (btn.dataset.action === 'move-down') {
      movePlayerInOrder(id, 1);
    } else if (btn.dataset.action === 'toggle-playing') {
      state.players[id].playing = state.players[id].playing === false ? true : false;
      saveState();
      renderLineup();
      renderBatterSelect();
    } else if (btn.dataset.action === 'switch-team') {
      const p = state.players[id];
      p.team = p.team === 'away' ? 'home' : 'away';
      saveState();
      renderLineup();
      renderBatterSelect();
    } else if (btn.dataset.action === 'edit') {
      const p = state.players[id];
      editingPlayerId = id;
      document.getElementById('player-modal-title').textContent = 'Edit Player';
      document.getElementById('pm-name').value     = p.name;
      document.getElementById('pm-number').value   = p.number || '';
      document.getElementById('pm-position').value = p.position || '';
      document.getElementById('pm-song').value     = p.song || '';
      openModal('player-modal');
    } else if (btn.dataset.action === 'play-song') {
      playSong(id);
    } else if (btn.dataset.action === 'del') {
      if (!confirm('Remove ' + state.players[id].name + '?')) return;
      delete state.players[id];
      saveState();
      renderLineup();
      renderBatterSelect();
    }
  });

  // Team rename
  document.getElementById('edit-team-btn').addEventListener('click', () => {
    document.getElementById('tm-name').value = state.teams[lineupTeam].name;
    openModal('team-modal');
    setTimeout(() => document.getElementById('tm-name').focus(), 80);
  });
  document.getElementById('tm-save').addEventListener('click', () => {
    const name = document.getElementById('tm-name').value.trim();
    if (!name) return;
    state.teams[lineupTeam].name = name;
    saveState();
    renderAll();
    closeModal('team-modal');
  });
  document.getElementById('tm-cancel').addEventListener('click', () => closeModal('team-modal'));

  // ─── STATS EVENTS ────────────────────────────────────────────────────────────

  document.getElementById('stats-game-select').addEventListener('change', function () {
    statsGameIdx = parseInt(this.value);
    // Reset to Away when switching games (Career doesn't depend on game)
    if (statsTeam !== 'career') {
      document.querySelectorAll('#tab-stats .team-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('#tab-stats .team-btn[data-team="away"]').classList.add('active');
      statsTeam = 'away';
      document.getElementById('batting-card').classList.remove('hidden');
      document.getElementById('career-card').classList.add('hidden');
      renderStats();
    }
  });

  document.querySelectorAll('#tab-stats .team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-stats .team-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statsTeam = btn.dataset.team;
      if (statsTeam === 'career') {
        document.getElementById('batting-card').classList.add('hidden');
        document.getElementById('career-card').classList.remove('hidden');
        renderCareerStats();
      } else {
        document.getElementById('batting-card').classList.remove('hidden');
        document.getElementById('career-card').classList.add('hidden');
        renderStats();
      }
    });
  });

  // ─── HISTORY / NEW GAME ───────────────────────────────────────────────────────

  document.getElementById('new-game-btn').addEventListener('click', () => openModal('new-game-modal'));
  document.getElementById('ng-cancel').addEventListener('click', () => closeModal('new-game-modal'));

  document.getElementById('ng-save').addEventListener('click', () => {
    const history = state.gameHistory || [];
    history.push({
      gameId: state.gameId, date: state.date, status: 'final',
      teams: state.teams, inningScores: state.inningScores,
      players: state.players, atBats: state.atBats,
    });
    const fresh = defaultState(state.totalInnings);
    fresh.teams = JSON.parse(JSON.stringify(state.teams));
    fresh.players = JSON.parse(JSON.stringify(state.players));
    // Reset player stats (keep roster, clear at-bats)
    fresh.atBats = [];
    fresh.gameHistory = history;
    state = fresh;
    saveState();
    renderAll();
    closeModal('new-game-modal');
    resetRoomCode();
  });

  document.getElementById('ng-discard').addEventListener('click', () => {
    const history = state.gameHistory || [];
    const fresh = defaultState(state.totalInnings);
    fresh.gameHistory = history;
    state = fresh;
    saveState();
    renderAll();
    closeModal('new-game-modal');
    resetRoomCode();
  });

  // ─── SCHEDULE EVENTS ─────────────────────────────────────────────────────────

  let editingGameId = null;

  document.getElementById('add-game-btn').addEventListener('click', () => {
    editingGameId = null;
    document.getElementById('schedule-modal-title').textContent = 'Schedule Game';
    document.getElementById('sc-date').value     = '';
    document.getElementById('sc-time').value     = '';
    document.getElementById('sc-home').value     = state.teams.home.name !== 'Home Team' ? state.teams.home.name : '';
    document.getElementById('sc-away').value     = state.teams.away.name !== 'Away Team' ? state.teams.away.name : '';
    document.getElementById('sc-location').value = '';
    document.getElementById('sc-notes').value    = '';
    openModal('schedule-modal');
    setTimeout(() => document.getElementById('sc-date').focus(), 80);
  });

  document.getElementById('sc-cancel').addEventListener('click', () => closeModal('schedule-modal'));

  document.getElementById('sc-save').addEventListener('click', () => {
    const date = document.getElementById('sc-date').value;
    const home = document.getElementById('sc-home').value.trim();
    const away = document.getElementById('sc-away').value.trim();
    if (!date || !home || !away) {
      alert('Please fill in date, home team, and away team.');
      return;
    }

    const game = {
      id:       editingGameId || uid(),
      date,
      time:     document.getElementById('sc-time').value,
      home,
      away,
      location: document.getElementById('sc-location').value.trim(),
      notes:    document.getElementById('sc-notes').value.trim(),
      ts:       Date.now(),
    };

    const idx = schedule.findIndex(g => g.id === game.id);
    if (idx >= 0) schedule[idx] = game;
    else schedule.push(game);

    saveScheduleLocal();
    renderSchedule();
    renderUpcomingBanner();
    closeModal('schedule-modal');
  });

  document.getElementById('schedule-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.action === 'del-game') {
      if (!confirm('Delete this scheduled game?')) return;
      schedule = schedule.filter(g => g.id !== id);
      saveScheduleLocal();
      renderSchedule();
      renderUpcomingBanner();
    }

    if (btn.dataset.action === 'edit-game') {
      const g = schedule.find(x => x.id === id);
      if (!g) return;
      editingGameId = id;
      document.getElementById('schedule-modal-title').textContent = 'Edit Game';
      document.getElementById('sc-date').value     = g.date;
      document.getElementById('sc-time').value     = g.time || '';
      document.getElementById('sc-home').value     = g.home;
      document.getElementById('sc-away').value     = g.away;
      document.getElementById('sc-location').value = g.location || '';
      document.getElementById('sc-notes').value    = g.notes    || '';
      openModal('schedule-modal');
    }
  });

  // ─── SHARE ───────────────────────────────────────────────────────────────────

  document.getElementById('golive-btn').addEventListener('click', () => {
    const base = location.href.replace(/\/[^/]*$/, '/');
    const url  = base + 'spectator.html?room=' + roomCode;
    window.open(url, '_blank');
    navigator.clipboard.writeText(url).then(() => showToast()).catch(() => showToast());
  });

  function showToast() {
    const t = document.getElementById('share-toast');
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3500);
  }

  document.getElementById('copy-btn').addEventListener('click', () => {
    const url = document.getElementById('share-url').value;
    navigator.clipboard.writeText(url).catch(() => {
      document.getElementById('share-url').select();
      document.execCommand('copy');
    });
    const btn = document.getElementById('copy-btn');
    const prev = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => (btn.textContent = prev), 2000);
  });

  document.getElementById('share-close').addEventListener('click', () => closeModal('share-modal'));

  // ─── SETTINGS ────────────────────────────────────────────────────────────────

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('set-innings').value = state.totalInnings;
    openModal('settings-modal');
  });
  document.getElementById('set-cancel').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('set-save').addEventListener('click', () => {
    const n = Math.max(1, Math.min(12, parseInt(document.getElementById('set-innings').value) || 5));
    const old = state.inningScores;
    state.totalInnings = n;
    state.inningScores = Array.from({ length: n }, (_, i) => old[i] || { away: 0, home: 0 });
    if (state.currentInning > n) state.currentInning = n;
    saveState();
    renderAll();
    closeModal('settings-modal');
  });

  // ─── MODAL HELPERS ───────────────────────────────────────────────────────────

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }
  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', () => bd.closest('.modal').classList.add('hidden'));
  });

  // ─── VIEWER MODE ─────────────────────────────────────────────────────────────

  function checkViewerMode() {
    const params = new URLSearchParams(location.search);
    if (!params.has('share')) return;
    try {
      const decoded = JSON.parse(decodeURIComponent(escape(atob(params.get('share')))));
      state = Object.assign(defaultState(decoded.totalInnings), decoded);
      isViewer = true;
      document.body.classList.add('viewer-mode');
      document.getElementById('viewer-banner').classList.remove('hidden');
      document.getElementById('golive-btn').style.display = 'none';
    } catch (e) {
      console.warn('Bad share data');
    }
  }

  // ─── RECAP CARD ──────────────────────────────────────────────────────────────

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawRecapCard(canvas, g) {
    // g = game snapshot (defaults to current state)
    const gs = g || state;
    const W = 600, H = 430;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const awayR = gs.inningScores.reduce((s, i) => s + (i.away || 0), 0);
    const homeR = gs.inningScores.reduce((s, i) => s + (i.home || 0), 0);
    const awayH = Object.values(gs.players || {}).filter(p => p.team === 'away')
      .reduce((s, p) => s + computeStatsFromAbs(gs.atBats.filter(a => a.playerId === p.id)).H, 0);
    const homeH = Object.values(gs.players || {}).filter(p => p.team === 'home')
      .reduce((s, p) => s + computeStatsFromAbs(gs.atBats.filter(a => a.playerId === p.id)).H, 0);

    const sf = (size, weight) => (weight || 'normal') + ' ' + size + 'px system-ui,-apple-system,sans-serif';
    const trunc = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

    // ── Background ──────────────────────────────
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, '#060d1c');
    bgGrad.addColorStop(1, '#090f20');
    ctx.fillStyle = bgGrad;
    roundRect(ctx, 0, 0, W, H, 16);
    ctx.fill();

    // subtle grid lines
    ctx.strokeStyle = 'rgba(96,165,250,0.04)';
    ctx.lineWidth = 1;
    for (let y = 0; y < H; y += 24) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // outer border
    ctx.strokeStyle = 'rgba(96,165,250,0.18)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, 1, 1, W - 2, H - 2, 15);
    ctx.stroke();

    // ── Header band ─────────────────────────────
    const hBg = ctx.createLinearGradient(0, 0, W, 0);
    hBg.addColorStop(0, 'rgba(37,99,235,0.25)');
    hBg.addColorStop(1, 'rgba(37,99,235,0.05)');
    ctx.fillStyle = hBg;
    roundRect(ctx, 0, 0, W, 46, 16);  // only top rounded
    ctx.fill();

    ctx.font = sf(14, 'bold');
    ctx.fillStyle = '#93c5fd';
    ctx.textAlign = 'left';
    ctx.fillText('⚾  PINES WIFFLE', 20, 30);

    const dateStr = new Date(gs.date).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    ctx.font = sf(11);
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    ctx.fillText(dateStr, W - 20, 30);

    // ── Status pill ─────────────────────────────
    const finalText = gs.status === 'final' ? 'FINAL' : 'IN PROGRESS';
    const pillColor = gs.status === 'final' ? '#22c55e' : '#f59e0b';
    ctx.font = sf(10, 'bold');
    const pillW = ctx.measureText(finalText).width + 16;
    ctx.fillStyle = gs.status === 'final' ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)';
    ctx.textAlign = 'center';
    roundRect(ctx, W/2 - pillW/2, 58, pillW, 18, 9);
    ctx.fill();
    ctx.fillStyle = pillColor;
    ctx.fillText(finalText, W/2, 71);

    // ── Big scores ──────────────────────────────
    const scoreY = 94;
    ctx.font = sf(11, 'bold');
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(trunc(gs.teams.away.name, 14).toUpperCase(), 30, scoreY);
    ctx.textAlign = 'right';
    ctx.fillText(trunc(gs.teams.home.name, 14).toUpperCase(), W - 30, scoreY);

    ctx.font = sf(88, 'bold');
    ctx.textAlign = 'left';
    ctx.fillStyle = awayR >= homeR ? '#f1f5f9' : '#334155';
    ctx.fillText(String(awayR), 30, scoreY + 88);
    ctx.textAlign = 'right';
    ctx.fillStyle = homeR >= awayR ? '#f1f5f9' : '#334155';
    ctx.fillText(String(homeR), W - 30, scoreY + 88);

    ctx.font = sf(20, 'bold');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#334155';
    ctx.fillText('—', W/2, scoreY + 56);

    // ── Divider ─────────────────────────────────
    const divY = scoreY + 104;
    ctx.strokeStyle = 'rgba(96,165,250,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(20, divY); ctx.lineTo(W - 20, divY); ctx.stroke();

    // ── Scoreboard ──────────────────────────────
    const innings = gs.totalInnings;
    const sbX     = 64;
    const avail   = W - sbX - 60;
    const cellW   = Math.min(38, Math.floor(avail / innings));
    const rColX   = sbX + innings * cellW + 8;
    const sbRow1  = divY + 18;
    const sbRow2  = sbRow1 + 19;
    const sbRow3  = sbRow2 + 19;

    // inning headers
    ctx.font = sf(9, 'bold');
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    for (let i = 0; i < innings; i++) {
      ctx.fillText(String(i + 1), sbX + i * cellW + cellW / 2, sbRow1);
    }
    ctx.fillText('R', rColX + 12, sbRow1);
    ctx.fillText('H', rColX + 30, sbRow1);

    // team rows
    [[gs.teams.away.name, 'away', awayR, awayH, sbRow2],
     [gs.teams.home.name, 'home', homeR, homeH, sbRow3]].forEach(([name, side, runs, hits, rowY]) => {
      ctx.font = sf(9, 'bold');
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'left';
      ctx.fillText(trunc(name, 7).toUpperCase(), 10, rowY);
      for (let i = 0; i < innings; i++) {
        const sc = gs.inningScores[i]?.[side] ?? 0;
        ctx.textAlign = 'center';
        ctx.fillStyle = sc > 0 ? '#94a3b8' : '#334155';
        ctx.fillText(String(sc), sbX + i * cellW + cellW / 2, rowY);
      }
      ctx.font = sf(9, 'bold');
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(String(runs), rColX + 12, rowY);
      ctx.fillStyle = '#64748b';
      ctx.fillText(String(hits), rColX + 30, rowY);
    });

    // ── Top performers ───────────────────────────
    const perfY = sbRow3 + 24;
    ctx.strokeStyle = 'rgba(96,165,250,0.12)';
    ctx.beginPath(); ctx.moveTo(20, perfY); ctx.lineTo(W - 20, perfY); ctx.stroke();

    ctx.font = sf(9, 'bold');
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'left';
    ctx.fillText('TOP PERFORMERS', 20, perfY + 15);

    const allP = Object.values(gs.players || {});
    const cats = [
      { icon: '🏆', lbl: 'AVG', key: 'AVG', cmp: v => parseFloat(v), minAB: 1,
        fmt: (p, s) => (p.number ? '#' + p.number + ' ' : '') + p.name + '   ' + s.AVG + ' AVG' },
      { icon: '💥', lbl: 'HR',  key: 'HR',  cmp: v => v, minAB: 0,
        fmt: (p, s) => (p.number ? '#' + p.number + ' ' : '') + p.name + '   ' + s.HR + ' HR' },
      { icon: '🎯', lbl: 'RBI', key: 'RBI', cmp: v => v, minAB: 0,
        fmt: (p, s) => (p.number ? '#' + p.number + ' ' : '') + p.name + '   ' + s.RBI + ' RBI' },
    ];

    const colW = Math.floor((W - 40) / cats.length);
    cats.forEach(({ icon, lbl, key, cmp, minAB, fmt }, ci) => {
      const leaders = allP
        .map(p => ({ p, s: computeStatsFromAbs((gs.atBats || []).filter(a => a.playerId === p.id)) }))
        .filter(({ s }) => s.AB >= minAB && cmp(s[key]) > 0)
        .sort((a, b) => cmp(b.s[key]) - cmp(a.s[key]));
      if (!leaders.length) return;
      const { p, s } = leaders[0];
      const cx = 20 + ci * colW;
      ctx.font = sf(11);
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.fillText(icon + ' ' + lbl, cx, perfY + 34);
      ctx.font = sf(11, 'bold');
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(trunc(p.name, 12), cx, perfY + 50);
      ctx.font = sf(14, 'bold');
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(String(s[key]), cx, perfY + 68);
    });

    // ── Footer ──────────────────────────────────
    ctx.font = sf(10);
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'center';
    ctx.fillText('Scored with Pines Wiffle Tracker', W / 2, H - 12);
  }

  function openRecap(gameSnapshot) {
    const modal = document.getElementById('recap-modal');
    modal.classList.remove('hidden');
    const canvas = document.getElementById('recap-canvas');
    drawRecapCard(canvas, gameSnapshot || null);
  }

  document.getElementById('recap-btn').addEventListener('click', () => openRecap());
  document.getElementById('recap-close').addEventListener('click', () => {
    document.getElementById('recap-modal').classList.add('hidden');
  });
  document.getElementById('recap-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('recap-modal') ||
        e.target.classList.contains('modal-backdrop')) {
      document.getElementById('recap-modal').classList.add('hidden');
    }
  });

  document.getElementById('recap-download').addEventListener('click', () => {
    const canvas = document.getElementById('recap-canvas');
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pines-wiffle-recap.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  });

  document.getElementById('recap-share').addEventListener('click', async () => {
    const canvas = document.getElementById('recap-canvas');
    canvas.toBlob(async blob => {
      const file = new File([blob], 'pines-wiffle-recap.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: 'Game Recap — Pines Wiffle',
            files: [file],
          });
        } catch (e) { /* user cancelled */ }
      } else {
        // Fallback: download
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'pines-wiffle-recap.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    }, 'image/png');
  });

  // Recap button in history list
  document.getElementById('history-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="recap"]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    openRecap(state.gameHistory[idx]);
  });

  // ─── INIT ────────────────────────────────────────────────────────────────────

  checkViewerMode();
  renderAll();
  renderGear();
  initHostPeer();

  // If opened via Watch button, jump straight to the Live tab
  if (new URLSearchParams(location.search).has('watch')) {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="live"]').classList.add('active');
    document.getElementById('tab-live').classList.add('active');
    renderLiveView();
  }

  // Register service worker for PWA / offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

})();
