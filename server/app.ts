import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { loadConfig, type ServerConfig } from './config';
import {
  DbForbiddenError,
  DbIdempotencyConflictError,
  DbInvalidInputError,
  DbNotFoundError,
  DbRevisionConflictError,
  DbRoomClosedError,
  RoomDatabase,
} from './db';
import {
  generateToken,
  hashToken,
  isValidRoomId,
  isValidToken,
  MEMBER_COOKIE_NAME,
  ownerCookieName,
  resolveCookieSecure,
  verifySameOrigin,
} from './security';
import { RoomEventHub } from './sseHub';
import {
  parseAfterRevision,
  validateCloseRoomBody,
  validateCreateRoomBody,
  validateSaveMineBody,
  ValidationError,
} from './validation';

export interface ServerContext {
  app: FastifyInstance;
  db: RoomDatabase;
  sseHub: RoomEventHub;
  config: ServerConfig;
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

function sendJsonError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

function readValidCookieToken(request: FastifyRequest, cookieName: string): string | null {
  const raw = request.cookies[cookieName];
  return isValidToken(raw) ? raw : null;
}

function setMemberCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  config: ServerConfig,
): void {
  reply.setCookie(MEMBER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: resolveCookieSecure(request, config.cookieSecure),
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
}

function setOwnerCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  roomId: string,
  token: string,
  config: ServerConfig,
): void {
  reply.setCookie(ownerCookieName(roomId), token, {
    httpOnly: true,
    secure: resolveCookieSecure(request, config.cookieSecure),
    sameSite: 'lax',
    path: `/api/rooms/${roomId}`,
    maxAge: config.roomTtlDays * 24 * 60 * 60,
  });
}

export function buildServer(overrides: Partial<ServerConfig> = {}): ServerContext {
  const config = loadConfig(overrides);
  const app = Fastify({
    logger: config.logger,
    trustProxy: config.trustProxy,
  });

  const db = new RoomDatabase(config.dbPath);
  const sseHub = new RoomEventHub();

  app.register(cookie);

  app.addHook('onClose', async () => {
    sseHub.closeAll();
    db.close();
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    if (!MUTATION_METHODS.has(request.method)) return;
    if (!verifySameOrigin(request, config.allowedOrigins)) {
      return sendJsonError(reply, 403, 'ORIGIN_FORBIDDEN', '来源校验失败，仅允许同源请求。');
    }
  });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ValidationError || err instanceof DbInvalidInputError) {
      return sendJsonError(reply, 400, 'INVALID_INPUT', err.message);
    }
    if (err instanceof DbNotFoundError) {
      return sendJsonError(reply, 404, 'NOT_FOUND', err.message);
    }
    if (err instanceof DbForbiddenError) {
      return sendJsonError(reply, 403, 'OWNER_REQUIRED', err.message);
    }
    if (err instanceof DbIdempotencyConflictError) {
      return sendJsonError(reply, 409, 'IDEMPOTENCY_CONFLICT', err.message);
    }
    if (err instanceof DbRevisionConflictError) {
      return sendJsonError(reply, 409, 'REVISION_CONFLICT', err.message);
    }
    if (err instanceof DbRoomClosedError) {
      return sendJsonError(reply, 410, 'ROOM_CLOSED', err.message);
    }

    const fastifyErr = err as { statusCode?: number; message?: string };
    if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
      return sendJsonError(
        reply,
        fastifyErr.statusCode,
        'INVALID_INPUT',
        fastifyErr.message || '请求参数格式不正确。',
      );
    }

    app.log.error(err);
    return sendJsonError(reply, 500, 'INTERNAL_ERROR', '服务器开小差了，请稍后重试。');
  });

  app.get('/healthz', async (_request, reply) => {
    return reply.code(200).send({ ok: true, status: 'alive' });
  });

  app.get('/readyz', async (_request, reply) => {
    try {
      const ready = db.checkReady();
      if (!ready.ok) {
        return reply.code(503).send({ ok: false, status: 'not_ready' });
      }
      return reply.code(200).send({
        ok: true,
        status: 'ready',
        journalMode: ready.journalMode,
      });
    } catch {
      return reply.code(503).send({ ok: false, status: 'not_ready' });
    }
  });

  app.get('/api/health', async (_request, reply) => {
    const ok = db.ping();
    return reply.code(ok ? 200 : 503).send({ ok });
  });

  app.post('/api/rooms', async (request, reply) => {
    const body = validateCreateRoomBody(request.body);
    const existingMemberToken = readValidCookieToken(request, MEMBER_COOKIE_NAME);
    const memberToken = existingMemberToken ?? generateToken();
    const memberTokenHash = hashToken(memberToken, config.tokenPepper);

    const freshOwnerToken = generateToken();
    const freshOwnerHash = hashToken(freshOwnerToken, config.tokenPepper);

    const result = db.createRoom(
      body,
      freshOwnerHash,
      memberTokenHash,
      (roomId) => {
        const cookieToken = readValidCookieToken(request, ownerCookieName(roomId));
        return cookieToken ? hashToken(cookieToken, config.tokenPepper) : null;
      },
      config.roomTtlDays,
    );

    if (!existingMemberToken) {
      setMemberCookie(request, reply, memberToken, config);
    }
    if (result.created) {
      setOwnerCookie(request, reply, result.snapshot.id, freshOwnerToken, config);
    }

    return reply
      .code(result.created ? 201 : 200)
      .header('Cache-Control', 'private, no-store')
      .send(result.snapshot);
  });

  app.get<{ Params: { id: string } }>('/api/rooms/:id', async (request, reply) => {
    const { id } = request.params;
    if (!isValidRoomId(id)) {
      throw new DbNotFoundError();
    }

    const existingMemberToken = readValidCookieToken(request, MEMBER_COOKIE_NAME);
    const ownerToken = readValidCookieToken(request, ownerCookieName(id));

    const memberHash = existingMemberToken
      ? hashToken(existingMemberToken, config.tokenPepper)
      : null;
    const ownerHash = ownerToken ? hashToken(ownerToken, config.tokenPepper) : null;

    const snapshot = db.getRoom(id, memberHash, ownerHash);

    if (!existingMemberToken) {
      const mintedMemberToken = generateToken();
      setMemberCookie(request, reply, mintedMemberToken, config);
    }

    return reply
      .code(200)
      .header('Cache-Control', 'private, no-store')
      .send(snapshot);
  });

  app.put<{ Params: { id: string } }>('/api/rooms/:id/me', async (request, reply) => {
    const { id } = request.params;
    if (!isValidRoomId(id)) {
      throw new DbNotFoundError();
    }

    const body = validateSaveMineBody(request.body);
    const existingMemberToken = readValidCookieToken(request, MEMBER_COOKIE_NAME);
    const memberToken = existingMemberToken ?? generateToken();
    const memberHash = hashToken(memberToken, config.tokenPepper);

    const ownerToken = readValidCookieToken(request, ownerCookieName(id));
    const ownerHash = ownerToken ? hashToken(ownerToken, config.tokenPepper) : null;

    const result = db.saveMine(id, body, memberHash, ownerHash);

    if (!existingMemberToken) {
      setMemberCookie(request, reply, memberToken, config);
    }

    if (result.mutated) {
      sseHub.broadcastRevision(id, result.roomRevision);
    }

    return reply
      .code(200)
      .header('Cache-Control', 'private, no-store')
      .send(result.snapshot);
  });

  app.put<{ Params: { id: string } }>('/api/rooms/:id/closure', async (request, reply) => {
    const { id } = request.params;
    if (!isValidRoomId(id)) {
      throw new DbNotFoundError();
    }

    const body = validateCloseRoomBody(request.body);
    const existingMemberToken = readValidCookieToken(request, MEMBER_COOKIE_NAME);
    const memberHash = existingMemberToken
      ? hashToken(existingMemberToken, config.tokenPepper)
      : null;

    const ownerToken = readValidCookieToken(request, ownerCookieName(id));
    const ownerHash = ownerToken ? hashToken(ownerToken, config.tokenPepper) : null;

    const result = db.closeRoom(id, body.mutationId, memberHash, ownerHash);

    if (result.mutated) {
      sseHub.broadcastRevision(id, result.roomRevision);
    }

    return reply
      .code(200)
      .header('Cache-Control', 'private, no-store')
      .send(result.snapshot);
  });

  app.get<{
    Params: { id: string };
    Querystring: { afterRevision?: string };
  }>('/api/rooms/:id/events', async (request, reply) => {
    const { id } = request.params;
    if (!isValidRoomId(id)) {
      throw new DbNotFoundError();
    }

    const initialRevision = db.getRoomRevision(id);
    if (initialRevision === null) {
      throw new DbNotFoundError();
    }

    const afterRevision = parseAfterRevision(request.query?.afterRevision);

    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();

    request.socket?.setTimeout?.(0);
    request.socket?.setNoDelay?.(true);

    // Subscribe BEFORE checking latest revision so commits during setup aren't missed
    const subscription = sseHub.subscribe(id, reply.raw, request.raw, config.sseHeartbeatMs);

    const latestRevision = db.getRoomRevision(id);
    if (latestRevision !== null && latestRevision > afterRevision) {
      subscription.sendRevision(latestRevision);
    } else {
      subscription.sendComment('connected');
    }

    return reply;
  });

  return { app, db, sseHub, config };
}
