import { PLAYERS, PROMOTION_TYPES, createGame, isCell, playMove } from "../dist/engine.mjs";
import { chooseBotMove } from "../dist/bot.mjs";

const seats = PLAYERS.map(player => player.id);
const seatIds = new Set(seats);
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomPath = /^\/api\/rooms(?:\/([^/]+)(?:\/(join|start|move|advance))?)?\/?$/;
const roomCode = /^[A-HJ-NP-Z2-9]{8}$/;
const maxBodyBytes = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

class RoomError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...noStore, ...headers } });
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)),
    byte => codeAlphabet[byte % codeAlphabet.length]).join("");
}

async function digest(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

async function seatCredentials() {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await digest(token) };
}

async function identifySeat(request, state) {
  const bearer = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.get("Authorization") ?? "");
  if (!bearer) return null;
  const hash = await digest(bearer[1]);
  return seats.find(seat => state.seats[seat] === "human" && state.tokens[seat] === hash) ?? null;
}

function snapshot(code, revision, state, you) {
  const { host, seats, phase, game } = state;
  return { code, revision, host, seats, phase, game, you };
}

async function bodyObject(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RoomError(415, "Send an application/json request.");
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > maxBodyBytes) {
    throw new RoomError(413, "Request body is too large.");
  }
  if (!request.body) throw new RoomError(400, "A JSON object is required.");

  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBodyBytes);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBodyBytes) {
        await reader.cancel();
        throw new RoomError(413, "Request body is too large.");
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const data = JSON.parse(decoder.decode(bytes.subarray(0, size)));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // Invalid UTF-8 and invalid JSON both fail the body requirement.
  }
  throw new RoomError(400, "A JSON object is required.");
}

function validatedSeat(value) {
  if (!seatIds.has(value)) throw new RoomError(400, "Choose one of the six armies.");
  return value;
}

function validateRevision(revision, actual) {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RoomError(400, "A valid room revision is required.");
  }
  if (revision !== actual) throw new RoomError(409, "The room changed. Refresh and try again.");
}

function readAfter(url) {
  const after = url.searchParams.get("after");
  if (after === null) return null;
  const revision = Number(after);
  if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(revision)) {
    throw new RoomError(400, "The after revision must be a nonnegative integer.");
  }
  return revision;
}

function normalizeCode(value) {
  let code;
  try {
    code = decodeURIComponent(value).trim().toUpperCase();
  } catch {
    throw new RoomError(400, "The room code is invalid.");
  }
  if (!roomCode.test(code)) throw new RoomError(400, "The room code is invalid.");
  return code;
}

async function createRoom(request, db) {
  const { seat } = await bodyObject(request);
  const host = validatedSeat(seat);
  const { token, hash } = await seatCredentials();
  const state = {
    host, seats: Object.fromEntries(seats.map(id => [id, id === host ? "human" : "open"])),
    phase: "lobby", game: createGame(), tokens: { [host]: hash },
  };
  const serialized = JSON.stringify(state);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomCode();
    const result = await db.prepare(
      "INSERT INTO rooms (code, revision, state, updated_at) VALUES (?, 0, ?, ?) ON CONFLICT (code) DO NOTHING"
    ).bind(code, serialized, Date.now()).run();
    if (result.meta.changes === 1) return json({ token, room: snapshot(code, 0, state, host) }, 201);
  }
  throw new RoomError(503, "A room code could not be allocated. Try again.");
}

async function updateRoom(db, code, revision, state, you, token) {
  const result = await db.prepare(
    "UPDATE rooms SET state = ?, revision = revision + 1, updated_at = ? WHERE code = ? AND revision = ?"
  ).bind(JSON.stringify(state), Date.now(), code, revision).run();
  if (result.meta.changes !== 1) throw new RoomError(409, "The room changed. Refresh and try again.");

  const room = snapshot(code, revision + 1, state, you);
  return json(token ? { token, room } : { room });
}

function startMatch(state, you) {
  if (state.host !== you) throw new RoomError(403, "Only the host can start the match.");
  if (state.phase !== "lobby") throw new RoomError(409, "The match has already started.");
  state.phase = "active";
  for (const seat of seats) {
    if (state.seats[seat] === "open") state.seats[seat] = "bot";
  }
}

function applyRoomMove(state, move) {
  const next = playMove(state.game, move.from, move.to, move.promotion);
  if (!next) throw new RoomError(422, "That move is not legal.");
  state.game = next;
}

async function roomRoute(request, db, url, code, action) {
  const method = action ? "POST" : "GET";
  if (request.method !== method) throw new RoomError(405, "Method not allowed.", { Allow: method });
  const after = action ? null : readAfter(url);
  const row = await db.prepare("SELECT revision, state FROM rooms WHERE code = ?").bind(code).first();
  if (!row) throw new RoomError(404, "Room not found.");
  const { revision } = row;
  if (!action && after === revision) return new Response(null, { status: 204, headers: noStore });

  const state = JSON.parse(row.state);
  if (action === "join") {
    const { seat } = await bodyObject(request);
    validatedSeat(seat);
    if (state.phase !== "lobby") throw new RoomError(409, "The match has already started.");
    if (state.seats[seat] !== "open") throw new RoomError(409, "That army is already claimed.");
    const { token, hash } = await seatCredentials();
    state.seats[seat] = "human";
    state.tokens[seat] = hash;
    return updateRoom(db, code, revision, state, seat, token);
  }

  const you = await identifySeat(request, state);
  if (!action) return json({ room: snapshot(code, revision, state, you) });
  if (!you) throw new RoomError(401, "A room seat is required.", { "WWW-Authenticate": "Bearer" });

  const body = await bodyObject(request);
  validateRevision(body.revision, revision);
  if (action === "start") {
    startMatch(state, you);
    return updateRoom(db, code, revision, state, you);
  }
  if (state.phase !== "active") throw new RoomError(409, "The match has not started.");
  if (state.game.winner || state.game.draw) throw new RoomError(409, "The match is complete.");

  if (action === "move") {
    if (state.game.turn !== you) throw new RoomError(403, "It is another army's turn.");
    const { from, to, promotion } = body;
    if (!isCell(from) || !isCell(to) || (promotion != null && !PROMOTION_TYPES.includes(promotion))) {
      throw new RoomError(400, "Provide valid source, destination, and promotion values.");
    }
    applyRoomMove(state, body);
  } else {
    if (state.seats[state.game.turn] !== "bot") throw new RoomError(409, "It is not a bot's turn.");
    const move = chooseBotMove(state.game);
    if (!move) throw new RoomError(409, "The bot has no legal move.");
    applyRoomMove(state, move);
  }
  return updateRoom(db, code, revision, state, you);
}

export async function handleRooms(request, env) {
  try {
    const url = new URL(request.url);
    const path = roomPath.exec(url.pathname);
    if (!path) throw new RoomError(404, "Room endpoint not found.");
    const [, code, action] = path;
    if (code) return await roomRoute(request, env.DB, url, normalizeCode(code), action);

    if (request.method !== "POST") throw new RoomError(405, "Method not allowed.", { Allow: "POST" });
    return await createRoom(request, env.DB);
  } catch (error) {
    if (error instanceof RoomError) return json({ error: error.message }, error.status, error.headers);
    return json({ error: "Room service is unavailable. Try again." }, 503);
  }
}
