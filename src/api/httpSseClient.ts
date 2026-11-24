import type { CreateRoomSpec, RoomSnapshot, SaveMineInput } from '../domain/types';
import {
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RevisionConflictError,
  RoomClosedError,
  type RoomRepository,
  type SubscribeHandlers,
} from './repository';

/**
 * Production repository client targeting the Phase-2 Fastify + SQLite + SSE backend
 * under same-origin `/api/rooms` routes with HttpOnly session cookies.
 */
export class HttpSseRoomClient implements RoomRepository {
  private readonly baseUrl: string;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;
  }

  async createRoom(spec: CreateRoomSpec, mutationId: string): Promise<RoomSnapshot> {
    const res = await this.fetchJson(`${this.baseUrl}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ...spec, mutationId }),
    });
    return res as RoomSnapshot;
  }

  async getRoom(id: string, signal?: AbortSignal): Promise<RoomSnapshot> {
    const res = await this.fetchJson(`${this.baseUrl}/rooms/${encodeURIComponent(id)}`, {
      method: 'GET',
      credentials: 'same-origin',
      signal,
    });
    return res as RoomSnapshot;
  }

  async saveMine(id: string, input: SaveMineInput): Promise<RoomSnapshot> {
    const res = await this.fetchJson(`${this.baseUrl}/rooms/${encodeURIComponent(id)}/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
    });
    return res as RoomSnapshot;
  }

  async closeRoom(id: string, mutationId: string): Promise<RoomSnapshot> {
    const res = await this.fetchJson(`${this.baseUrl}/rooms/${encodeURIComponent(id)}/closure`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ mutationId }),
    });
    return res as RoomSnapshot;
  }

  subscribe(id: string, afterRevision: number, handlers: SubscribeHandlers): () => void {
    let lastRevision = afterRevision;
    let disposed = false;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;
    let inFlightFetch: AbortController | null = null;

    const pullSnapshot = async () => {
      if (disposed || document.visibilityState === 'hidden') return;
      inFlightFetch?.abort();
      inFlightFetch = new AbortController();
      try {
        const snap = await this.getRoom(id, inFlightFetch.signal);
        if (disposed) return;
        if (snap.roomRevision > lastRevision) {
          lastRevision = snap.roomRevision;
          handlers.onSnapshot(snap);
        }
        handlers.onConnection('live');
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || disposed) return;
        handlers.onConnection('reconnecting');
      }
    };

    const connectSse = () => {
      if (disposed || document.visibilityState === 'hidden') return;
      if (typeof EventSource === 'undefined') {
        startFallbackPolling();
        return;
      }
      source?.close();
      source = new EventSource(
        `${this.baseUrl}/rooms/${encodeURIComponent(id)}/events?afterRevision=${lastRevision}`,
        { withCredentials: true },
      );

      source.onopen = () => {
        if (!disposed) handlers.onConnection('live');
      };

      source.addEventListener('revision', (evt) => {
        if (disposed) return;
        try {
          const payload = JSON.parse((evt as MessageEvent).data) as { roomRevision?: number };
          if (typeof payload.roomRevision === 'number' && payload.roomRevision > lastRevision) {
            void pullSnapshot();
          }
        } catch {
          void pullSnapshot();
        }
      });

      source.onerror = () => {
        if (disposed) return;
        handlers.onConnection('reconnecting');
      };
    };

    const startFallbackPolling = () => {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => {
        void pullSnapshot();
      }, 6000);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        source?.close();
        source = null;
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } else {
        void pullSnapshot();
        connectSse();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    connectSse();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      inFlightFetch?.abort();
      source?.close();
      if (pollTimer !== null) clearInterval(pollTimer);
    };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new NetworkError();
    }

    if (response.ok) {
      return response.json();
    }

    if (response.status === 404) throw new NotFoundError();
    if (response.status === 403) throw new ForbiddenError();
    if (response.status === 409) throw new RevisionConflictError();
    if (response.status === 410) throw new RoomClosedError();
    throw new NetworkError(`请求失败（${response.status}），请稍后重试。`);
  }
}
