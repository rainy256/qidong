import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { recommend } from '../src/domain/recommend';
import { buildNightWindow, shanghaiToSlot } from '../src/domain/time';
import type { RoomSnapshot } from '../src/domain/types';
import { buildServer, type ServerContext } from './app';

const TEST_HOST = '127.0.0.1:3000';
const TEST_ORIGIN = `http://${TEST_HOST}`;
const TEST_MEMBER = 'a'.repeat(64);

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const prefix = `${name}=`;
  for (const raw of list) {
    const firstPart = raw.split(';')[0]?.trim();
    if (firstPart && firstPart.startsWith(prefix)) {
      return decodeURIComponent(firstPart.slice(prefix.length));
    }
  }
  return null;
}

function findSetCookieLine(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return list.find((line) => line.startsWith(`${name}=`)) ?? null;
}

interface SseStreamHandle {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  waitForText: (substring: string, timeoutMs?: number) => Promise<string>;
  close: () => void;
}

function openSseStream(url: string): Promise<SseStreamHandle> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const waiters: Array<{
      substring: string;
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];

    const checkWaiters = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (buffer.includes(w.substring)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(buffer);
        }
      }
    };

    const req = http.get(url, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        checkWaiters();
      });
      res.on('error', (err) => {
        for (const w of waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(err);
        }
      });

      resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        waitForText: (substring: string, timeoutMs = 3000) => {
          if (buffer.includes(substring)) {
            return Promise.resolve(buffer);
          }
          return new Promise<string>((resWait, rejWait) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((item) => item.timer === timer);
              if (idx >= 0) waiters.splice(idx, 1);
              rejWait(
                new Error(`Timed out waiting for "${substring}" in SSE stream. Buffer:\n${buffer}`),
              );
            }, timeoutMs);
            waiters.push({ substring, resolve: resWait, reject: rejWait, timer });
          });
        },
        close: () => {
          for (const w of waiters.splice(0)) {
            clearTimeout(w.timer);
          }
          res.destroy();
          req.destroy();
        },
      });
    });

    req.on('error', reject);
  });
}

describe('Phase 2 Fastify + SQLite WAL + SSE backend', () => {
  const cleanups: Array<() => Promise<void>> = [];

  async function createTestServer(): Promise<{ ctx: ServerContext; dbPath: string }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yueju-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const ctx = buildServer({
      dbPath,
      tokenPepper: 'test-pepper-secret-0123456789abcdef',
      cookieSecure: 'auto',
      sseHeartbeatMs: 60_000,
    });
    cleanups.push(async () => {
      await ctx.app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return { ctx, dbPath };
  }

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  const sampleNight = buildNightWindow('2026-11-27', 19, 0, 2, 0);

  async function createSampleRoom(ctx: ServerContext, overrides: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        cookie: `yj_member=${TEST_MEMBER}`,
      },
      payload: {
        title: '周五晚 Apex 三排',
        gameTag: 'apex',
        nights: [sampleNight],
        targetPlayers: 3,
        durationSlots: 4,
        mutationId: 'create_sample_1',
        ...overrides,
      },
    });
    const setCookie = res.headers['set-cookie'];
    const snapshot = res.json<RoomSnapshot>();
    return {
      res,
      snapshot,
      memberCookie: TEST_MEMBER,
      ownerCookie: extractCookieValue(setCookie, `yj_owner_${snapshot.id}`),
    };
  }

  it('1. enables SQLite WAL mode, foreign_keys pragma, versioned migrations, and /healthz + /readyz probes', async () => {
    const { ctx } = await createTestServer();
    expect(ctx.db.getJournalMode()).toBe('wal');
    expect(ctx.db.getForeignKeys()).toBe(1);
    expect(ctx.db.getAppliedMigrations()).toEqual([1, 2]);

    const health = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const healthz = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json()).toEqual({ ok: true, status: 'alive' });

    const readyz = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json()).toEqual({ ok: true, status: 'ready', journalMode: 'wal' });
  });

  it('2. creates room with HttpOnly owner/member cookies, supports idempotent replay (200), and rejects invalid payloads (400)', async () => {
    const { ctx } = await createTestServer();
    const { res, snapshot, memberCookie, ownerCookie } = await createSampleRoom(ctx, {
      mutationId: 'create_idem_1',
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(snapshot.id).toMatch(/^r-[A-Za-z0-9]{12}$/);
    expect(snapshot.tzid).toBe('Asia/Shanghai');
    expect(snapshot.roomRevision).toBe(1);
    expect(snapshot.viewer.canClose).toBe(true);
    expect(snapshot.viewer.memberId).toBeNull();
    expect(snapshot.viewer.mineRevision).toBe(0);

    expect(memberCookie).toBeTruthy();
    expect(ownerCookie).toBeTruthy();

    const ownerCookieLine = findSetCookieLine(res.headers['set-cookie'], `yj_owner_${snapshot.id}`);
    expect(ownerCookieLine).toContain('HttpOnly');
    expect(ownerCookieLine).toContain(`Path=/api/rooms/${snapshot.id}`);
    expect(ownerCookieLine).toContain('SameSite=Lax');

    // Replay same mutationId -> 200 and only 1 row in rooms
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${TEST_MEMBER}` },
      payload: {
        title: '周五晚 Apex 三排',
        gameTag: 'apex',
        nights: [sampleNight],
        targetPlayers: 3,
        durationSlots: 4,
        mutationId: 'create_idem_1',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<RoomSnapshot>().id).toBe(snapshot.id);
    expect(replay.json<RoomSnapshot>().viewer.canClose).toBe(true);
    expect(extractCookieValue(replay.headers['set-cookie'], `yj_owner_${snapshot.id}`)).toBe(ownerCookie);
    expect(ctx.db.countRows('rooms')).toBe(1);

    const bootstrap = await ctx.app.inject({method:'GET',url:'/api/session'});
    const otherToken = extractCookieValue(bootstrap.headers['set-cookie'],'yj_member');
    expect(otherToken).toBeTruthy();
    expect(otherToken).not.toBe(memberCookie);
    // A different session using the same mutation key cannot obtain this room.
    const other = await ctx.app.inject({
      method:'POST',url:'/api/rooms',
      headers:{host:TEST_HOST,origin:TEST_ORIGIN,cookie:`yj_member=${otherToken}`},
      payload:{title:'周五晚 Apex 三排',gameTag:'apex',nights:[sampleNight],targetPlayers:3,durationSlots:4,mutationId:'create_idem_1'}
    });
    expect(other.statusCode).toBe(201);
    expect(other.json<RoomSnapshot>().id).not.toBe(snapshot.id);

    // Invalid payload -> 400
    const badRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${TEST_MEMBER}` },
      payload: {
        title: '   ',
        nights: [sampleNight],
        targetPlayers: 3,
        durationSlots: 4,
        mutationId: 'create_bad',
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json<{ error: { code: string } }>().error.code).toBe('INVALID_INPUT');
  });

  it('3. GET /api/rooms/:id mints yj_member without creating zombie participants and returns 404 when missing or expired', async () => {
    const { ctx } = await createTestServer();
    const { snapshot } = await createSampleRoom(ctx);

    const getRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${snapshot.id}`,
      headers: { host: TEST_HOST },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers['cache-control']).toBe('private, no-store');
    expect(extractCookieValue(getRes.headers['set-cookie'], 'yj_member')).toBeTruthy();

    const body = getRes.json<RoomSnapshot>();
    expect(body.viewer).toEqual({ memberId: null, canClose: false, mineRevision: 0 });
    expect(body.submissions).toEqual([]);
    expect(ctx.db.countRows('participants')).toBe(0);

    const notFound = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r-doesNotExist99',
      headers: { host: TEST_HOST },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('4. allows concurrent saves from two different members without 409 conflicts and lets owner participate too', async () => {
    const { ctx } = await createTestServer();
    const { snapshot, memberCookie: ownerMemberCookie, ownerCookie } = await createSampleRoom(ctx);

    const guest1Res = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const guest2Res = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const token1 = extractCookieValue(guest1Res.headers['set-cookie'], 'yj_member')!;
    const token2 = extractCookieValue(guest2Res.headers['set-cookie'], 'yj_member')!;

    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const [save1, save2] = await Promise.all([
      ctx.app.inject({
        method: 'PUT',
        url: `/api/rooms/${snapshot.id}/me`,
        headers: {
          host: TEST_HOST,
          origin: TEST_ORIGIN,
          cookie: `yj_member=${token1}`,
        },
        payload: {
          nickname: '阿哲',
          answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
          baseMineRevision: 0,
          mutationId: 'save_g1_1',
        },
      }),
      ctx.app.inject({
        method: 'PUT',
        url: `/api/rooms/${snapshot.id}/me`,
        headers: {
          host: TEST_HOST,
          origin: TEST_ORIGIN,
          cookie: `yj_member=${token2}`,
        },
        payload: {
          nickname: '老周',
          answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
          baseMineRevision: 0,
          mutationId: 'save_g2_1',
        },
      }),
    ]);

    expect(save1.statusCode).toBe(200);
    expect(save2.statusCode).toBe(200);

    // Owner also saves their own slots while keeping canClose = true
    const ownerSave = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        cookie: `yj_member=${ownerMemberCookie}; yj_owner_${snapshot.id}=${ownerCookie}`,
      },
      payload: {
        nickname: '房主小满',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'save_owner_1',
      },
    });
    expect(ownerSave.statusCode).toBe(200);
    const ownerSnap = ownerSave.json<RoomSnapshot>();
    expect(ownerSnap.viewer.canClose).toBe(true);
    expect(ownerSnap.viewer.memberId).toBeTruthy();
    expect(ownerSnap.viewer.mineRevision).toBe(1);
    expect(ownerSnap.roomRevision).toBe(4);
    expect(ownerSnap.submissions.map((s) => s.nickname)).toHaveLength(3);
  });

  it('5. enforces per-member optimistic locking (409) and mutationId idempotency (200) including unavailable mode', async () => {
    const { ctx } = await createTestServer();
    const { snapshot } = await createSampleRoom(ctx);
    const guestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const memberToken = extractCookieValue(guestRes.headers['set-cookie'], 'yj_member')!;

    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    // First save
    const first = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '七七',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'm1',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<RoomSnapshot>().viewer.mineRevision).toBe(1);
    expect(first.json<RoomSnapshot>().roomRevision).toBe(2);

    // Replay same mutationId with old baseMineRevision -> idempotent 200, roomRevision unchanged
    const replay = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '七七',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'm1',
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<RoomSnapshot>().roomRevision).toBe(2);

    // Stale baseMineRevision with new mutationId -> 409 REVISION_CONFLICT
    const conflict = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '七七',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'm2',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('REVISION_CONFLICT');

    // Update with current baseMineRevision: 1 -> unavailable
    const unavailable = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '七七',
        answer: { kind: 'unavailable' },
        baseMineRevision: 1,
        mutationId: 'm3',
      },
    });
    expect(unavailable.statusCode).toBe(200);
    const snap3 = unavailable.json<RoomSnapshot>();
    expect(snap3.viewer.mineRevision).toBe(2);
    expect(snap3.roomRevision).toBe(3);
    expect(snap3.submissions[0].answer).toEqual({ kind: 'unavailable' });
  });

  it('6. normalizes overlapping picks via normalizePicks and rejects completely out-of-bounds picks with 400', async () => {
    const { ctx } = await createTestServer();
    const { snapshot } = await createSampleRoom(ctx);
    const guestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const memberToken = extractCookieValue(guestRes.headers['set-cookie'], 'yj_member')!;

    // Out-of-bounds picks -> 400
    const badOob = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '越界哥',
        answer: {
          kind: 'available',
          picks: [{ nightId: sampleNight.id, from: sampleNight.from - 4, to: sampleNight.from }],
        },
        baseMineRevision: 0,
        mutationId: 'oob_1',
      },
    });
    expect(badOob.statusCode).toBe(400);

    // Adjacent + overlapping picks get clipped & merged
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t21 = shanghaiToSlot('2026-11-27', 21, 0);
    const mergedRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '归并哥',
        answer: {
          kind: 'available',
          picks: [
            { nightId: sampleNight.id, from: sampleNight.from - 2, to: t20 },
            { nightId: sampleNight.id, from: t20, to: t21 },
          ],
        },
        baseMineRevision: 0,
        mutationId: 'merge_1',
      },
    });
    expect(mergedRes.statusCode).toBe(200);
    expect(mergedRes.json<RoomSnapshot>().submissions[0].answer).toEqual({
      kind: 'available',
      picks: [{ nightId: sampleNight.id, from: sampleNight.from, to: t21 }],
    });
  });

  it('7. pushes live SSE revision events, sends catch-up on reconnect, enforces owner-only closure (403 OWNER_REQUIRED), and locks room (410)', async () => {
    const { ctx } = await createTestServer();
    const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const parsed = new URL(baseUrl);
    const liveHost = parsed.host;
    const liveOrigin = parsed.origin;

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: liveHost, origin: liveOrigin, cookie: `yj_member=${TEST_MEMBER}` },
      payload: {
        title: 'SSE 联调房',
        gameTag: 'tarkov',
        nights: [sampleNight],
        targetPlayers: 4,
        durationSlots: 4,
        mutationId: 'sse_create_1',
      },
    });
    const room = createRes.json<RoomSnapshot>();
    const ownerCookie = extractCookieValue(
      createRes.headers['set-cookie'],
      `yj_owner_${room.id}`,
    )!;

    // 1. Open live SSE stream at afterRevision=1
    const sse1 = await openSseStream(`${baseUrl}/api/rooms/${room.id}/events?afterRevision=1`);
    cleanups.push(async () => sse1.close());
    expect(sse1.statusCode).toBe(200);
    expect(sse1.headers['content-type']).toContain('text/event-stream');
    expect(sse1.headers['cache-control']).toBe('no-cache, no-transform');
    expect(sse1.headers['x-accel-buffering']).toBe('no');
    await sse1.waitForText(': connected');

    // 2. Member saves -> live SSE receives revision 2
    const guestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${room.id}` });
    const memberToken = extractCookieValue(guestRes.headers['set-cookie'], 'yj_member')!;
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const saveRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/me`,
      headers: { host: liveHost, origin: liveOrigin, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '阿九',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'sse_save_1',
      },
    });
    expect(saveRes.statusCode).toBe(200);
    await sse1.waitForText('event: revision\ndata: {"roomRevision":2}');

    // 3. Reconnect catch-up stream with afterRevision=1 immediately receives revision 2
    const sse2 = await openSseStream(`${baseUrl}/api/rooms/${room.id}/events?afterRevision=1`);
    cleanups.push(async () => sse2.close());
    await sse2.waitForText('event: revision\ndata: {"roomRevision":2}');
    sse2.close();

    // 4. Non-owner cannot close room -> 403 OWNER_REQUIRED
    const nonOwnerClose = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/closure`,
      headers: { host: liveHost, origin: liveOrigin, cookie: `yj_member=${memberToken}` },
      payload: { mutationId: 'close_forbidden' },
    });
    expect(nonOwnerClose.statusCode).toBe(403);
    expect(nonOwnerClose.json<{ error: { code: string } }>().error.code).toBe('OWNER_REQUIRED');

    // 5. Owner closes room -> 200, SSE receives revision 3
    const ownerClose = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/closure`,
      headers: {
        host: liveHost,
        origin: liveOrigin,
        cookie: `yj_owner_${room.id}=${ownerCookie}`,
      },
      payload: { mutationId: 'close_ok_1' },
    });
    expect(ownerClose.statusCode).toBe(200);
    const closedSnap = ownerClose.json<RoomSnapshot>();
    expect(closedSnap.closedAt).toBeTruthy();
    expect(closedSnap.roomRevision).toBe(3);
    await sse1.waitForText('event: revision\ndata: {"roomRevision":3}');
    sse1.close();
    await expect.poll(() => ctx.sseHub.clientCount(room.id)).toBe(0);

    // Save whose response was lost before closure is still an idempotent success.
    const saveReplay = await ctx.app.inject({
      method:'PUT',url:`/api/rooms/${room.id}/me`,
      headers:{host:liveHost,origin:liveOrigin,cookie:`yj_member=${memberToken}`},
      payload:{nickname:'阿九',answer:{kind:'available',picks:[{nightId:sampleNight.id,from:t20,to:t22}]},baseMineRevision:0,mutationId:'sse_save_1'}
    });
    expect(saveReplay.statusCode).toBe(200);
    expect(saveReplay.json<RoomSnapshot>().roomRevision).toBe(3);

    // 6. Replay closure -> 200, roomRevision stays 3
    const closeReplay = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/closure`,
      headers: {
        host: liveHost,
        origin: liveOrigin,
        cookie: `yj_owner_${room.id}=${ownerCookie}`,
      },
      payload: { mutationId: 'close_ok_1' },
    });
    expect(closeReplay.statusCode).toBe(200);
    expect(closeReplay.json<RoomSnapshot>().roomRevision).toBe(3);

    // 7. Save after closure -> 410 ROOM_CLOSED
    const postCloseSave = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/me`,
      headers: { host: liveHost, origin: liveOrigin, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '阿九',
        answer: { kind: 'unavailable' },
        baseMineRevision: 1,
        mutationId: 'save_after_close',
      },
    });
    expect(postCloseSave.statusCode).toBe(410);
    expect(postCloseSave.json<{ error: { code: string } }>().error.code).toBe('ROOM_CLOSED');
  });

  it('8. enforces same-origin CSRF protection via Origin and Referer headers (403 ORIGIN_FORBIDDEN)', async () => {
    const { ctx } = await createTestServer();
    const basePayload = {
      title: '同源校验房',
      nights: [sampleNight],
      targetPlayers: 4,
      durationSlots: 4,
      mutationId: 'csrf_test_1',
    };

    // Cross-origin Origin -> 403 ORIGIN_FORBIDDEN
    const evilOrigin = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST, origin: 'https://evil.example' },
      payload: basePayload,
    });
    expect(evilOrigin.statusCode).toBe(403);
    expect(evilOrigin.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_FORBIDDEN');

    // Missing both Origin and Referer -> 403 ORIGIN_FORBIDDEN
    const noOriginOrRef = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST },
      payload: basePayload,
    });
    expect(noOriginOrRef.statusCode).toBe(403);
    expect(noOriginOrRef.json<{ error: { code: string } }>().error.code).toBe('ORIGIN_FORBIDDEN');

    // Missing Origin with same-origin Referer -> 201
    const sameRef = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST, referer: `${TEST_ORIGIN}/`, cookie: `yj_member=${TEST_MEMBER}` },
      payload: basePayload,
    });
    expect(sameRef.statusCode).toBe(201);
  });

  it('9. preserves recommendation counterexample semantics through real backend persistence', async () => {
    const { ctx } = await createTestServer();
    const fri = buildNightWindow('2026-11-27', 19, 0, 23, 0);
    const { snapshot: room } = await createSampleRoom(ctx, {
      title: '四排反例验证',
      nights: [fri],
      targetPlayers: 4,
      durationSlots: 4,
      mutationId: 'counterexample_room',
    });

    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t21 = shanghaiToSlot('2026-11-27', 21, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const players = [
      { nickname: '甲', from: t20, to: t22 },
      { nickname: '乙', from: t20, to: t22 },
      { nickname: '丙', from: t20, to: t22 },
      { nickname: '丁', from: t20, to: t21 },
      { nickname: '戊', from: t21, to: t22 },
    ];

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const getRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${room.id}` });
      const token = extractCookieValue(getRes.headers['set-cookie'], 'yj_member')!;
      const putRes = await ctx.app.inject({
        method: 'PUT',
        url: `/api/rooms/${room.id}/me`,
        headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${token}` },
        payload: {
          nickname: p.nickname,
          answer: { kind: 'available', picks: [{ nightId: fri.id, from: p.from, to: p.to }] },
          baseMineRevision: 0,
          mutationId: `ce_p_${i}`,
        },
      });
      expect(putRes.statusCode).toBe(200);
    }

    const latestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${room.id}` });
    const latest = latestRes.json<RoomSnapshot>();
    expect(latest.submissions).toHaveLength(5);

    const res2h = recommend({
      nights: latest.nights,
      targetPlayers: latest.targetPlayers,
      durationSlots: latest.durationSlots,
      earliestStart: latest.nights[0].from,
      submissions: latest.submissions,
    });
    expect(res2h).toHaveLength(1);
    expect(res2h[0].missingPlayers).toBe(1);
    const nicknames2h = res2h[0].memberIds
      .map((id) => latest.submissions.find((s) => s.memberId === id)?.nickname)
      .sort();
    expect(nicknames2h).toEqual(['甲', '乙', '丙'].sort());

    const res1h = recommend({
      nights: latest.nights,
      targetPlayers: latest.targetPlayers,
      durationSlots: 2,
      earliestStart: latest.nights[0].from,
      submissions: latest.submissions,
    }).filter((c) => c.missingPlayers === 0);
    expect(res1h).toHaveLength(2);
    expect(res1h[0].firstStart).toBe(t20);
    expect(
      res1h[0].memberIds
        .map((id) => latest.submissions.find((s) => s.memberId === id)?.nickname)
        .sort(),
    ).toEqual(['甲', '乙', '丙', '丁'].sort());
    expect(res1h[1].firstStart).toBe(t21);
    expect(
      res1h[1].memberIds
        .map((id) => latest.submissions.find((s) => s.memberId === id)?.nickname)
        .sort(),
    ).toEqual(['甲', '乙', '丙', '戊'].sort());
  });

  it('10. rejects mutationId reuse with mismatched payload (409 IDEMPOTENCY_CONFLICT) on create and save', async () => {
    const { ctx } = await createTestServer();
    const { snapshot } = await createSampleRoom(ctx, {
      title: '原始标题',
      mutationId: 'idem_guard_create',
    });

    const createMismatch = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${TEST_MEMBER}` },
      payload: {
        title: '篡改后的标题',
        gameTag: 'apex',
        nights: [sampleNight],
        targetPlayers: 3,
        durationSlots: 4,
        mutationId: 'idem_guard_create',
      },
    });
    expect(createMismatch.statusCode).toBe(409);
    expect(createMismatch.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );

    const guestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const memberToken = extractCookieValue(guestRes.headers['set-cookie'], 'yj_member')!;
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const firstSave = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '小满',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'idem_guard_save',
      },
    });
    expect(firstSave.statusCode).toBe(200);

    const saveMismatch = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '小满改名',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'idem_guard_save',
      },
    });
    expect(saveMismatch.statusCode).toBe(409);
    expect(saveMismatch.json<{ error: { code: string } }>().error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('11. treats expired rooms as 404 across all endpoints and purges expired rooms + cascaded participants', async () => {
    const { ctx, dbPath } = await createTestServer();
    const { snapshot, ownerCookie } = await createSampleRoom(ctx, {
      mutationId: 'expire_room_1',
    });

    const guestRes = await ctx.app.inject({ method: 'GET', url: `/api/rooms/${snapshot.id}` });
    const memberToken = extractCookieValue(guestRes.headers['set-cookie'], 'yj_member')!;
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const saveRes = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '测试员',
        answer: { kind: 'available', picks: [{ nightId: sampleNight.id, from: t20, to: t22 }] },
        baseMineRevision: 0,
        mutationId: 'expire_save_1',
      },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(ctx.db.countRows('participants')).toBe(1);

    // Backdate expires_at in SQLite directly
    const rawDb = new Database(dbPath);
    try {
      rawDb
        .prepare('UPDATE rooms SET expires_at = ? WHERE id = ?')
        .run('2020-01-01T00:00:00.000Z', snapshot.id);
    } finally {
      rawDb.close();
    }

    const expiredGet = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${snapshot.id}`,
      headers: { host: TEST_HOST },
    });
    expect(expiredGet.statusCode).toBe(404);
    expect(expiredGet.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');

    const expiredPut = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/me`,
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie: `yj_member=${memberToken}` },
      payload: {
        nickname: '测试员',
        answer: { kind: 'unavailable' },
        baseMineRevision: 1,
        mutationId: 'expire_save_2',
      },
    });
    expect(expiredPut.statusCode).toBe(404);

    const expiredClose = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${snapshot.id}/closure`,
      headers: {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        cookie: `yj_owner_${snapshot.id}=${ownerCookie}`,
      },
      payload: { mutationId: 'expire_close_1' },
    });
    expect(expiredClose.statusCode).toBe(404);

    const expiredEvents = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${snapshot.id}/events?afterRevision=1`,
      headers: { host: TEST_HOST },
    });
    expect(expiredEvents.statusCode).toBe(404);

    // purgeExpired deletes expired room and cascades participants
    const purged = ctx.db.purgeExpired();
    expect(purged.deletedRooms).toBe(1);
    expect(ctx.db.countRows('rooms')).toBe(0);
    expect(ctx.db.countRows('participants')).toBe(0);
  });
});
