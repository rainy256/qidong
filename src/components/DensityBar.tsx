import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { mergeDensityRuns, type SlotDensityCell } from '../domain/recommend';
import {
  formatAxisTick,
  formatSlotInNight,
  formatSpanInNight,
  slotToShanghaiParts,
} from '../domain/time';
import type { Night, Slot, Span } from '../domain/types';
import styles from './DensityBar.module.css';

type DensityBarProps = Readonly<{
  night: Night;
  cells: readonly SlotDensityCell[];
  draftSpans: readonly Span[];
  targetPlayers: number;
}>;

function getLevel(count: number, targetPlayers: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  const threshold = Math.max(1, targetPlayers - 1);
  const ratio = count / threshold;
  if (ratio >= 1) return 4;
  if (ratio >= 0.65) return 3;
  if (ratio >= 0.35) return 2;
  return 1;
}

function getBarHeightPct(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 26;
  return Math.round(36 + (count / maxCount) * 64);
}

export function DensityBar({
  night,
  cells,
  draftSpans,
  targetPlayers,
}: DensityBarProps) {
  const [hoveredCell, setHoveredCell] = useState<SlotDensityCell | null>(null);
  const [showList, setShowList] = useState(false);

  const totalSlots = cells.length;
  if (totalSlots === 0) return null;

  const canHover =
    typeof window !== 'undefined' && window.matchMedia?.('(hover: hover)').matches;

  const maxCount = Math.max(
    1,
    targetPlayers - 1,
    ...cells.map((c) => c.count),
  );

  const ticks: { slot: Slot; label: string; leftPct: number; align: 'start' | 'center' | 'end' }[] =
    [];
  for (let i = 0; i <= totalSlots; i++) {
    const slot = night.from + i;
    const parts = slotToShanghaiParts(slot);
    const isEvenHour = parts.minute === 0 && parts.hour % 2 === 0;
    const isEdge = i === 0 || i === totalSlots;
    if (!isEvenHour && !isEdge) continue;
    if (i > 0 && i < 2) continue;
    if (i < totalSlots && totalSlots - i < 2) continue;

    ticks.push({
      slot,
      label: formatAxisTick(slot, night.dateKey),
      leftPct: (i / totalSlots) * 100,
      align: i === 0 ? 'start' : i === totalSlots ? 'end' : 'center',
    });
  }

  const clampedDrafts = draftSpans
    .map((s) => ({
      from: Math.max(night.from, s.from),
      to: Math.min(night.to, s.to),
    }))
    .filter((s) => s.to > s.from);

  const runs = mergeDensityRuns(cells);

  return (
    <div className={styles.root}>
      <div className={styles.topBar}>
        <span className={styles.label}>小伙伴空余波浪</span>
        <button
          type="button"
          className={styles.inspectBtn}
          aria-expanded={showList}
          onClick={() => setShowList((v) => !v)}
        >
          <span>{showList ? '收起人数' : '查看人数'}</span>
          <ChevronDown
            size={14}
            className={showList ? styles.chevronOpen : styles.chevron}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Upper track: variable-height periwinkle wave */}
      <div
        className={styles.waveTrack}
        style={{ gridTemplateColumns: `repeat(${totalSlots}, minmax(0, 1fr))` }}
        onMouseLeave={() => setHoveredCell(null)}
        aria-label="当晚其他人空余时段分布"
      >
        {cells.map((cell) => {
          const parts = slotToShanghaiParts(cell.slot);
          const isMidnightStart =
            parts.dateKey !== night.dateKey && parts.hour === 0 && parts.minute === 0;
          const level = getLevel(cell.count, targetPlayers);
          const heightPct = getBarHeightPct(cell.count, maxCount);
          return (
            <div
              key={cell.slot}
              className={`${styles.waveSlot} ${isMidnightStart ? styles.midnightDivider : ''}`}
              onMouseEnter={() => {
                if (canHover) setHoveredCell(cell);
              }}
            >
              <div
                className={`${styles.waveBar} ${styles[`level${level}`]}`}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>

      {/* Lower track: my coral-peach capsule */}
      <div className={styles.draftRow}>
        <span className={styles.draftCaption}>我的上车时段</span>
        <div
          className={styles.draftTrack}
          style={{ gridTemplateColumns: `repeat(${totalSlots}, minmax(0, 1fr))` }}
        >
          {clampedDrafts.map((span) => {
            const startCol = span.from - night.from + 1;
            const endCol = span.to - night.from + 1;
            return (
              <div
                key={`${span.from}-${span.to}`}
                className={styles.draftSegment}
                style={{ gridColumn: `${startCol} / ${endCol}` }}
              />
            );
          })}
        </div>
      </div>

      <div className={`${styles.axis} tabular`} aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t.slot}
            className={`${styles.tick} ${styles[`tick_${t.align}`]}`}
            style={{ left: `${t.leftPct}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>

      {hoveredCell && (
        <p className={`${styles.hoverReadout} tabular`}>
          {formatSlotInNight(hoveredCell.slot, night.dateKey)}–
          {formatSlotInNight(hoveredCell.slot + 1, night.dateKey)} · {hoveredCell.count} 人有空
          {hoveredCell.memberNames.length > 0
            ? `（${hoveredCell.memberNames.join('、')}）`
            : ''}
        </p>
      )}

      {showList && (
        <div className={styles.breakdown}>
          {runs.length === 0 ? (
            <p className={styles.breakdownEmpty}>暂时还没有其他朋友填这一晚哦。</p>
          ) : (
            <ul className={styles.breakdownList}>
              {runs.map((run) => (
                <li key={`${run.from}-${run.to}`} className={`${styles.breakdownRow} tabular`}>
                  <span className={styles.breakdownTime}>{formatSpanInNight(night, run)}</span>
                  <span className={styles.breakdownCount}>{run.count} 人</span>
                  <span className={styles.breakdownNames}>{run.memberNames.join('、')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
