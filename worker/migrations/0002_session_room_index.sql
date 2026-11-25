-- Index rooms by browser session signature so creators can recover active rooms
-- even after clearing localStorage (while preserving per-room owner_hash isolation).
ALTER TABLE rooms ADD COLUMN creator_session_hash TEXT;
CREATE INDEX rooms_creator_session ON rooms(creator_session_hash, created_at DESC);
