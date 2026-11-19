import { handleRooms } from "./rooms.mjs";

const methods = ["GET", "POST"];
const allowedHeaders = ["authorization", "content-type"];

export async function handleRoomRequest(request, env) {
  const origin = request.headers.get("Origin");
  const configuredOrigin = env.HEXACHESS_FRONTEND_ORIGIN;
  const allowedOrigin = origin?.startsWith("https://") && origin === configuredOrigin;
  const preflightMethod = request.headers.get("Access-Control-Request-Method");

  if (request.method === "OPTIONS" && preflightMethod) {
    const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
      .toLowerCase().split(",").map(header => header.trim()).filter(Boolean);
    const headers = { Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" };
    if (!allowedOrigin || !methods.includes(preflightMethod) ||
        !requestedHeaders.every(header => allowedHeaders.includes(header))) {
      return new Response(null, { status: 403, headers });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": methods.join(", "),
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  const response = await handleRooms(request, env);
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");
  if (allowedOrigin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
