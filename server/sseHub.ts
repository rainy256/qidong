import type { ServerResponse } from 'node:http';

export type SseSubscription = Readonly<{
  sendRevision: (roomRevision: number) => void;
  sendComment: (comment: string) => void;
  cleanup: () => void;
}>;

interface SseClient {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export class RoomEventHub {
  private readonly rooms = new Map<string, Set<SseClient>>();

  subscribe(
    roomId: string,
    res: ServerResponse,
    heartbeatMs: number,
  ): SseSubscription {
    let closed = false;

    const client: SseClient = {
      res,
      timer: null as unknown as NodeJS.Timeout,
      cleanup: () => {
        if (closed) return;
        closed = true;
        clearInterval(client.timer);
        res.off('close', client.cleanup);
        res.off('error', client.cleanup);

        const set = this.rooms.get(roomId);
        if (set) {
          set.delete(client);
          if (set.size === 0) {
            this.rooms.delete(roomId);
          }
        }
      },
    };

    const writeSafe = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) {
        client.cleanup();
        return;
      }
      try {
        if (!res.write(chunk)) { res.destroy(); client.cleanup(); }
      } catch {
        client.cleanup();
      }
    };

    client.timer = setInterval(() => {
      writeSafe(': ping\n\n');
    }, heartbeatMs);
    client.timer.unref?.();

    let set = this.rooms.get(roomId);
    if (!set) {
      set = new Set<SseClient>();
      this.rooms.set(roomId, set);
    }
    set.add(client);

    res.on('close', client.cleanup);
    res.on('error', client.cleanup);

    return {
      sendRevision: (roomRevision: number) => {
        writeSafe(`event: revision\ndata: ${JSON.stringify({ roomRevision })}\n\n`);
      },
      sendComment: (comment: string) => {
        writeSafe(`: ${comment}\n\n`);
      },
      cleanup: client.cleanup,
    };
  }

  broadcastRevision(roomId: string, roomRevision: number): void {
    const set = this.rooms.get(roomId);
    if (!set || set.size === 0) return;

    const payload = `event: revision\ndata: ${JSON.stringify({ roomRevision })}\n\n`;
    for (const client of Array.from(set)) {
      if (client.res.writableEnded || client.res.destroyed) {
        client.cleanup();
        continue;
      }
      try {
        if (!client.res.write(payload)) { client.res.destroy(); client.cleanup(); }
      } catch {
        client.cleanup();
      }
    }
  }

  clientCount(roomId?: string): number {
    if (roomId !== undefined) {
      return this.rooms.get(roomId)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.rooms.values()) {
      total += set.size;
    }
    return total;
  }

  closeAll(): void {
    for (const set of Array.from(this.rooms.values())) {
      for (const client of Array.from(set)) {
        client.cleanup();
        try {
          if (!client.res.writableEnded && !client.res.destroyed) {
            client.res.end();
          }
        } catch {
          // Ignore errors when shutting down already-closing sockets
        }
      }
    }
    this.rooms.clear();
  }
}
