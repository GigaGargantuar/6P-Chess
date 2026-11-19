import {
  HILL_CELLS, PLAYERS, PIECES, PROMOTION_TYPES, adoptHomeHills, cellOf, createGame, getHillOwner, getLegalMoves,
  isCell, isInCheck, keyOf, playMove,
} from "./engine.mjs";
import { createVolume } from "./volume.mjs";
import { createBotRunner } from "./bot-turns.mjs";
import { createOnlineClient } from "./online.mjs";

const $ = id => document.getElementById(id);
const players = Object.fromEntries(PLAYERS.map(player => [player.id, player]));
const glyphs = { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };
const axes = ["X", "Y", "Z"];
const storageKey = "hexachess-match-v1";

function settleLegacyTurn(states, boundary) {
  const index = states.length - 1;
  if (index > 0 && index <= boundary) states[index] = adoptHomeHills(states[index]);
}

function resumeMatch() {
  const states = [createGame()];
  let botSeats = new Set();
  let hillFrom = 0;
  let hillSafetyFrom = 0;
  let homeHillsFrom = 0;
  let demoPaused = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const log = Array.isArray(saved) ? saved : saved?.log;
    if (Array.isArray(saved?.bots)) {
      botSeats = new Set(PLAYERS.map(player => player.id).filter(id => saved.bots.includes(id)));
      demoPaused = botSeats.size === PLAYERS.length && saved.demoPaused === true;
    }
    if (Array.isArray(log)) {
      // Apply each hill rule from the move recorded under that rule.
      const ruleStart = value => Number.isInteger(value) ? Math.max(0, Math.min(log.length, value)) : log.length;
      hillFrom = ruleStart(saved?.hillFrom);
      hillSafetyFrom = ruleStart(saved?.hillSafetyFrom);
      homeHillsFrom = ruleStart(saved?.homeHillsFrom);
      for (const [index, record] of log.entries()) {
        if (index === homeHillsFrom) settleLegacyTurn(states, homeHillsFrom);
        const next = playMove(states.at(-1), record?.from, record?.to, record?.promotion, {
          hill: index >= hillFrom,
          hillSafety: index >= hillSafetyFrom,
          homeHills: index >= homeHillsFrom,
        });
        if (!next) break;
        states.push(next);
      }
    }
  } catch {
    // Local storage may be unavailable.
  }
  settleLegacyTurn(states, homeHillsFrom);
  return {
    states, botSeats, demoPaused,
    hillFrom: Math.min(hillFrom, states.length - 1),
    hillSafetyFrom: Math.min(hillSafetyFrom, states.length - 1),
    homeHillsFrom: Math.min(homeHillsFrom, states.length - 1),
  };
}

const savedMatch = resumeMatch();
const timeline = savedMatch.states;
let botSeats = savedMatch.botSeats;
let hillFrom = savedMatch.hillFrom;
let hillSafetyFrom = savedMatch.hillSafetyFrom;
let homeHillsFrom = savedMatch.homeHillsFrom;
let demoPaused = savedMatch.demoPaused;
let game = timeline.at(-1);
let view = "volume";
let layerAxis = 0;
let layerDepth = 3;
let layerVisited = false;
let selection = null;
let moves = [];
let promotionMove = null;
let statusOverride = "";
let openPicker = null;
let inspectedArmy = null;
let onlineRoom = null;
let onlineBusy = false;
let onlineNotice = "";
let roomConnection = "";
let sendingMove = null;

const volume = createVolume($("volume"), { onCell: selectCell, onHover: showCell, getSpawnArmy: cameraArmy });
const botRunner = createBotRunner(playBotTurn);
const apiSetting = document.querySelector('meta[name="hexachess-room-api"]')?.content;
const onlineAvailable = apiSetting !== "";
const onlineClient = createOnlineClient({ apiUrl: apiSetting ?? "", onRoom: receiveRoom, onStatus: setRoomConnection });
const position = cell => cell.map(value => String(value).replace("-", "−")).join(", ");
const signed = value => String(value).replace("-", "−");
const armyToken = type => `<span class="army-symbol" aria-hidden="true">${glyphs[type]}</span>`;
const setArmyColor = (node, player) => node.style.setProperty("--army-color", player.color);
const isInView = cell => view === "volume" || cell[layerAxis] === layerDepth;
const destinationsInView = () => moves.filter(move => isInView(move.to));
const seatIsBot = id => onlineRoom ? onlineRoom.seats[id] === "bot" : botSeats.has(id);
const isBotTurn = () => !game.winner && !game.draw && seatIsBot(game.turn);
const isDemo = () => !onlineRoom && botSeats.size === PLAYERS.length;
const canControlTurn = () => !onlineRoom ||
  (onlineRoom.phase === "active" && onlineRoom.you === game.turn && !sendingMove);

function cameraArmy() {
  const opener = game.log[0]?.player ?? game.turn ?? PLAYERS[0].id;
  if (onlineRoom) return onlineRoom.you && !game.eliminated.includes(onlineRoom.you) ? onlineRoom.you : opener;
  const current = Math.max(0, PLAYERS.findIndex(army => army.id === game.turn));
  const order = [...PLAYERS.slice(current), ...PLAYERS.slice(0, current)];
  const human = order.find(({ id }) => !botSeats.has(id) && !game.eliminated.includes(id));
  return human?.id ?? opener;
}

function isRivalHill(cell, player) {
  const owner = getHillOwner(cell);
  return !!owner && owner !== player && !game.eliminated.includes(owner);
}

function isPotentialHillEntry(cell, origin) {
  const piece = game.board[keyOf(origin)];
  const occupant = game.board[keyOf(cell)];
  return piece?.type === "K" && isRivalHill(cell, piece.player) &&
    occupant?.type !== "K" && occupant?.player !== piece.player &&
    Math.max(...origin.map((coordinate, axis) => Math.abs(cell[axis] - coordinate))) === 1;
}

function undoIndex() {
  if (onlineRoom) return -1;
  if (isDemo()) return demoPaused || game.winner || game.draw ? game.log.length - 1 : -1;
  return game.log.findLastIndex(entry => !botSeats.has(entry.player));
}

function saveMatch() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      log: game.log, bots: [...botSeats], hillFrom, hillSafetyFrom, homeHillsFrom, demoPaused,
    }));
  } catch {
    // The current match remains playable without persistence.
  }
}

function showCell(cell) {
  const readout = $("cell-readout");
  if (!cell || !isInView(cell)) {
    readout.textContent = "";
    return;
  }
  const piece = game.board[keyOf(cell)];
  const labels = [position(cell)];
  if (piece) labels.unshift(`${players[piece.player].name} ${PIECES[piece.type]}`);
  const owner = getHillOwner(cell);
  if (owner) labels.push(`${players[owner].name} hill`);
  readout.textContent = labels.join(" · ");
}

function clearSelection() {
  selection = null;
  moves = [];
  openPicker = null;
  statusOverride = "";
}

function selectCell(cell) {
  if (game.winner || game.draw || isBotTurn() || !canControlTurn() || !cell || !isCell(cell) || !isInView(cell)) return;
  const key = keyOf(cell);
  const move = moves.find(candidate => keyOf(candidate.to) === key);
  if (move) {
    chooseMove(move);
    return;
  }

  if (selection && keyOf(selection) === key) {
    clearSelection();
    renderBoard();
    return;
  }
  const piece = game.board[key];
  if (piece?.player === game.turn) {
    selection = cell;
    moves = getLegalMoves(game, cell);
    openPicker = null;
    statusOverride = "";
    renderBoard();
    return;
  }
  if (selection && isPotentialHillEntry(cell, selection)) {
    statusOverride = "That hill cell is under attack.";
  } else {
    statusOverride = piece
      ? `${players[piece.player].name} ${PIECES[piece.type]}. ${players[game.turn].name} is to move.`
      : selection ? "Choose a highlighted destination or another piece." : "Select one of your pieces to begin.";
  }
  renderStatus();
}

function chooseMove(move) {
  if (move.promotes) {
    promotionMove = move;
    const dialog = $("promotion");
    dialog.returnValue = "";
    dialog.showModal();
    return;
  }
  commitMove(move);
}

function commitMove(move, promotion) {
  commitTurn(selection, move.to, promotion);
}

function commitTurn(from, to, promotion) {
  if (onlineRoom) {
    if (!canControlTurn() || isBotTurn() || game.winner || game.draw) return false;
    void sendOnlineMove(from, to, promotion);
    return true;
  }
  const next = playMove(game, from, to, promotion);
  if (!next) return false;
  game = next;
  timeline.push(game);
  afterGameChange(game.log.at(-1));
  return true;
}

function canRunBot() {
  return !onlineRoom && isBotTurn() && !demoPaused && !document.querySelector("dialog[open]");
}

function syncBotTurn() {
  if (canRunBot()) botRunner.request(game);
  else botRunner.cancel();
}

function playBotTurn(expectedGame, move) {
  if (expectedGame !== game || !canRunBot()) return;
  if (move && commitTurn(move.from, move.to, move.promotion)) return;
  for (const [key, piece] of Object.entries(game.board)) {
    if (piece.player !== game.turn) continue;
    const from = cellOf(key);
    const fallback = getLegalMoves(game, from)[0];
    if (fallback) {
      commitTurn(from, fallback.to, fallback.promotes ? "Q" : null);
      return;
    }
  }
}

function afterGameChange(move = null) {
  clearSelection();
  inspectedArmy = null;
  if (view === "layers" && game.winReason === "hill") layerDepth = game.log.at(-1).to[layerAxis];
  else if (view === "layers" && game.turn && !game.winner) showArmyLayer(game.turn);
  else layerVisited = false;
  if (!onlineRoom) {
    hillFrom = Math.min(hillFrom, game.log.length);
    hillSafetyFrom = Math.min(hillSafetyFrom, game.log.length);
    homeHillsFrom = Math.min(homeHillsFrom, game.log.length);
    saveMatch();
  }
  showCell(null);
  render(move);
  syncBotTurn();
}

function showArmyLayer(id) {
  const player = players[id];
  // A vertical slice through the army includes its forward axis.
  layerAxis = player.axis === 2 ? 0 : 2;
  const counts = new Map();
  let kingDepth = 3;
  for (const [key, piece] of Object.entries(game.board)) {
    if (piece.player !== id) continue;
    const depth = cellOf(key)[layerAxis];
    counts.set(depth, (counts.get(depth) ?? 0) + 1);
    if (piece.type === "K") kingDepth = depth;
  }
  layerDepth = [...counts.keys()].sort((a, b) =>
    counts.get(b) - counts.get(a) || Math.abs(a - kingDepth) - Math.abs(b - kingDepth)
  )[0] ?? kingDepth;
}

function setView(next) {
  if (view === next) return;
  view = next;
  if (view === "layers" && !layerVisited) {
    if (inspectedArmy || game.turn) showArmyLayer(inspectedArmy || game.turn);
    if (selection) layerDepth = selection[layerAxis];
    layerVisited = true;
  }
  statusOverride = "";
  showCell(null);
  renderBoard();
}

function setLayer(depth) {
  layerDepth = Math.max(-4, Math.min(11, depth));
  statusOverride = "";
  showCell(null);
  renderBoard();
}

function renderLayerControls() {
  for (const button of $("axis-controls").children) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.axis) === layerAxis));
  }
  const axis = axes[layerAxis];
  $("layer-depth").value = layerDepth;
  $("layer-depth").setAttribute("aria-valuetext", `${axis} layer ${signed(layerDepth)}`);
  $("layer-label").textContent = `${axis} ${signed(layerDepth)}`;
  $("prev-layer").disabled = layerDepth <= -4;
  $("next-layer").disabled = layerDepth >= 11;
}

function piecesInView() {
  if (game.winner || game.draw || isBotTurn() || !canControlTurn()) return [];
  return Object.entries(game.board).filter(([key, piece]) =>
    piece.player === game.turn && isInView(cellOf(key))
  );
}

function renderStatus(destinations = destinationsInView(), pieces = piecesInView()) {
  const status = $("board-status");
  if (onlineRoom?.phase === "lobby") status.textContent = "Waiting for the host to start the match.";
  else if (sendingMove) status.textContent = "Sending move…";
  else if (roomConnection && onlineRoom) status.textContent = roomConnection;
  else if (statusOverride) status.textContent = statusOverride;
  else if (game.winReason === "hill") status.textContent = `${players[game.winner].name} wins by reaching the center hill.`;
  else if (game.winner) status.textContent = `${players[game.winner].name} wins the match.`;
  else if (game.draw) status.textContent = "Draw. All remaining armies are blocked.";
  else if (demoPaused && !onlineRoom) status.textContent = "Demo paused.";
  else if (isBotTurn()) status.textContent = `${players[game.turn].name} bot is choosing a move.`;
  else if (!canControlTurn()) {
    status.textContent = onlineRoom.you ? `Waiting for ${players[game.turn].name} to move.`
      : `Spectating · ${players[game.turn].name} to move.`;
  }
  else if (selection) {
    const piece = game.board[keyOf(selection)];
    const legalTargets = new Set(destinations.map(move => keyOf(move.to)));
    const attackedHillCells = piece.type === "K"
      ? HILL_CELLS.filter(to => isPotentialHillEntry(to, selection) && isInView(to) && !legalTargets.has(keyOf(to))).length
      : 0;
    let summary = "No legal moves";
    if (destinations.length) {
      summary = `${destinations.length} legal ${destinations.length === 1 ? "move" : "moves"}`;
      if (view === "layers") summary += " in this slice";
    } else if (moves.length) {
      summary = "No moves in this slice";
    }
    if (attackedHillCells) {
      summary += ` · ${attackedHillCells} hill ${attackedHillCells === 1 ? "cell" : "cells"} under attack`;
    }
    status.innerHTML = `<strong>${players[piece.player].name} ${PIECES[piece.type]}</strong> · ${position(selection)} · ${summary}`;
  } else if (isInCheck(game)) {
    status.innerHTML = `<strong>${players[game.turn].name}</strong> is in check. Choose a move that protects the king.`;
  } else if (view === "layers" && !pieces.length) {
    status.textContent = `No ${players[game.turn].name} pieces in this slice.`;
  } else {
    status.innerHTML = `Select a <strong>${players[game.turn].name}</strong> piece to see its moves.`;
  }
}

function renderPickers(destinations = destinationsInView(), pieces = piecesInView()) {
  const moveButton = $("move-picker-button");
  const pieceButton = $("piece-picker-button");
  moveButton.hidden = !destinations.length;
  pieceButton.hidden = !pieces.length;
  if ((openPicker === "moves" && moveButton.hidden) || (openPicker === "pieces" && pieceButton.hidden)) {
    openPicker = null;
  }
  moveButton.setAttribute("aria-expanded", String(openPicker === "moves"));
  pieceButton.setAttribute("aria-expanded", String(openPicker === "pieces"));

  const picker = $("move-picker");
  picker.hidden = !openPicker;
  if (openPicker === "moves") {
    picker.innerHTML = destinations.map(move => {
      const action = move.capture ? `Capture ${players[move.capture.player].name} ${PIECES[move.capture.type]}` : "Move";
      const hill = move.hillCaptured;
      const detail = hill ? ` and claim ${players[hill].name}’s hill` : move.promotes ? " and promote" : "";
      const symbol = hill ? "◆" : move.promotes ? "↑" : move.capture ? "×" : "·";
      const style = hill ? "hill-option" : move.capture ? "capture-option" : "";
      return `<button data-cell="${keyOf(move.to)}" class="${style}" aria-label="${action} to ${position(move.to)}${detail}">${position(move.to)} <span aria-hidden="true">${symbol}</span></button>`;
    }).join("");
  } else if (openPicker === "pieces") {
    const selectedKey = selection ? keyOf(selection) : null;
    picker.innerHTML = pieces.map(([key, piece]) => {
      const player = players[piece.player];
      const name = `${player.name} ${PIECES[piece.type]}`;
      const coordinates = position(cellOf(key));
      return `<button class="piece-option" data-cell="${key}" style="--army-color:${player.color}" aria-pressed="${key === selectedKey}" aria-label="Select ${name} at ${coordinates}"><span aria-hidden="true" class="piece-option-glyph">${glyphs[piece.type]}</span> ${coordinates}</button>`;
    }).join("");
  } else {
    picker.replaceChildren();
  }
}

function renderBoard(move = null) {
  const layers = view === "layers";
  const destinations = destinationsInView();
  const pieces = piecesInView();
  const slice = layers ? { axis: layerAxis, depth: layerDepth } : null;
  $("view-volume").setAttribute("aria-pressed", String(!layers));
  $("view-layers").setAttribute("aria-pressed", String(layers));
  $("layer-controls").hidden = !layers;
  $("projection-label").textContent = layers ? `Slice ${axes[layerAxis]} ${signed(layerDepth)}` : "First person";
  $("demo-toggle").hidden = !isDemo() || !!game.winner || game.draw;
  $("demo-toggle").textContent = demoPaused ? "Resume demo" : "Pause demo";
  if (layers) renderLayerControls();
  volume.render({ game, selection, moves: destinations, slice, move });
  renderStatus(destinations, pieces);
  renderPickers(destinations, pieces);
}

function deriveRound() {
  if (!game.log.length) return 1;
  let round = 1;
  for (let index = 1; index < game.log.length; index += 1) {
    if (PLAYERS.indexOf(players[game.log[index].player]) <= PLAYERS.indexOf(players[game.log[index - 1].player])) round += 1;
  }
  if (game.turn && !game.winner && PLAYERS.indexOf(players[game.turn]) <= PLAYERS.indexOf(players[game.log.at(-1).player])) round += 1;
  return round;
}

function renderArmies() {
  const player = players[game.turn] ?? PLAYERS[0];
  const turn = $("turn-banner");
  setArmyColor(turn, player);
  const lobby = onlineRoom?.phase === "lobby";
  const caption = lobby ? "Online lobby" : game.winReason === "hill" ? "King of the Hill"
    : game.winner || game.draw ? "Match complete" : demoPaused && !onlineRoom ? "Demo paused"
      : isInCheck(game) ? "In check" : isBotTurn() ? "Bot turn" : "Current turn";
  const name = lobby ? "Waiting to start" : game.winner ? `${player.name} wins` : game.draw ? "Draw" : `${player.name} to move`;
  turn.innerHTML = `${armyToken("K")}<span class="turn-info"><span class="turn-caption">${caption}</span><strong class="turn-name">${name}</strong></span>${lobby || game.draw ? "" : `<span class="turn-face">${player.face}</span>`}`;
  $("round").textContent = `ROUND ${String(deriveRound()).padStart(2, "0")}`;
  $("match-mode").textContent = onlineRoom ? `Online · ${onlineRoom.code}${onlineRoom.you ? ` · ${players[onlineRoom.you].name}` : " · Watching"}`
    : isDemo() ? "6-bot demo" : botSeats.size ? lineupSummary(botSeats.size) : "Local pass-and-play";

  const counts = Object.fromEntries(PLAYERS.map(army => [army.id, 0]));
  for (const piece of Object.values(game.board)) counts[piece.player] += 1;
  $("player-list").innerHTML = PLAYERS.map(army => {
    const eliminated = game.eliminated.includes(army.id);
    const current = !lobby && army.id === game.turn && !game.winner;
    const controller = army.id === onlineRoom?.you ? "You" : seatIsBot(army.id) ? "Bot" : "";
    const score = game.scores[army.id];
    return `<li><button class="player${eliminated ? " player-out" : ""}" data-player="${army.id}" style="--army-color:${army.color}" aria-current="${current}" aria-label="Focus ${army.name}${controller === "You" ? ", your army" : controller === "Bot" ? ", bot" : ""}, ${score} points, ${counts[army.id]} pieces${eliminated ? ", eliminated" : ""}" title="Focus ${army.name}">
      ${armyToken("K")}<span class="player-name">${army.name}</span><span class="player-kind">${controller}</span><span class="player-face">${army.face}</span><span class="player-count" title="Pieces remaining">${counts[army.id]}</span><span class="player-score" title="Score">${score}<small> pts</small></span>
    </button></li>`;
  }).join("");
}

function renderHistory() {
  $("undo").disabled = undoIndex() < 0;
  $("undo").title = botSeats.size && !isDemo() ? "Undo the latest human move and bot replies" : "Undo the latest move";
  const history = $("move-history");
  if (!game.log.length) {
    history.innerHTML = '<div class="history-empty"><span class="history-empty-symbol" aria-hidden="true">≡</span><strong>No moves yet</strong><span>Played moves will appear here.</span></div>';
    return;
  }
  const entries = game.log.map((entry, index) => {
    const player = players[entry.player];
    const details = [];
    if (entry.capture) details.push(`Captured ${players[entry.capture.player].name} ${PIECES[entry.capture.type]}`);
    if (entry.promotion) details.push(`Promoted to ${PIECES[entry.promotion]}`);
    for (const { player: removed, by, reason } of entry.eliminations) {
      const name = players[removed].name;
      if (reason === "hill") details.push(`Claimed ${name}’s hill`);
      else if (reason === "checkmate") details.push(`${name} checkmated by ${players[by].name}`);
      else details.push(`${name} eliminated`);
      if (by !== entry.player && reason === "checkmate") details.push(`${players[by].name} +20 pts`);
    }
    if (entry.points) details.push(`+${entry.points} pts`);
    if (entry.winReason === "hill") details.push("Won on the center hill");
    return `<li style="--army-color:${player.color}"><span class="history-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="history-symbol" title="${player.name} ${PIECES[entry.type]}" aria-hidden="true">${glyphs[entry.type]}</span>
      <div><div class="history-move"><span class="sr-only">${player.name} ${PIECES[entry.type]} </span>${position(entry.from)} → ${position(entry.to)}</div>
      ${details.length ? `<div class="history-detail">${details.join(" · ")}</div>` : ""}</div></li>`;
  });
  history.innerHTML = `<ol class="history-list">${entries.join("")}</ol>`;
  history.scrollTop = history.scrollHeight;
}

function render(move = null) {
  renderBoard(move);
  renderArmies();
  renderHistory();
  renderOnlineDialog();
}

function receiveRoom(room) {
  const previous = onlineRoom;
  if (!room && !previous) return;
  const continuing = !!room && previous?.code === room.code;
  const entered = !continuing || room.you !== previous.you || room.phase !== previous.phase;
  let move = null;
  let nextGame = room?.game ?? timeline.at(-1);
  if (continuing) {
    const added = nextGame.log.slice(game.log.length);
    if (nextGame.log.length === game.log.length) nextGame = game;
    else if (added.length) {
      nextGame = { ...nextGame, log: [...game.log, ...added] };
      if (added.length === 1) move = added[0];
    }
  } else {
    sendingMove = null;
  }
  onlineRoom = room;
  if (room) botRunner.cancel();
  if (!entered && nextGame === game) {
    renderOnlineDialog();
    return;
  }
  game = nextGame;
  promotionMove = null;
  if ($("promotion").open) $("promotion").close();
  if (entered) {
    layerVisited = false;
    volume.reset(cameraArmy());
  }
  if (room && !continuing) {
    const url = new URL(window.location.href);
    if (url.searchParams.has("room")) {
      url.searchParams.delete("room");
      window.history.replaceState(null, "", url);
    }
  }
  afterGameChange(move);
}

function setRoomConnection(message) {
  roomConnection = message;
  renderOnlineDialog();
  if (onlineRoom) renderStatus();
}

function renderOnlineDialog() {
  const room = onlineRoom;
  $("online-entry").hidden = !!room;
  $("online-room").hidden = !room;
  $("online-button-label").textContent = room ? "Room" : "Online";
  $("restart-button").disabled = !!room;
  $("online-status").textContent = onlineNotice || roomConnection;
  $("online-create").disabled = onlineBusy;
  $("online-seat").disabled = onlineBusy;
  $("online-code").disabled = onlineBusy;
  for (const button of $("online-join").querySelectorAll("button")) button.disabled = onlineBusy;
  if (!room) return;

  $("room-code").textContent = room.code;
  const invite = new URL(window.location.href);
  invite.search = "";
  invite.hash = "";
  invite.searchParams.set("room", room.code);
  if ($("room-invite").value !== invite.href) $("room-invite").value = invite.href;
  $("room-seats").innerHTML = PLAYERS.map(army => {
    const seat = room.seats[army.id];
    const label = army.id === room.you ? (army.id === room.host ? "You · Host" : "You")
      : army.id === room.host ? "Host" : seat === "bot" ? "Bot" : seat === "human" ? "Joined" : "Open";
    return `<li style="--army-color:${army.color}"><span class="room-army"><span class="room-army-dot" aria-hidden="true"></span>${army.name}</span><span class="room-seat-status">${label}</span></li>`;
  }).join("");
  const canStart = room.you === room.host && room.phase === "lobby";
  $("room-start").hidden = !canStart;
  $("room-start").disabled = onlineBusy;
  $("room-leave").disabled = onlineBusy;
  $("room-message").textContent = room.phase === "lobby"
    ? canStart ? "Share the code to invite players. Bots fill any open armies when you start." : "Waiting for the host to start."
    : room.you ? `You are playing ${players[room.you].name}.` : "You are watching this match.";
}

async function onlineAction(work) {
  if (onlineBusy) return;
  onlineBusy = true;
  onlineNotice = "";
  renderOnlineDialog();
  try {
    return await work();
  } catch (error) {
    onlineNotice = error.message;
  } finally {
    onlineBusy = false;
    renderOnlineDialog();
  }
}

async function sendOnlineMove(from, to, promotion) {
  const request = {};
  sendingMove = request;
  statusOverride = "";
  renderStatus();
  try {
    await onlineClient.play(from, to, promotion);
  } catch (error) {
    if (sendingMove === request) statusOverride = error.message;
  } finally {
    if (sendingMove === request) {
      sendingMove = null;
      renderBoard();
    }
  }
}

function showOnline() {
  if (!onlineAvailable) return;
  if (!$("online").open) $("online").showModal();
  syncBotTurn();
}

function codeFromEntry() {
  const input = $("online-code");
  input.value = input.value.trim().toUpperCase();
  return input.reportValidity() ? input.value : null;
}

function lineupSummary(botCount) {
  const humans = PLAYERS.length - botCount;
  return `${humans} ${humans === 1 ? "human" : "humans"} · ${botCount} ${botCount === 1 ? "bot" : "bots"}`;
}

function draftBotSeats() {
  const seats = $("match-seats").querySelectorAll("select");
  return new Set([...seats].filter(seat => seat.value === "bot").map(seat => seat.dataset.seat));
}

function updateSetupStatus() {
  const bots = draftBotSeats();
  const count = bots.size;
  $("setup-solo").setAttribute("aria-pressed", String(count === PLAYERS.length - 1 && !bots.has(PLAYERS[0].id)));
  $("setup-all-human").setAttribute("aria-pressed", String(count === 0));
  $("setup-demo").setAttribute("aria-pressed", String(count === PLAYERS.length));
  $("setup-status").textContent = count === PLAYERS.length ? "6-bot demo" : lineupSummary(count);
}

function setLineupPreset(preset) {
  for (const seat of $("match-seats").querySelectorAll("select")) {
    const isBot = preset === "demo" || (preset === "solo" && seat.dataset.seat !== PLAYERS[0].id);
    seat.value = isBot ? "bot" : "human";
  }
  updateSetupStatus();
}

$("rules-button").addEventListener("click", () => {
  $("rules").showModal();
  syncBotTurn();
});
$("rules").addEventListener("close", syncBotTurn);
$("online-seat").innerHTML = PLAYERS.map(army => `<option value="${army.id}">${army.name}</option>`).join("");
$("online-button").addEventListener("click", showOnline);
$("online").addEventListener("close", syncBotTurn);
$("online-create").addEventListener("click", () => onlineAction(() => onlineClient.create($("online-seat").value)));
$("online-join").addEventListener("submit", event => {
  event.preventDefault();
  const code = codeFromEntry();
  if (code) void onlineAction(() => onlineClient.join(code, $("online-seat").value));
});
$("online-watch").addEventListener("click", () => {
  const code = codeFromEntry();
  if (code) void onlineAction(() => onlineClient.watch(code));
});
$("room-start").addEventListener("click", async () => {
  const room = await onlineAction(() => onlineClient.start());
  if (room?.phase === "active" && $("online").open) $("online").close();
});
$("room-play").addEventListener("click", () => $("online").close());
$("room-leave").addEventListener("click", () => {
  onlineNotice = "";
  onlineClient.leave();
  $("online").close();
});
$("room-copy").addEventListener("click", async () => {
  const input = $("room-invite");
  try {
    await navigator.clipboard.writeText(input.value);
    onlineNotice = "Invite link copied.";
  } catch {
    input.focus();
    input.select();
    onlineNotice = "Invite link selected. Copy it to share.";
  }
  renderOnlineDialog();
});
$("restart-button").addEventListener("click", () => {
  if (onlineRoom) return;
  $("match-seats").innerHTML = PLAYERS.map(army => `<label class="seat" style="--army-color:${army.color}">
    ${armyToken("K")}<span class="seat-name">${army.name}</span>
    <select data-seat="${army.id}" aria-label="${army.name} controller">
      <option value="human">Human</option>
      <option value="bot"${botSeats.has(army.id) ? " selected" : ""}>Bot</option>
    </select></label>`
  ).join("");
  updateSetupStatus();
  $("replace-match").hidden = !game.log.length;
  $("restart").returnValue = "";
  $("restart").showModal();
  syncBotTurn();
});
for (const [id, preset] of [["setup-solo", "solo"], ["setup-all-human", "human"], ["setup-demo", "demo"]]) {
  $(id).addEventListener("click", () => setLineupPreset(preset));
}
$("match-seats").addEventListener("change", updateSetupStatus);
$("restart").addEventListener("close", ({ currentTarget }) => {
  if (currentTarget.returnValue !== "restart") {
    syncBotTurn();
    return;
  }
  botRunner.cancel();
  botSeats = draftBotSeats();
  hillFrom = 0;
  hillSafetyFrom = 0;
  homeHillsFrom = 0;
  demoPaused = false;
  game = createGame();
  timeline.splice(0, timeline.length, game);
  layerVisited = false;
  volume.reset(cameraArmy());
  afterGameChange();
});
$("undo").addEventListener("click", () => {
  const index = undoIndex();
  if (index < 0) return;
  botRunner.cancel();
  if (isDemo()) demoPaused = true;
  timeline.splice(index + 1);
  settleLegacyTurn(timeline, homeHillsFrom);
  game = timeline.at(-1);
  afterGameChange();
});
$("demo-toggle").addEventListener("click", () => {
  if (!isDemo() || game.winner || game.draw) return;
  demoPaused = !demoPaused;
  saveMatch();
  render();
  syncBotTurn();
});

$("view-volume").addEventListener("click", () => setView("volume"));
$("view-layers").addEventListener("click", () => setView("layers"));
$("zoom-in").addEventListener("click", () => volume.zoom(1.15));
$("zoom-out").addEventListener("click", () => volume.zoom(1 / 1.15));
$("reset-camera").addEventListener("click", () => {
  inspectedArmy = null;
  volume.reset(cameraArmy());
});
$("focus-hill").innerHTML += PLAYERS.map(army => `<option value="${army.id}">${army.name} hill</option>`).join("");
$("focus-hill").addEventListener("change", ({ currentTarget }) => {
  const id = currentTarget.value;
  const army = players[id];
  if (!army) return;
  currentTarget.value = "";
  if (view === "layers") {
    const cell = HILL_CELLS.find(home => getHillOwner(home) === id);
    layerAxis = army.axis;
    setLayer(cell[layerAxis]);
  }
  volume.focusHill(id);
});
for (const button of $("touch-movement").querySelectorAll("[data-movement]")) {
  const code = button.dataset.movement;
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    $("volume").focus({ preventScroll: true });
    button.setPointerCapture(event.pointerId);
    volume.setMovement(code, true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(type, () => volume.setMovement(code, false));
  }
}
$("player-list").addEventListener("click", event => {
  const button = event.target.closest("button[data-player]");
  if (!button) return;
  inspectedArmy = button.dataset.player;
  volume.focusPlayer(inspectedArmy);
  if (view === "layers") {
    showArmyLayer(inspectedArmy);
    setLayer(layerDepth);
  }
});
$("axis-controls").addEventListener("click", event => {
  const button = event.target.closest("button[data-axis]");
  if (!button) return;
  layerAxis = Number(button.dataset.axis);
  const current = players[game.turn];
  setLayer(selection?.[layerAxis] ?? (current?.axis === layerAxis ? current.sign < 0 ? -3 : 10 : 3));
});
$("layer-depth").addEventListener("input", event => setLayer(Number(event.target.value)));
$("prev-layer").addEventListener("click", () => setLayer(layerDepth - 1));
$("next-layer").addEventListener("click", () => setLayer(layerDepth + 1));
for (const [id, type] of [["move-picker-button", "moves"], ["piece-picker-button", "pieces"]]) {
  $(id).addEventListener("click", () => {
    openPicker = openPicker === type ? null : type;
    renderPickers();
  });
}
$("move-picker").addEventListener("click", event => {
  const button = event.target.closest("button[data-cell]");
  if (!button) return;
  selectCell(cellOf(button.dataset.cell));
  if (document.querySelector("dialog[open]") || button.isConnected) return;
  const fallback = [$("move-picker-button"), $("piece-picker-button"), $("layer-depth")]
    .find(node => !node.closest("[hidden]")) ?? $("volume");
  fallback.focus({ preventScroll: true });
});
$("promotion-options").innerHTML = PROMOTION_TYPES.map(type =>
  `<button value="${type}"><span aria-hidden="true">${glyphs[type]}</span>${PIECES[type]}</button>`
).join("");
$("promotion").addEventListener("close", ({ currentTarget }) => {
  const move = promotionMove;
  promotionMove = null;
  if (move && PROMOTION_TYPES.includes(currentTarget.returnValue)) commitMove(move, currentTarget.returnValue);
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]") || !selection) return;
  clearSelection();
  renderBoard();
});

$("online-button").hidden = !onlineAvailable;
$("online-help").hidden = !onlineAvailable;
volume.reset(cameraArmy());
render();
syncBotTurn();

if (onlineAvailable) {
  const inviteCode = new URL(window.location.href).searchParams.get("room")?.toUpperCase();
  if (inviteCode && /^[A-HJ-NP-Z2-9]{8}$/.test(inviteCode)) {
    $("online-code").value = inviteCode;
    showOnline();
  } else {
    void onlineAction(() => onlineClient.restore()).then(room => {
      if (room?.phase === "lobby" && !document.querySelector("dialog[open]")) showOnline();
    });
  }
}
