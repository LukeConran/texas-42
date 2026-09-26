import { handleSignal } from "./signal";

/** JSON answer for POST /api/signal. Kept free of the Vercel request types. */
export async function roomFetch(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const result = await handleSignal(body);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Room service failed.";
    return Response.json({ error: message }, { status: 503 });
  }
}
