import { randomInt } from 'node:crypto';

/**
 * 牌面使用紧凑编码： rank + suit
 * rank: 2..9, T(10), J, Q, K, A
 * suit: S(黑桃), H(红桃), D(方块), C(梅花)
 */
export const RANK_LABELS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

export const SUITS = [
  { code: 'S', symbol: '♠', name: '黑桃', color: 'black' },
  { code: 'H', symbol: '♥', name: '红桃', color: 'red' },
  { code: 'D', symbol: '♦', name: '方块', color: 'red' },
  { code: 'C', symbol: '♣', name: '梅花', color: 'black' },
];

export const SUIT_BY_CODE = Object.fromEntries(SUITS.map((s) => [s.code, s]));

export const CATEGORY = {
  HIGH: 1,
  PAIR: 2,
  STRAIGHT: 3,
  FLUSH: 4,
  STRAIGHT_FLUSH: 5,
  TRIPS: 6,
};

export const CATEGORY_NAME = {
  1: '单张',
  2: '对子',
  3: '顺子',
  4: '金花',
  5: '同花顺',
  6: '豹子',
};

export const CATEGORY_ORDER = '单张 < 对子 < 顺子 < 金花 < 同花顺 < 豹子';

const SUIT_POWER = { S: 4, H: 3, C: 2, D: 1 };

const RANK_CHARS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const CHAR_RANKS = Object.fromEntries(Object.entries(RANK_CHARS).map(([r, c]) => [c, Number(r)]));

export function cardCode(rank, suit) {
  return `${RANK_CHARS[rank]}${suit}`;
}

export function parseCard(code) {
  const rank = CHAR_RANKS[code[0]];
  const suit = SUIT_BY_CODE[code[1]];
  if (!rank || !suit) throw new Error(`非法牌面: ${code}`);
  return { rank, suit: suit.code, code };
}

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push(cardCode(rank, suit.code));
    }
  }
  return deck;
}

/** Fisher-Yates，使用 crypto.randomInt 保证洗牌不可预测 */
export function shuffle(deck) {
  const cards = deck.slice();
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function countRanks(ranks) {
  const map = new Map();
  for (const r of ranks) map.set(r, (map.get(r) || 0) + 1);
  return map;
}

function straightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.length !== 3) return null;
  if (unique[0] === 14 && unique[1] === 3 && unique[2] === 2) {
    // A23 是最小的顺子
    return 3;
  }
  if (unique[0] - unique[1] === 1 && unique[1] - unique[2] === 1) {
    return unique[0];
  }
  return null;
}

/**
 * 评估三张牌
 * @param {string[]} cards 三张牌的紧凑编码
 * @param {{special235?: boolean}} [options]
 * @returns {{cat:number,catName:string,tiebreak:number[],label:string,ranks:number[],is235:boolean,flush:boolean,straight:boolean}}
 */
export function evaluateHand(cards, options = {}) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('炸金花每人必须正好三张牌');
  }
  const parsed = cards.map(parseCard);
  const ranked = parsed.slice().sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    return SUIT_POWER[b.suit] - SUIT_POWER[a.suit];
  });
  const ranks = ranked.map((c) => c.rank);
  const counts = countRanks(ranks);
  const flush = parsed.every((c) => c.suit === parsed[0].suit);
  const high = straightHigh(ranks);
  const straight = high !== null;
  const is235 = !flush && ranks[0] === 5 && ranks[1] === 3 && ranks[2] === 2;

  let cat;
  let tiebreak;
  let tiebreakSuits;
  let label;

  if (counts.size === 1) {
    cat = CATEGORY.TRIPS;
    tiebreak = [ranks[0]];
    tiebreakSuits = [Math.max(...ranked.map((c) => SUIT_POWER[c.suit]))];
    label = `豹子 ${RANK_LABELS[ranks[0]]}`;
  } else if (straight && flush) {
    cat = CATEGORY.STRAIGHT_FLUSH;
    tiebreak = [high];
    tiebreakSuits = [SUIT_POWER[ranked.find((c) => c.rank === high).suit]];
    label = high === 3 ? '同花顺 A23' : `同花顺 ${RANK_LABELS[high]} 高`;
  } else if (flush) {
    cat = CATEGORY.FLUSH;
    tiebreak = ranks;
    tiebreakSuits = ranked.map((c) => SUIT_POWER[c.suit]);
    label = `金花 ${ranks.map((r) => RANK_LABELS[r]).join(' ')}`;
  } else if (straight) {
    cat = CATEGORY.STRAIGHT;
    tiebreak = [high];
    tiebreakSuits = [SUIT_POWER[ranked.find((c) => c.rank === high).suit]];
    label = high === 3 ? '顺子 A23' : `顺子 ${RANK_LABELS[high]} 高`;
  } else if (counts.size === 2) {
    cat = CATEGORY.PAIR;
    const pairRank = [...counts.entries()].find(([, n]) => n === 2)[0];
    const kicker = ranks.find((r) => r !== pairRank);
    const pairSuits = ranked
      .filter((c) => c.rank === pairRank)
      .map((c) => SUIT_POWER[c.suit])
      .sort((a, b) => b - a);
    tiebreak = [pairRank, kicker];
    tiebreakSuits = [...pairSuits, SUIT_POWER[ranked.find((c) => c.rank === kicker).suit]];
    label = `对子 ${RANK_LABELS[pairRank]}`;
  } else {
    cat = CATEGORY.HIGH;
    tiebreak = ranks;
    tiebreakSuits = ranked.map((c) => SUIT_POWER[c.suit]);
    label = `单张 ${ranks.map((r) => RANK_LABELS[r]).join(' ')}`;
  }

  return {
    cat,
    catName: CATEGORY_NAME[cat],
    tiebreak,
    tiebreakSuits,
    label,
    ranks,
    is235,
    flush,
    straight,
    special235: Boolean(options.special235),
  };
}

/**
 * 比较两手牌，返回 1 表示 a 大，-1 表示 b 大，0 表示完全相同。
 * 默认不启用 235 吃豹子；启用后，不同花的 235 可以击败豹子。
 */
export function compareHands(a, b, options = {}) {
  if (options.special235) {
    if (a.is235 && b.cat === CATEGORY.TRIPS) return 1;
    if (b.is235 && a.cat === CATEGORY.TRIPS) return -1;
  }
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] ?? 0;
    const bv = b.tiebreak[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  // 点数完全相同时比花色：黑桃 > 红桃 > 梅花 > 方块
  const suitLen = Math.max(a.tiebreakSuits?.length || 0, b.tiebreakSuits?.length || 0);
  for (let i = 0; i < suitLen; i++) {
    const av = a.tiebreakSuits?.[i] ?? 0;
    const bv = b.tiebreakSuits?.[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

export function isFlush(cards) {
  return cards.every((c) => parseCard(c).suit === parseCard(cards[0]).suit);
}

export function sortForDisplay(cards) {
  return cards.slice().sort((a, b) => {
    const ca = parseCard(a);
    const cb = parseCard(b);
    if (ca.rank !== cb.rank) return cb.rank - ca.rank;
    return ca.suit.localeCompare(cb.suit);
  });
}
