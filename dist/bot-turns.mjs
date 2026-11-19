import { chooseBotMove } from "./bot.mjs";

const TURN_DELAY = 360;
const RESPONSE_TIMEOUT = 2500;

export function createBotRunner(onMove) {
  let workerAvailable = typeof Worker === "function";
  let worker = null;
  let pending = null;
  let lastId = 0;

  function discardWorker() {
    worker?.terminate();
    worker = null;
  }

  function cancel() {
    if (!pending) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.deadline);
    if (pending.deadline !== null) discardWorker();
    pending = null;
  }

  function finish(task, move) {
    if (pending !== task) return;
    clearTimeout(task.deadline);
    pending = null;
    onMove(task.game, move);
  }

  function calculateLocally(task) {
    if (pending !== task) return;
    workerAvailable = false;
    discardWorker();
    let move = null;
    try {
      move = chooseBotMove(task.game);
    } catch {
      // The game can still choose a legal move if the bot evaluator fails.
    }
    finish(task, move);
  }

  function openWorker() {
    const instance = new Worker(new URL("./bot-worker.mjs", import.meta.url), { type: "module" });
    instance.addEventListener("message", ({ data }) => {
      const task = pending;
      if (instance !== worker || !task || data?.id !== task.id) return;
      if (data.error) calculateLocally(task);
      else finish(task, data.move);
    });
    instance.addEventListener("error", event => {
      if (instance !== worker) return;
      event.preventDefault();
      if (pending && pending.deadline !== null) calculateLocally(pending);
      else {
        workerAvailable = false;
        discardWorker();
      }
    });
    return instance;
  }

  function calculate(task) {
    if (pending !== task) return;
    if (!workerAvailable) {
      calculateLocally(task);
      return;
    }
    try {
      worker ??= openWorker();
      task.deadline = setTimeout(() => calculateLocally(task), RESPONSE_TIMEOUT);
      worker.postMessage({ id: task.id, game: task.game });
    } catch {
      calculateLocally(task);
    }
  }

  return {
    request(game) {
      if (pending?.game === game) return;
      cancel();
      const task = { id: ++lastId, game, timer: null, deadline: null };
      pending = task;
      task.timer = setTimeout(() => calculate(task), TURN_DELAY);
    },
    cancel,
  };
}
