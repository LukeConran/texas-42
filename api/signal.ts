import { handleSignal } from "../src/server/signal";

type Req = { method?: string; body?: unknown };
type Res = { status: (code: number) => { json: (value: unknown) => void } };

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const result = await handleSignal(req.body);
  res.status(result.status).json(result.body);
}
