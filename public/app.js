/* global EventSource, AudioContext */
window.__ZJH_VERSION = 'remote-3';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SUITS = {
  S: { symbol: '♠', red: false },
  H: { symbol: '♥', red: true },
  D: { symbol: '♦', red: true },
  C: { symbol: '♣', red: false },
};
const RANKS = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };
const CAT_NAME = { 1: '单张', 2: '对子', 3: '顺子', 4: '金花', 5: '同花顺', 6: '豹子' };
const QUICK_CHATS = ['快点啦', '这牌绝了', '跟到底', '溜了溜了', '老板大气', '😭', '🔥'];
const LS = {
  name: 'zjh.name',
  settings: 'zjh.settings',
  sound: 'zjh.sound',
  session: 'zjh.session',
};

const app = {
  roomCode: null,
  token: null,
  state: null,
  seq: -1,
  clockOffset: 0,
  sse: null,
  sseErrors: 0,
  sseWatchdog: null,
  sseGotState: false,
  transport: 'sse',
  pollTimer: null,
  roomsTimer: null,
  timer: null,
  feedInitialized: false,
  feedLastId: 0,
  feedRoom: null,
  lastCompareAt: 0,
  lastResultAt: 0,
  celebratedAt: 0,
  seatEls: new Map(),
  myCardsHandKey: null,
  myCardsFaceKey: '',
  myCardEls: [],
  displayPot: 0,
  sound: true,
  audio: null,
  modal: null,
  sideTab: 'feed',
  unread: 0,
  actionPending: false,
  autoJoinTried: false,
  lastTurnMine: false,
};

/* -------------------------------------------------------------------------- */
/* 小工具                                                                     */
/* -------------------------------------------------------------------------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtPoints(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('zh-CN');
}

function fmtScore(value) {
  const n = Number(value) || 0;
  if (n > 0) return `+${fmtPoints(n)}`;
  if (n < 0) return `−${fmtPoints(Math.abs(n))}`;
  return '0';
}

function rankLabel(code) {
  if (!code) return '';
  const ch = code[0];
  return RANKS[ch] || ch;
}

function suitInfo(code) {
  return SUITS[code?.[1]] || { symbol: '', red: false };
}

function miniCardHtml(code) {
  if (!code) return '<i class="mini-card placeholder"></i>';
  const s = suitInfo(code);
  return `<i class="mini-card ${s.red ? 'red' : ''}"><b>${esc(rankLabel(code))}</b><span>${s.symbol}</span></i>`;
}

function timeLabel(ts) {
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* noop */ }
}

function loadSession() {
  return loadJson(LS.session, null);
}

function saveSession(code, token, name) {
  saveJson(LS.session, { code, token, name, at: Date.now() });
}

function clearSession() {
  try { localStorage.removeItem(LS.session); } catch { /* noop */ }
}

function toast(message, type = '', duration = 2600) {
  const root = $('#toasts');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.append(node);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, duration);
}

async function api(path, body) {
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch {
    const error = new Error('连不上服务器，检查一下网络或服务器是否还开着');
    error.code = 'NETWORK';
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* noop */ }
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || `请求失败（${res.status}）`);
    error.code = data?.code || 'HTTP_ERROR';
    error.status = res.status;
    throw error;
  }
  return data;
}

function showBootLoading(text = '正在进入房间…') {
  const el = $('#boot-loading');
  if (!el) return;
  const p = el.querySelector('p');
  if (p) p.textContent = text;
  el.classList.remove('hidden');
}

function hideBootLoading() {
  $('#boot-loading')?.classList.add('hidden');
}

function handleError(error, { silent = false } = {}) {
  if (!error) return;
  if (error.code === 'UNAUTHORIZED' || error.status === 401) {
    if (app.roomCode) {
      expireSession();
      return;
    }
    if (!silent) toast(error.message || '房间会话已失效，请重新加入', 'error');
    return;
  }
  if (!silent) toast(error.message || '操作失败', 'error');
}

/* -------------------------------------------------------------------------- */
/* 启动                                                                       */
/* -------------------------------------------------------------------------- */

boot();

async function boot() {
  app.sound = loadJson(LS.sound, true) !== false;
  const savedName = loadJson(LS.name, '');
  if (savedName) {
    $('#create-name').value = savedName;
    $('#join-name').value = savedName;
  }
  const savedSettings = loadJson(LS.settings, null);
  if (savedSettings) applySettingsForm(savedSettings);

  bindLanding();
  bindRoom();
  bindGlobal();
  renderQuickChats();
  updateSoundButton();
  updateResumeButton();
  startTimer();
  refreshRooms();
  app.roomsTimer = setInterval(() => {
    if (!app.state && !document.hidden) refreshRooms(true);
  }, 5000);
  await handleInvite();
}

function updateResumeButton() {
  const btn = $('#resume-room');
  if (!btn) return;
  const session = loadSession();
  const params = new URLSearchParams(location.search);
  const hasRoomParam = Boolean(params.get('room'));
  if (!session?.code || !session.token || hasRoomParam || app.state) {
    btn.classList.add('hidden');
    return;
  }
  $('#resume-code').textContent = session.code;
  btn.classList.remove('hidden');
}

async function resumeSession() {
  const session = loadSession();
  if (!session?.code || !session.token) {
    updateResumeButton();
    return;
  }
  const btn = $('#resume-room');
  btn.disabled = true;
  showBootLoading('正在回到上次房间…');
  try {
    const data = await api('/api/join', {
      code: session.code,
      token: session.token,
      name: session.name,
    });
    enterRoom(data);
  } catch (error) {
    clearSession();
    updateResumeButton();
    handleError(error);
  } finally {
    btn.disabled = false;
    hideBootLoading();
  }
}

async function handleInvite() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!code) return;
  $('#join-code').value = code;
  switchTab('join');
  const session = loadSession();
  if (session?.code === code && session.token) {
    app.autoJoinTried = true;
    showBootLoading();
    try {
      const data = await api('/api/join', { code, token: session.token, name: session.name });
      enterRoom(data);
    } catch (error) {
      clearSession();
      if (error.code !== 'UNAUTHORIZED' && error.code !== 'NOT_FOUND') {
        toast(error.message, 'error');
      }
    } finally {
      hideBootLoading();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 大厅                                                                       */
/* -------------------------------------------------------------------------- */

function bindLanding() {
  $$('.lobby-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('#create-btn').addEventListener('click', createRoom);
  $('#join-btn').addEventListener('click', joinRoom);
  $('#refresh-rooms').addEventListener('click', () => refreshRooms());
  $('#rules-btn').addEventListener('click', openRules);
  $('#remote-btn').addEventListener('click', openRemoteJoin);
  $('#mobile-join-btn').addEventListener('click', openMobileJoin);
  $('#resume-room').addEventListener('click', resumeSession);
  $('#join-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  for (const selector of ['#create-name', '#join-name', '#join-code']) {
    $(selector).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (selector === '#join-code') joinRoom();
        else if (selector === '#create-name') createRoom();
        else joinRoom();
      }
    });
    $(selector).addEventListener('input', (event) => event.target.classList.remove('input-error'));
  }
}

function switchTab(tab) {
  $$('.lobby-tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
  $$('.lobby-pane').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.pane !== tab));
  if (tab === 'join') {
    setTimeout(() => {
      const code = $('#join-code');
      if (!code.value) code.focus();
      else $('#join-name').focus();
    }, 50);
  }
}

function readName(input) {
  const name = input.value.trim().replace(/\s+/g, ' ').slice(0, 12);
  if (!name) {
    input.classList.add('input-error');
    input.focus();
    toast('先给自己取个昵称吧', 'error');
    return null;
  }
  saveJson(LS.name, name);
  input.value = name;
  return name;
}

function getCreateSettings() {
  const ante = Number($('#set-ante').value) || 10;
  return {
    ante,
    baseBet: ante,
    maxBet: Number($('#set-max').value) || 200,
    turnSeconds: Number($('#set-time').value) || 30,
    special235: $('#set-235').checked,
  };
}

function applySettingsForm(settings) {
  if (!settings) return;
  if (settings.ante) $('#set-ante').value = String(settings.ante);
  if (settings.maxBet) $('#set-max').value = String(settings.maxBet);
  if (settings.turnSeconds) $('#set-time').value = String(settings.turnSeconds);
  $('#set-235').checked = Boolean(settings.special235);
  if (settings.listed !== undefined) $('#set-listed').checked = Boolean(settings.listed);
}

async function createRoom() {
  const name = readName($('#create-name'));
  if (!name) return;
  const settings = getCreateSettings();
  saveJson(LS.settings, { ...settings, listed: $('#set-listed').checked });
  const btn = $('#create-btn');
  setButtonBusy(btn, true, '创建中…');
  try {
    const data = await api('/api/create', {
      name,
      settings,
      listed: $('#set-listed').checked,
    });
    enterRoom(data);
  } catch (error) {
    handleError(error);
  } finally {
    setButtonBusy(btn, false);
  }
}

async function joinRoom() {
  const name = readName($('#join-name'));
  if (!name) return;
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length < 6) {
    $('#join-code').classList.add('input-error');
    $('#join-code').focus();
    toast('请输入完整的 6 位房间号', 'error');
    return;
  }
  const btn = $('#join-btn');
  setButtonBusy(btn, true, '加入中…');
  try {
    const data = await api('/api/join', { code, name });
    enterRoom(data);
  } catch (error) {
    if (error.code === 'NOT_FOUND') $('#join-code').classList.add('input-error');
    handleError(error);
  } finally {
    setButtonBusy(btn, false);
  }
}

function setButtonBusy(btn, busy, busyText = '') {
  if (!btn) return;
  if (busy) {
    btn.dataset.original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span>${esc(busyText)}</span><b>···</b>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.original) {
      btn.innerHTML = btn.dataset.original;
      delete btn.dataset.original;
    }
  }
}

function enterRoom(data) {
  app.roomCode = data.code;
  app.token = data.token;
  app.seq = -1;
  app.feedInitialized = false;
  app.feedLastId = 0;
  app.feedRoom = data.code;
  app.lastCompareAt = 0;
  app.lastResultAt = 0;
  app.celebratedAt = 0;
  app.displayPot = 0;
  app.myCardsHandKey = null;
  app.myCardsFaceKey = '';
  app.myCardEls = [];
  app.seatEls.clear();
  app.actionPending = false;
  app.lastTurnMine = false;
  app.sideTab = 'feed';
  app.unread = 0;
  $('#seats').innerHTML = '';
  $('#my-cards').innerHTML = '';
  $('#feed-list').innerHTML = '';
  $('#confetti').innerHTML = '';
  hideBootLoading();
  updateFeedBadge();
  saveSession(data.code, data.token, data.state?.you?.name || '');
  $('#landing').classList.add('hidden');
  $('#room').classList.remove('hidden');
  document.body.classList.remove('side-open');
  document.title = `炸金花 · ${data.code}`;
  history.replaceState({}, '', `?room=${data.code}`);
  $('#resume-room').classList.add('hidden');
  handleState(data.state, { initial: true });
  connectSSE();
  closeModal();
}

function showLanding() {
  closeSSE();
  app.state = null;
  app.seq = -1;
  app.roomCode = null;
  app.token = null;
  app.feedInitialized = false;
  app.feedLastId = 0;
  app.myCardEls = [];
  app.myCardsHandKey = null;
  app.seatEls.clear();
  app.displayPot = 0;
  app.lastTurnMine = false;
  app.unread = 0;
  document.body.classList.remove('side-open');
  $('#room').classList.add('hidden');
  $('#landing').classList.remove('hidden');
  document.title = '炸金花 · 联机版';
  history.replaceState({}, '', '/');
  closeModal();
  setConn('offline');
  hideBootLoading();
  updateResumeButton();
  refreshRooms();
}

async function refreshRooms(silent = false) {
  if (app.state) return;
  const list = $('#room-list');
  try {
    const res = await fetch('/api/rooms', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('bad');
    const data = await res.json();
    renderRoomList(data.rooms || []);
  } catch {
    if (!silent) {
      list.innerHTML = '<p class="empty">连接不上服务器，稍后再试</p>';
    }
  }
}

function renderRoomList(rooms) {
  const list = $('#room-list');
  if (!rooms.length) {
    list.innerHTML = '<p class="empty">还没有公开房间，创建一个吧</p>';
    return;
  }
  list.innerHTML = '';
  for (const room of rooms) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-item';
    const phaseMap = { lobby: '等待开局', playing: '激战中', handover: '本局结束' };
    btn.innerHTML = `
      <span class="room-item-code">${esc(room.code)}</span>
      <div><b>${esc(room.hostName)} 的牌桌</b><small>底注 ${fmtPoints(room.ante)} · 封顶 ${fmtPoints(room.maxBet)} · ${phaseMap[room.phase] || ''}</small></div>
      <span class="room-item-count">${room.playerCount}/8</span>
    `;
    btn.addEventListener('click', () => {
      switchTab('join');
      $('#join-code').value = room.code;
      if (!$('#join-name').value.trim()) {
        $('#join-name').value = loadJson(LS.name, '');
      }
      $('#join-btn').focus();
      toast(`已填入房间 ${room.code}，点“加入房间”就行`, '', 2400);
    });
    list.append(btn);
  }
}

/* -------------------------------------------------------------------------- */
/* SSE 与状态                                                                 */
/* -------------------------------------------------------------------------- */

function connectSSE() {
  closeSSE();
  // 公网隧道/反向代理经常会缓冲 SSE；HTTPS 远程模式直接用短轮询，保证状态能到达。
  if (!window.EventSource || location.protocol === 'https:') {
    startPolling();
    return;
  }
  setConn('reconnecting');
  app.transport = 'sse';
  app.sseGotState = false;
  const url = `/api/events?code=${encodeURIComponent(app.roomCode)}&token=${encodeURIComponent(app.token)}`;
  const es = new EventSource(url);
  app.sse = es;
  app.sseErrors = 0;

  // 某些公网反向代理/隧道会缓冲 SSE。3 秒内没有收到状态就切换为 HTTP 轮询。
  clearTimeout(app.sseWatchdog);
  app.sseWatchdog = setTimeout(() => {
    if (!app.sse || app.sseGotState) return;
    const stalled = app.sse;
    app.sse = null;
    try { stalled.close(); } catch { /* noop */ }
    if (app.roomCode && app.token) {
      startPolling();
      toast('已切换到远程兼容模式', '', 1800);
    }
  }, 3000);

  es.onopen = () => {
    app.sseErrors = 0;
    setConn('online');
  };
  es.addEventListener('state', (event) => {
    app.sseGotState = true;
    clearTimeout(app.sseWatchdog);
    try {
      handleState(JSON.parse(event.data));
    } catch (error) {
      console.error('state parse error', error);
    }
  });
  es.addEventListener('event', (event) => {
    try {
      handleEvent(JSON.parse(event.data));
    } catch { /* noop */ }
  });
  es.onerror = () => {
    if (!app.sse) return;
    setConn('reconnecting');
    app.sseErrors += 1;
    if (app.sseErrors === 3) probeSession();
  };
}

function closeSSE() {
  clearTimeout(app.sseWatchdog);
  app.sseWatchdog = null;
  if (app.sse) {
    try { app.sse.close(); } catch { /* noop */ }
    app.sse = null;
  }
  stopPolling();
}

async function probeSession() {
  if (!app.roomCode || !app.token) return;
  try {
    const res = await fetch(`/api/state?code=${encodeURIComponent(app.roomCode)}&token=${encodeURIComponent(app.token)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401 || res.status === 404) {
      expireSession();
      return;
    }
    if (res.ok) {
      const data = await res.json();
      if (data?.ok) {
        setConn('online');
        handleState(data.state);
      }
    }
  } catch {
    setConn('offline');
  }
}

function expireSession() {
  if (!app.roomCode) return;
  const code = app.roomCode;
  clearSession();
  showLanding();
  switchTab('join');
  if (code) $('#join-code').value = code;
  toast('房间会话已失效，请重新加入', 'error', 3400);
}

function startPolling() {
  stopPolling();
  app.transport = 'poll';
  setConn('reconnecting');
  app.pollTimer = setInterval(async () => {
    if (!app.roomCode || !app.token) return;
    try {
      const res = await fetch(`/api/state?code=${encodeURIComponent(app.roomCode)}&token=${encodeURIComponent(app.token)}`);
      if (res.status === 401 || res.status === 404) {
        expireSession();
        return;
      }
      const data = await res.json();
      if (data?.ok) {
        setConn('online');
        handleState(data.state);
      }
    } catch {
      setConn('offline');
    }
  }, 1000);
  probeSession();
}

function stopPolling() {
  if (app.pollTimer) {
    clearInterval(app.pollTimer);
    app.pollTimer = null;
  }
}

function setConn(status) {
  const dot = $('#conn-status');
  if (!dot) return;
  dot.className = `conn-dot ${status}`;
  dot.title = status === 'online' ? '已连接' : status === 'reconnecting' ? '正在重连…' : '连接断开';
}

function handleState(next, { initial = false } = {}) {
  if (!next || next.code !== app.roomCode) return;
  if (!initial && app.seq >= 0 && next.seq < app.seq) return;
  const prev = app.state;
  app.state = next;
  app.seq = next.seq;
  app.clockOffset = next.serverTime - Date.now();

  if (initial) {
    app.lastCompareAt = (next.you.compareViews || []).reduce((max, view) => Math.max(max, view.at), 0);
    app.lastResultAt = next.hand?.result?.at || 0;
  }

  if (next.phase === 'playing' && prev?.phase !== 'playing') {
    app.lastCompareAt = 0;
    app.lastResultAt = 0;
    app.celebratedAt = 0;
  }

  renderAll(next);

  // 私密比牌结果
  const views = next.you.compareViews || [];
  const latest = views[views.length - 1];
  if (latest && latest.at > app.lastCompareAt) {
    app.lastCompareAt = latest.at;
    if (!initial && next.phase === 'playing') {
      openCompareResult(latest);
    }
  }

  // 本局结算
  if (next.phase === 'handover' && next.hand?.result) {
    const result = next.hand.result;
    if (!initial && result.at !== app.lastResultAt) {
      app.lastResultAt = result.at;
      if (app.modal && ['raise', 'fold', 'compare'].includes(app.modal.type)) closeModal();
      if (result.winnerSeats?.includes(next.you.seat)) {
        if (result.at !== app.celebratedAt) {
          app.celebratedAt = result.at;
          burstConfetti();
          toast(`你赢得了 ${fmtPoints(result.pot)} 分！`, 'success', 3600);
        }
      } else if (result.pot > 0) {
        const winner = result.winnerName || '赢家';
        toast(`${winner} 赢得本局底池 ${fmtPoints(result.pot)}`, '', 2200);
      }
    }
  } else if (next.phase === 'playing') {
    app.lastResultAt = 0;
  }

  // 轮到我
  const mine = Boolean(next.you.available?.isTurn);
  if (mine && !app.lastTurnMine && !initial) {
    sfx('turn');
    if (navigator.vibrate) navigator.vibrate(25);
  }
  app.lastTurnMine = mine;
  if (mine && document.hidden) {
    document.title = '🔔 轮到你了 · 炸金花';
  } else if (next.code) {
    document.title = `炸金花 · ${next.code}`;
  }
}

function handleEvent(event) {
  if (!event) return;
  const mySeat = app.state?.you?.seat;
  switch (event.type) {
    case 'deal':
      sfx('deal');
      break;
    case 'look':
      if (event.seat === mySeat) sfx('look');
      break;
    case 'call':
    case 'raise':
      sfx('chip');
      break;
    case 'fold':
      sfx('fold');
      break;
    case 'compare':
      sfx('compare');
      break;
    case 'win':
      if (event.winnerSeats?.includes(mySeat)) sfx('win');
      else sfx('winSmall');
      break;
    case 'timeout':
      sfx('timeout');
      break;
    case 'join':
    case 'leave':
      sfx('pop');
      break;
    case 'kick':
      if (event.seat === app.state?.you?.seat) {
        toast('你被房主请出了房间', 'error', 3200);
        expireSession();
      } else {
        toast(`${event.name || '一名玩家'} 被房主请出了房间`, '', 2200);
      }
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* 总渲染                                                                     */
/* -------------------------------------------------------------------------- */

function renderAll(state) {
  renderHeader(state);
  renderSeats(state);
  renderCenter(state);
  renderMyZone(state);
  renderActionBar(state);
  renderFeed(state);
  renderRank(state);
  renderSideTabs();
}

function renderHeader(state) {
  $('#room-code').textContent = state.code;
  const host = state.players.find((p) => p.seat === state.hostSeat);
  $('#room-code-btn').title = `复制邀请链接 · 房主：${host?.name || '—'}`;
  updateSoundButton();
}

/* -------------------------------------------------------------------------- */
/* 座位                                                                       */
/* -------------------------------------------------------------------------- */

function renderSeats(state) {
  const players = state.players || [];
  const viewerSeat = state.you.seat;
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const vi = sorted.findIndex((p) => p.seat === viewerSeat);
  const ordered = vi >= 0 ? [...sorted.slice(vi), ...sorted.slice(0, vi)] : sorted;
  const total = Math.max(1, ordered.length);
  const seen = new Set();
  $('#seats').classList.toggle('compact', ordered.length >= 7);

  ordered.forEach((p, index) => {
    const angle = (90 + (360 / total) * index) * (Math.PI / 180);
    const x = 50 + 38 * Math.cos(angle);
    const y = 50 + 37 * Math.sin(angle);
    let seatEl = app.seatEls.get(p.seat);
    if (!seatEl) {
      seatEl = document.createElement('div');
      seatEl.className = 'seat';
      seatEl.dataset.seat = String(p.seat);
      seatEl.innerHTML = `
        <div class="dealer-chip hidden">庄</div>
        <div class="seat-top">
          <div class="avatar"></div>
          <div class="seat-id"><div class="seat-name"></div><div class="seat-chips"></div></div>
        </div>
        <div class="seat-badges"></div>
        <div class="seat-bottom">
          <div class="seat-cards"></div>
          <div class="seat-action"></div>
        </div>
        <div class="seat-bet"></div>
        <div class="fold-stamp"><span>弃牌</span></div>
      `;
      $('#seats').append(seatEl);
      app.seatEls.set(p.seat, seatEl);
    }
    seatEl.style.setProperty('--x', `${x.toFixed(2)}%`);
    seatEl.style.setProperty('--y', `${y.toFixed(2)}%`);
    seen.add(p.seat);

    const isWinner = state.phase === 'handover' && state.hand?.result?.winnerSeats?.includes(p.seat);
    seatEl.classList.toggle('is-me', p.seat === viewerSeat);
    seatEl.classList.toggle('is-turn', Boolean(p.isTurn && state.phase === 'playing'));
    seatEl.classList.toggle('folded', Boolean(p.folded));
    seatEl.classList.toggle('winner', Boolean(isWinner));

    const avatar = seatEl.querySelector('.avatar');
    avatar.textContent = [...p.name][0] || '?';
    avatar.style.setProperty('--hue', String(p.hue ?? 150));

    const nameEl = seatEl.querySelector('.seat-name');
    nameEl.textContent = p.name;
    if (p.isHost) {
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = ' ♛';
      nameEl.append(crown);
    }

    const scoreEl = seatEl.querySelector('.seat-chips');
    scoreEl.textContent = fmtScore(p.score);
    scoreEl.classList.toggle('pos', p.score > 0);
    scoreEl.classList.toggle('neg', p.score < 0);
    scoreEl.title = `累计 ${fmtScore(p.score)} 分`;

    const badges = seatEl.querySelector('.seat-badges');
    badges.innerHTML = '';
    if (p.inHand && p.looked && !p.folded) badges.append(badge('看', 'looked'));
    if (p.isBot) badges.append(badge('AI', 'bot'));
    if (!p.connected && !p.isBot) badges.append(badge('离线', 'offline'));

    const actionEl = seatEl.querySelector('.seat-action');
    let actionText = '';
    if (p.isTurn && state.phase === 'playing' && !p.folded) actionText = '行动中…';
    else if (p.folded) actionText = '已弃牌';
    else if (p.lastAction && p.lastAction !== '底注') actionText = p.lastAction;
    else if (!p.inHand && state.phase !== 'lobby') actionText = '旁观';
    else if (p.looked) actionText = '已看牌';
    else if (p.inHand) actionText = '闷牌';
    else actionText = '已入座';
    if (isWinner) actionText = '赢家';
    actionEl.textContent = actionText;
    actionEl.className = `seat-action${isWinner ? ' winner' : p.folded ? ' folded' : p.looked ? ' looked' : ''}`;

    const cardsEl = seatEl.querySelector('.seat-cards');
    const sig = p.cards ? `f:${p.cards.join(',')}` : p.inHand ? 'b' : 'n';
    if (cardsEl.dataset.sig !== sig) {
      cardsEl.dataset.sig = sig;
      cardsEl.innerHTML = '';
      if (p.cards) {
        for (const code of p.cards) cardsEl.insertAdjacentHTML('beforeend', miniCardHtml(code));
      } else if (p.inHand) {
        for (let i = 0; i < 3; i++) cardsEl.insertAdjacentHTML('beforeend', '<i class="mini-card back"></i>');
      } else {
        for (let i = 0; i < 3; i++) cardsEl.insertAdjacentHTML('beforeend', '<i class="mini-card placeholder"></i>');
      }
    }

    const betEl = seatEl.querySelector('.seat-bet');
    if (p.inHand && p.contributed > 0) {
      betEl.textContent = `投 ${fmtPoints(p.contributed)}`;
      betEl.classList.add('visible');
      betEl.title = `本局已投入 ${fmtPoints(p.contributed)} 分`;
    } else {
      betEl.classList.remove('visible');
    }

    seatEl.querySelector('.dealer-chip').classList.toggle('hidden', !p.isDealer);
  });

  for (const [seat, el] of [...app.seatEls]) {
    if (!seen.has(seat)) {
      el.remove();
      app.seatEls.delete(seat);
    }
  }
}

function badge(text, cls = '') {
  const span = document.createElement('span');
  span.className = `mini-badge ${cls}`;
  span.textContent = text;
  return span;
}

/* -------------------------------------------------------------------------- */
/* 桌心                                                                       */
/* -------------------------------------------------------------------------- */

function renderCenter(state) {
  const hand = state.hand;
  const pot = hand?.pot || 0;
  $('#table-center').classList.toggle('handover', state.phase === 'handover');
  if (pot !== app.displayPot) {
    animateNumber($('#pot-value'), app.displayPot, pot, 380);
    app.displayPot = pot;
  }
  if (!hand) $('#pot-value').textContent = '0';

  if (hand) {
    $('#stake-pill').textContent = `单注 ${fmtPoints(hand.currentBet)} · 封顶 ${fmtPoints(hand.maxBet)}`;
    $('#hand-pill').textContent = `第 ${state.handNo} 局`;
  } else {
    $('#stake-pill').textContent = `底注 ${fmtPoints(state.settings.ante)}`;
    $('#hand-pill').textContent = state.phase === 'lobby' ? '等待开局' : '准备中';
  }

  const turnBox = $('#turn-box');
  const resultBox = $('#result-box');

  if (state.phase === 'playing' && hand) {
    const current = state.players.find((p) => p.seat === hand.turnSeat);
    const mine = hand.turnSeat === state.you.seat && !state.you.folded;
    const timerHtml = hand.deadline ? `
      <div class="timer" id="turn-timer">
        <svg viewBox="0 0 42 42">
          <circle class="timer-bg" cx="21" cy="21" r="18"></circle>
          <circle class="timer-fg" id="timer-fg" cx="21" cy="21" r="18" stroke-dasharray="113.1" stroke-dashoffset="0"></circle>
        </svg>
        <b id="timer-num">${Math.max(1, Math.ceil((hand.deadline - (Date.now() + app.clockOffset)) / 1000))}</b>
      </div>` : '';
    let line;
    if (state.you.folded) line = `观战中 · ${esc(current?.name || '等待')} 思考中`;
    else if (mine) line = '轮到你行动';
    else if (current) line = `${esc(current.name)} 思考中`;
    else line = '等待行动';
    if (!state.you.folded && !state.you.inHand) line = '本局旁观';
    turnBox.innerHTML = `
      <div class="turn-line ${mine ? 'my-turn' : ''}"><span class="turn-dot"></span>${line}</div>
      ${state.you.folded || !state.you.inHand ? '' : timerHtml}
    `;
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';
  } else if (state.phase === 'handover' && hand?.result) {
    turnBox.innerHTML = '';
    renderResultBox(state, resultBox);
    resultBox.classList.remove('hidden');
  } else {
    const host = state.players.find((p) => p.seat === state.hostSeat);
    turnBox.innerHTML = `
      <div class="turn-line"><span class="turn-dot"></span>${state.you.isHost ? '人齐就开局' : `等待房主 ${esc(host?.name || '')} 开局`}</div>
    `;
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';
  }
}

function renderResultBox(state, box) {
  const result = state.hand.result;
  const winner = state.players.find((p) => p.seat === result.winnerSeat);
  const winnerHand = result.hands?.find((h) => h.seat === result.winnerSeat);
  const iWon = result.winnerSeats?.includes(state.you.seat);
  const myDelta = result.deltas?.find((d) => d.seat === state.you.seat)?.delta || 0;
  box.innerHTML = `
    <div class="result-kicker">${iWon ? '你赢了' : '本局结束'}</div>
    <div class="result-winner">
      <div class="avatar" style="--hue:${winner?.hue ?? 150}">${esc([...(winner?.name || '?')][0] || '?')}</div>
      <div>
        <b>${esc(result.winnerName || '流局')}</b>
        <small>${esc(winnerHand?.label || result.reasonText || '')}</small>
      </div>
    </div>
    <div class="result-pot">${fmtPoints(result.pot)}<small>底池</small></div>
    <div class="result-reason">${esc(result.reasonText || '')}${result.showdown ? ' · 已摊牌' : ''}</div>
    <div class="result-deltas">${(result.deltas || []).map((d) => `<span class="${d.delta > 0 ? 'pos' : d.delta < 0 ? 'neg' : 'zero'}">${esc(d.name)} ${fmtScore(d.delta)}</span>`).join('')}</div>
    <div class="result-score">${state.you.inHand ? `本局 <b class="${myDelta >= 0 ? 'pos' : 'neg'}">${fmtScore(myDelta)}</b> · 累计 <b class="${state.you.score >= 0 ? 'pos' : 'neg'}">${fmtScore(state.you.score)}</b> 分` : '本局未参与，积分不变'}</div>
    <div class="result-countdown" id="result-countdown">${countdownText(state)}</div>
  `;
}

function countdownText(state) {
  if (!state.canStart) {
    return state.you.isHost ? '人数不足，加人或等朋友上线后再开' : '等待房主处理';
  }
  if (!state.nextHandAt) {
    return state.you.isHost ? '等待你开始下一局' : '等待房主开始下一局';
  }
  const remaining = Math.max(0, Math.ceil((state.nextHandAt - (Date.now() + app.clockOffset)) / 1000));
  return `${remaining} 秒后自动开始下一局`;
}

function animateNumber(el, from, to, duration) {
  if (!el) return;
  const start = performance.now();
  const delta = to - from;
  const step = (now) => {
    const t = clamp((now - start) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmtPoints(Math.round(from + delta * eased));
    if (t < 1) requestAnimationFrame(step);
    else {
      el.textContent = fmtPoints(to);
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  };
  requestAnimationFrame(step);
}

/* -------------------------------------------------------------------------- */
/* 我的区域                                                                   */
/* -------------------------------------------------------------------------- */

function renderMyZone(state) {
  const you = state.you;
  $('#my-name').textContent = you.name;
  const scoreEl = $('#my-score');
  scoreEl.textContent = fmtScore(you.score);
  scoreEl.classList.toggle('pos', you.score > 0);
  scoreEl.classList.toggle('neg', you.score < 0);
  $('#my-badge').classList.toggle('hidden', !you.isHost);
  renderMyCards(state);

  const label = $('#my-hand-label');
  label.className = 'hand-label';
  if (state.phase === 'lobby') {
    label.textContent = '等待开局';
  } else if (!you.inHand) {
    label.textContent = '本局旁观';
  } else if (you.folded) {
    label.textContent = '已弃牌';
    label.classList.add('bad');
  } else if (state.phase === 'handover') {
    const delta = state.hand?.result?.deltas?.find((d) => d.seat === you.seat)?.delta || 0;
    label.textContent = `本局 ${fmtScore(delta)} 分`;
    label.classList.add(delta >= 0 ? 'good' : 'bad');
  } else if (you.looked && you.handLabel) {
    label.textContent = you.handLabel;
    if ((you.handCat || 0) >= 3) label.classList.add('good');
  } else if (you.inHand) {
    label.textContent = '闷牌中 · 看牌后注额 ×2';
  } else {
    label.textContent = '等待下一局';
  }
}

function renderMyCards(state) {
  const you = state.you;
  const slotCount = you.inHand ? 3 : 0;
  const handKey = `${state.handNo}:${state.hand?.startedAt || 0}:${slotCount}`;
  const cards = you.cards;
  const container = $('#my-cards');

  if (app.myCardsHandKey !== handKey) {
    app.myCardsHandKey = handKey;
    app.myCardsFaceKey = '';
    app.myCardEls = [];
    container.innerHTML = '';
    if (slotCount === 0) {
      for (let i = 0; i < 3; i++) {
        const empty = document.createElement('div');
        empty.className = 'empty-card';
        empty.textContent = '♠';
        container.append(empty);
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const card = document.createElement('div');
        card.className = 'card';
        if (cards) card.classList.add('no-anim');
        card.innerHTML = `
          <div class="card-inner">
            <div class="card-face card-back"></div>
            <div class="card-face card-front">
              <span class="corner tl"><b></b><i></i></span>
              <span class="card-pip"></span>
              <span class="corner br"><b></b><i></i></span>
            </div>
          </div>
        `;
        container.append(card);
        app.myCardEls.push(card);
      }
      if (cards) {
        cards.forEach((code, i) => setCardFace(app.myCardEls[i], code));
        app.myCardEls.forEach((card) => card.classList.add('faceup'));
        app.myCardsFaceKey = cards.join(',');
        requestAnimationFrame(() => {
          setTimeout(() => app.myCardEls.forEach((card) => card.classList.remove('no-anim')), 60);
        });
      }
    }
  }

  if (cards && slotCount === 3) {
    const faceKey = cards.join(',');
    if (faceKey !== app.myCardsFaceKey) {
      cards.forEach((code, i) => setCardFace(app.myCardEls[i], code));
      app.myCardsFaceKey = faceKey;
      requestAnimationFrame(() => {
        app.myCardEls.forEach((card, i) => {
          if (i === 0) void card.offsetWidth;
          card.classList.add('faceup');
        });
      });
    }
  }
}

function setCardFace(card, code) {
  if (!card) return;
  const s = suitInfo(code);
  const front = card.querySelector('.card-front');
  if (!front) return;
  front.classList.toggle('red', s.red);
  const rank = rankLabel(code);
  for (const corner of front.querySelectorAll('.corner')) {
    corner.querySelector('b').textContent = rank;
    corner.querySelector('i').textContent = s.symbol;
  }
  const pip = front.querySelector('.card-pip');
  pip.textContent = s.symbol;
  pip.classList.toggle('small', rank.length > 1);
}

/* -------------------------------------------------------------------------- */
/* 操作栏                                                                     */
/* -------------------------------------------------------------------------- */

function renderActionBar(state) {
  const bar = $('#action-bar');
  const hint = $('#action-hint');
  const you = state.you;
  const hand = state.hand;

  if (state.phase === 'playing' && hand) {
    if (!you.inHand) {
      bar.innerHTML = '<div class="waiting-pill"><span class="spinner"></span> 本局旁观，下一局自动入座</div>';
      hint.textContent = '你是在牌局开始后加入的，下一局自动发牌。';
      return;
    }
    if (you.folded) {
      bar.innerHTML = '<div class="waiting-pill"><span class="spinner"></span> 你已弃牌，等待本局结束</div>';
      hint.textContent = '看看剩下的人怎么打，下一局再战。';
      return;
    }

    if (you.available.isTurn) {
      const av = you.available;
      const buttons = [];
      if (av.canLook) {
        buttons.push(actButton('look', '看牌', '免费', '看牌后注额 ×2', false, '看看自己的三张牌', 'look'));
      }
      buttons.push(actButton(
        'call',
        '跟注',
        fmtPoints(av.callCost ?? 0),
        you.looked ? '看牌价' : '闷牌价',
        !av.canCall,
        av.canCall ? `投入 ${av.callCost} 分` : '现在不能跟注',
        'primary',
      ));
      const raiseSub = av.minRaiseTo ? `最低 ${fmtPoints(av.minRaiseTo)}` : '已封顶';
      buttons.push(actButton('raise', '加注', '', raiseSub, !av.canRaise, av.canRaise ? '提高当前单注' : raiseSub));
      if (you.looked) {
        buttons.push(actButton(
          'compare',
          '比牌',
          fmtPoints(av.compareCost ?? 0),
          '费用 ×2',
          !av.canCompare,
          av.canCompare ? '选择一名对手比牌' : '没有可比的对手',
          'compare',
        ));
      }
      buttons.push(actButton('fold', '弃牌', '', '放弃本局', false, '弃牌', 'fold'));
      bar.innerHTML = buttons.join('');
      hint.textContent = you.looked
        ? `跟注 ${fmtPoints(av.callCost)} · 比牌 ${fmtPoints(av.compareCost)} · 单注 ${fmtPoints(hand.currentBet)}`
        : `闷牌跟注 ${fmtPoints(av.callCost)}；看牌后跟注翻倍。`;
      return;
    }

    if (you.available.canLook) {
      bar.innerHTML = `${actButton('look', '看牌', '免费', '随时可看', false, '看看自己的三张牌', 'look')}
        <div class="waiting-pill"><span class="spinner"></span> 等待 ${esc(currentName(state))} 行动</div>`;
      hint.textContent = '现在可以看牌，看完后跟注按 2 倍投入。';
      return;
    }

    bar.innerHTML = `<div class="waiting-pill"><span class="spinner"></span> 等待 ${esc(currentName(state))} 行动</div>`;
    hint.textContent = '你已看牌，等待其他玩家行动。';
    return;
  }

  if (state.phase === 'handover') {
    const buttons = [];
    if (you.isHost) {
      buttons.push(actButton('start', '开始下一局', '', state.canStart ? '继续战斗' : '人数不足', !state.canStart, state.canStart ? '' : '至少需要 2 名在线玩家', 'primary'));
    }
    buttons.push(actButton('details', '本局详情', '', '看看牌型', false, ''));
    buttons.push(actButton('settle', '结算算分', '', '本局 / 累计', false, '查看每人本局净分和转账建议', 'compare'));
    bar.innerHTML = buttons.join('');
    hint.textContent = state.canStart
      ? '本局净分已计入累计；结束时点「结算算分」算总账。'
      : state.you.isHost
        ? '人数不足，加人或等朋友上线后再开下一局。'
        : '人数不足，等待房主处理。';
    return;
  }

  // 大厅
  if (you.isHost) {
    bar.innerHTML = `
      ${actButton('start', '开始游戏', '', state.canStart ? '发牌' : '至少 2 人', !state.canStart, state.canStart ? '' : '至少需要 2 名在线玩家，可添加机器人', 'primary')}
      ${actButton('addbot', '加机器人', '', '陪练', state.players.length >= 8, state.players.length >= 8 ? '房间已满' : '添加机器人陪练', '')}
      ${actButton('settings', '房间设置', '', '人数 · 规则', false, '', '')}
    `;
    hint.textContent = state.canStart ? '人齐了，发牌吧。每人从 0 分起。' : '至少 2 人才能开局，也可以加机器人陪练。';
  } else {
    bar.innerHTML = '<div class="waiting-pill"><span class="spinner"></span> 等待房主开始游戏</div>';
    hint.textContent = `房间号 ${state.code} · 最多 8 人同桌 · 每人 0 分起`;
  }
}

function actButton(act, label, cost, sub, disabled = false, title = '', className = '') {
  return `<button type="button" class="act ${className}" data-act="${act}" ${disabled ? 'disabled' : ''} title="${esc(title)}">
    <span class="act-label">${esc(label)}</span>
    ${cost ? `<span class="act-cost">${esc(cost)}</span>` : ''}
    ${sub ? `<span class="act-sub">${esc(sub)}</span>` : ''}
  </button>`;
}

function currentName(state) {
  const current = state.players.find((p) => p.seat === state.hand?.turnSeat);
  return current?.name || '其他玩家';
}

/* -------------------------------------------------------------------------- */
/* 战况与排行                                                                 */
/* -------------------------------------------------------------------------- */

function renderFeed(state) {
  const list = $('#feed-list');
  if (!app.feedInitialized || app.feedRoom !== state.code) {
    app.feedInitialized = true;
    app.feedRoom = state.code;
    list.innerHTML = '';
    for (const entry of state.feed.slice(-60)) {
      list.append(createFeedItem(entry));
    }
    app.feedLastId = state.feed.length ? state.feed[state.feed.length - 1].id : 0;
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    return;
  }

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const incoming = state.feed.filter((entry) => entry.id > app.feedLastId);
  if (!incoming.length) return;
  for (const entry of incoming) {
    list.append(createFeedItem(entry));
    app.feedLastId = Math.max(app.feedLastId, entry.id);
    if (entry.kind === 'chat' && entry.seat !== state.you.seat && !isSideVisible()) {
      app.unread += 1;
    }
  }
  while (list.children.length > 100) list.firstElementChild.remove();
  app.feedLastId = Math.max(app.feedLastId, state.feed[state.feed.length - 1]?.id || 0);
  if (nearBottom) list.scrollTop = list.scrollHeight;
  updateFeedBadge();
}

function createFeedItem(entry) {
  const item = document.createElement('div');
  item.className = `feed-item ${entry.kind || ''}`;
  const time = document.createElement('span');
  time.className = 'feed-time';
  time.textContent = timeLabel(entry.t);
  const text = document.createElement('span');
  text.className = 'feed-text';
  if (entry.kind === 'chat' && entry.name) {
    const name = document.createElement('b');
    name.textContent = `${entry.name}：`;
    text.append(name, document.createTextNode(entry.text));
  } else {
    text.textContent = entry.text;
  }
  item.append(time, text);
  return item;
}

function updateFeedBadge() {
  const badge = $('#feed-badge');
  if (!badge) return;
  badge.textContent = '';
  badge.classList.toggle('visible', app.unread > 0);
}

function renderRank(state) {
  const players = [...state.players].sort((a, b) => {
    const diff = (b.score || 0) - (a.score || 0);
    if (diff) return diff;
    return (b.stats?.wins || 0) - (a.stats?.wins || 0);
  });
  const list = $('#rank-list');
  list.innerHTML = '';
  players.forEach((p, index) => {
    const score = p.score || 0;
    const delta = p.stats?.lastDelta || 0;
    const row = document.createElement('div');
    row.className = `rank-row${p.seat === state.you.seat ? ' is-me' : ''}`;
    row.innerHTML = `
      <span class="rank-no">${index + 1}</span>
      <div class="avatar" style="--hue:${p.hue ?? 150}">${esc([...p.name][0] || '?')}</div>
      <div class="rank-main"><b>${esc(p.name)}</b><small>${p.stats?.hands || 0} 局 · ${p.stats?.wins || 0} 胜${delta ? ` · 本局 ${fmtScore(delta)}` : ''}</small></div>
      <span class="rank-profit ${score > 0 ? 'pos' : score < 0 ? 'neg' : 'zero'}">${fmtScore(score)}</span>
    `;
    list.append(row);
  });
}

function bindSide() {
  $$('.side-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchSideTab(btn.dataset.sideTab));
  });
  $('#side-toggle').addEventListener('click', () => {
    document.body.classList.add('side-open');
    app.unread = 0;
    updateFeedBadge();
  });
  $('#close-side').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#side-backdrop').addEventListener('click', () => document.body.classList.remove('side-open'));
}

function switchSideTab(tab) {
  app.sideTab = tab;
  $$('.side-tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.sideTab === tab));
  $('#side-feed').classList.toggle('hidden', tab !== 'feed');
  $('#side-rank').classList.toggle('hidden', tab !== 'rank');
  if (tab === 'feed') {
    app.unread = 0;
    updateFeedBadge();
    const list = $('#feed-list');
    if (list) list.scrollTop = list.scrollHeight;
  }
}

function renderSideTabs() {
  $$('.side-tabs button').forEach((btn) => btn.classList.toggle('active', btn.dataset.sideTab === app.sideTab));
  $('#side-feed').classList.toggle('hidden', app.sideTab !== 'feed');
  $('#side-rank').classList.toggle('hidden', app.sideTab !== 'rank');
}

function isSideVisible() {
  if (window.innerWidth > 980) return app.sideTab === 'feed';
  return document.body.classList.contains('side-open') && app.sideTab === 'feed';
}

function renderQuickChats() {
  const root = $('#quick-chats');
  root.innerHTML = '';
  for (const text of QUICK_CHATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', () => sendChat(text));
    root.append(btn);
  }
}

/* -------------------------------------------------------------------------- */
/* 绑定房间事件                                                               */
/* -------------------------------------------------------------------------- */

function bindRoom() {
  bindSide();

  $('#room-code-btn').addEventListener('click', copyInvite);
  $('#settle-room').addEventListener('click', openSettlement);
  $('#remote-room').addEventListener('click', openRemoteJoin);
  $('#mobile-join-room').addEventListener('click', openMobileJoin);
  $('#sound-btn').addEventListener('click', toggleSound);
  $('#rules-btn-room').addEventListener('click', openRules);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settle-btn').addEventListener('click', openSettlement);
  $('#leave-btn').addEventListener('click', confirmLeave);
  $('#action-bar').addEventListener('click', onActionClick);
  $('#result-box').addEventListener('click', onActionClick);
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendChat(text);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 980) document.body.classList.remove('side-open');
  });
  window.addEventListener('pageshow', updateResumeButton);
}

function onActionClick(event) {
  const btn = event.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  if (app.actionPending && !['details', 'settings', 'addbot', 'settle'].includes(act)) return;
  switch (act) {
    case 'look':
      ensureAudio();
      doAction('look');
      break;
    case 'call':
      ensureAudio();
      doAction('call');
      break;
    case 'raise':
      openRaiseModal();
      break;
    case 'compare':
      openComparePicker();
      break;
    case 'fold':
      openFoldConfirm();
      break;
    case 'start':
      startGame();
      break;
    case 'addbot':
      addBot();
      break;
    case 'settings':
      openSettings();
      break;
    case 'details':
      openResultDetails();
      break;
    case 'settle':
      openSettlement();
      break;
    default:
      break;
  }
}

async function doAction(type, payload = {}) {
  if (app.actionPending) return;
  app.actionPending = true;
  try {
    await api('/api/action', {
      code: app.roomCode,
      token: app.token,
      type,
      ...payload,
    });
  } catch (error) {
    handleError(error);
    if (error.code === 'NOT_YOUR_TURN') refreshState();
  } finally {
    app.actionPending = false;
  }
}

async function startGame() {
  if (app.actionPending) return;
  app.actionPending = true;
  try {
    await api('/api/start', { code: app.roomCode, token: app.token });
    ensureAudio();
  } catch (error) {
    handleError(error);
  } finally {
    app.actionPending = false;
  }
}

async function addBot() {
  if (app.actionPending) return;
  app.actionPending = true;
  try {
    const data = await api('/api/addbot', { code: app.roomCode, token: app.token });
    toast(`机器人 ${data.name} 入座了`, 'success');
    await refreshState();
    if (app.modal?.type === 'settings') openSettings();
  } catch (error) {
    handleError(error);
  } finally {
    app.actionPending = false;
  }
}

async function refreshState() {
  if (!app.roomCode || !app.token) return;
  try {
    const res = await fetch(`/api/state?code=${encodeURIComponent(app.roomCode)}&token=${encodeURIComponent(app.token)}`);
    if (res.status === 401 || res.status === 404) {
      expireSession();
      return;
    }
    const data = await res.json();
    if (data?.ok) handleState(data.state);
  } catch { /* noop */ }
}

async function sendChat(text) {
  if (!text) return;
  try {
    await api('/api/chat', { code: app.roomCode, token: app.token, text });
    ensureAudio();
  } catch (error) {
    handleError(error);
  }
}

async function copyText(text) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* noop */ }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { /* noop */ }
  }
  return ok;
}

async function copyInvite() {
  if (!app.roomCode) return;
  let base = location.origin;
  if (['127.0.0.1', 'localhost', '::1'].includes(location.hostname)) {
    try {
      const res = await fetch('/api/network', { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const net = await res.json();
        if (net.lan?.[0]) base = net.lan[0];
      }
    } catch { /* noop */ }
  }
  const link = `${base}/?room=${app.roomCode}`;
  const ok = await copyText(link);
  if (base === location.origin && ['127.0.0.1', 'localhost', '::1'].includes(location.hostname)) {
    toast(ok ? '链接已复制，但手机需要和电脑同一 WiFi' : `房间号 ${app.roomCode}，让朋友在大厅输入`, ok ? 'success' : 'error');
    return;
  }
  toast(ok ? '邀请链接已复制，发给朋友吧' : `房间号 ${app.roomCode}，让朋友在大厅输入`, ok ? 'success' : '');
}

async function openMobileJoin() {
  let net = null;
  try {
    const res = await fetch('/api/network', { headers: { Accept: 'application/json' } });
    if (res.ok) net = await res.json();
  } catch { /* noop */ }

  if (net?.cloud) {
    openRemoteJoin();
    return;
  }

  const lan = Array.isArray(net?.lan) ? net.lan.filter(Boolean) : [];
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
  const base = isLocal ? (lan[0] || net?.local || location.origin) : location.origin;
  const code = app.roomCode || '';
  const url = `${base}/${code ? `?room=${encodeURIComponent(code)}` : ''}`;
  const noLan = isLocal && !lan.length;

  const body = document.createElement('div');
  body.className = 'mobile-join';
  body.innerHTML = `
    <p class="join-lead">手机和电脑连同一个 WiFi，然后在手机浏览器打开这个地址：</p>
    <div class="join-url-row">
      <code class="join-url">${esc(url)}</code>
      <button type="button" data-copy="${esc(url)}">复制</button>
    </div>
    ${code ? `<div class="join-code-line">房间号 <b>${esc(code)}</b><span>打开后会自动填入房间号，填昵称即可加入</span></div>` : ''}
    ${lan.length > 1 ? `<p class="join-lan-list">其他可用地址：${lan.slice(1).map((u) => esc(code ? `${u}/?room=${encodeURIComponent(code)}` : `${u}/`)).join('、')}</p>` : ''}
    <ol class="join-steps">
      <li>确认手机和电脑在同一个 WiFi / 路由器下。</li>
      <li>把上面的地址复制到手机浏览器打开。</li>
      ${code ? `<li>手机打开后填昵称，点“加入房间”，就会和电脑同桌。</li>` : '<li>先在电脑上创建房间，再点“手机加入”复制带房间号的链接。</li>'}
      <li>如果手机打不开，检查 Windows 防火墙是否允许 Node.js 访问<strong>专用网络</strong>。</li>
    </ol>
    <p class="join-note">${noLan ? '没有检测到局域网 IP，请确认电脑已连接 WiFi/路由器。' : '电脑上开房间，手机加入同一个房间即可实时联机；不需要同一个浏览器或账号。'}</p>
  `;

  openModal({
    type: 'mobile-join',
    title: '手机 + 电脑一起玩',
    subtitle: '同一 WiFi 下，手机和电脑进入同一个房间',
    wide: true,
    body,
    actions: code
      ? [{ label: '知道了', className: 'solid' }]
      : [
        { label: '关闭', className: '' },
        {
          label: '去创建房间',
          className: 'solid',
          onClick: () => {
            switchTab('create');
            setTimeout(() => $('#create-name').focus(), 80);
          },
        },
      ],
    onOpen: (modal) => {
      $$('[data-copy]', modal).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await copyText(btn.dataset.copy);
          toast(ok ? '地址已复制，发到手机上打开' : '复制失败，请手动选中地址', ok ? 'success' : 'error');
        });
      });
    },
  });
}

async function openRemoteJoin() {
  let net = null;
  try {
    const res = await fetch('/api/network', { headers: { Accept: 'application/json' } });
    if (res.ok) net = await res.json();
  } catch { /* noop */ }

  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname);
  const tunnelHost = /(^|\.)(trycloudflare\.com|lhr\.life|serveousercontent\.com|ngrok-free\.app|ngrok\.io)$/i.test(location.hostname);
  const hosted = !isLocal && !tunnelHost;
  const rawPublic = net?.publicUrl || (!isLocal ? location.origin : '');
  const publicUrl = rawPublic ? rawPublic.replace(/\/+$/, '') : '';
  const code = app.roomCode || '';
  const link = publicUrl ? `${publicUrl}/${code ? `?room=${encodeURIComponent(code)}` : ''}` : '';

  const body = document.createElement('div');
  body.className = 'mobile-join remote-join';
  if (publicUrl) {
    const steps = hosted
      ? `
        <li>对方不需要安装任何东西，浏览器打开链接即可。</li>
        <li>填昵称、点「加入房间」，就会进入同一个房间。</li>
        <li>这是云端服务器，不依赖本地电脑，也不占用你的校园网上行。</li>
        <li>房间数据在服务器内存里，服务重启后会清空。</li>
      `
      : `
        <li>对方不需要安装任何东西，浏览器打开链接即可。</li>
        <li>填昵称、点「加入房间」，就会进入同一个房间。</li>
        <li>远程模式每秒同步；建议把牌桌留在前台，切后台可能延迟。</li>
        <li>这台电脑要保持开机，运行隧道的窗口/进程不要关。</li>
        <li>隧道重启后公网地址会变，请重新复制。</li>
      `;
    const note = hosted
      ? '当前运行在云端服务器，公网地址固定；本地电脑和校园网不再是服务器。'
      : '当前使用 Cloudflare 免费临时隧道（trycloudflare.com），适合朋友间临时玩；长期固定可使用命名 Cloudflare Tunnel、自己的服务器或云主机部署。';
    body.innerHTML = `
      <p class="join-lead">把下面的公网地址发给朋友，手机/电脑在任何网络下都能打开：</p>
      <div class="join-url-row">
        <code class="join-url">${esc(link)}</code>
        <button type="button" data-copy="${esc(link)}">复制</button>
      </div>
      ${code ? `<div class="join-code-line">房间号 <b>${esc(code)}</b><span>朋友打开链接后填昵称即可加入</span></div>` : ''}
      <ol class="join-steps">${steps}</ol>
      <p class="join-note">${esc(note)}</p>
    `;
  } else {
    body.innerHTML = `
      <p class="join-lead">远程通道还没有启动。在电脑上双击 <b>start-remote.bat</b>，它会启动服务器和一条免费公网隧道：</p>
      <div class="remote-command">start-remote.bat</div>
      <ol class="join-steps">
        <li>双击后等待窗口里出现 <code>https://xxxx.trycloudflare.com</code> 地址。</li>
        <li>回到这里点「刷新状态」，复制带房间号的公网链接。</li>
        <li>把链接发给任何网络下的朋友，浏览器打开就能加入。</li>
        <li>电脑保持开机；隧道窗口不要关。地址每次重启会变。</li>
      </ol>
      <p class="join-note">需要电脑能访问互联网。免费隧道不需要注册账号，适合朋友间临时联机。</p>
    `;
  }

  openModal({
    type: 'remote-join',
    title: '远程联机',
    subtitle: '不在同一个 WiFi，也能进同一个房间',
    wide: true,
    body,
    actions: publicUrl
      ? [{ label: '知道了', className: 'solid' }]
      : [
        { label: '关闭', className: '' },
        {
          label: '刷新状态',
          className: 'solid',
          onClick: () => {
            setTimeout(openRemoteJoin, 220);
          },
        },
      ],
    onOpen: (modal) => {
      $$('[data-copy]', modal).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ok = await copyText(btn.dataset.copy);
          toast(ok ? '远程链接已复制，发给朋友吧' : '复制失败，请手动选中链接', ok ? 'success' : 'error');
        });
      });
    },
  });
}

async function leaveNow() {
  try {
    await api('/api/leave', { token: app.token });
  } catch { /* noop */ }
  clearSession();
  showLanding();
  toast('已离开房间', '', 1800);
}

function confirmLeave() {
  const state = app.state;
  const hostNote = state?.you.isHost ? '你是房主，离开后房主会自动移交给下一位玩家。' : '';
  const hasScore = (state?.settlement?.entries || []).some((entry) => entry.score !== 0);
  if (hasScore && (state.you.isHost || state.you.score !== 0)) {
    openModal({
      type: 'leave',
      title: '还有分数没结清',
      subtitle: hostNote || '建议先看一眼本场结算，再决定是否离开。',
      body: `<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">当前正分合计 <b class="pos">${fmtScore(state.settlement.totalPositive)}</b>，负分合计 <b class="neg">${fmtScore(-state.settlement.totalNegative)}</b>。离开后分数仍会留在结算账本里，但房间可能散掉，最好先截图或复制结算。</p>`,
      actions: [
        { label: '继续打', className: '' },
        { label: '查看结算', className: 'solid', keepOpen: true, onClick: () => openSettlement() },
        { label: '直接离开', className: 'danger', onClick: leaveNow },
      ],
    });
    return;
  }
  openModal({
    type: 'leave',
    title: '离开房间？',
    subtitle: hostNote || '本局投入的分数不会退回。',
    body: '<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">离开后可以凭房间号重新加入，但当前手牌会被放弃。</p>',
    actions: [
      { label: '再想想', className: '' },
      {
        label: '确定离开',
        className: 'danger',
        onClick: leaveNow,
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* 比牌 / 加注 / 弃牌                                                         */
/* -------------------------------------------------------------------------- */

function openRaiseModal() {
  const state = app.state;
  if (!state?.hand || !state.you.available?.isTurn) return;
  const av = state.you.available;
  if (!av.canRaise || !av.minRaiseTo) return;
  const min = av.minRaiseTo;
  const max = av.maxRaiseTo;
  const looked = state.you.looked;
  const base = state.settings.baseBet;
  const current = state.hand.currentBet;
  const multiplier = looked ? 2 : 1;
  const presets = [...new Set([min, min + base, Math.min(max, current * 2), max])]
    .filter((v) => v >= min && v <= max)
    .sort((a, b) => a - b);

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="raise-readout">
      <span>加注到</span>
      <b id="raise-amount">${fmtPoints(min)}</b>
      <span>· 投入</span>
      <b id="raise-cost">${fmtPoints(min * multiplier)}</b>
    </div>
    <input id="raise-slider" class="raise-slider" type="range" min="${min}" max="${max}" step="1" value="${min}">
    <div class="raise-presets" id="raise-presets">
      ${presets.map((v) => `<button type="button" data-value="${v}">${fmtPoints(v)}</button>`).join('')}
    </div>
    <p class="raise-note">${looked ? '你已看牌，投入按单注的 2 倍计算。' : '你还在闷牌，投入按单注的 1 倍计算。'} 单注封顶 ${fmtPoints(max)}。</p>
  `;
  const actions = [
    { label: '取消', className: '' },
    {
      label: `加注到 ${fmtPoints(min)}`,
      className: 'solid',
      keepOpen: true,
      onClick: () => {},
    },
  ];
  openModal({
    type: 'raise',
    title: '加注',
    subtitle: `当前单注 ${fmtPoints(current)} · 最低加到 ${fmtPoints(min)}`,
    body,
    actions,
    onOpen: (modal) => {
      const slider = $('#raise-slider', modal);
      const amountEl = $('#raise-amount', modal);
      const costEl = $('#raise-cost', modal);
      const confirm = modal.querySelector('.modal-actions button.solid');
      const sync = (value) => {
        const v = clamp(Number(value) || min, min, max);
        slider.value = String(v);
        amountEl.textContent = fmtPoints(v);
        costEl.textContent = fmtPoints(v * multiplier);
        confirm.textContent = `加注到 ${fmtPoints(v)}`;
      };
      slider.addEventListener('input', () => sync(slider.value));
      $('#raise-presets', modal).addEventListener('click', (event) => {
        const btn = event.target.closest('[data-value]');
        if (btn) sync(btn.dataset.value);
      });
      confirm.addEventListener('click', () => {
        const value = Number(slider.value);
        closeModal();
        doAction('raise', { to: value });
      });
      sync(min);
    },
  });
}

function openComparePicker() {
  const state = app.state;
  if (!state?.hand || !state.you.available?.isTurn) return;
  const av = state.you.available;
  if (!state.you.looked) {
    toast('先看牌才能比牌', 'error');
    return;
  }
  if (!av.canCompare) {
    toast('现在不能比牌：没有可比的对手', 'error');
    return;
  }
  const targets = av.compareTargets || [];
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="compare-cost">比牌费用 <b>${fmtPoints(av.compareCost)}</b> 分 · 失败者出局</div>
    <div class="compare-targets">
      ${targets.map((t) => `
        <button type="button" class="compare-target" data-target="${t.seat}">
          <span class="avatar" style="--hue:${state.players.find((p) => p.seat === t.seat)?.hue ?? 150}">${esc([...t.name][0] || '?')}</span>
          <span class="compare-target-name">${esc(t.name)}</span>
          <span class="compare-target-state">${t.looked ? '已看牌' : '闷牌'}</span>
          <span class="compare-target-arrow">比牌 →</span>
        </button>
      `).join('')}
    </div>
    <p class="raise-note">比牌会公开胜负，但只有你们两人能看到对方的牌。</p>
  `;
  openModal({
    type: 'compare-picker',
    title: '找谁比牌？',
    subtitle: `胜者留下，败者弃牌。费用 ${fmtPoints(av.compareCost)} 分。`,
    body,
    actions: [{ label: '取消', className: '' }],
    onOpen: (modal) => {
      $$('.compare-target', modal).forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = Number(btn.dataset.target);
          closeModal();
          doAction('compare', { seat: target });
        });
      });
    },
  });
}

function openFoldConfirm() {
  const state = app.state;
  if (!state?.you.inHand) return;
  const contributed = state.hand?.seats?.[state.you.seat]?.contributed
    ?? state.players.find((p) => p.seat === state.you.seat)?.contributed
    ?? 0;
  openModal({
    type: 'fold',
    title: '确定弃牌？',
    subtitle: '弃牌后本局投入的分数不会退回。',
    body: `<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">本局你已经投入 <b style="color:var(--gold)">${fmtPoints(contributed)}</b> 分。</p>`,
    actions: [
      { label: '继续战斗', className: '' },
      {
        label: '弃牌',
        className: 'danger',
        onClick: () => doAction('fold'),
      },
    ],
  });
}

function openCompareResult(view) {
  const state = app.state;
  const aWin = view.winner === view.a;
  const iWon = view.winner === (view.iAm === 'a' ? view.a : view.b);
  const body = `
    <div class="compare-stage">
      <div class="compare-side ${aWin ? 'win' : 'lose'}">
        <div class="avatar" style="--hue:${state.players.find((p) => p.seat === view.a)?.hue ?? 150}">${esc([...view.aName][0] || '?')}</div>
        <div class="compare-name">${esc(view.aName)}${view.a === state.you.seat ? '（你）' : ''}</div>
        <div class="compare-cards">${view.aCards.map(miniCardHtml).join('')}</div>
        <div class="compare-label">${esc(view.aLabel)}</div>
      </div>
      <div class="compare-vs">VS</div>
      <div class="compare-side ${!aWin ? 'win' : 'lose'}">
        <div class="avatar" style="--hue:${state.players.find((p) => p.seat === view.b)?.hue ?? 150}">${esc([...view.bName][0] || '?')}</div>
        <div class="compare-name">${esc(view.bName)}${view.b === state.you.seat ? '（你）' : ''}</div>
        <div class="compare-cards">${view.bCards.map(miniCardHtml).join('')}</div>
        <div class="compare-label">${esc(view.bLabel)}</div>
      </div>
    </div>
    <div class="compare-verdict ${iWon ? '' : 'lose'}">${iWon ? '你赢了，对手出局' : '你输了，已出局'}</div>
  `;
  openModal({
    type: 'compare',
    title: '比牌结果',
    subtitle: '只有参与比牌的两人能看到这两手牌。',
    body,
    actions: [{ label: '知道了', className: 'solid' }],
  });
}

/* -------------------------------------------------------------------------- */
/* 结算详情 / 规则 / 设置                                                     */
/* -------------------------------------------------------------------------- */

function settlementText(data) {
  const lines = ['炸金花 · 本场结算'];
  for (const entry of data.entries) {
    lines.push(`${entry.name}${entry.left ? '（已离开）' : ''} ${fmtScore(entry.score)}`);
  }
  if (data.bots?.length) {
    lines.push('', '机器人陪练（不计入真人结算）：');
    for (const bot of data.bots) lines.push(`${bot.name} ${fmtScore(bot.score)}`);
  }
  lines.push('');
  if (!data.transfers.length) {
    lines.push('当前没有需要转账的分数。');
  } else {
    for (const transfer of data.transfers) {
      lines.push(`${transfer.from} → ${transfer.to}：${fmtPoints(transfer.amount)} 分`);
    }
  }
  lines.push('', `正分合计 ${fmtPoints(data.totalPositive)} · 负分合计 ${fmtPoints(data.totalNegative)}`);
  if (!data.balanced) lines.push(`真人分数未完全平账，差额 ${fmtScore(data.difference)} 分。`);
  return lines.join('\n');
}

function openSettlement() {
  const state = app.state;
  const data = state?.settlement;
  if (!state || !data) return;
  const rows = data.entries.length
    ? data.entries.map((entry) => `
      <div class="settle-row ${entry.left ? 'left' : ''}">
        <div class="avatar" style="--hue:${entry.seat * 37 % 360}">${esc([...entry.name][0] || '?')}</div>
        <div class="settle-main">
          <b>${esc(entry.name)}${entry.left ? ' <small>已离开</small>' : ''}</b>
          <small>${entry.score > 0 ? '应收' : entry.score < 0 ? '应付' : '持平'}</small>
        </div>
        <strong class="${entry.score > 0 ? 'pos' : entry.score < 0 ? 'neg' : 'zero'}">${fmtScore(entry.score)}</strong>
      </div>
    `).join('')
    : '<p class="settle-empty">还没有产生积分，先打一局吧。</p>';

  const transfers = data.transfers.length
    ? data.transfers.map((transfer) => `
      <div class="settle-transfer">
        <span>${esc(transfer.from)}</span><i>→</i><span>${esc(transfer.to)}</span>
        <b>${fmtPoints(transfer.amount)} 分</b>
      </div>
    `).join('')
    : '<p class="settle-empty">当前没有需要结算的转账。</p>';

  const botNote = data.bots.length
    ? `<p class="settle-note">机器人陪练的分数不计入真人结算；只把真人之间的分数结清即可。</p>`
    : '';
  const balanceNote = data.balanced
    ? ''
    : `<p class="settle-note warn">真人分数未完全平账，差额 ${fmtScore(data.difference)} 分；请检查是否有玩家中途离开。</p>`;

  const actions = [{ label: '关闭', className: '' }];
  actions.push({ label: '复制结算', className: 'solid', keepOpen: true, onClick: () => copySettlement(data) });
  if (state.you.isHost && state.phase !== 'playing') {
    actions.push({ label: '清零新赛季', className: 'danger', keepOpen: true, onClick: () => confirmResetScores() });
  }

  openModal({
    type: 'settlement',
    title: '本场结算',
    subtitle: '负数付给正数 · 系统给出最少转账组合',
    wide: true,
    body: `
      <div class="settle-stats">
        <div><span>正分合计</span><b class="pos">${fmtScore(data.totalPositive)}</b></div>
        <div><span>负分合计</span><b class="neg">${fmtScore(-data.totalNegative)}</b></div>
        <div><span>转账笔数</span><b>${data.transfers.length}</b></div>
      </div>
      <div class="settle-section">
        <h3>本次积分</h3>
        <div class="settle-list">${rows}</div>
      </div>
      <div class="settle-section">
        <h3>建议转账</h3>
        <div class="settle-transfers">${transfers}</div>
      </div>
      ${botNote}${balanceNote}
      <p class="settle-note">每局结束自动累计净分；清零后会重新从 0 分开始，历史结算不再保留。</p>
    `,
    actions,
  });
}

async function copySettlement(data) {
  try {
    await copyText(settlementText(data));
    toast('结算已复制', 'success');
  } catch {
    toast('复制失败，请手动截图', 'error');
  }
}

function confirmResetScores() {
  openModal({
    type: 'reset',
    title: '清零开始新赛季？',
    subtitle: '所有在场玩家积分回到 0，已离开玩家的结算记录也会清空。',
    body: '<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">建议先把当前结算截图或复制保存，再清零。清零后无法恢复。</p>',
    actions: [
      { label: '取消', className: '' },
      {
        label: '确认清零',
        className: 'danger',
        onClick: async () => {
          try {
            await api('/api/reset', { code: app.roomCode, token: app.token });
            await refreshState();
            toast('积分已清零，新赛季开始', 'success');
          } catch (error) {
            handleError(error);
            throw error;
          }
        },
      },
    ],
  });
}

function openResultDetails() {
  const state = app.state;
  const result = state?.hand?.result;
  if (!result) return;
  const rows = (result.hands || []).map((h) => {
    const delta = Number(h.delta) || 0;
    const score = h.score;
    return `
    <div class="result-hand ${h.seat === result.winnerSeat ? 'winner' : ''}">
      <div class="avatar" style="--hue:${state.players.find((p) => p.seat === h.seat)?.hue ?? 150}">${esc([...h.name][0] || '?')}</div>
      <div class="result-hand-main">
        <b>${esc(h.name)} ${h.folded ? '<span style="color:var(--muted-2)">· 弃牌</span>' : ''}</b>
        <small>投入 ${fmtPoints(h.contributed)} · 本局 <em class="${delta >= 0 ? 'pos' : 'neg'}">${fmtScore(delta)}</em>${score === null || score === undefined ? '' : ` · 累计 ${fmtScore(score)}`}</small>
      </div>
      <div class="result-hand-cards">${h.cards.map(miniCardHtml).join('')}</div>
      <span class="hand-tag">${esc(h.label)}</span>
    </div>
  `;
  }).join('');

  const compares = (result.compares || []).length
    ? `<div class="rules-section" style="margin-top:14px"><h3>比牌记录</h3><p>${result.compares.map((c) => `${esc(c.aName)} vs ${esc(c.bName)} · ${esc(state.players.find((p) => p.seat === c.winner)?.name || '')} 胜`).join('<br>')}</p></div>`
    : '';

  const myDelta = result.deltas?.find((d) => d.seat === state.you.seat)?.delta || 0;
  openModal({
    type: 'result',
    title: '本局牌型与积分',
    subtitle: `${result.reasonText || ''} · 底池 ${fmtPoints(result.pot)}`,
    wide: true,
    body: `
      <div class="result-summary">
        <span>赢家</span><b>${esc(result.winnerName || '流局')}</b>
        <span>底池</span><b style="color:var(--gold-bright)">${fmtPoints(result.pot)}</b>
        <span>你的本局</span><b class="${myDelta >= 0 ? 'pos' : 'neg'}">${fmtScore(myDelta)}</b>
      </div>
      <div class="result-table">${rows}</div>
      ${compares}
    `,
    actions: [
      { label: '关闭', className: '' },
      { label: '结算算分', className: '', keepOpen: true, onClick: () => openSettlement() },
      ...(state.you.isHost && state.phase === 'handover' && state.canStart
        ? [{ label: '开始下一局', className: 'solid', onClick: () => startGame() }]
        : []),
    ],
  });
}

function confirmKick(member) {
  if (!app.state?.you.isHost) return;
  openModal({
    type: 'kick',
    title: `请离 ${member.name}？`,
    subtitle: '对方会被移出房间，需要凭房间号重新加入。',
    body: `<p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">${esc(member.name)} 当前积分 ${fmtScore(member.score)} 分。请离操作在牌局进行中不可用。</p>`,
    actions: [
      { label: '取消', className: '' },
      {
        label: '请离',
        className: 'danger',
        onClick: async () => {
          try {
            await api('/api/kick', {
              code: app.roomCode,
              token: app.token,
              seat: member.seat,
            });
            await refreshState();
          } catch (error) {
            handleError(error);
            throw error;
          }
        },
      },
    ],
  });
}

function openRules() {
  const state = app.state;
  const special = state?.settings?.special235;
  openModal({    type: 'rules',
    title: '炸金花 · 玩法',
    subtitle: '2–8 人 · 标准规则 · 无小丑牌',
    wide: true,
    body: `
      <div class="rules-section">
        <h3>牌型大小</h3>
        <p>从大到小：</p>
        <div class="rank-strip">
          <span>豹子</span><span>同花顺</span><span>金花</span><span>顺子</span><span>对子</span><span>单张</span>
        </div>
        <p style="margin-top:7px">A23 是最小的顺子 / 同花顺，QKA 最大。同牌型逐张比大小；点数完全相同时比花色：黑桃 &gt; 红桃 &gt; 梅花 &gt; 方块。</p>
      </div>
      <div class="rules-section">
        <h3>闷牌与看牌</h3>
        <p>开局每人 3 张暗牌。看牌免费，但看牌后所有跟注、加注都按当前单注的 <b style="color:var(--gold)">2 倍</b> 投入；闷牌只按 1 倍。看牌是公开动作。</p>
      </div>
      <div class="rules-section">
        <h3>行动</h3>
        <ul class="rules-list">
          <li><b>跟注</b>：投入当前单注，继续留在局中。</li>
          <li><b>加注</b>：提高当前单注（不超过封顶），其他人需要按新单注跟。</li>
          <li><b>比牌</b>：看完牌后选一名对手，支付双倍跟注额，输的人直接出局。比牌结果只有你们两人能看到牌。</li>
          <li><b>弃牌</b>：放弃本局，已投入的分数不会退回。</li>
          <li>最后剩下的一人赢走全部底池。超过 120 次行动会自动摊牌。</li>
        </ul>
      </div>
      <div class="rules-section">
        <h3>积分规则</h3>
        <p>每人从 <b style="color:var(--gold)">0 分</b> 开始，可以负分。每局结束时结算一次：本局净分 = 赢得的底池 − 本局投入，累计到下一局。</p>
        <p>结束时点「结算算分」，负数玩家按分数付给正数玩家；系统会自动给出最少的转账组合。</p>
      </div>
      <div class="rules-section">
        <h3>本房间</h3>
        <p>底注 ${fmtPoints(state?.settings?.ante ?? 10)} · 单注封顶 ${fmtPoints(state?.settings?.maxBet ?? 200)} · 每回合 ${state?.settings?.turnSeconds ?? 30} 秒，超时自动弃牌。</p>
        <p>${special ? '已开启“235 吃豹子”：不同花的 2-3-5 可以击败豹子。' : '未开启“235 吃豹子”，按标准牌型比较。'}</p>
      </div>
      <div class="rules-section">
        <h3>小提示</h3>
        <p>房间最多 8 人；牌局中途加入会旁观到下一局。每局净分会自动累计；房主可以在结算面板清零开始新赛季。房主离开后会自动移交给下一位在线玩家。</p>
      </div>
    `,
    actions: [{ label: '上桌', className: 'solid' }],
  });
}

function openSettings() {
  const state = app.state;
  if (!state) return;
  const isHost = state.you.isHost;
  const locked = state.phase === 'playing';
  const s = state.settings;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="settings-grid">
      <label class="field"><span>底注</span><input id="set-ante-live" type="number" min="1" max="5000" value="${s.ante}" ${!isHost || locked ? 'disabled' : ''}></label>
      <label class="field"><span>单注封顶</span><input id="set-max-live" type="number" min="${s.baseBet}" max="1000000" value="${s.maxBet}" ${!isHost || locked ? 'disabled' : ''}></label>
      <label class="field"><span>回合时限（秒）</span><input id="set-time-live" type="number" min="10" max="180" value="${s.turnSeconds}" ${!isHost || locked ? 'disabled' : ''}></label>
    </div>
    <p class="score-rule" style="margin:2px 0 10px"><b>每人 0 分起</b> · 可负分 · 每局自动结算净分</p>
    <label class="switch-row" style="margin-top:6px">
      <span>235 吃豹子<small>地方玩法</small></span>
      <input type="checkbox" id="set-235-live" ${s.special235 ? 'checked' : ''} ${!isHost || locked ? 'disabled' : ''}>
      <i class="switch"></i>
    </label>
    <label class="switch-row">
      <span>公开房间<small>出现在大厅列表</small></span>
      <input type="checkbox" id="set-listed-live" ${s.listed !== false ? 'checked' : ''} ${!isHost || locked ? 'disabled' : ''}>
      <i class="switch"></i>
    </label>
    <label class="switch-row">
      <span>自动开始下一局<small>本局结束后 7.5 秒自动发牌（默认关闭，方便看结算）</small></span>
      <input type="checkbox" id="set-auto-live" ${state.autoStart ? 'checked' : ''} ${!isHost || locked ? 'disabled' : ''}>
      <i class="switch"></i>
    </label>
    <div class="bot-manager player-manager">
      <div class="bot-manager-head">
        <h3>在场玩家</h3>
        <span class="member-count">${state.players.length}/8</span>
      </div>
      <div class="bot-list" id="player-list-live"></div>
    </div>
    <div class="bot-manager">
      <div class="bot-manager-head">
        <h3>机器人陪练</h3>
        ${isHost && !locked && state.players.length < 8 ? '<button type="button" class="small-btn" id="add-bot-live">+ 添加机器人</button>' : ''}
      </div>
      <div class="bot-list" id="bot-list-live"></div>
    </div>
    <p class="settings-note">${locked ? '牌局进行中不能修改设置，本局结束后再改。' : isHost ? '设置只对下一局生效；积分从 0 开始，不会因设置改变。' : '只有房主可以修改设置。'}</p>
  `;
  const playerList = $('#player-list-live', body);
  const humans = state.players.filter((p) => !p.isBot);
  for (const member of humans) {
    const row = document.createElement('div');
    row.className = 'bot-row';
    const tags = [];
    if (member.isHost) tags.push('房主');
    if (member.seat === state.you.seat) tags.push('你');
    row.innerHTML = `
      <div class="avatar" style="--hue:${member.hue}">${esc([...member.name][0] || '?')}</div>
      <span>${esc(member.name)}${tags.length ? ` <small class="member-tag">${tags.join(' · ')}</small>` : ''}</span>
      <small class="member-meta">${member.connected ? '在线' : '离线'} · ${fmtScore(member.score)} 分</small>
    `;
    if (isHost && !locked && member.seat !== state.you.seat) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.textContent = '请离';
      kick.addEventListener('click', () => confirmKick(member));
      row.append(kick);
    }
    playerList.append(row);
  }
  const botList = $('#bot-list-live', body);
  const bots = state.players.filter((p) => p.isBot);
  if (!bots.length) {
    botList.innerHTML = '<p style="margin:3px 0;color:var(--muted-2);font-size:10.5px">还没有机器人。加一个凑桌，或者等朋友进来。</p>';
  } else {
    for (const bot of bots) {
      const row = document.createElement('div');
      row.className = 'bot-row';
      row.innerHTML = `<div class="avatar" style="--hue:${bot.hue}">${esc([...bot.name][0] || '?')}</div><span>${esc(bot.name)}</span>`;
      if (isHost && !locked) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '移除';
        remove.addEventListener('click', async () => {
          try {
            await api('/api/removebot', { code: app.roomCode, token: app.token, seat: bot.seat });
            await refreshState();
            if (app.modal?.type === 'settings') openSettings();
          } catch (error) {
            handleError(error);
          }
        });
        row.append(remove);
      }
      botList.append(row);
    }
  }

  const actions = [{ label: '关闭', className: '' }];
  if (isHost && !locked) {
    actions.push({
      label: '保存设置',
      className: 'solid',
      keepOpen: false,
      onClick: async () => {
        try {
          await api('/api/settings', {
            code: app.roomCode,
            token: app.token,
            settings: {
              ante: Number($('#set-ante-live', body).value),
              baseBet: Number($('#set-ante-live', body).value),
              maxBet: Number($('#set-max-live', body).value),
              turnSeconds: Number($('#set-time-live', body).value),
              special235: $('#set-235-live', body).checked,
              listed: $('#set-listed-live', body).checked,
            },
          });
          const auto = $('#set-auto-live', body).checked;
          if (auto !== state.autoStart) {
            await api('/api/autostart', {
              code: app.roomCode,
              token: app.token,
              value: auto,
            });
          }
          toast('房间设置已更新', 'success');
        } catch (error) {
          handleError(error);
          throw error;
        }
      },
    });
  }

  openModal({
    type: 'settings',
    title: '房间设置',
    subtitle: `房间 ${state.code} · ${state.players.length}/8 人 · ${locked ? '牌局进行中' : state.phase === 'handover' ? '本局结束' : '等待开局'}`,
    body,
    actions,
    onOpen: (modal) => {
      const add = $('#add-bot-live', modal);
      if (add) {
        add.addEventListener('click', async () => {
          await addBot();
        });
      }
    },
  });
}

/* -------------------------------------------------------------------------- */
/* 弹窗                                                                       */
/* -------------------------------------------------------------------------- */

function openModal({ title, subtitle = '', body, actions = [], wide = false, type = '', closable = true, onOpen = null }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = `modal${wide ? ' wide' : ''}`;
  const head = document.createElement('div');
  head.className = 'modal-head';
  head.innerHTML = `<div><h2 class="modal-title">${esc(title)}</h2>${subtitle ? `<p class="modal-sub">${esc(subtitle)}</p>` : ''}</div>`;
  if (closable) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-close';
    close.textContent = '×';
    close.addEventListener('click', closeModal);
    head.append(close);
  }
  modal.append(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  modal.append(bodyEl);

  if (actions.length) {
    const actionsEl = document.createElement('div');
    actionsEl.className = 'modal-actions';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = action.className || '';
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        try {
          const result = await action.onClick?.();
          if (result === false) return;
        } catch {
          /* 错误已提示，保留弹窗 */
          return;
        }
        if (!action.keepOpen) closeModal();
      });
      actionsEl.append(btn);
    }
    modal.append(actionsEl);
  }

  backdrop.append(modal);
  $('#modal-root').append(backdrop);
  app.modal = { backdrop, modal, type };
  if (closable) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal();
    });
  }
  setTimeout(() => {
    const focusable = modal.querySelector('button, input, select');
    focusable?.focus({ preventScroll: true });
  }, 30);
  onOpen?.(modal);
}

function closeModal() {
  if (app.modal?.backdrop) {
    app.modal.backdrop.remove();
  }
  app.modal = null;
}

/* -------------------------------------------------------------------------- */
/* 计时                                                                       */
/* -------------------------------------------------------------------------- */

function startTimer() {
  if (app.timer) clearInterval(app.timer);
  app.timer = setInterval(updateTimer, 100);
}

function updateTimer() {
  const state = app.state;
  if (!state) return;
  if (state.phase === 'playing' && state.hand?.deadline) {
    const total = Math.max(1, state.settings.turnSeconds * 1000);
    const remaining = Math.max(0, state.hand.deadline - (Date.now() + app.clockOffset));
    const ratio = clamp(remaining / total, 0, 1);
    const ring = $('#timer-fg');
    const num = $('#timer-num');
    const box = $('#turn-timer');
    if (ring) {
      const circumference = 2 * Math.PI * 18;
      ring.style.strokeDashoffset = String(circumference * (1 - ratio));
      ring.style.strokeDasharray = String(circumference);
    }
    if (num) num.textContent = String(Math.max(0, Math.ceil(remaining / 1000)));
    if (box) box.classList.toggle('urgent', remaining <= 6000 && remaining > 0);
  }
  if (state.phase === 'handover' && state.hand?.result) {
    const countdown = $('#result-countdown');
    if (countdown) countdown.textContent = countdownText(state);
  }
}

/* -------------------------------------------------------------------------- */
/* 音效                                                                       */
/* -------------------------------------------------------------------------- */

function ensureAudio() {
  if (!app.sound) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!app.audio) {
    try { app.audio = new Ctx(); } catch { return null; }
  }
  if (app.audio.state === 'suspended') app.audio.resume().catch(() => {});
  return app.audio;
}

function tone(ctx, { from = 440, to = from, duration = 0.12, type = 'sine', gain = 0.035, delay = 0 }) {
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), start + duration);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(env).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function noiseBurst(ctx, duration = 0.12, gain = 0.028) {
  const size = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < size; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / size) ** 2;
  }
  const source = ctx.createBufferSource();
  const env = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1900;
  filter.Q.value = 0.7;
  env.gain.value = gain;
  source.buffer = buffer;
  source.connect(filter).connect(env).connect(ctx.destination);
  source.start();
}

function sfx(kind) {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    switch (kind) {
      case 'deal':
        noiseBurst(ctx, 0.13, 0.026);
        tone(ctx, { from: 240, to: 180, duration: 0.08, type: 'triangle', gain: 0.016, delay: 0.04 });
        break;
      case 'chip':
        tone(ctx, { from: 1180, to: 980, duration: 0.05, type: 'triangle', gain: 0.022 });
        tone(ctx, { from: 1560, to: 1300, duration: 0.05, type: 'triangle', gain: 0.014, delay: 0.045 });
        break;
      case 'look':
        tone(ctx, { from: 520, to: 900, duration: 0.14, type: 'sine', gain: 0.02 });
        break;
      case 'fold':
        tone(ctx, { from: 170, to: 90, duration: 0.16, type: 'sine', gain: 0.03 });
        break;
      case 'compare':
        tone(ctx, { from: 220, to: 180, duration: 0.12, type: 'square', gain: 0.018 });
        tone(ctx, { from: 330, to: 260, duration: 0.16, type: 'square', gain: 0.016, delay: 0.1 });
        break;
      case 'win':
        [523, 659, 784, 1046].forEach((freq, i) => {
          tone(ctx, { from: freq, to: freq, duration: 0.18, type: 'triangle', gain: 0.03, delay: i * 0.09 });
        });
        break;
      case 'winSmall':
        [392, 523].forEach((freq, i) => {
          tone(ctx, { from: freq, to: freq, duration: 0.15, type: 'sine', gain: 0.018, delay: i * 0.08 });
        });
        break;
      case 'turn':
        tone(ctx, { from: 880, to: 880, duration: 0.08, type: 'sine', gain: 0.02 });
        tone(ctx, { from: 1320, to: 1320, duration: 0.1, type: 'sine', gain: 0.014, delay: 0.07 });
        break;
      case 'ding':
        tone(ctx, { from: 1046, to: 1046, duration: 0.1, type: 'sine', gain: 0.016 });
        break;
      case 'timeout':
        tone(ctx, { from: 230, to: 140, duration: 0.25, type: 'sawtooth', gain: 0.02 });
        break;
      case 'pop':
        tone(ctx, { from: 620, to: 820, duration: 0.07, type: 'sine', gain: 0.015 });
        break;
      default:
        break;
    }
  } catch { /* 音频不是关键路径 */ }
}

function toggleSound() {
  app.sound = !app.sound;
  saveJson(LS.sound, app.sound);
  updateSoundButton();
  if (app.sound) {
    ensureAudio();
    sfx('ding');
    toast('音效已开启', '', 1200);
  } else {
    toast('音效已关闭', '', 1200);
  }
}

function updateSoundButton() {
  const btn = $('#sound-btn');
  if (!btn) return;
  btn.textContent = app.sound ? '♪' : '♪';
  btn.classList.toggle('muted', !app.sound);
  btn.title = app.sound ? '音效：开' : '音效：关';
}

/* -------------------------------------------------------------------------- */
/* 彩带                                                                       */
/* -------------------------------------------------------------------------- */

function burstConfetti() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const root = $('#confetti');
  const colors = ['#e8c47c', '#f6dca4', '#d94a4c', '#69d39c', '#f7eddb', '#b88943'];
  for (let i = 0; i < 64; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 260}px`);
    piece.style.setProperty('--rot', `${360 + Math.random() * 720}deg`);
    piece.style.setProperty('--duration', `${1.3 + Math.random() * 1.1}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.18}s`);
    if (i % 3 === 0) {
      piece.style.width = '5px';
      piece.style.height = '9px';
    }
    root.append(piece);
  }
  setTimeout(() => { root.innerHTML = ''; }, 2800);
}

/* -------------------------------------------------------------------------- */
/* 全局事件                                                                   */
/* -------------------------------------------------------------------------- */

function bindGlobal() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (app.modal) closeModal();
      else if (document.body.classList.contains('side-open')) document.body.classList.remove('side-open');
    }
    if (event.key === 'Enter' && app.sideTab === 'feed' && app.state && !app.modal) {
      const active = document.activeElement;
      if (!active || !['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
        $('#chat-input')?.focus();
      }
    }
  });
  document.addEventListener('pointerdown', () => {
    if (app.sound && !app.audio) ensureAudio();
  }, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (app.roomCode) document.title = `炸金花 · ${app.roomCode}`;
      if (app.state) refreshState();
    }
  });
  window.addEventListener('beforeunload', () => {
    // 不主动离开：刷新页面后还能凭 token 回到原座位
  });
}
