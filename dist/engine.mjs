export const PLAYERS = [
  { id: "north", name: "North", face: "−Z", color: "#55e6b3", axis: 2, sign: -1, right: [-1, 0, 0], up: [0, 1, 0] },
  { id: "east", name: "East", face: "+X", color: "#f7c66d", axis: 0, sign: 1, right: [0, 0, -1], up: [0, 1, 0] },
  { id: "south", name: "South", face: "+Z", color: "#b6a0f8", axis: 2, sign: 1, right: [1, 0, 0], up: [0, 1, 0] },
  { id: "west", name: "West", face: "−X", color: "#f78fae", axis: 0, sign: -1, right: [0, 0, 1], up: [0, 1, 0] },
  { id: "zenith", name: "Zenith", face: "+Y", color: "#79c8f5", axis: 1, sign: 1, right: [1, 0, 0], up: [0, 0, -1] },
  { id: "nadir", name: "Nadir", face: "−Y", color: "#f49b78", axis: 1, sign: -1, right: [-1, 0, 0], up: [0, 0, -1] },
];

export const PIECES = {
  K: "King",
  Q: "Queen",
  R: "Rook",
  B: "Bishop",
  N: "Knight",
  P: "Pawn",
};

export const ARM_PATTERN = ["BNNB", "NQRN", "NRKN", "BNNB"];
export const PROMOTION_TYPES = ["Q", "R", "B", "N"];
export const PIECE_POINTS = { Q: 9, B: 5, R: 4, N: 3, P: 1 };
export const ELIMINATION_POINTS = 20;

const CENTER = 3.5;
const FIRST_CORE_CELL = 0;
const LAST_CORE_CELL = 7;
const LOWEST_CELL = -4;
const HIGHEST_CELL = 11;
const FIRST_ARM_CELL = 2;
const LAST_ARM_CELL = 5;
const HOME_PAWN_DEPTH = 1;
const STEPS = [-1, 0, 1];

const kingDirections = STEPS.flatMap(x =>
  STEPS.flatMap(y => STEPS.map(z => [x, y, z]))
).filter(step => step.some(Boolean));

const rookDirections = [];
const bishopDirections = [];
const queenDirections = [];
const knightDirections = [];

for (const step of kingDirections) {
  const activeAxes = step.filter(Boolean).length;
  if (activeAxes === 1) rookDirections.push(step);
  if (activeAxes >= 2) bishopDirections.push(step);
  if (activeAxes <= 2) queenDirections.push(step);
  if (activeAxes === 2) {
    for (const longAxis of step.keys()) {
      if (step[longAxis]) {
        knightDirections.push(step.map((distance, axis) => axis === longAxis ? 2 * distance : distance));
      }
    }
  }
}

const sliders = { R: rookDirections, B: bishopDirections, Q: queenDirections };
const jumpers = { K: kingDirections, N: knightDirections };
const playersById = Object.fromEntries(PLAYERS.map(player => [player.id, player]));
const startingScores = Object.fromEntries(PLAYERS.map(player => [player.id, 0]));
const kingLocations = new WeakMap();
const attackPaths = new Map();
const reverseDirections = kingDirections.map(step => ({
  step,
  sliderTypes: Object.keys(sliders).filter(type => sliders[type].includes(step)),
  pawnPlayers: PLAYERS.filter(({ axis, sign }) => step[axis] === sign && hasSideStep(step, axis))
    .map(player => player.id),
}));

export function keyOf(cell) {
  return cell.join(",");
}

export function cellOf(key) {
  return key.split(",").map(Number);
}

export function getRegion(cell) {
  if (!Array.isArray(cell) || cell.length !== 3 ||
      !cell.every(value => Number.isInteger(value) && value >= LOWEST_CELL && value <= HIGHEST_CELL)) {
    return null;
  }

  const outerAxis = cell.findIndex(value => value < FIRST_CORE_CELL || value > LAST_CORE_CELL);
  if (outerAxis === -1) return "core";
  if (!cell.every((value, axis) => axis === outerAxis || (value >= FIRST_ARM_CELL && value <= LAST_ARM_CELL))) {
    return null;
  }

  const sign = cell[outerAxis] < FIRST_CORE_CELL ? -1 : 1;
  return PLAYERS.find(player => player.axis === outerAxis && player.sign === sign).id;
}

export function isCell(cell) {
  return getRegion(cell) !== null;
}

export const ALL_CELLS = [];
for (let x = LOWEST_CELL; x <= HIGHEST_CELL; x += 1) {
  for (let y = LOWEST_CELL; y <= HIGHEST_CELL; y += 1) {
    for (let z = LOWEST_CELL; z <= HIGHEST_CELL; z += 1) {
      const cell = [x, y, z];
      if (isCell(cell)) ALL_CELLS.push(cell);
    }
  }
}

function armCoordinate(sign, depth) {
  return sign < 0 ? LOWEST_CELL + depth : HIGHEST_CELL - depth;
}

function startCell(player, row, column, depth) {
  const coordinates = player.right.map((right, axis) =>
    CENTER + right * (column - 1.5) + player.up[axis] * (1.5 - row)
  );
  coordinates[player.axis] = armCoordinate(player.sign, depth);
  return coordinates;
}

const homeHills = PLAYERS.flatMap(player => [1, 2].flatMap(row =>
  [1, 2].map(column => ({ cell: startCell(player, row, column, 0), owner: player.id }))
));
const hillOwners = new Map(homeHills.map(({ cell, owner }) => [keyOf(cell), owner]));

export const HILL_CELLS = homeHills.map(({ cell }) => cell);

export function getHillOwner(cell) {
  if (!Array.isArray(cell) || cell.length !== 3 || !cell.every(Number.isInteger)) return null;
  return hillOwners.get(keyOf(cell)) ?? null;
}

export function isHill(cell) {
  return getHillOwner(cell) !== null;
}

function isCenterHill(cell) {
  return cell.every(coordinate => coordinate === 3 || coordinate === 4);
}

export function createGame() {
  const board = {};
  for (const player of PLAYERS) {
    for (const [row, line] of ARM_PATTERN.entries()) {
      for (const [column, type] of [...line].entries()) {
        board[keyOf(startCell(player, row, column, 0))] = { player: player.id, type };
        board[keyOf(startCell(player, row, column, HOME_PAWN_DEPTH))] = { player: player.id, type: "P" };
      }
    }
  }

  return {
    board, turn: PLAYERS[0].id, log: [], eliminated: [], scores: { ...startingScores },
    winner: null, winReason: null, draw: false,
  };
}

function offset(from, step, distance = 1) {
  return from.map((coordinate, axis) => coordinate + step[axis] * distance);
}

function hasSideStep(step, axis) {
  return step.some((amount, dimension) => dimension !== axis && amount !== 0);
}

function pawnMoves(board, from, piece) {
  const { axis, sign } = playersById[piece.player];
  const onStartingLayer = from[axis] === armCoordinate(sign, HOME_PAWN_DEPTH);
  const moves = [];

  for (const step of kingDirections) {
    if (step[axis] !== -sign) continue;
    const to = offset(from, step);
    if (!isCell(to)) continue;
    const capture = board[keyOf(to)] ?? null;
    const diagonal = hasSideStep(step, axis);
    if (diagonal ? !capture || capture.player === piece.player : capture) continue;
    const promotes = (from[axis] - CENTER) * sign > 0 && (to[axis] - CENTER) * sign < 0;
    moves.push({ to, capture, promotes });
    if (!diagonal && onStartingLayer) {
      const doubleStep = offset(from, step, 2);
      if (isCell(doubleStep) && !board[keyOf(doubleStep)]) {
        moves.push({ to: doubleStep, capture: null, promotes: false });
      }
    }
  }

  return moves;
}

function pieceMoves(board, from, piece) {
  if (piece.type === "P") return pawnMoves(board, from, piece);

  const slider = sliders[piece.type];
  const moves = [];
  for (const direction of slider ?? jumpers[piece.type] ?? []) {
    for (let distance = 1; ; distance += 1) {
      const to = offset(from, direction, distance);
      if (!isCell(to)) break;
      const capture = board[keyOf(to)] ?? null;
      if (capture?.player === piece.player) break;
      moves.push({ to, capture, promotes: false });
      if (capture || !slider) break;
    }
  }
  return moves;
}

function pathsTo(target) {
  const cached = attackPaths.get(target);
  if (cached) return cached;
  const cell = cellOf(target);
  const raySquares = new Set();
  const rays = reverseDirections.map(({ step, sliderTypes, pawnPlayers }) => {
    const squares = [];
    for (let distance = 1; ; distance += 1) {
      const square = offset(cell, step, distance);
      if (!isCell(square)) break;
      const key = keyOf(square);
      squares.push(key);
      raySquares.add(key);
    }
    return { squares, sliderTypes, pawnPlayers };
  });
  const knights = knightDirections.map(step => offset(cell, step)).filter(isCell).map(keyOf);
  const paths = { rays, raySquares, knights };
  attackPaths.set(target, paths);
  return paths;
}

function findKing(board, player) {
  const cached = kingLocations.get(board);
  const position = cached?.get(player);
  if (board[position]?.type === "K" && board[position].player === player) return position;

  for (const key in board) {
    const piece = board[key];
    if (piece.type !== "K" || piece.player !== player) continue;
    const locations = cached ?? new Map();
    locations.set(player, key);
    if (!cached) kingLocations.set(board, locations);
    return key;
  }
  return null;
}

function isAttacked(board, target, defender, eliminated, move = {}, attackers = null) {
  if (!target) return false;
  const paths = pathsTo(target);

  // A proposed move can vacate a blocker, place a new blocker, or remove an entire army.
  function pieceAt(key) {
    if (key === move.from) return null;
    const piece = key === move.to ? move.piece : board[key];
    if (!piece || piece.player === move.removed || eliminated.includes(piece.player)) return null;
    return piece;
  }

  for (const { squares, sliderTypes, pawnPlayers } of paths.rays) {
    for (let index = 0; index < squares.length; index += 1) {
      const piece = pieceAt(squares[index]);
      if (!piece) continue;
      if (piece.player !== defender &&
          (sliderTypes.includes(piece.type) || (index === 0 &&
            (piece.type === "K" || (piece.type === "P" && pawnPlayers.includes(piece.player)))))) {
        if (!attackers) return true;
        attackers.add(piece.player);
      }
      break;
    }
  }
  for (const key of paths.knights) {
    const piece = pieceAt(key);
    if (piece?.type !== "N" || piece.player === defender) continue;
    if (!attackers) return true;
    attackers.add(piece.player);
  }
  return !!attackers?.size;
}

export function isInCheck(game, player = game.turn) {
  return !!player && !game.eliminated.includes(player) &&
    isAttacked(game.board, findKing(game.board, player), player, game.eliminated);
}

function legalPieceMoves(board, from, piece, eliminated, options, firstOnly = false) {
  const { homeHills = true, hill = true, hillSafety = true } = options;
  const possible = pieceMoves(board, from, piece);
  if (!possible.length) return possible;

  const origin = keyOf(from);
  if (!homeHills) {
    if (!hill || !hillSafety || piece.type !== "K") return possible;
    return possible.filter(move => !isCenterHill(move.to) || !isAttacked(
      board, keyOf(move.to), piece.player, eliminated,
      { from: origin, removed: move.capture?.type === "K" ? move.capture.player : null }
    ));
  }

  const kingMoves = piece.type === "K";
  const king = kingMoves ? origin : findKing(board, piece.player);
  // A quiet move away from the king's rays cannot expose a king that is already safe.
  const checkSafety = kingMoves || (king &&
    (pathsTo(king).raySquares.has(origin) || isAttacked(board, king, piece.player, eliminated)));
  const legal = [];
  for (const move of possible) {
    if (move.capture?.type === "K") continue;
    const destination = keyOf(move.to);
    const owner = kingMoves ? hillOwners.get(destination) : null;
    const hillCaptured = owner && owner !== piece.player && !eliminated.includes(owner) ? owner : null;
    const change = { from: origin, to: destination, piece };
    const kingAfter = kingMoves ? destination : king;
    if (checkSafety && isAttacked(board, kingAfter, piece.player, eliminated, change)) continue;
    if (hillCaptured && isAttacked(board, kingAfter, piece.player, eliminated, { ...change, removed: hillCaptured })) {
      continue;
    }
    legal.push({ ...move, hillCaptured });
    if (firstOnly) break;
  }
  return legal;
}

export function getLegalMoves(game, from, options = {}) {
  if (game.winner || game.draw || !isCell(from)) return [];
  const piece = game.board[keyOf(from)];
  if (!piece || piece.player !== game.turn) return [];
  return legalPieceMoves(game.board, from, piece, game.eliminated, options);
}

function removeArmy(state, player, by, reason) {
  for (const key in state.board) {
    if (state.board[key].player === player) delete state.board[key];
  }
  state.eliminated.push(player);
  state.eliminations.push({ player, by, reason });
  if (reason !== "capture") state.scores[by] += ELIMINATION_POINTS;
}

function creditCheckmate(attackers, mover, history) {
  if (attackers.has(mover)) return mover;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (attackers.has(history[index].player)) return history[index].player;
  }
  return PLAYERS.find(player => attackers.has(player.id)).id;
}

function survivingArmy(eliminated) {
  if (eliminated.length !== PLAYERS.length - 1) return null;
  return PLAYERS.find(player => !eliminated.includes(player.id)).id;
}

function nextTurn(state, after, history, options, mover = after) {
  let index = PLAYERS.findIndex(player => player.id === after);
  let visited = 0;
  while (visited < PLAYERS.length) {
    const winner = survivingArmy(state.eliminated);
    if (winner) return winner;
    index = (index + 1) % PLAYERS.length;
    visited += 1;
    const { id } = PLAYERS[index];
    if (state.eliminated.includes(id)) continue;

    const { board, eliminated } = state;
    const hasMove = Object.entries(board).some(([key, piece]) => piece.player === id &&
      legalPieceMoves(board, cellOf(key), piece, eliminated, options, true).length > 0);
    if (hasMove) return id;
    if (options.homeHills === false) continue;
    const attackers = new Set();
    if (isAttacked(board, findKing(board, id), id, eliminated, {}, attackers)) {
      removeArmy(state, id, creditCheckmate(attackers, mover, history), "checkmate");
      visited = 0;
    }
  }
  return null;
}

export function adoptHomeHills(game) {
  const seat = PLAYERS.findIndex(player => player.id === game.turn);
  if (seat < 0 || game.winner || game.draw) return game;

  const last = game.log.at(-1);
  const previousSeat = PLAYERS[(seat + PLAYERS.length - 1) % PLAYERS.length].id;
  const state = {
    board: { ...game.board }, eliminated: [...game.eliminated], eliminations: [],
    scores: { ...startingScores, ...game.scores },
  };
  const turn = nextTurn(state, previousSeat, game.log, {}, last?.player ?? null);
  const { board, eliminated, eliminations, scores } = state;
  if (turn === game.turn && !eliminations.length) return game;

  const winner = survivingArmy(eliminated);
  const winReason = winner ? "last-army" : null;
  let log = game.log;
  if (last && eliminations.length) {
    const points = scores[last.player] - (game.scores?.[last.player] ?? 0);
    log = [...log.slice(0, -1), {
      ...last,
      eliminated: last.eliminated ?? eliminations[0].player,
      eliminations: [...(last.eliminations ?? []), ...eliminations],
      points: (last.points ?? 0) + points,
      winReason,
    }];
  }
  return { ...game, board, turn, log, eliminated, scores, winner, winReason, draw: turn === null };
}

export function playMove(game, from, to, promotion, options = {}) {
  if (!isCell(to)) return null;
  const target = keyOf(to);
  const move = getLegalMoves(game, from, options).find(candidate => keyOf(candidate.to) === target);
  if (!move || (move.promotes && !PROMOTION_TYPES.includes(promotion))) return null;

  const source = keyOf(from);
  const piece = game.board[source];
  const promotedType = move.promotes ? promotion : null;
  const state = {
    board: { ...game.board }, eliminated: [...game.eliminated], eliminations: [],
    scores: { ...startingScores, ...game.scores },
  };
  delete state.board[source];
  state.board[target] = { player: piece.player, type: promotedType ?? piece.type };
  const capturePoints = PIECE_POINTS[move.capture?.type] ?? 0;
  state.scores[piece.player] += capturePoints;

  const hillCaptured = move.hillCaptured ?? null;
  if (hillCaptured) removeArmy(state, hillCaptured, piece.player, "hill");
  if (move.capture?.type === "K") removeArmy(state, move.capture.player, piece.player, "capture");
  const centerWin = options.homeHills === false && options.hill !== false &&
    piece.type === "K" && isCenterHill(move.to);
  const turn = centerWin ? piece.player : nextTurn(state, game.turn, game.log, options);
  const winner = centerWin ? piece.player : survivingArmy(state.eliminated);
  const winReason = centerWin ? "hill" : winner ? "last-army" : null;
  const { board, eliminated, eliminations, scores } = state;
  const points = scores[piece.player] - (game.scores?.[piece.player] ?? 0);
  const entry = {
    player: piece.player,
    type: piece.type,
    from: [...from],
    to: move.to,
    capture: move.capture,
    promotion: promotedType,
    eliminated: eliminations[0]?.player ?? null,
    eliminations,
    hillCaptured,
    points,
    winReason,
  };
  return { board, turn, log: [...game.log, entry], eliminated, scores, winner, winReason, draw: turn === null };
}
