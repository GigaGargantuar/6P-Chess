import {
  HILL_CELLS, PIECE_POINTS, PLAYERS, PROMOTION_TYPES, cellOf, getHillOwner,
  getLegalMoves, isCell, isInCheck, keyOf, playMove,
} from "./engine.mjs";

const center = 3.5;
const shortlistSize = 10;
const players = Object.fromEntries(PLAYERS.map(player => [player.id, player]));
const steps = [-1, 0, 1].flatMap(x =>
  [-1, 0, 1].flatMap(y => [-1, 0, 1].map(z => [x, y, z]))
).filter(step => step.some(Boolean));

function hillDistances(cells) {
  const distances = new Map(cells.map(cell => [keyOf(cell), 0]));
  const queue = [...cells];
  for (let index = 0; index < queue.length; index += 1) {
    const cell = queue[index];
    const distance = distances.get(keyOf(cell)) + 1;
    for (const step of steps) {
      const next = cell.map((coordinate, axis) => coordinate + step[axis]);
      const key = keyOf(next);
      if (distances.has(key) || !isCell(next)) continue;
      distances.set(key, distance);
      queue.push(next);
    }
  }
  return distances;
}

const hills = PLAYERS.map(({ id }) => ({
  owner: id,
  distances: hillDistances(HILL_CELLS.filter(cell => getHillOwner(cell) === id)),
}));

function distanceToCenter(cell) {
  return cell.reduce((sum, coordinate) => sum + Math.abs(coordinate - center), 0);
}

function gap(a, b) {
  return Math.max(...a.map((value, axis) => Math.abs(value - b[axis])));
}

function nextHillDistance(cell, hills, player) {
  const key = keyOf(cell);
  return Math.min(...hills.filter(hill => hill.owner !== player)
    .map(hill => hill.distances.get(key)));
}

function kingRouteCost(cell, hills, player) {
  const key = keyOf(cell);
  return Math.min(...hills.filter(hill => hill.owner !== player).map(hill =>
    hill.distances.get(key) + Math.max(0, 3 - (hill.guardDistance ?? 3)) * 1.25
  ));
}

function moveRatings(game, availableHills) {
  const player = players[game.turn];
  const recent = game.log.slice(-48).filter(entry => entry.player === player.id);
  const ratings = [];
  let tieBreak = (game.log.length + 1) * (PLAYERS.indexOf(player) + 1);

  for (const [key, piece] of Object.entries(game.board)) {
    if (piece.player !== player.id) continue;
    const from = cellOf(key);
    const kingCost = piece.type === "K" ? kingRouteCost(from, availableHills, player.id) : 0;
    for (const move of getLegalMoves(game, from)) {
      const to = keyOf(move.to);
      const captured = PIECE_POINTS[move.capture?.type] ?? 0;
      const development = (distanceToCenter(from) - distanceToCenter(move.to)) * 0.12;
      const forward = (from[player.axis] - move.to[player.axis]) * player.sign;
      let progress = piece.type === "P" ? forward * 0.32 : development;
      if (piece.type === "K" && Number.isFinite(kingCost)) {
        progress = (kingCost - kingRouteCost(move.to, availableHills, player.id)) * 0.94;
      }
      const repetition = recent.reduce((penalty, entry) => {
        if (keyOf(entry.from) === key && keyOf(entry.to) === to) return penalty + 1.1;
        if (keyOf(entry.from) === to && keyOf(entry.to) === key) return penalty + 0.85;
        return penalty;
      }, 0);
      tieBreak = (Math.imul(tieBreak, 1664525) + 1013904223) >>> 0;
      for (const promotion of move.promotes ? PROMOTION_TYPES : [null]) {
        const promotionGain = promotion ? PIECE_POINTS[promotion] - PIECE_POINTS.P : 0;
        ratings.push({
          from, to: move.to, promotion, type: piece.type, hillCaptured: move.hillCaptured,
          score: captured + progress + promotionGain - repetition + tieBreak / 2 ** 32 * 0.16,
        });
      }
    }
  }
  return ratings.sort((a, b) => b.score - a.score);
}

// Cheap reachability for narrowing down moves that can change a check or trade.
function reaches(from, to, type, player) {
  const delta = to.map((value, axis) => value - from[axis]);
  const axes = delta.map(Math.abs).filter(Boolean);
  if (!axes.length) return false;
  const max = Math.max(...axes);
  if (type === "K") return max === 1;
  if (type === "N") return axes.length === 2 && max === 2 && axes.includes(1);
  if (type === "P") {
    const { axis, sign } = players[player];
    return max === 1 && axes.length > 1 && delta[axis] === -sign;
  }
  if (!axes.every(value => value === max)) return false;
  return type === "B" ? axes.length >= 2 : type === "R" ? axes.length === 1 :
    type === "Q" ? axes.length <= 2 : true;
}

function previewMove(game, move) {
  const from = keyOf(move.from);
  const piece = game.board[from];
  const board = { ...game.board, [keyOf(move.to)]: { ...piece, type: move.promotion ?? piece.type } };
  delete board[from];
  return { ...game, board };
}

function kingMoves(game, king) {
  if (game.board[king.key]?.player !== king.player || game.eliminated.includes(king.player)) return [];
  return getLegalMoves({ ...game, turn: king.player }, king.cell);
}

function hillDanger(game, kings, defender) {
  let own = Infinity;
  let first = Infinity;
  let claims = 0;
  for (const king of kings) {
    for (const move of kingMoves(game, king)) {
      if (!move.hillCaptured) continue;
      first = Math.min(first, king.order);
      if (move.hillCaptured === defender) own = Math.min(own, king.order);
      claims += 1;
    }
  }
  return { own, first, claims };
}

function compareDanger(a, b) {
  if (a.own !== b.own) return a.own > b.own ? -1 : 1;
  if (a.first !== b.first) return a.first > b.first ? -1 : 1;
  return a.claims - b.claims;
}

function couldGiveCheck(move, king, player) {
  return reaches(move.to, king.cell, move.promotion ?? move.type, player) ||
    reaches(move.from, king.cell) ||
    (king.checked && gap(move.to, king.cell) <= 2);
}

function eliminationReward(game, player) {
  return game.log.at(-1)?.eliminations?.reduce((total, elimination) =>
    total + (elimination.by === player ? (elimination.reason === "hill" ? 20 : 23) :
      elimination.player === player ? -500 : 4), 0) ?? 0;
}

function exposure(game, player, destination) {
  const target = keyOf(destination);
  const ourPieces = Object.entries(game.board).filter(([key, piece]) =>
    piece.player === player && piece.type !== "K" && (key === target || (PIECE_POINTS[piece.type] ?? 0) >= 5)
  ).map(([key]) => cellOf(key));
  let risk = 0;

  for (const [key, piece] of Object.entries(game.board)) {
    if (piece.player === player) continue;
    const from = cellOf(key);
    if (!ourPieces.some(cell => reaches(from, cell, piece.type, piece.player))) continue;
    const opponent = { ...game, turn: piece.player };
    for (const move of getLegalMoves(opponent, from)) {
      if (move.capture?.player !== player) continue;
      const movedPiece = keyOf(move.to) === target;
      const loss = (PIECE_POINTS[move.capture.type] ?? 0) * (movedPiece ? 0.9 : 0.3);
      risk = Math.max(risk, loss * (piece.player === game.turn ? 1 : 0.68));
    }
  }
  return risk;
}

function approachRisk(game, kings, availableHills) {
  let risk = 0;
  for (const king of kings) {
    const entry = kingMoves(game, king).some(move => {
      if ((king.distance === 1 && !move.capture) || move.hillCaptured ||
          nextHillDistance(move.to, availableHills, king.player) !== 1) return false;
      const staged = previewMove({ ...game, turn: king.player }, { ...move, from: king.cell });
      return kingMoves(staged, { ...king, cell: move.to, key: keyOf(move.to) })
        .some(entry => entry.hillCaptured);
    });
    if (entry) risk += (king.player === game.turn ? 1.5 : 0.85) * (king.distance === 1 ? 2 : 1);
  }
  return risk;
}

function reply(move) {
  return { from: move.from, to: move.to, promotion: move.promotion };
}

export function chooseBotMove(game) {
  if (!players[game.turn] || game.winner || game.draw) return null;

  const activeIndex = PLAYERS.indexOf(players[game.turn]);
  const order = [...PLAYERS.slice(activeIndex + 1), ...PLAYERS.slice(0, activeIndex)]
    .filter(player => !game.eliminated.includes(player.id));
  const kings = Object.fromEntries(Object.entries(game.board).filter(([, piece]) => piece.type === "K")
    .map(([key, piece]) => [piece.player, { key, cell: cellOf(key), player: piece.player }]));
  const availableHills = hills.filter(hill => !game.eliminated.includes(hill.owner)).map(hill => ({
    ...hill, guardDistance: hill.distances.get(kings[hill.owner]?.key) ?? 3,
  }));
  const ratings = moveRatings(game, availableHills);
  if (!ratings.length) return null;

  const rivals = order.flatMap(({ id }, index) => {
    const king = kings[id];
    return king ? [{ ...king, order: index, checked: isInCheck(game, id),
      distance: nextHillDistance(king.cell, availableHills, id) }] : [];
  });
  const immediate = rivals.filter(king => king.distance === 1);
  const nearby = rivals.filter(king => king.distance <= 2);
  const finalists = [];
  let safest = null;

  for (const move of ratings) {
    const affected = rivals.filter(king => couldGiveCheck(move, king, game.turn));
    const preview = !move.hillCaptured && (affected.length || immediate.length) ? previewMove(game, move) : null;
    const next = move.hillCaptured || affected.some(king => isInCheck(preview, king.player))
      ? playMove(game, move.from, move.to, move.promotion) : null;
    if (next?.winner === game.turn) return reply(move);
    const danger = immediate.length ? hillDanger(next ?? preview, immediate, game.turn) : null;
    const comparison = safest && danger ? compareDanger(danger, safest) : 0;
    if (comparison > 0) continue;
    if (comparison < 0) finalists.length = 0;
    if (danger) safest = danger;
    finalists.push({ move, next, score: move.score + (next ? eliminationReward(next, game.turn) : 0) });
  }

  finalists.sort((a, b) => b.score - a.score);
  const shortlist = finalists.slice(0, shortlistSize);
  const kingMove = finalists.find(({ move }) => move.type === "K");
  if (kingMove && !shortlist.includes(kingMove)) shortlist.push(kingMove);

  let best = shortlist[0].move;
  let bestScore = -Infinity;
  for (const { move, next: examined } of shortlist) {
    const next = examined ?? playMove(game, move.from, move.to, move.promotion);
    if (!next) continue;
    if (next.winner === game.turn) return reply(move);
    const score = move.score + eliminationReward(next, game.turn) - exposure(next, game.turn, move.to) -
      approachRisk(next, nearby, availableHills);
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return reply(best);
}
