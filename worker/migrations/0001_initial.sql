-- Cloudflare D1 schema. Each successful mutation and its effects commit together.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  game_tag TEXT,
  nights_json TEXT NOT NULL,
  target_players INTEGER NOT NULL CHECK(target_players BETWEEN 2 AND 10),
  duration_slots INTEGER NOT NULL CHECK(duration_slots BETWEEN 1 AND 16),
  room_revision INTEGER NOT NULL DEFAULT 1,
  closed_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX rooms_expiry ON rooms(expires_at);

CREATE TABLE participants (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  member_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  answer_kind TEXT NOT NULL CHECK(answer_kind IN ('available','unavailable')),
  picks_json TEXT NOT NULL,
  participant_rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(room_id,id),
  UNIQUE(room_id,member_hash)
);

CREATE TABLE mutations (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('save','close')),
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  base_rev INTEGER,
  member_id TEXT,
  nickname TEXT,
  answer_kind TEXT,
  picks_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id,actor_hash,action,mutation_id)
);

-- The caller inserts only if this exact mutation key does not exist.
-- Triggers run atomically with the INSERT; no read/modify/write race across Workers.
CREATE TRIGGER mutation_guard BEFORE INSERT ON mutations
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM rooms WHERE id=NEW.room_id AND expires_at>NEW.created_at
  ) THEN RAISE(ABORT,'QIDONG_NOT_FOUND') END;
  SELECT CASE WHEN NEW.action='close' AND NOT EXISTS(
    SELECT 1 FROM rooms WHERE id=NEW.room_id AND owner_hash=NEW.actor_hash
  ) THEN RAISE(ABORT,'QIDONG_OWNER_REQUIRED') END;
  SELECT CASE WHEN NEW.action='save' AND EXISTS(
    SELECT 1 FROM rooms WHERE id=NEW.room_id AND closed_at IS NOT NULL
  ) THEN RAISE(ABORT,'QIDONG_ROOM_CLOSED') END;
  SELECT CASE WHEN NEW.action='save' AND NEW.base_rev != COALESCE(
    (SELECT participant_rev FROM participants WHERE room_id=NEW.room_id AND member_hash=NEW.actor_hash),0
  ) THEN RAISE(ABORT,'QIDONG_REVISION_CONFLICT') END;
END;

CREATE TRIGGER mutation_apply_save AFTER INSERT ON mutations WHEN NEW.action='save'
BEGIN
  INSERT INTO participants(room_id,id,member_hash,nickname,answer_kind,picks_json,participant_rev,updated_at)
  VALUES(NEW.room_id,NEW.member_id,NEW.actor_hash,NEW.nickname,NEW.answer_kind,NEW.picks_json,1,NEW.created_at)
  ON CONFLICT(room_id,member_hash) DO UPDATE SET
    nickname=excluded.nickname, answer_kind=excluded.answer_kind, picks_json=excluded.picks_json,
    participant_rev=participants.participant_rev+1, updated_at=excluded.updated_at;
  UPDATE rooms SET room_revision=room_revision+1 WHERE id=NEW.room_id;
END;

CREATE TRIGGER mutation_apply_close AFTER INSERT ON mutations WHEN NEW.action='close'
BEGIN
  UPDATE rooms SET closed_at=NEW.created_at, room_revision=room_revision+1
  WHERE id=NEW.room_id AND closed_at IS NULL;
END;
