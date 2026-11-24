import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { normalizePicks } from '../src/domain/recommend';
import type {
  Answer,
  GameTag,
  Night,
  Pick,
  RoomSnapshot,
  SaveMineInput,
  Submission,
} from '../src/domain/types';
import { runMigrations } from './migrations';
import { generateMemberId, generateRoomId, hashPayload, timingSafeHashEqual } from './security';
import type { ValidatedCreateRoomBody } from './validation';

export class DbNotFoundError extends Error {
  constructor(message = '找不到这个约局房间，可能链接有误或已过期。') {
    super(message);
    this.name = 'DbNotFoundError';
  }
}

export class DbRoomClosedError extends Error {
  constructor(message = '房主已结束本次收集，当前仅可查看结果。') {
    super(message);
    this.name = 'DbRoomClosedError';
  }
}

export class DbRevisionConflictError extends Error {
  constructor(message = '你在其他设备或窗口已经更新过填写，请先刷新查看最新内容。') {
    super(message);
    this.name = 'DbRevisionConflictError';
  }
}

export class DbForbiddenError extends Error {
  constructor(message = '只有房主可以结束收集。') {
    super(message);
    this.name = 'DbForbiddenError';
  }
}

export class DbInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbInvalidInputError';
  }
}

export class DbIdempotencyConflictError extends Error {
  constructor(message = '该请求编号已被不同内容占用，请刷新后重试。') {
    super(message);
    this.name = 'DbIdempotencyConflictError';
  }
}

interface RoomRow {
  id: string;
  title: string;
  game_tag: GameTag | null;
  owner_token_hash: string;
  tzid: string;
  nights_json: string;
  target_players: number;
  duration_slots: number;
  room_revision: number;
  closed_at: string | null;
  expires_at: string;
  created_at: string;
}

interface ParticipantRow {
  room_id: string;
  id: string;
  member_token_hash: string;
  nickname: string;
  answer_kind: 'available' | 'unavailable';
  picks_json: string;
  participant_rev: number;
  updated_at: string;
}

interface MutationRow {
  scope: string;
  mutation_id: string;
  room_revision: number;
  room_id: string | null;
  request_hash: string | null;
  created_at: string;
}

export type CreateRoomResult = Readonly<{
  created: boolean;
  snapshot: RoomSnapshot;
}>;

export type MutationResult = Readonly<{
  mutated: boolean;
  roomRevision: number;
  snapshot: RoomSnapshot;
}>;

function buildSnapshot(
  roomRow: RoomRow,
  participantRows: readonly ParticipantRow[],
  viewerMemberHash: string | null,
  viewerCanClose: boolean,
  syncedAt: string,
): RoomSnapshot {
  const nights = JSON.parse(roomRow.nights_json) as Night[];
  let viewerMemberId: string | null = null;
  let mineRevision = 0;

  const submissions: Submission[] = participantRows.map((p) => {
    if (viewerMemberHash !== null && timingSafeHashEqual(viewerMemberHash, p.member_token_hash)) {
      viewerMemberId = p.id;
      mineRevision = p.participant_rev;
    }

    const answer: Answer =
      p.answer_kind === 'available'
        ? { kind: 'available', picks: JSON.parse(p.picks_json) as Pick[] }
        : { kind: 'unavailable' };

    return {
      memberId: p.id,
      nickname: p.nickname,
      answer,
      updatedAt: p.updated_at,
    };
  });

  const base = {
    id: roomRow.id,
    title: roomRow.title,
    tzid: 'Asia/Shanghai' as const,
    nights,
    targetPlayers: roomRow.target_players,
    durationSlots: roomRow.duration_slots,
    roomRevision: roomRow.room_revision,
    closedAt: roomRow.closed_at,
    submissions,
    viewer: {
      memberId: viewerMemberId,
      canClose: viewerCanClose,
      mineRevision,
    },
    syncedAt,
  };

  return roomRow.game_tag ? { ...base, gameTag: roomRow.game_tag } : base;
}

export class RoomDatabase {
  private readonly db: Database.Database;

  private readonly stmtGetActiveRoom: Database.Statement<[string, string], RoomRow>;
  private readonly stmtGetRoomRev: Database.Statement<[string, string], { room_revision: number }>;
  private readonly stmtGetParticipants: Database.Statement<[string], ParticipantRow>;
  private readonly stmtGetParticipantByHash: Database.Statement<[string, string], ParticipantRow>;
  private readonly stmtGetMutation: Database.Statement<[string, string], MutationRow>;
  private readonly stmtDeleteMutation: Database.Statement<[string, string]>;
  private readonly stmtInsertMutation: Database.Statement<
    [string, string, number, string | null, string, string]
  >;
  private readonly stmtInsertRoom: Database.Statement<
    [string, string, string | null, string, string, number, number, string, string]
  >;
  private readonly stmtInsertParticipant: Database.Statement<
    [string, string, string, string, 'available' | 'unavailable', string, string]
  >;
  private readonly stmtUpdateParticipant: Database.Statement<
    [string, 'available' | 'unavailable', string, string, string, string]
  >;
  private readonly stmtBumpRoomRevision: Database.Statement<[string]>;
  private readonly stmtCloseRoom: Database.Statement<[string, string]>;
  private readonly stmtPurgeExpiredRooms: Database.Statement<[string]>;
  private readonly stmtPurgeOldMutations: Database.Statement<[string]>;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    runMigrations(this.db);

    this.stmtGetActiveRoom = this.db.prepare(
      'SELECT * FROM rooms WHERE id = ? AND expires_at > ?',
    );
    this.stmtGetRoomRev = this.db.prepare(
      'SELECT room_revision FROM rooms WHERE id = ? AND expires_at > ?',
    );
    this.stmtGetParticipants = this.db.prepare(
      'SELECT * FROM participants WHERE room_id = ? ORDER BY rowid ASC',
    );
    this.stmtGetParticipantByHash = this.db.prepare(
      'SELECT * FROM participants WHERE room_id = ? AND member_token_hash = ?',
    );
    this.stmtGetMutation = this.db.prepare(
      'SELECT * FROM mutations WHERE scope = ? AND mutation_id = ?',
    );
    this.stmtDeleteMutation = this.db.prepare(
      'DELETE FROM mutations WHERE scope = ? AND mutation_id = ?',
    );
    this.stmtInsertMutation = this.db.prepare(
      'INSERT INTO mutations (scope, mutation_id, room_revision, room_id, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.stmtInsertRoom = this.db.prepare(
      `INSERT INTO rooms (
        id, title, game_tag, owner_token_hash, tzid, nights_json,
        target_players, duration_slots, room_revision, closed_at, expires_at, created_at
      ) VALUES (?, ?, ?, ?, 'Asia/Shanghai', ?, ?, ?, 1, NULL, ?, ?)`,
    );
    this.stmtInsertParticipant = this.db.prepare(
      `INSERT INTO participants (
        room_id, id, member_token_hash, nickname, answer_kind, picks_json, participant_rev, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    this.stmtUpdateParticipant = this.db.prepare(
      `UPDATE participants
       SET nickname = ?, answer_kind = ?, picks_json = ?, participant_rev = participant_rev + 1, updated_at = ?
       WHERE room_id = ? AND id = ?`,
    );
    this.stmtBumpRoomRevision = this.db.prepare(
      'UPDATE rooms SET room_revision = room_revision + 1 WHERE id = ?',
    );
    this.stmtCloseRoom = this.db.prepare(
      'UPDATE rooms SET closed_at = COALESCE(closed_at, ?), room_revision = room_revision + 1 WHERE id = ?',
    );
    this.stmtPurgeExpiredRooms = this.db.prepare(
      'DELETE FROM rooms WHERE expires_at <= ?',
    );
    this.stmtPurgeOldMutations = this.db.prepare(
      'DELETE FROM mutations WHERE created_at <= ?',
    );
  }

  getJournalMode(): string {
    const res = this.db.pragma('journal_mode', { simple: true });
    return String(res).toLowerCase();
  }

  getForeignKeys(): number {
    const res = this.db.pragma('foreign_keys', { simple: true });
    return Number(res);
  }

  countRows(table: 'rooms' | 'participants' | 'mutations'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    return row.cnt;
  }

  ping(): boolean {
    const row = this.db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  getAppliedMigrations(): number[] {
    const rows = this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }

  checkReady(): { ok: boolean; journalMode: string } {
    const ok = this.ping();
    const journalMode = this.getJournalMode();
    return { ok, journalMode };
  }

  close(): void {
    this.db.close();
  }

  createRoom(
    input: ValidatedCreateRoomBody,
    ownerTokenHash: string,
    memberTokenHash: string | null,
    existingOwnerHashForRoomLookup: (roomId: string) => string | null,
    roomTtlDays: number,
  ): CreateRoomResult {
    const requestHash = hashPayload({
      title: input.title,
      gameTag: input.gameTag ?? null,
      nights: input.nights,
      targetPlayers: input.targetPlayers,
      durationSlots: input.durationSlots,
    });

    const tx = this.db.transaction((): CreateRoomResult => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      const existingMutation = this.stmtGetMutation.get('create', input.mutationId);
      if (existingMutation?.room_id) {
        const existingRoom = this.stmtGetActiveRoom.get(existingMutation.room_id, nowIso);
        if (existingRoom) {
          if (existingMutation.request_hash && existingMutation.request_hash !== requestHash) {
            throw new DbIdempotencyConflictError();
          }
          const participants = this.stmtGetParticipants.all(existingRoom.id);
          const ownerHash = existingOwnerHashForRoomLookup(existingRoom.id);
          const canClose =
            ownerHash !== null && timingSafeHashEqual(ownerHash, existingRoom.owner_token_hash);
          return {
            created: false,
            snapshot: buildSnapshot(existingRoom, participants, memberTokenHash, canClose, nowIso),
          };
        }
        this.stmtDeleteMutation.run('create', input.mutationId);
      }

      let roomId = generateRoomId();
      while (this.db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(roomId)) {
        roomId = generateRoomId();
      }

      const expiresAt = new Date(nowMs + roomTtlDays * 86_400_000).toISOString();
      const nightsJson = JSON.stringify(input.nights);

      this.stmtInsertRoom.run(
        roomId,
        input.title,
        input.gameTag ?? null,
        ownerTokenHash,
        nightsJson,
        input.targetPlayers,
        input.durationSlots,
        expiresAt,
        nowIso,
      );
      this.stmtInsertMutation.run('create', input.mutationId, 1, roomId, requestHash, nowIso);

      const createdRoom = this.stmtGetActiveRoom.get(roomId, nowIso)!;
      return {
        created: true,
        snapshot: buildSnapshot(createdRoom, [], memberTokenHash, true, nowIso),
      };
    });

    return tx.immediate();
  }

  getRoom(
    roomId: string,
    viewerMemberHash: string | null,
    viewerOwnerHash: string | null,
  ): RoomSnapshot {
    const tx = this.db.transaction((): RoomSnapshot => {
      const nowIso = new Date().toISOString();
      const room = this.stmtGetActiveRoom.get(roomId, nowIso);
      if (!room) {
        throw new DbNotFoundError();
      }
      const participants = this.stmtGetParticipants.all(roomId);
      const canClose =
        viewerOwnerHash !== null && timingSafeHashEqual(viewerOwnerHash, room.owner_token_hash);
      return buildSnapshot(room, participants, viewerMemberHash, canClose, nowIso);
    });

    return tx();
  }

  getRoomRevision(roomId: string): number | null {
    const nowIso = new Date().toISOString();
    const row = this.stmtGetRoomRev.get(roomId, nowIso);
    return row ? row.room_revision : null;
  }

  saveMine(
    roomId: string,
    input: SaveMineInput,
    memberTokenHash: string,
    viewerOwnerHash: string | null,
  ): MutationResult {
    const tx = this.db.transaction((): MutationResult => {
      const nowIso = new Date().toISOString();
      const room = this.stmtGetActiveRoom.get(roomId, nowIso);
      if (!room) {
        throw new DbNotFoundError();
      }
      if (room.closed_at !== null) {
        throw new DbRoomClosedError();
      }

      const canClose =
        viewerOwnerHash !== null && timingSafeHashEqual(viewerOwnerHash, room.owner_token_hash);

      const nights = JSON.parse(room.nights_json) as Night[];
      let answerKind: 'available' | 'unavailable' = 'unavailable';
      let normalizedPicks: Pick[] = [];

      if (input.answer.kind === 'available') {
        normalizedPicks = normalizePicks(input.answer.picks, nights);
        if (normalizedPicks.length === 0) {
          throw new DbInvalidInputError('请至少选择一个位于候选晚间内的有效时段。');
        }
        answerKind = 'available';
      }

      const requestHash = hashPayload({
        nickname: input.nickname,
        answerKind,
        picks: normalizedPicks,
        baseMineRevision: input.baseMineRevision,
      });

      const scope = `save:${roomId}:${memberTokenHash}`;
      const existingMutation = this.stmtGetMutation.get(scope, input.mutationId);
      if (existingMutation) {
        if (existingMutation.request_hash && existingMutation.request_hash !== requestHash) {
          throw new DbIdempotencyConflictError();
        }
        const participants = this.stmtGetParticipants.all(roomId);
        return {
          mutated: false,
          roomRevision: room.room_revision,
          snapshot: buildSnapshot(room, participants, memberTokenHash, canClose, nowIso),
        };
      }

      const existingParticipant = this.stmtGetParticipantByHash.get(roomId, memberTokenHash);
      if (!existingParticipant && input.baseMineRevision !== 0) {
        throw new DbRevisionConflictError();
      }
      if (existingParticipant && existingParticipant.participant_rev !== input.baseMineRevision) {
        throw new DbRevisionConflictError();
      }

      const picksJson = JSON.stringify(normalizedPicks);
      if (!existingParticipant) {
        const memberId = generateMemberId();
        this.stmtInsertParticipant.run(
          roomId,
          memberId,
          memberTokenHash,
          input.nickname,
          answerKind,
          picksJson,
          nowIso,
        );
      } else {
        this.stmtUpdateParticipant.run(
          input.nickname,
          answerKind,
          picksJson,
          nowIso,
          roomId,
          existingParticipant.id,
        );
      }

      this.stmtBumpRoomRevision.run(roomId);
      const nextRev = room.room_revision + 1;
      this.stmtInsertMutation.run(scope, input.mutationId, nextRev, roomId, requestHash, nowIso);

      const updatedRoom = this.stmtGetActiveRoom.get(roomId, nowIso)!;
      const participants = this.stmtGetParticipants.all(roomId);
      return {
        mutated: true,
        roomRevision: nextRev,
        snapshot: buildSnapshot(updatedRoom, participants, memberTokenHash, canClose, nowIso),
      };
    });

    return tx.immediate();
  }

  closeRoom(
    roomId: string,
    mutationId: string,
    viewerMemberHash: string | null,
    viewerOwnerHash: string | null,
  ): MutationResult {
    const tx = this.db.transaction((): MutationResult => {
      const nowIso = new Date().toISOString();
      const room = this.stmtGetActiveRoom.get(roomId, nowIso);
      if (!room) {
        throw new DbNotFoundError();
      }

      if (
        viewerOwnerHash === null ||
        !timingSafeHashEqual(viewerOwnerHash, room.owner_token_hash)
      ) {
        throw new DbForbiddenError();
      }

      const scope = `close:${roomId}`;
      const requestHash = hashPayload({ action: 'close', roomId });
      const existingMutation = this.stmtGetMutation.get(scope, mutationId);
      if (existingMutation) {
        if (existingMutation.request_hash && existingMutation.request_hash !== requestHash) {
          throw new DbIdempotencyConflictError();
        }
        const participants = this.stmtGetParticipants.all(roomId);
        return {
          mutated: false,
          roomRevision: room.room_revision,
          snapshot: buildSnapshot(room, participants, viewerMemberHash, true, nowIso),
        };
      }

      if (room.closed_at === null) {
        this.stmtCloseRoom.run(nowIso, roomId);
        const nextRev = room.room_revision + 1;
        this.stmtInsertMutation.run(scope, mutationId, nextRev, roomId, requestHash, nowIso);
        const updatedRoom = this.stmtGetActiveRoom.get(roomId, nowIso)!;
        const participants = this.stmtGetParticipants.all(roomId);
        return {
          mutated: true,
          roomRevision: nextRev,
          snapshot: buildSnapshot(updatedRoom, participants, viewerMemberHash, true, nowIso),
        };
      }

      this.stmtInsertMutation.run(scope, mutationId, room.room_revision, roomId, requestHash, nowIso);
      const participants = this.stmtGetParticipants.all(roomId);
      return {
        mutated: false,
        roomRevision: room.room_revision,
        snapshot: buildSnapshot(room, participants, viewerMemberHash, true, nowIso),
      };
    });

    return tx.immediate();
  }

  purgeExpired(nowMs: number = Date.now(), mutationRetentionDays = 30): {
    deletedRooms: number;
    deletedMutations: number;
  } {
    const tx = this.db.transaction(() => {
      const nowIso = new Date(nowMs).toISOString();
      const cutoffIso = new Date(nowMs - mutationRetentionDays * 86_400_000).toISOString();
      const roomRes = this.stmtPurgeExpiredRooms.run(nowIso);
      const mutRes = this.stmtPurgeOldMutations.run(cutoffIso);
      return {
        deletedRooms: roomRes.changes,
        deletedMutations: mutRes.changes,
      };
    });
    return tx.immediate();
  }
}
