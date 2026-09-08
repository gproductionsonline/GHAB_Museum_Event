import type { Response } from "express";

type Client = { res: Response; eventId: string };

const clients = new Set<Client>();

export function addSseClient(res: Response, eventId: string): void {
  clients.add({ res, eventId });
  res.on("close", () => {
    clients.delete({ res, eventId } as Client);
  });
}

export function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(eventId: string, event: string, data: unknown): void {
  for (const client of clients) {
    if (client.eventId !== eventId) continue;
    try {
      sseSend(client.res, event, data);
    } catch {
      clients.delete(client);
    }
  }
}

export function startHeartbeat(intervalMs = 20000): NodeJS.Timeout {
  return setInterval(() => {
    for (const client of clients) {
      try {
        client.res.write(": heartbeat\n\n");
      } catch {
        clients.delete(client);
      }
    }
  }, intervalMs);
}
