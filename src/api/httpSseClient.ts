import type { CreateRoomSpec, RoomSnapshot, SaveMineInput } from '../domain/types';
import {
  ForbiddenError,
  NetworkError,
  NotFoundError,
  RepositoryError,
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
    let wasDisconnected = false;
    let consecutiveSseErrors = 0;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;
    let inFlightFetch: AbortController | null = null;

    const stopFallbackPolling = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

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
        handlers.onConnection(
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting',
        );
      }
    };

    const startFallbackPolling = () => {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => {
        void pullSnapshot();
      }, 6000);
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
        if (disposed) return;
        consecutiveSseErrors = 0;
        stopFallbackPolling();
        handlers.onConnection('live');
        if (wasDisconnected) {
          wasDisconnected = false;
          void pullSnapshot();
        }
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
        wasDisconnected = true;
        consecutiveSseErrors += 1;
        handlers.onConnection(
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting',
        );
        if (source?.readyState === EventSource.CLOSED || consecutiveSseErrors >= 2) {
          startFallbackPolling();
        }
      };
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        source?.close();
        source = null;
        consecutiveSseErrors = 0;
        stopFallbackPolling();
      } else {
        void pullSnapshot();
        connectSse();
      }
    };

    const onOffline = () => {
      if (disposed) return;
      wasDisconnected = true;
      handlers.onConnection('offline');
    };

    const onOnline = () => {
      if (disposed) return;
      void pullSnapshot();
      connectSse();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    connectSse();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      inFlightFetch?.abort();
      source?.close();
      stopFallbackPolling();
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

    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    } | null;

    const rawCode = body?.error?.code ?? body?.code;
    const rawMsg = body?.error?.message ?? body?.message;
    const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;
    const message = typeof rawMsg === 'string' && rawMsg.trim() ? rawMsg.trim() : undefined;

    if (code === 'NOT_FOUND' || response.status === 404) {
      throw new NotFoundError(message);
    }
    if (code === 'ORIGIN_FORBIDDEN') {
      throw new RepositoryError(
        'ORIGIN_FORBIDDEN',
        message ?? '来源校验失败，请从原页面重新打开后再试。',
      );
    }
    if (code === 'OWNER_REQUIRED' || response.status === 403) {
      throw new ForbiddenError(message);
    }
    if (code === 'IDEMPOTENCY_CONFLICT') {
      throw new RepositoryError(
        'IDEMPOTENCY_CONFLICT',
        message ?? '请求编号冲突，请刷新后重试。',
      );
    }
    if (code === 'REVISION_CONFLICT' || response.status === 409) {
      throw new RevisionConflictError(message);
    }
    if (code === 'ROOM_CLOSED' || response.status === 410) {
      throw new RoomClosedError(message);
    }
    if (code === 'INVALID_INPUT' || response.status === 400) {
      throw new RepositoryError(
        'INVALID_INPUT',
        message ?? '输入参数不合法，请检查后重试。',
      );
    }
    throw new NetworkError(message ?? `请求失败（${response.status}），请稍后重试。`);
  }
}
