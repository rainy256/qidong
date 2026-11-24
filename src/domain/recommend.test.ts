import { describe, expect, it } from 'vitest';
import {
  computeDraftFeedback,
  computeOthersSlotAvailability,
  mergeSpans,
  recommend,
} from './recommend';
import { formatSlotInNight, formatSpanInNight, shanghaiToSlot } from './time';
import type { Night, RoomSnapshot, Submission } from './types';

describe('recommendation engine & time domain', () => {
  const fri: Night = {
    id: 'fri',
    dateKey: '2026-11-27',
    from: shanghaiToSlot('2026-11-27', 19, 0),
    to: shanghaiToSlot('2026-11-27', 23, 0),
  };

  const sat: Night = {
    id: 'sat',
    dateKey: '2026-11-28',
    from: shanghaiToSlot('2026-11-28', 19, 0),
    to: shanghaiToSlot('2026-11-28', 23, 0),
  };

  it('prevents false positive on the 4-player 2h counterexample (甲乙丙 20-22, 丁 20-21, 戊 21-22)', () => {
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t21 = shanghaiToSlot('2026-11-27', 21, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);

    const submissions: Submission[] = [
      {
        memberId: 'a',
        nickname: '甲',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t20, to: t22 }] },
        updatedAt: '2026-11-27T10:00:00Z',
      },
      {
        memberId: 'b',
        nickname: '乙',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t20, to: t22 }] },
        updatedAt: '2026-11-27T10:01:00Z',
      },
      {
        memberId: 'c',
        nickname: '丙',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t20, to: t22 }] },
        updatedAt: '2026-11-27T10:02:00Z',
      },
      {
        memberId: 'd',
        nickname: '丁',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t20, to: t21 }] },
        updatedAt: '2026-11-27T10:03:00Z',
      },
      {
        memberId: 'e',
        nickname: '戊',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t21, to: t22 }] },
        updatedAt: '2026-11-27T10:04:00Z',
      },
    ];

    // Confirm per-slot density really is 4 across all four 30-min slots [20:00, 22:00)
    const cells = computeOthersSlotAvailability(fri, submissions, null).filter(
      (c) => c.slot >= t20 && c.slot < t22,
    );
    expect(cells.map((c) => c.count)).toEqual([4, 4, 4, 4]);

    // At 2 hours (4 slots), ONLY [甲, 乙, 丙] can play continuously -> missingPlayers = 1!
    const res2h = recommend({
      nights: [fri],
      targetPlayers: 4,
      durationSlots: 4,
      earliestStart: fri.from,
      submissions,
    });
    expect(res2h).toHaveLength(1);
    expect(res2h[0].memberIds).toEqual(['a', 'b', 'c']);
    expect(res2h[0].missingPlayers).toBe(1);
    expect(res2h[0].firstStart).toBe(t20);
    expect(res2h[0].availableUntil).toBe(t22);

    // At 1 hour (2 slots), BOTH 20:00 [甲乙丙丁] and 21:00 [甲乙丙戊] qualify with 4 players
    const res1h = recommend({
      nights: [fri],
      targetPlayers: 4,
      durationSlots: 2,
      earliestStart: fri.from,
      submissions,
    });
    const ready1h = res1h.filter((c) => c.missingPlayers === 0);
    expect(ready1h).toHaveLength(2);
    expect(ready1h[0].memberIds).toEqual(['a', 'b', 'c', 'd']);
    expect(ready1h[0].firstStart).toBe(t20);
    expect(ready1h[0].lastStart).toBe(t20);
    expect(ready1h[1].memberIds).toEqual(['a', 'b', 'c', 'e']);
    expect(ready1h[1].firstStart).toBe(t21);
    expect(ready1h[1].lastStart).toBe(t21);
  });

  it('merges adjacent intervals, preserves dinner breaks, and does not truncate cohort when someone joins midway', () => {
    const t19 = shanghaiToSlot('2026-11-27', 19, 0);
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t21 = shanghaiToSlot('2026-11-27', 21, 0);
    const t22 = shanghaiToSlot('2026-11-27', 22, 0);
    const t23 = shanghaiToSlot('2026-11-27', 23, 0);

    // Adjacent merges; gap preserves
    expect(mergeSpans([{ from: t19, to: t20 }, { from: t20, to: t21 }])).toEqual([
      { from: t19, to: t21 },
    ]);
    expect(mergeSpans([{ from: t19, to: t20 }, { from: t21, to: t23 }])).toEqual([
      { from: t19, to: t20 },
      { from: t21, to: t23 },
    ]);

    // 4 players 20-23, 5th joins only 21-22; duration 1h (2 slots)
    const submissions: Submission[] = [
      ...['m1', 'm2', 'm3', 'm4'].map((id) => ({
        memberId: id,
        nickname: id,
        answer: { kind: 'available' as const, picks: [{ nightId: 'fri', from: t20, to: t23 }] },
        updatedAt: '2026-11-27T10:00:00Z',
      })),
      {
        memberId: 'm5',
        nickname: 'm5',
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t21, to: t22 }] },
        updatedAt: '2026-11-27T10:05:00Z',
      },
    ];

    const res = recommend({
      nights: [fri],
      targetPlayers: 4,
      durationSlots: 2,
      earliestStart: fri.from,
      submissions,
    });

    const fourRoster = res.find((c) => c.memberIds.length === 4);
    expect(fourRoster).toBeDefined();
    expect(fourRoster?.firstStart).toBe(t20);
    expect(fourRoster?.availableUntil).toBe(t23);
    expect(fourRoster?.lastStart).toBe(t22);
  });

  it('ranks Friday 5-player ready option ahead of Saturday 6-player ready option', () => {
    const fri20 = shanghaiToSlot('2026-11-27', 20, 0);
    const fri22 = shanghaiToSlot('2026-11-27', 22, 0);
    const sat20 = shanghaiToSlot('2026-11-28', 20, 0);
    const sat22 = shanghaiToSlot('2026-11-28', 22, 0);

    const submissions: Submission[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => ({
      memberId: id,
      nickname: id,
      answer: {
        kind: 'available',
        picks:
          i < 5
            ? [
                { nightId: 'fri', from: fri20, to: fri22 },
                { nightId: 'sat', from: sat20, to: sat22 },
              ]
            : [{ nightId: 'sat', from: sat20, to: sat22 }],
      },
      updatedAt: '2026-11-27T10:00:00Z',
    }));

    const res = recommend({
      nights: [fri, sat],
      targetPlayers: 5,
      durationSlots: 4,
      earliestStart: fri.from,
      submissions,
    });

    expect(res[0].nightId).toBe('fri');
    expect(res[0].memberIds).toHaveLength(5);
    expect(res[1].nightId).toBe('sat');
    expect(res[1].memberIds).toHaveLength(6);
  });

  it('handles cross-midnight positive duration and 次日 formatting', () => {
    const nightMid: Night = {
      id: 'mid',
      dateKey: '2026-11-27',
      from: shanghaiToSlot('2026-11-27', 20, 0),
      to: shanghaiToSlot('2026-11-28', 3, 0),
    };
    const start22 = shanghaiToSlot('2026-11-27', 22, 0);
    const end02 = shanghaiToSlot('2026-11-27', 2, 0, true);

    expect(end02 - start22).toBe(8);
    expect(formatSlotInNight(end02, nightMid.dateKey)).toBe('次日 02:00');
    expect(formatSpanInNight(nightMid, { from: start22, to: end02 })).toBe('22:00–次日 02:00');
  });

  it('computes accurate live draft feedback with unsaved reminder', () => {
    const t20 = shanghaiToSlot('2026-11-27', 20, 0);
    const t23 = shanghaiToSlot('2026-11-27', 23, 0);

    const snapshot: RoomSnapshot = {
      id: 'r1',
      title: '五排',
      tzid: 'Asia/Shanghai',
      nights: [fri],
      targetPlayers: 5,
      durationSlots: 4,
      roomRevision: 1,
      closedAt: null,
      submissions: ['p1', 'p2', 'p3', 'p4'].map((id) => ({
        memberId: id,
        nickname: id,
        answer: { kind: 'available', picks: [{ nightId: 'fri', from: t20, to: t23 }] },
        updatedAt: '2026-11-27T10:00:00Z',
      })),
      viewer: { memberId: null, canClose: false, mineRevision: 0 },
      syncedAt: '2026-11-27T11:00:00Z',
    };

    const fb = computeDraftFeedback(
      snapshot,
      [{ nightId: 'fri', from: t20, to: t23 }],
      'available',
      true,
      fri.from,
    );

    expect(fb?.tone).toBe('ready');
    expect(fb?.message).toContain('算上你');
    expect(fb?.message).toContain('凑齐 5 人');
    expect(fb?.message).toContain('尚未保存');
  });
});
