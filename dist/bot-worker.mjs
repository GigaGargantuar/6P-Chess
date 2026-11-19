import { chooseBotMove } from "./bot.mjs";

self.addEventListener("message", ({ data: { id, game } }) => {
  try {
    self.postMessage({ id, move: chooseBotMove(game) });
  } catch {
    self.postMessage({ id, error: true });
  }
});
