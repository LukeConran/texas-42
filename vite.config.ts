import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { handleSignal } from "./src/server/signal";

function roomDoorbell(): Plugin {
  return {
    name: "room-doorbell",
    configureServer(server) {
      server.middlewares.use("/api/signal", (req, res) => {
        void readBody(req).then(async (body) => {
          const result = await handleSignal(body);
          sendJson(res, result.status, result.body);
        });
      });
    },
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default defineConfig({
  plugins: [roomDoorbell()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
