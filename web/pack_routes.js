// Some hosts serve this pack's web files and ComfyUI's core API, but not the
// routes the pack registers on the server. Comfy on Civitai answers those with
// a 501 whose error type is "backend_route_unavailable"; other hosts answer a
// plain 404. Recognise both, so features can say what is missing instead of
// failing with a status code or a JSON parse error.
// The same file is kept in each bno84 pack that has server routes; only PACK differs.
const PACK = "YuE2-Kit";

// host is "civitai" when Comfy on Civitai said so, otherwise "other".
export class RouteUnavailable extends Error {
  constructor(host = "other") {
    const reason = `it needs the ${PACK} server routes`;
    super(`Not available on this host: ${reason}.`);
    this.name = "RouteUnavailable";
    this.reason = reason;
    this.host = host;
  }
}

// "civitai", "other", or null when the route answered. The pack's own
// handlers report errors as JSON, never as a plain 404.
export async function unavailableHost(response) {
  if (response?.status === 501) {
    const body = await response.clone().json().catch(() => null);
    return body?.error?.type === "backend_route_unavailable" ? "civitai" : null;
  }
  return response?.status === 404 && !(response.headers?.get("content-type") ?? "").includes("json") ? "other" : null;
}

export async function routeUnavailable(response) {
  return (await unavailableHost(response)) !== null;
}

// Use as `await requireRoute(await api.fetchApi(path, options))`.
export async function requireRoute(response) {
  const host = await unavailableHost(response);
  if (host) throw new RouteUnavailable(host);
  return response;
}
