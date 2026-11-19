const pollDelay = 900;
const botDelay = 450;
const requestTimeout = 7000;

function load(storage, key) {
  try {
    return JSON.parse(globalThis[storage]?.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function save(storage, key, value) {
  try {
    const target = globalThis[storage];
    if (!target) return false;
    if (value === null) target.removeItem(key);
    else target.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function normalizeCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error("Enter an eight-character room code.");
  return code;
}

function requestError(message, status = 0) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function send(url, { token, body, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, requestTimeout);
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers, cache: "no-store", signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw requestError(result?.error ?? "The room service is unavailable. Try again.", response.status);
    }
    if (!result?.room) throw requestError("The room service returned an invalid response.", 502);
    return result;
  } catch (error) {
    if (error.status) throw error;
    throw requestError("Could not reach the room. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function isTemporary(error) {
  return !error.status || error.status >= 500 || error.status === 429;
}

function sameCell(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((coordinate, axis) => coordinate === b[axis]);
}

export function createOnlineClient({ apiUrl = "", onRoom = () => {}, onStatus = () => {} } = {}) {
  const roomsUrl = `${apiUrl}/api/rooms`;
  const apiScope = apiUrl ? `:${apiUrl}` : "";
  const roomKey = `hexachess-online-room-v1${apiScope}`;
  const seatsKey = `hexachess-online-seats-v1${apiScope}`;
  const seats = new Map(Object.entries(load("localStorage", seatsKey) ?? {}));
  let session = null;
  let action = null;
  let connection = "";

  function getRoom(code, token, signal, after) {
    const query = Number.isInteger(after) ? `?after=${after}` : "";
    return send(`${roomsUrl}/${code}${query}`, { token, signal });
  }

  function setStatus(message) {
    if (connection === message) return;
    connection = message;
    onStatus(connection);
  }

  function setRememberedSeat(code, token) {
    const stored = load("localStorage", seatsKey) ?? {};
    if (token) {
      seats.set(code, token);
      stored[code] = token;
    } else {
      seats.delete(code);
      delete stored[code];
    }
    save("localStorage", seatsKey, stored);
  }

  function rememberedSeat(code) {
    return seats.get(code) ?? load("localStorage", seatsKey)?.[code] ?? null;
  }

  function rememberRoom(current) {
    const saved = current ? { code: current.code, watch: !current.token } : null;
    if (!save("sessionStorage", roomKey, saved)) save("localStorage", roomKey, saved);
  }

  function stopRoom() {
    const previous = session;
    if (previous) {
      clearTimeout(previous.timer);
      previous.controller.abort();
      session = null;
    }
    return previous;
  }

  function accept(current, room) {
    if (session !== current || !room || room.code !== current.code) return false;
    if (!current.room || room.revision > current.room.revision) {
      if (current.token && !room.you) {
        setRememberedSeat(current.code, null);
        current.token = null;
        rememberRoom(current);
      }
      current.room = current.token ? room : { ...room, you: null };
      onRoom(current.room);
      return true;
    }
    return false;
  }

  function mount(code, token, room) {
    if (session?.code === code && session.token === token) {
      accept(session, room);
      return session;
    }
    const previous = stopRoom();
    const current = { code, token, room: null, timer: null, busy: false, controller: new AbortController() };
    session = current;
    rememberRoom(current);
    if (room) accept(current, room);
    else if (previous?.room) onRoom(null);
    return current;
  }

  function botTurn(current) {
    const room = current.room;
    return !!(current.token && room?.you && room.phase === "active" &&
      !room.game.winner && !room.game.draw && room.seats[room.game.turn] === "bot");
  }

  function schedule(current, delay) {
    if (!current || session !== current || current.busy || action || current.timer !== null) return;
    current.timer = setTimeout(() => {
      current.timer = null;
      void poll(current);
    }, delay ?? (!connection && botTurn(current) ? botDelay : pollDelay));
  }

  async function poll(current) {
    if (session !== current || current.busy || action) return;
    const { code, token, controller } = current;
    current.busy = true;
    let delay;
    try {
      const revision = current.room?.revision;
      if (!connection && botTurn(current)) {
        try {
          const result = await send(`${roomsUrl}/${code}/advance`, {
            token, signal: controller.signal, body: { revision },
          });
          accept(current, result?.room);
        } catch (error) {
          if (error.status !== 409 || session !== current) throw error;
          const result = await getRoom(code, token, controller.signal, revision);
          if (!accept(current, result?.room)) delay = pollDelay;
        }
      } else {
        const result = await getRoom(code, token, controller.signal, revision);
        accept(current, result?.room);
      }
      if (session === current) setStatus("");
    } catch (error) {
      if (session !== current) return;
      if (error.status === 404) {
        const previous = stopRoom();
        setRememberedSeat(code, null);
        rememberRoom(null);
        if (previous?.room) onRoom(null);
        setStatus(error.message);
      } else {
        setStatus(isTemporary(error) ? "Connection interrupted. Reconnecting…" : error.message);
        delay = pollDelay;
      }
    } finally {
      current.busy = false;
      schedule(current, delay);
    }
  }

  async function run(work) {
    if (action) throw new Error("An online action is already in progress.");
    const task = new AbortController();
    action = task;
    const current = () => action === task && !task.signal.aborted;
    try {
      return await work(task.signal, current);
    } catch (error) {
      if (current()) throw error;
      return null;
    } finally {
      if (current()) {
        action = null;
        schedule(session);
      }
    }
  }

  function open(code, token, room) {
    const current = mount(code, token, room);
    setStatus("");
    return current.room;
  }

  function mutate(route, payload = {}) {
    return run(async (signal, fresh) => {
      const current = session;
      const initial = current?.room;
      if (!current?.token || !initial?.you) throw new Error("Join a seat before playing.");
      const post = revision => send(`${roomsUrl}/${current.code}/${route}`, {
        token: current.token, signal, body: { revision, ...payload },
      });
      let result;
      try {
        result = await post(initial.revision);
      } catch (error) {
        if (!fresh()) return null;
        if (error.status !== 409) {
          if (isTemporary(error)) setStatus("Connection interrupted. Reconnecting…");
          throw error;
        }
        const updated = await getRoom(current.code, current.token, signal);
        if (!fresh()) return null;
        accept(current, updated?.room);
        const latest = current.room;
        setStatus("");
        if (route === "start" && latest.phase === "active") return latest;
        if (route === "move") {
          const completed = latest.game.log.slice(initial.game.log.length).some(entry => entry.player === initial.you &&
            sameCell(entry.from, payload.from) && sameCell(entry.to, payload.to) &&
            (entry.promotion ?? null) === (payload.promotion ?? null));
          if (completed) return latest;
        }
        const stillCurrent = latest.revision !== initial.revision && latest.you &&
          (route === "start" ? latest.phase === "lobby" :
            latest.game.turn === latest.you && latest.game.log.length === initial.game.log.length);
        if (!stillCurrent) throw error;
        result = await post(latest.revision);
      }
      if (!fresh()) return null;
      accept(current, result?.room);
      setStatus("");
      return current.room;
    });
  }

  return {
    get room() { return session?.room ?? null; },

    create(seat) {
      return run(async (signal, fresh) => {
        const { token, room } = await send(roomsUrl, { signal, body: { seat } });
        if (!fresh()) return null;
        setRememberedSeat(room.code, token);
        return open(room.code, token, room);
      });
    },

    join(value, seat) {
      return run(async (signal, fresh) => {
        const code = normalizeCode(value);
        const known = rememberedSeat(code);
        if (known) {
          try {
            const result = await getRoom(code, known, signal);
            if (!fresh()) return null;
            if (result?.room.you) return open(code, known, result.room);
          } catch (error) {
            if (!fresh()) return null;
            if (error.status !== 401 && error.status !== 403) throw error;
          }
          setRememberedSeat(code, null);
        }
        const { token, room } = await send(`${roomsUrl}/${code}/join`, { signal, body: { seat } });
        if (!fresh()) return null;
        setRememberedSeat(code, token);
        return open(code, token, room);
      });
    },

    watch(value) {
      return run(async (signal, fresh) => {
        const code = normalizeCode(value);
        const result = await getRoom(code, null, signal);
        return fresh() ? open(code, null, result.room) : null;
      });
    },

    restore() {
      return run(async (signal, fresh) => {
        const saved = load("sessionStorage", roomKey) ?? load("localStorage", roomKey);
        if (!saved?.code) return null;
        const code = normalizeCode(saved.code);
        const token = saved.watch ? null : rememberedSeat(code);
        try {
          const result = await getRoom(code, token, signal);
          return fresh() ? open(code, token, result.room) : null;
        } catch (error) {
          if (!fresh()) return null;
          if (error.status === 404) {
            rememberRoom(null);
            setRememberedSeat(code, null);
            return null;
          }
          if (!isTemporary(error)) throw error;
          mount(code, token, null);
          setStatus("Connection interrupted. Reconnecting…");
          return null;
        }
      });
    },

    leave() {
      action?.abort();
      action = null;
      const previous = stopRoom();
      rememberRoom(null);
      if (previous?.room) onRoom(null);
      setStatus("");
    },

    start() { return mutate("start"); },
    play(from, to, promotion = null) { return mutate("move", { from, to, promotion }); },
  };
}
