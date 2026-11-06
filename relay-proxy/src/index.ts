const ALLOWED_ORIGIN = "https://notmaplesugarstone.github.io";
const UPSTREAM = "https://scrunkle-rooms.maplesugarstone.workers.dev";
const UPSTREAM_ORIGIN = "https://maplesugarstone.github.io";

function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "content-type");
  headers.set("Access-Control-Max-Age", "0");
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Origin");
  return headers;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return new Response("forbidden origin", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const target = new URL(request.url);
    const upstream = new URL(UPSTREAM);
    target.protocol = upstream.protocol;
    target.host = upstream.host;

    const upstreamRequest = new Request(target, request);
    upstreamRequest.headers.set("Origin", UPSTREAM_ORIGIN);
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) upstreamRequest.headers.set("CF-Connecting-IP", clientIp);
    console.log(JSON.stringify({ incomingCfConnectingIp: clientIp, upstreamCfConnectingIp: upstreamRequest.headers.get("CF-Connecting-IP") }));

    const response = await fetch(upstreamRequest);
    if (response.status === 101) return response;

    const headers = new Headers(response.headers);
    for (const [name, value] of corsHeaders()) headers.set(name, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
