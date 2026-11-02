import { randomBytes, randomInt } from 'node:crypto';
import {
  CATEGORY,
  compareHands,
  createDeck,
  evaluateHand,
  shuffle,
  sortForDisplay,
} from './cards.js';

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
export const MAX_ACTIONS = 120;
const MAX_FEED = 80;
const FEED_SENT = 60;
const HANDOVER_MS = 7500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const DEFAULT_SETTINGS = Object.freeze({
  ante: 10,
  baseBet: 10,
  maxBet: 200,
  turnSeconds: 30,
  special235: false,
});

const BOT_NAMES = [
  '闷神', '花姐', '老K', '阿顺', '小豹子', '铁头', '七喜', '金花王',
  '慢半拍', '看牌怪', '梭哈哥', '不跟了',
];

export class GameError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function sanitizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  s.ante = clampInt(input.ante, 1, 5000, DEFAULT_SETTINGS.ante);
  s.baseBet = clampInt(input.baseBet, 1, 5000, DEFAULT_SETTINGS.baseBet);
  s.maxBet = clampInt(input.maxBet, s.baseBet, 1_000_000, DEFAULT_SETTINGS.maxBet);
  s.turnSeconds = clampInt(input.turnSeconds, 10, 180, DEFAULT_SETTINGS.turnSeconds);
  s.special235 = Boolean(input.special235);
  if (s.maxBet < s.baseBet) s.maxBet = s.baseBet;
  return s;
}

export function sanitizeName(name) {
  if (typeof name !== 'string') throw new GameError('请输入昵称');
  let value = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  value = [...value].slice(0, 12).join('').trim();
  if (!value) throw new GameError('昵称不能为空');
  return value;
}

function hashHue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

function makePlayer({ seat, name, isBot = false }) {
  return {
    seat,
    token: isBot ? null : newToken(),
    name,
    score: 0,
    connected: isBot ? true : true,
    isBot,
    left: false,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    lastChatAt: 0,
    hue: hashHue(name + seat),
    stats: { wins: 0, hands: 0, bestPot: 0, lastDelta: 0 },
    sse: new Set(),
  };
}

function randomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function sortCards(cards) {
  return sortForDisplay(cards);
}

function activeSeats(hand) {
  return hand.order.filter((seat) => !hand.seats[seat].folded);
}

function nextActiveSeat(hand, fromSeat) {
  const seats = hand.order;
  if (!seats.length) return null;
  let idx = seats.indexOf(fromSeat);
  if (idx === -1) idx = 0;
  for (let i = 1; i <= seats.length; i++) {
    const seat = seats[(idx + i) % seats.length];
    if (!hand.seats[seat].folded) return seat;
  }
  return null;
}

function nextSeatFrom(room, fromSeat, allowedSeats) {
  const set = new Set(allowedSeats);
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const seat = (fromSeat + i + MAX_PLAYERS) % MAX_PLAYERS;
    if (set.has(seat)) return seat;
  }
  return null;
}

function callCost(hand, hs) {
  return hand.currentBet * (hs.looked ? 2 : 1);
}

function compareCost(hand, hs) {
  return callCost(hand, hs) * 2;
}

function minRaiseTo(room, hand) {
  const next = hand.currentBet + room.settings.baseBet;
  if (next > room.settings.maxBet) {
    return hand.currentBet < room.settings.maxBet ? room.settings.maxBet : null;
  }
  return next;
}

function findPlayer(room, seat) {
  return room.players.find((p) => p.seat === seat && !p.left) || null;
}

function handPlayer(room, hand, seat) {
  return findPlayer(room, seat) || hand?.seats?.[seat]?.departedPlayer || null;
}

function addFeed(room, entry) {
  const item = {
    id: ++room.feedId,
    t: Date.now(),
    kind: entry.kind || 'system',
    text: entry.text,
    seat: entry.seat ?? null,
    name: entry.name ?? null,
  };
  room.feed.push(item);
  if (room.feed.length > MAX_FEED) room.feed.splice(0, room.feed.length - MAX_FEED);
  return item;
}

function reasonText(reason) {
  switch (reason) {
    case 'others_folded': return '其余玩家弃牌';
    case 'compare': return '比牌胜出';
    case 'showdown': return '最终摊牌';
    case 'aborted': return '本局流局';
    default: return '赢得底池';
  }
}

export class GameHub {
  constructor() {
    this.rooms = new Map();
    this.sessions = new Map(); // token -> { code, seat }
    this.onState = null;
    this.onEvent = null;
  }

  /* ------------------------------------------------------------------ */
  /* 房间与玩家                                                          */
  /* ------------------------------------------------------------------ */

  createRoom({ name, settings, listed = false } = {}) {
    const cleanName = sanitizeName(name);
    const cleanSettings = sanitizeSettings(settings);
    let code;
    for (let i = 0; i < 50; i++) {
      code = randomCode();
      if (!this.rooms.has(code)) break;
    }
    if (!code || this.rooms.has(code)) throw new GameError('房间号生成失败，请重试', 'SERVER_BUSY', 503);

    const player = makePlayer({ seat: 0, name: cleanName });
    const room = {
      code,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      seq: 0,
      listed: Boolean(listed),
      settings: cleanSettings,
      autoStart: false,
      phase: 'lobby',
      players: [player],
      departed: [],
      hostSeat: 0,
      handNo: 0,
      hand: null,
      lastDealer: -1,
      nextHandAt: null,
      sessionStartedAt: Date.now(),
      feed: [],
      feedId: 0,
    };
    this.rooms.set(code, room);
    this.sessions.set(player.token, { code, seat: player.seat });
    addFeed(room, { kind: 'system', text: `${cleanName} 创建了房间`, seat: player.seat, name: cleanName });
    this.changed(room);
    return { room, player, token: player.token };
  }

  getRoom(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('房间不存在或已解散', 'NOT_FOUND', 404);
    return room;
  }

  auth(code, token) {
    const room = this.getRoom(code);
    const session = this.sessions.get(token);
    if (!session || session.code !== room.code) {
      throw new GameError('会话已失效，请重新加入房间', 'UNAUTHORIZED', 401);
    }
    const player = findPlayer(room, session.seat);
    if (!player) throw new GameError('你已不在该房间', 'UNAUTHORIZED', 401);
    return { room, player };
  }

  joinRoom({ code, name, token } = {}) {
    const room = this.getRoom(code);
    if (token) {
      const session = this.sessions.get(token);
      if (session && session.code === room.code) {
        const existing = findPlayer(room, session.seat);
        if (existing) {
          const wasDisconnected = !existing.connected;
          existing.connected = true;
          existing.justReconnected = wasDisconnected || existing.justReconnected;
          existing.lastSeen = Date.now();
          this.changed(room);
          return { room, player: existing, token, reconnected: true };
        }
      }
    }

    if (room.phase !== 'playing') this.purgeLeft(room);
    const occupiedPlayers = room.phase === 'playing'
      ? room.players
      : room.players.filter((p) => !p.left);
    if (occupiedPlayers.length >= MAX_PLAYERS) {
      throw new GameError('房间已满（最多 8 人）', 'ROOM_FULL', 409);
    }

    const cleanName = sanitizeName(name);
    if (room.players.some((p) => !p.left && p.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      throw new GameError('这个昵称已经被占用了，换一个吧', 'NAME_TAKEN', 409);
    }

    const used = new Set(occupiedPlayers.map((p) => p.seat));
    let seat = -1;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!used.has(i)) { seat = i; break; }
    }
    if (seat === -1) throw new GameError('房间已满（最多 8 人）', 'ROOM_FULL', 409);

    const player = makePlayer({ seat, name: cleanName });
    room.players.push(player);
    room.players.sort((a, b) => a.seat - b.seat);
    this.sessions.set(player.token, { code: room.code, seat });
    addFeed(room, {
      kind: 'join',
      text: `${cleanName} 加入了房间${room.phase === 'playing' ? '，将等待下一局' : ''}`,
      seat,
      name: cleanName,
    });
    this.emit(room, { type: 'join', seat, name: cleanName });
    this.changed(room);
    return { room, player, token: player.token, reconnected: false };
  }

  leave(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    const room = this.rooms.get(session.code);
    this.sessions.delete(token);
    if (!room) return null;
    const player = room.players.find((p) => p.seat === session.seat && !p.left);
    if (!player) return null;

    const wasHost = room.hostSeat === player.seat;
    this.retire(room, player);
    player.left = true;
    player.connected = false;
    addFeed(room, { kind: 'leave', text: `${player.name} 离开了房间`, seat: player.seat, name: player.name });
    this.emit(room, { type: 'leave', seat: player.seat, name: player.name });

    if (room.phase === 'playing' && room.hand?.seats[player.seat]) {
      this.forceFold(room, player.seat, `${player.name} 离开了房间`, { silent: true });
    }

    if (wasHost) {
      const nextHost = this.pickHost(room, player.seat);
      room.hostSeat = nextHost ? nextHost.seat : null;
      if (nextHost) {
        addFeed(room, { kind: 'system', text: `${nextHost.name} 成为新房主`, seat: nextHost.seat, name: nextHost.name });
      }
    }

    if (room.phase !== 'playing') this.purgeLeft(room);

    if (!room.players.some((p) => !p.isBot && !p.left)) {
      this.rooms.delete(room.code);
      return room;
    }
    this.changed(room);
    return room;
  }

  retire(room, player) {
    const inHand = room.phase === 'playing' && room.hand?.seats[player.seat];
    if (!inHand && player.score === 0 && player.stats.hands === 0) return;
    player.leftAt = Date.now();
    if (!room.departed.includes(player)) room.departed.push(player);
    if (inHand) room.hand.seats[player.seat].departedPlayer = player;
  }

  pickHost(room, excludeSeat = null) {
    const humans = room.players.filter((p) => !p.left && !p.isBot && p.seat !== excludeSeat);
    const connected = humans.filter((p) => p.connected);
    return connected[0] || humans[0] || null;
  }

  purgeLeft(room) {
    const removed = room.players.filter((p) => p.left);
    if (!removed.length) return;
    for (const p of removed) {
      if (p.token) this.sessions.delete(p.token);
      for (const res of p.sse) {
        try { res.end(); } catch { /* noop */ }
      }
      p.sse.clear();
    }
    room.players = room.players.filter((p) => !p.left);
    if (room.hostSeat !== null && !room.players.some((p) => p.seat === room.hostSeat && !p.left)) {
      const next = this.pickHost(room);
      room.hostSeat = next ? next.seat : null;
    }
  }

  markConnection(player, connected) {
    player.connected = connected;
    player.lastSeen = Date.now();
  }

  /**
   * SSE 重新连上时调用：如果正好轮到该玩家，把 8 秒离线倒计时恢复成完整回合时间。
   * 每局每个座位最多补一次，避免反复刷新拖延牌局。
   */
  onReconnect(room, player) {
    player.justReconnected = false;
    const hand = room.hand;
    if (room.phase !== 'playing' || !hand || hand.turnSeat !== player.seat) return false;
    const hs = hand.seats[player.seat];
    if (!hs || hs.folded) return false;
    if (hand.reconnectExtended.has(player.seat)) return false;
    hand.reconnectExtended.add(player.seat);
    const desired = Date.now() + room.settings.turnSeconds * 1000;
    if (!hand.deadline || hand.deadline < desired) {
      hand.deadline = desired;
      hand.botActAt = null;
      addFeed(room, {
        kind: 'system',
        text: `${player.name} 已重新连接，回合时间恢复`,
        seat: player.seat,
        name: player.name,
      });
      return true;
    }
    return false;
  }

  kick(room, host, seat) {
    this.requireHost(room, host);
    if (room.phase === 'playing') throw new GameError('牌局进行中不能请离玩家');
    const target = room.players.find((p) => p.seat === Number(seat) && !p.left);
    if (!target) throw new GameError('没有找到这个玩家', 'NOT_FOUND', 404);
    if (target.seat === host.seat) throw new GameError('不能请离自己');
    if (target.isBot) {
      this.removeBot(room, host, seat);
      return { seat: target.seat, name: target.name };
    }

    this.emit(room, { type: 'kick', seat: target.seat, name: target.name });
    this.retire(room, target);
    target.left = true;
    target.connected = false;
    if (target.token) this.sessions.delete(target.token);
    addFeed(room, {
      kind: 'leave',
      text: `${target.name} 被房主请出了房间`,
      seat: target.seat,
      name: target.name,
    });
    this.purgeLeft(room);
    this.changed(room);
    return { seat: target.seat, name: target.name };
  }

  /* ------------------------------------------------------------------ */
  /* 房主操作                                                            */
  /* ------------------------------------------------------------------ */

  requireHost(room, player) {
    if (room.hostSeat !== player.seat) throw new GameError('只有房主可以进行这个操作', 'FORBIDDEN', 403);
  }

  updateSettings(room, player, settings) {
    this.requireHost(room, player);
    if (room.phase === 'playing') throw new GameError('牌局进行中不能修改设置');
    room.settings = sanitizeSettings({ ...room.settings, ...settings });
    if (settings?.listed !== undefined) room.listed = Boolean(settings.listed);
    addFeed(room, { kind: 'system', text: '房主更新了房间设置', seat: player.seat, name: player.name });
    this.changed(room);
    return room.settings;
  }

  setAutoStart(room, player, value) {
    this.requireHost(room, player);
    room.autoStart = Boolean(value);
    if (room.phase === 'handover') {
      room.nextHandAt = room.autoStart ? Date.now() + HANDOVER_MS : null;
    }
    addFeed(room, { kind: 'system', text: `自动开始下一局：${room.autoStart ? '开启' : '关闭'}`, seat: player.seat });
    this.changed(room);
  }

  addBot(room, player, requestedName) {
    this.requireHost(room, player);
    if (room.phase === 'playing') throw new GameError('牌局进行中不能添加机器人');
    this.purgeLeft(room);
    if (room.players.filter((p) => !p.left).length >= MAX_PLAYERS) {
      throw new GameError('房间已满（最多 8 人）', 'ROOM_FULL', 409);
    }
    const used = new Set(room.players.filter((p) => !p.left).map((p) => p.seat));
    let seat = -1;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!used.has(i)) { seat = i; break; }
    }
    if (seat === -1) throw new GameError('房间已满（最多 8 人）', 'ROOM_FULL', 409);

    const usedNames = new Set(room.players.filter((p) => !p.left).map((p) => p.name));
    let name = requestedName ? sanitizeName(requestedName) : '';
    if (!name || usedNames.has(name)) {
      name = BOT_NAMES.find((candidate) => !usedNames.has(candidate)) || `机器人${seat + 1}`;
    }
    if (usedNames.has(name)) name = `${name}${seat + 1}`;

    const bot = makePlayer({ seat, name, isBot: true });
    room.players.push(bot);
    room.players.sort((a, b) => a.seat - b.seat);
    addFeed(room, { kind: 'join', text: `机器人 ${name} 入座了`, seat, name });
    this.emit(room, { type: 'join', seat, name, bot: true });
    this.changed(room);
    return bot;
  }

  removeBot(room, player, seat) {
    this.requireHost(room, player);
    if (room.phase === 'playing') throw new GameError('牌局进行中不能移除机器人');
    const bot = room.players.find((p) => p.seat === Number(seat) && p.isBot && !p.left);
    if (!bot) throw new GameError('没有找到这个机器人', 'NOT_FOUND', 404);
    room.players = room.players.filter((p) => p !== bot);
    addFeed(room, { kind: 'leave', text: `机器人 ${bot.name} 离开了房间`, seat: bot.seat, name: bot.name });
    this.emit(room, { type: 'leave', seat: bot.seat, name: bot.name, bot: true });
    this.changed(room);
    return bot;
  }

  chat(room, player, text) {
    const now = Date.now();
    if (now - player.lastChatAt < 700) {
      throw new GameError('说慢一点，喝口茶再发', 'RATE_LIMITED', 429);
    }
    if (typeof text !== 'string') throw new GameError('消息内容不正确');
    const clean = [...text.replace(/[\u0000-\u001f\u007f]/g, '').trim()]
      .slice(0, 160)
      .join('')
      .trim();
    if (!clean) throw new GameError('消息不能为空');
    player.lastChatAt = now;
    addFeed(room, { kind: 'chat', text: clean, seat: player.seat, name: player.name });
    this.emit(room, { type: 'chat', seat: player.seat });
    this.changed(room);
  }

  startGame(room, player) {
    this.requireHost(room, player);
    if (room.phase === 'playing') throw new GameError('牌局已经在进行了');
    return this.startHand(room);
  }

  resetSession(room, player) {
    this.requireHost(room, player);
    if (room.phase === 'playing') throw new GameError('牌局进行中不能清零积分，请等本局结束');
    for (const p of room.players) {
      p.score = 0;
      p.stats = { wins: 0, hands: 0, bestPot: 0, lastDelta: 0 };
    }
    room.departed = [];
    room.handNo = 0;
    room.hand = null;
    room.lastDealer = -1;
    room.nextHandAt = null;
    room.phase = 'lobby';
    room.sessionStartedAt = Date.now();
    addFeed(room, { kind: 'system', text: '房主清零了本次积分，新赛季开始' });
    this.changed(room);
    return room;
  }

  /* ------------------------------------------------------------------ */
  /* 开局                                                                */
  /* ------------------------------------------------------------------ */

  canStart(room) {
    if (room.phase === 'playing') return false;
    const eligible = room.players.filter((p) => !p.left && (p.isBot || p.connected));
    return eligible.length >= MIN_PLAYERS && eligible.some((p) => !p.isBot);
  }

  startHand(room) {
    if (room.phase === 'playing') throw new GameError('牌局已经在进行了');
    this.purgeLeft(room);

    const seated = room.players.filter((p) => !p.left);
    const eligible = seated.filter((p) => p.isBot || p.connected);
    if (eligible.length < MIN_PLAYERS || !eligible.some((p) => !p.isBot)) {
      const ready = eligible.length;
      throw new GameError(
        ready < MIN_PLAYERS
          ? `至少需要 2 名在线玩家（当前 ${ready} 名）`
          : '至少需要一名在线真人玩家才能开局',
        'NOT_ENOUGH_PLAYERS',
        409,
      );
    }

    const sitOut = seated.filter((p) => !eligible.includes(p));
    for (const p of sitOut) {
      addFeed(room, {
        kind: 'system',
        text: `${p.name} 不在线，本局旁观`,
        seat: p.seat,
        name: p.name,
      });
    }

    const dealerSeat = nextSeatFrom(room, room.lastDealer, eligible.map((p) => p.seat));
    room.lastDealer = dealerSeat;
    room.handNo += 1;
    for (const p of room.players) p.stats.lastDelta = 0;

    const deck = shuffle(createDeck());
    const hand = {
      dealerSeat,
      turnSeat: null,
      pot: 0,
      currentBet: room.settings.baseBet,
      actionCount: 0,
      startedAt: Date.now(),
      deadline: null,
      botActAt: null,
      order: eligible.map((p) => p.seat).sort((a, b) => a - b),
      seats: {},
      compares: [],
      result: null,
      reveal: false,
      offlineWarned: new Set(),
      reconnectExtended: new Set(),
    };

    for (const p of eligible) {
      const cards = deck.splice(0, 3);
      hand.seats[p.seat] = {
        cards,
        looked: false,
        folded: false,
        contributed: room.settings.ante,
        lastAction: '底注',
      };
      hand.pot += room.settings.ante;
    }

    room.hand = hand;
    room.phase = 'playing';
    room.nextHandAt = null;

    addFeed(room, {
      kind: 'deal',
      text: `第 ${room.handNo} 局开始 · ${findPlayer(room, dealerSeat)?.name || ''} 坐庄 · 底注 ${room.settings.ante}`,
    });
    this.emit(room, { type: 'deal', handNo: room.handNo, dealerSeat });
    this.setTurn(room, nextActiveSeat(hand, dealerSeat));
    this.changed(room);
    return hand;
  }

  setTurn(room, seat) {
    const hand = room.hand;
    hand.turnSeat = seat;
    if (seat === null) {
      hand.deadline = null;
      hand.botActAt = null;
      return;
    }
    const player = findPlayer(room, seat);
    if (player?.isBot) {
      hand.deadline = Date.now() + room.settings.turnSeconds * 1000;
      hand.botActAt = Date.now() + 700 + randomInt(900);
    } else if (player && !player.connected) {
      hand.deadline = Date.now() + Math.min(8, room.settings.turnSeconds) * 1000;
      hand.botActAt = null;
      if (!hand.offlineWarned.has(seat)) {
        hand.offlineWarned.add(seat);
        addFeed(room, {
          kind: 'system',
          text: `${player.name} 当前离线，8 秒后自动弃牌`,
          seat,
          name: player.name,
        });
      }
    } else {
      hand.deadline = Date.now() + room.settings.turnSeconds * 1000;
      hand.botActAt = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 玩家动作                                                            */
  /* ------------------------------------------------------------------ */

  applyAction(room, seat, type, payload = {}) {
    if (room.phase !== 'playing' || !room.hand) throw new GameError('当前没有进行中的牌局');
    const hand = room.hand;
    const hs = hand.seats[seat];
    const player = findPlayer(room, seat);
    if (!hs || !player) throw new GameError('你不在本局牌局中', 'NOT_IN_HAND', 409);
    if (hs.folded) throw new GameError('你已经弃牌了');

    if (type === 'look') {
      if (hs.looked) return { looked: true, already: true };
      hs.looked = true;
      hs.lastAction = '看牌';
      addFeed(room, { kind: 'look', text: `${player.name} 看牌了`, seat, name: player.name });
      this.emit(room, { type: 'look', seat });
      this.changed(room);
      return { looked: true };
    }

    if (hand.turnSeat !== seat) throw new GameError('还没轮到你行动', 'NOT_YOUR_TURN', 409);

    if (type === 'fold') {
      this.fold(room, seat);
      return { ok: true };
    }

    if (type === 'call') {
      const cost = callCost(hand, hs);
      hand.pot += cost;
      hs.contributed += cost;
      hs.lastAction = hs.looked ? `跟注 ${cost}` : `闷跟 ${cost}`;
      hand.actionCount += 1;
      addFeed(room, {
        kind: 'call',
        text: `${player.name} ${hs.looked ? '跟注' : '闷跟'} ${cost}`,
        seat,
        name: player.name,
      });
      this.emit(room, { type: 'call', seat, cost, looked: hs.looked });
      this.afterAction(room, seat);
      return { ok: true, cost };
    }

    if (type === 'raise') {
      const to = Number(payload.to);
      const min = minRaiseTo(room, hand);
      if (!Number.isInteger(to)) throw new GameError('加注金额不正确');
      if (min === null || to > room.settings.maxBet) {
        throw new GameError(`本局单注已封顶（${room.settings.maxBet}）`, 'MAX_BET', 409);
      }
      if (to < min) throw new GameError(`至少要加注到 ${min}`, 'MIN_RAISE', 409);
      const cost = to * (hs.looked ? 2 : 1);
      hand.pot += cost;
      hs.contributed += cost;
      hand.currentBet = to;
      hs.lastAction = `加注到 ${to}`;
      hand.actionCount += 1;
      addFeed(room, {
        kind: 'raise',
        text: `${player.name} 加注到 ${to}（投入 ${cost}）`,
        seat,
        name: player.name,
      });
      this.emit(room, { type: 'raise', seat, to, cost, looked: hs.looked });
      this.afterAction(room, seat);
      return { ok: true, to, cost };
    }

    if (type === 'compare') {
      if (!hs.looked) throw new GameError('先看牌才能比牌', 'MUST_LOOK', 409);
      const targetSeat = Number(payload.seat);
      const target = hand.seats[targetSeat];
      const targetPlayer = findPlayer(room, targetSeat);
      if (!target || !targetPlayer || targetSeat === seat || target.folded) {
        throw new GameError('请选择一名还在局中的对手', 'BAD_TARGET', 409);
      }
      const cost = compareCost(hand, hs);
      hand.pot += cost;
      hs.contributed += cost;
      hand.actionCount += 1;

      const myEval = evaluateHand(hs.cards, { special235: room.settings.special235 });
      const targetEval = evaluateHand(target.cards, { special235: room.settings.special235 });
      const cmp = compareHands(myEval, targetEval, { special235: room.settings.special235 });
      const iWin = cmp > 0;
      const winnerSeat = iWin ? seat : targetSeat;
      const loserSeat = iWin ? targetSeat : seat;

      hand.seats[loserSeat].folded = true;
      hand.seats[loserSeat].lastAction = '比牌失败';
      hs.lastAction = iWin ? '比牌胜出' : '比牌失败';

      const record = {
        id: hand.compares.length + 1,
        a: seat,
        b: targetSeat,
        winner: winnerSeat,
        aName: player.name,
        bName: targetPlayer.name,
        aCards: sortCards(hs.cards),
        bCards: sortCards(target.cards),
        aLabel: myEval.label,
        bLabel: targetEval.label,
        aCat: myEval.cat,
        bCat: targetEval.cat,
        at: Date.now(),
      };
      hand.compares.push(record);
      addFeed(room, {
        kind: 'compare',
        text: `${player.name} 找 ${targetPlayer.name} 比牌，${iWin ? player.name : targetPlayer.name} 胜出`,
        seat,
        name: player.name,
      });
      this.emit(room, {
        type: 'compare',
        a: seat,
        b: targetSeat,
        winner: winnerSeat,
        winnerName: iWin ? player.name : targetPlayer.name,
      });

      this.afterAction(room, seat, { reason: 'compare' });
      return { ok: true, winner: winnerSeat, compare: record };
    }

    throw new GameError('未知的操作');
  }

  fold(room, seat) {
    const hand = room.hand;
    const hs = hand.seats[seat];
    const player = findPlayer(room, seat);
    hs.folded = true;
    hs.lastAction = '弃牌';
    hand.actionCount += 1;
    addFeed(room, { kind: 'fold', text: `${player.name} 弃牌`, seat, name: player.name });
    this.emit(room, { type: 'fold', seat });
    this.afterAction(room, seat);
  }

  forceFold(room, seat, reason, { silent = false } = {}) {
    const hand = room.hand;
    if (!hand?.seats[seat] || hand.seats[seat].folded) return;
    hand.seats[seat].folded = true;
    hand.seats[seat].lastAction = '离场';
    hand.actionCount += 1;
    if (!silent) addFeed(room, { kind: 'fold', text: reason, seat });
    const wasTurn = hand.turnSeat === seat;
    const active = activeSeats(hand);
    if (active.length <= 1) {
      this.endHand(room, active, 'others_folded');
      return;
    }
    if (wasTurn) {
      this.afterAction(room, seat);
    }
  }

  afterAction(room, fromSeat, { reason = 'others_folded' } = {}) {
    const hand = room.hand;
    if (!hand) return;
    const active = activeSeats(hand);
    if (active.length <= 1) {
      this.endHand(room, active, active.length === 1 ? reason : 'aborted');
      return;
    }
    if (hand.actionCount >= MAX_ACTIONS) {
      this.showdown(room);
      return;
    }
    const next = nextActiveSeat(hand, fromSeat);
    if (next === null) {
      this.endHand(room, active, 'others_folded');
      return;
    }
    this.setTurn(room, next);
    this.changed(room);
  }

  /* ------------------------------------------------------------------ */
  /* 结束与摊牌                                                          */
  /* ------------------------------------------------------------------ */

  showdown(room) {
    const hand = room.hand;
    const active = activeSeats(hand);
    if (!active.length) {
      this.endHand(room, [], 'aborted');
      return;
    }
    const ranked = active
      .map((seat) => ({
        seat,
        ev: evaluateHand(hand.seats[seat].cards, { special235: room.settings.special235 }),
      }))
      .sort((a, b) => compareHands(b.ev, a.ev, { special235: room.settings.special235 }));
    const best = ranked[0];
    const winners = ranked
      .filter((r) => compareHands(r.ev, best.ev, { special235: room.settings.special235 }) === 0)
      .map((r) => r.seat);
    this.endHand(room, winners, 'showdown');
  }

  endHand(room, winnerSeats = [], reason = 'others_folded') {
    const hand = room.hand;
    if (!hand || room.phase !== 'playing') return;
    room.phase = 'handover';

    const winners = winnerSeats.filter((seat) => hand.seats[seat] && !hand.seats[seat].folded);
    const pot = hand.pot;
    const handResult = {
      winnerSeat: winners[0] ?? null,
      winnerSeats: winners.slice(),
      winnerName: winners.map((seat) => handPlayer(room, hand, seat)?.name).filter(Boolean).join('、'),
      reason,
      reasonText: reasonText(reason),
      pot,
      at: Date.now(),
      showdown: reason === 'showdown',
      hands: [],
      deltas: [],
      compares: hand.compares.map((c) => ({
        a: c.a, b: c.b, winner: c.winner, aName: c.aName, bName: c.bName, at: c.at,
      })),
    };

    const payouts = new Map();
    if (winners.length > 0) {
      const share = Math.floor(pot / winners.length);
      let remainder = pot - share * winners.length;
      for (const seat of winners) {
        const amount = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder -= 1;
        payouts.set(seat, amount);
        const p = handPlayer(room, hand, seat);
        if (p) {
          p.stats.wins += 1;
          p.stats.bestPot = Math.max(p.stats.bestPot, pot);
        }
      }
    }

    // 分数只在每局结束时结算一次：本局净分 = 赢得的底池 − 本局投入
    for (const seat of hand.order) {
      const hs = hand.seats[seat];
      const p = handPlayer(room, hand, seat);
      const delta = winners.length === 0 ? 0 : (payouts.get(seat) || 0) - hs.contributed;
      if (p) {
        p.score += delta;
        p.stats.lastDelta = delta;
        p.stats.hands += 1;
      }
      handResult.deltas.push({
        seat,
        name: p?.name || hs.name || '已离开',
        delta,
        score: p ? p.score : null,
        left: !p,
      });
      const entry = this.resultHand(room, hand, seat);
      entry.delta = delta;
      entry.score = p ? p.score : null;
      handResult.hands.push(entry);
    }

    if (winners.length === 0) {
      addFeed(room, { kind: 'system', text: `本局流局，不计分（底池 ${pot}）` });
      this.emit(room, { type: 'aborted', pot });
    } else {
      addFeed(room, {
        kind: 'win',
        text: `${handResult.winnerName} 赢得底池 ${pot} 分（${handResult.reasonText}）`,
        seat: winners[0],
        name: handResult.winnerName,
      });
      this.emit(room, {
        type: 'win',
        winnerSeat: winners[0],
        winnerSeats: winners,
        winnerName: handResult.winnerName,
        pot,
        reason,
      });
    }

    const summary = handResult.deltas
      .filter((row) => row.delta !== 0)
      .map((row) => `${row.name} ${row.delta > 0 ? '+' : ''}${row.delta}`)
      .join(' · ');
    if (summary) addFeed(room, { kind: 'score', text: `本局结算：${summary}` });

    hand.result = handResult;
    hand.reveal = true;
    hand.deadline = null;
    hand.turnSeat = null;
    hand.botActAt = null;
    room.nextHandAt = room.autoStart ? Date.now() + HANDOVER_MS : null;
    this.changed(room);
  }

  resultHand(room, hand, seat) {
    const hs = hand.seats[seat];
    const p = handPlayer(room, hand, seat);
    const ev = evaluateHand(hs.cards, { special235: room.settings.special235 });
    return {
      seat,
      name: p?.name || hs.name || '已离开',
      cards: sortCards(hs.cards),
      cat: ev.cat,
      catName: ev.catName,
      label: ev.label,
      folded: hs.folded,
      contributed: hs.contributed,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 计时器、机器人与维护                                                */
  /* ------------------------------------------------------------------ */

  tick(now = Date.now()) {
    for (const room of this.rooms.values()) {
      try {
        this.tickRoom(room, now);
      } catch (error) {
        console.error(`[room ${room.code}] tick error`, error);
      }
    }
  }

  tickRoom(room, now) {
    if (room.phase === 'playing') {
      const hand = room.hand;
      if (!hand) return;
      const player = findPlayer(room, hand.turnSeat);
      if (!player) {
        const active = activeSeats(hand);
        if (active.length <= 1) this.endHand(room, active, 'others_folded');
        else this.setTurn(room, nextActiveSeat(hand, hand.turnSeat ?? 0));
        return;
      }

      if (player.isBot) {
        if (hand.botActAt && now >= hand.botActAt) this.botStep(room);
        return;
      }

      if (hand.deadline && now >= hand.deadline) {
        addFeed(room, {
          kind: 'timeout',
          text: `${player.name} 超时，自动弃牌`,
          seat: player.seat,
          name: player.name,
        });
        this.emit(room, { type: 'timeout', seat: player.seat });
        this.forceFold(room, player.seat, `${player.name} 超时弃牌`);
      }
      return;
    }

    if (room.phase === 'handover' && room.autoStart && room.nextHandAt && now >= room.nextHandAt) {
      try {
        this.startHand(room);
      } catch (error) {
        room.nextHandAt = null;
        if (error instanceof GameError) {
          addFeed(room, { kind: 'system', text: `${error.message}，等待房主开始下一局` });
        } else {
          console.error(error);
        }
        this.changed(room);
      }
      return;
    }

    // 房主离线太久，移交给其他在线玩家
    if (room.hostSeat !== null) {
      const host = room.players.find((p) => p.seat === room.hostSeat);
      if (host && !host.isBot && !host.connected && now - host.lastSeen > 60_000) {
        const next = this.pickHost(room, host.seat);
        if (next) {
          room.hostSeat = next.seat;
          addFeed(room, { kind: 'system', text: `${next.name} 成为新房主`, seat: next.seat, name: next.name });
          this.changed(room);
        }
      }
    }

    // 清理长时间离线且不在牌局中的玩家
    if (room.phase !== 'playing') {
      let changed = false;
      for (const p of [...room.players]) {
        if (!p.isBot && !p.connected && !p.left && now - p.lastSeen > 10 * 60_000) {
          this.retire(room, p);
          p.left = true;
          changed = true;
          if (p.token) this.sessions.delete(p.token);
          addFeed(room, { kind: 'leave', text: `${p.name} 因长时间离线被移出房间`, name: p.name });
          if (room.hostSeat === p.seat) {
            const next = this.pickHost(room, p.seat);
            room.hostSeat = next ? next.seat : null;
          }
        }
      }
      if (changed) {
        this.purgeLeft(room);
        if (!room.players.some((p) => !p.isBot && !p.left)) {
          this.rooms.delete(room.code);
          return;
        }
        this.changed(room);
      }
    }

    if (now - room.updatedAt > 2 * 60 * 60_000 && !room.players.some((p) => !p.isBot && p.connected)) {
      this.rooms.delete(room.code);
    }
  }

  botStep(room) {
    const hand = room.hand;
    const seat = hand.turnSeat;
    const player = findPlayer(room, seat);
    if (!player?.isBot) return;
    const hs = hand.seats[seat];
    if (!hs || hs.folded) return;

    // 先决定要不要看牌
    if (!hs.looked) {
      const lookChance = hand.actionCount >= 3 ? 0.8 : 0.55;
      if (Math.random() < lookChance) {
        this.applyAction(room, seat, 'look');
        hand.botActAt = Date.now() + 450 + randomInt(550);
        return;
      }
    }

    const ev = hs.looked
      ? evaluateHand(hs.cards, { special235: room.settings.special235 })
      : null;
    const active = activeSeats(hand).length;
    const maxBet = room.settings.maxBet;
    const minRaise = minRaiseTo(room, hand);
    const canRaise = minRaise !== null;
    const cost = callCost(hand, hs);

    if (!hs.looked) {
      const roll = Math.random();
      if (roll < 0.08 && hand.actionCount > 2) { this.applyAction(room, seat, 'fold'); return; }
      if (roll < 0.22 && canRaise) {
        const raiseTo = Math.min(maxBet, Math.max(minRaise, hand.currentBet + room.settings.baseBet));
        if (raiseTo > hand.currentBet) {
          this.applyAction(room, seat, 'raise', { to: raiseTo });
          return;
        }
      }
      this.applyAction(room, seat, 'call');
      return;
    }

    const high = ev.tiebreak[0] || 0;
    const strong = ev.cat >= CATEGORY.STRAIGHT;
    const medium = ev.cat === CATEGORY.PAIR;
    const weak = ev.cat === CATEGORY.HIGH && high < 12;

    // 只剩两人时，强牌更愿意直接比牌结束
    if (active === 2) {
      if (strong && Math.random() < 0.72) { this.compareWithRandomBot(room, seat); return; }
      if (medium && Math.random() < 0.35) { this.compareWithRandomBot(room, seat); return; }
      if (weak && Math.random() < 0.12) { this.compareWithRandomBot(room, seat); return; }
    }

    if (active > 2 && strong && hand.actionCount > 8 && Math.random() < 0.25) {
      this.compareWithRandomBot(room, seat);
      return;
    }

    if (strong) {
      if (canRaise && Math.random() < 0.48) {
        const raiseTo = Math.min(maxBet, Math.max(minRaise, hand.currentBet + room.settings.baseBet));
        if (raiseTo > hand.currentBet) {
          this.applyAction(room, seat, 'raise', { to: raiseTo });
          return;
        }
      }
      this.applyAction(room, seat, 'call');
      return;
    }

    if (medium) {
      if (canRaise && Math.random() < 0.18) {
        const raiseTo = Math.min(maxBet, Math.max(minRaise, hand.currentBet + room.settings.baseBet));
        if (raiseTo > hand.currentBet) {
          this.applyAction(room, seat, 'raise', { to: raiseTo });
          return;
        }
      }
      this.applyAction(room, seat, 'call');
      return;
    }

    // 弱牌：下注压力大时更倾向弃牌（分数可以负，不存在跟不起）
    if (weak && (cost > room.settings.baseBet * 4 || hand.currentBet > room.settings.baseBet * 3)) {
      if (Math.random() < 0.7) { this.applyAction(room, seat, 'fold'); return; }
    }
    if (Math.random() < 0.12) { this.applyAction(room, seat, 'fold'); return; }
    this.applyAction(room, seat, 'call');
  }

  compareWithRandomBot(room, seat) {
    const hand = room.hand;
    const targets = activeSeats(hand).filter((s) => s !== seat && hand.seats[s]);
    if (!targets.length) {
      this.applyAction(room, seat, 'call');
      return;
    }
    const target = targets[randomInt(targets.length)];
    this.applyAction(room, seat, 'compare', { seat: target });
  }

  /* ------------------------------------------------------------------ */
  /* 状态输出                                                            */
  /* ------------------------------------------------------------------ */

  changed(room) {
    room.updatedAt = Date.now();
    room.seq += 1;
    this.onState?.(room);
  }

  emit(room, event) {
    this.onEvent?.(room, { at: Date.now(), ...event });
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter((room) => room.listed && room.players.some((p) => !p.left && !p.isBot))
      .map((room) => {
        const players = room.players.filter((p) => !p.left);
        return {
          code: room.code,
          hostName: findPlayer(room, room.hostSeat)?.name || '—',
          playerCount: players.length,
          humanCount: players.filter((p) => !p.isBot).length,
          phase: room.phase,
          ante: room.settings.ante,
          baseBet: room.settings.baseBet,
          maxBet: room.settings.maxBet,
          handNo: room.handNo,
          createdAt: room.createdAt,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
  }

  settlementFor(room) {
    const seen = new Set();
    const humans = [];
    const bots = [];
    const addEntry = (p, left) => {
      if (seen.has(p)) return;
      seen.add(p);
      const entry = {
        seat: p.seat,
        name: p.name,
        score: p.score,
        left,
        isBot: Boolean(p.isBot),
        leftAt: left ? p.leftAt || null : null,
      };
      (p.isBot ? bots : humans).push(entry);
    };
    for (const p of room.players) {
      if (!p.left) addEntry(p, false);
    }
    for (const p of room.departed) addEntry(p, true);
    humans.sort((a, b) => b.score - a.score || a.seat - b.seat);

    const debtors = humans
      .filter((e) => e.score < 0)
      .map((e) => ({ ...e, remain: -e.score }))
      .sort((a, b) => b.remain - a.remain);
    const creditors = humans
      .filter((e) => e.score > 0)
      .map((e) => ({ ...e, remain: e.score }))
      .sort((a, b) => b.remain - a.remain);

    const transfers = [];
    let di = 0;
    let ci = 0;
    while (di < debtors.length && ci < creditors.length) {
      const debtor = debtors[di];
      const creditor = creditors[ci];
      const amount = Math.min(debtor.remain, creditor.remain);
      if (amount > 0) {
        transfers.push({
          from: debtor.name,
          fromSeat: debtor.seat,
          to: creditor.name,
          toSeat: creditor.seat,
          amount,
        });
      }
      debtor.remain -= amount;
      creditor.remain -= amount;
      if (debtor.remain === 0) di += 1;
      if (creditor.remain === 0) ci += 1;
    }

    const totalPositive = humans.filter((e) => e.score > 0).reduce((sum, e) => sum + e.score, 0);
    const totalNegative = humans.filter((e) => e.score < 0).reduce((sum, e) => sum + Math.abs(e.score), 0);
    return {
      entries: humans,
      bots,
      transfers,
      totalPositive,
      totalNegative,
      balanced: totalPositive === totalNegative,
      difference: totalPositive - totalNegative,
    };
  }

  stateFor(room, viewer) {
    const hand = room.hand;
    const revealAll = room.phase === 'handover' && Boolean(hand?.reveal);
    const viewerHs = hand?.seats[viewer.seat] || null;
    const viewerCanSeeOwn = Boolean(viewerHs && (viewerHs.looked || revealAll));

    const players = room.players
      .filter((p) => !p.left)
      .sort((a, b) => a.seat - b.seat)
      .map((p) => {
        const hs = hand?.seats[p.seat] || null;
        const isSelf = p.seat === viewer.seat;
        const revealed = revealAll || (isSelf && viewerCanSeeOwn);
        let handLabel = null;
        let handCat = null;
        if (revealed && hs) {
          const ev = evaluateHand(hs.cards, { special235: room.settings.special235 });
          handLabel = ev.label;
          handCat = ev.cat;
        }
        return {
          seat: p.seat,
          name: p.name,
          score: p.score,
          connected: p.connected,
          isBot: p.isBot,
          isHost: room.hostSeat === p.seat,
          isDealer: hand?.dealerSeat === p.seat,
          inHand: Boolean(hs),
          looked: Boolean(hs?.looked),
          folded: Boolean(hs?.folded),
          cards: revealed && hs ? sortCards(hs.cards) : null,
          cardCount: hs ? 3 : 0,
          handLabel,
          handCat,
          contributed: hs?.contributed || 0,
          lastAction: hs?.lastAction || null,
          isTurn: hand?.turnSeat === p.seat,
          stats: { ...p.stats },
          hue: p.hue,
        };
      });

    const active = hand ? activeSeats(hand) : [];
    const call = hand && viewerHs && !viewerHs.folded ? callCost(hand, viewerHs) : null;
    const cCost = hand && viewerHs && !viewerHs.folded && viewerHs.looked ? compareCost(hand, viewerHs) : null;
    const raiseTo = hand ? minRaiseTo(room, hand) : null;
    const isMyTurn = Boolean(hand && hand.turnSeat === viewer.seat && viewerHs && !viewerHs.folded);
    const canAct = room.phase === 'playing' && isMyTurn;
    const compareTargets = canAct && viewerHs?.looked
      ? active
        .filter((s) => s !== viewer.seat && hand.seats[s] && !hand.seats[s].folded)
        .map((s) => {
          const p = findPlayer(room, s);
          return { seat: s, name: p?.name || '', looked: Boolean(hand.seats[s].looked), isBot: Boolean(p?.isBot) };
        })
      : [];

    const myCompares = hand && viewerHs
      ? hand.compares
        .filter((c) => c.a === viewer.seat || c.b === viewer.seat)
        .slice(-3)
        .map((c) => ({
          id: c.id,
          a: c.a,
          b: c.b,
          winner: c.winner,
          aName: c.aName,
          bName: c.bName,
          aCards: c.aCards,
          bCards: c.bCards,
          aLabel: c.aLabel,
          bLabel: c.bLabel,
          at: c.at,
          iAm: c.a === viewer.seat ? 'a' : 'b',
        }))
      : [];

    const myEval = viewerCanSeeOwn && viewerHs
      ? evaluateHand(viewerHs.cards, { special235: room.settings.special235 })
      : null;

    const available = {
      isTurn: isMyTurn,
      canLook: Boolean(hand && viewerHs && !viewerHs.folded && !viewerHs.looked && room.phase === 'playing'),
      canCall: Boolean(canAct && call !== null),
      callCost: call,
      canRaise: Boolean(canAct && raiseTo !== null),
      minRaiseTo: raiseTo,
      maxRaiseTo: room.settings.maxBet,
      canCompare: Boolean(canAct && viewerHs?.looked && compareTargets.length > 0),
      compareCost: cCost,
      canFold: canAct,
      compareTargets,
      score: viewer.score,
    };

    return {
      code: room.code,
      phase: room.phase,
      handNo: room.handNo,
      settings: { ...room.settings, listed: room.listed },
      hostSeat: room.hostSeat,
      autoStart: room.autoStart,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      seq: room.seq,
      serverTime: Date.now(),
      nextHandAt: room.nextHandAt,
      canStart: this.canStart(room),
      players,
      departed: room.departed.map((p) => ({
        name: p.name,
        score: p.score,
        seat: p.seat,
        leftAt: p.leftAt || p.left || Date.now(),
        isBot: Boolean(p.isBot),
      })),
      settlement: this.settlementFor(room),
      hand: hand
        ? {
          pot: hand.pot,
          currentBet: hand.currentBet,
          baseBet: room.settings.baseBet,
          maxBet: room.settings.maxBet,
          dealerSeat: hand.dealerSeat,
          turnSeat: hand.turnSeat,
          deadline: hand.deadline,
          actionCount: hand.actionCount,
          activeCount: active.length,
          startedAt: hand.startedAt,
          minRaiseTo: raiseTo,
          result: hand.result,
        }
        : null,
      you: {
        seat: viewer.seat,
        name: viewer.name,
        score: viewer.score,
        isHost: room.hostSeat === viewer.seat,
        inHand: Boolean(viewerHs),
        looked: Boolean(viewerHs?.looked),
        folded: Boolean(viewerHs?.folded),
        cards: viewerCanSeeOwn ? sortCards(viewerHs.cards) : null,
        cardCount: viewerHs ? 3 : 0,
        handLabel: myEval?.label || null,
        handCat: myEval?.cat || null,
        available,
        compareViews: myCompares,
        stats: { ...viewer.stats },
      },
      feed: room.feed.slice(-FEED_SENT),
    };
  }
}
