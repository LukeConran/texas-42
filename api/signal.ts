import { handleSignal } from "../src/server/signal";

type NodeReq = { method?: string; body?: unknown };
type NodeRes = { status: (code: number) => { json: (value: unknown) => void } };

/**
 * Vercel calls this file in more than one shape. The Web `Request` path is
 * what current projects use. The Node `(req, res)` path is the older one.
 * Either way the answer is JSON, never an HTML error page.
 */
async function respond(request: Request): Promise<Response> {
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
}

async function respondNode(req: NodeReq, res: NodeRes): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const result = await handleSignal(readNodeBody(req.body));
  res.status(result.status).json(result.body);
}

function readNodeBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") return body;
  return {};
}

function isWebRequest(value: unknown): value is Request {
  return typeof Request !== "undefined" && value instanceof Request;
}

async function handler(req: Request | NodeReq, res?: NodeRes): Promise<Response | void> {
  if (res && typeof res.status === "function") return respondNode(req as NodeReq, res);
  if (isWebRequest(req)) return respond(req);
  const result = await handleSignal(readNodeBody((req as NodeReq).body));
  return Response.json(result.body, { status: result.status });
}

handler.fetch = (request: Request): Promise<Response> => respond(request);

export function POST(request: Request): Promise<Response> {
  return respond(request);
}

export default handler;
