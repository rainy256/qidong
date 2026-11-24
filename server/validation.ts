import type { CreateRoomSpec, GameTag, Night, Pick, SaveMineInput } from '../src/domain/types';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type ValidatedCreateRoomBody = CreateRoomSpec & Readonly<{
  mutationId: string;
}>;

const VALID_GAME_TAGS = new Set<GameTag>(['apex', 'gta', 'tarkov', 'custom']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateKey(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function requireNonEmptyString(
  value: unknown,
  fieldLabel: string,
  maxChars: number,
  emptyMsg?: string,
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldLabel}格式不正确。`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(emptyMsg ?? `${fieldLabel}不能为空。`);
  }
  if (Array.from(trimmed).length > maxChars) {
    throw new ValidationError(`${fieldLabel}不能超过 ${maxChars} 个字。`);
  }
  return trimmed;
}

export function validateCreateRoomBody(body: unknown): ValidatedCreateRoomBody {
  if (!isPlainObject(body)) {
    throw new ValidationError('请求体必须是 JSON 对象。');
  }

  const title = requireNonEmptyString(body.title, '房间标题', 32, '房间标题不能为空。');

  let gameTag: GameTag | undefined;
  if (body.gameTag !== undefined && body.gameTag !== null) {
    if (typeof body.gameTag !== 'string' || !VALID_GAME_TAGS.has(body.gameTag as GameTag)) {
      throw new ValidationError('游戏标签不合法。');
    }
    gameTag = body.gameTag as GameTag;
  }

  const targetPlayers = body.targetPlayers;
  if (typeof targetPlayers !== 'number' || !Number.isInteger(targetPlayers) || targetPlayers < 2 || targetPlayers > 10) {
    throw new ValidationError('发车人数必须是 2 到 10 之间的整数。');
  }

  const durationSlots = body.durationSlots;
  if (typeof durationSlots !== 'number' || !Number.isInteger(durationSlots) || durationSlots < 1 || durationSlots > 16) {
    throw new ValidationError('最短游玩时长必须在 0.5 到 8 小时之间。');
  }

  if (!Array.isArray(body.nights) || body.nights.length < 1 || body.nights.length > 7) {
    throw new ValidationError('备选晚间数量必须为 1 到 7 晚。');
  }

  const seenIds = new Set<string>();
  const nights: Night[] = body.nights.map((rawNight, index) => {
    if (!isPlainObject(rawNight)) {
      throw new ValidationError(`第 ${index + 1} 个晚间配置格式不正确。`);
    }
    const id = requireNonEmptyString(rawNight.id, '晚间 ID', 32);
    if (seenIds.has(id)) {
      throw new ValidationError('晚间 ID 不能重复。');
    }
    seenIds.add(id);

    if (typeof rawNight.dateKey !== 'string' || !isValidDateKey(rawNight.dateKey)) {
      throw new ValidationError('晚间日期格式不合法。');
    }

    const from = rawNight.from;
    const to = rawNight.to;
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isInteger(from) ||
      !Number.isInteger(to)
    ) {
      throw new ValidationError('晚间起止时间必须是半小时整数格点。');
    }
    if (to <= from) {
      throw new ValidationError('晚间结束时间必须晚于开始时间。');
    }
    if (to - from < durationSlots) {
      throw new ValidationError('每晚可填时长不能短于最短游玩时长。');
    }
    if (to - from > 48) {
      throw new ValidationError('单晚时间窗口不能超过 24 小时。');
    }

    return {
      id,
      dateKey: rawNight.dateKey,
      from,
      to,
    };
  });

  const mutationId = requireNonEmptyString(body.mutationId, 'mutationId', 128);

  return {
    title,
    gameTag,
    nights,
    targetPlayers,
    durationSlots,
    mutationId,
  };
}

export function validateSaveMineBody(body: unknown): SaveMineInput {
  if (!isPlainObject(body)) {
    throw new ValidationError('请求体必须是 JSON 对象。');
  }

  const nickname = requireNonEmptyString(body.nickname, '昵称', 20, '请先填一个群里认得出你的昵称～');

  const baseMineRevision = body.baseMineRevision;
  if (typeof baseMineRevision !== 'number' || !Number.isInteger(baseMineRevision) || baseMineRevision < 0) {
    throw new ValidationError('版本号格式不合法。');
  }

  const mutationId = requireNonEmptyString(body.mutationId, 'mutationId', 128);

  if (!isPlainObject(body.answer)) {
    throw new ValidationError('时间回答格式不正确。');
  }

  if (body.answer.kind === 'unavailable') {
    return {
      nickname,
      answer: { kind: 'unavailable' },
      baseMineRevision,
      mutationId,
    };
  }

  if (body.answer.kind !== 'available') {
    throw new ValidationError('时间回答类型不合法。');
  }

  if (!Array.isArray(body.answer.picks) || body.answer.picks.length > 100) {
    throw new ValidationError('所选时段列表格式不正确。');
  }

  const picks: Pick[] = body.answer.picks.map((rawPick) => {
    if (!isPlainObject(rawPick)) {
      throw new ValidationError('时段项格式不正确。');
    }
    const nightId = requireNonEmptyString(rawPick.nightId, '晚间 ID', 32);
    const from = rawPick.from;
    const to = rawPick.to;
    if (
      typeof from !== 'number' ||
      typeof to !== 'number' ||
      !Number.isInteger(from) ||
      !Number.isInteger(to)
    ) {
      throw new ValidationError('时段起止时间必须是整数格点。');
    }
    return { nightId, from, to };
  });

  return {
    nickname,
    answer: { kind: 'available', picks },
    baseMineRevision,
    mutationId,
  };
}

export function validateCloseRoomBody(body: unknown): { mutationId: string } {
  if (!isPlainObject(body)) {
    throw new ValidationError('请求体必须是 JSON 对象。');
  }
  const mutationId = requireNonEmptyString(body.mutationId, 'mutationId', 128);
  return { mutationId };
}

export function parseAfterRevision(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    }
  }
  return 0;
}
