import { AlertCircle, ArrowRight, Check, Minus, Plus, Sparkles } from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { NetworkError, RepositoryError, type RoomRepository } from '../api/repository';
import { pendingMutation, readPending, writePending, type PendingMutation } from '../api/mutation';
import { getAvatarTone } from '../components/AvatarChip';
import { GameStickerArt, HeroSquadIllustration } from '../components/GameArtwork';
import {
  buildNightWindow,
  buildUpcomingDateOptions,
  formatDuration,
  getTodayShanghaiDateKey,
} from '../domain/time';
import type { GameTag } from '../domain/types';
import styles from './CreateRoomPage.module.css';

type CreateRoomPageProps = Readonly<{
  repository: RoomRepository;
  showDemoLink?: boolean;
  onCreated: (roomId: string) => void;
  onNavigate: (path: string) => void;
}>;

type GamePreset = Readonly<{
  tag: GameTag;
  label: string;
  hint: string;
  defaultTitle: string;
  defaultPlayers: number;
}>;

const GAME_PRESETS: readonly GamePreset[] = [
  {
    tag: 'apex',
    label: 'Apex',
    hint: '3 人小队',
    defaultTitle: '周五晚 Apex 三排',
    defaultPlayers: 3,
  },
  {
    tag: 'gta',
    label: 'GTA',
    hint: '4 人车队',
    defaultTitle: '周末 GTA 抢劫分红车',
    defaultPlayers: 4,
  },
  {
    tag: 'tarkov',
    label: '塔科夫',
    hint: '4 人跑图',
    defaultTitle: '深夜塔科夫跑图车队',
    defaultPlayers: 4,
  },
  {
    tag: 'custom',
    label: '自定义',
    hint: '自由填名',
    defaultTitle: '',
    defaultPlayers: 4,
  },
];

const START_HOUR_OPTIONS = [18, 19, 20, 21, 22] as const;
const END_HOUR_OPTIONS: readonly { label: string; hour: number }[] = [
  { label: '22:00', hour: 22 },
  { label: '23:00', hour: 23 },
  { label: '次日 00:00', hour: 0 },
  { label: '次日 01:00', hour: 1 },
  { label: '次日 02:00', hour: 2 },
  { label: '次日 03:00', hour: 3 },
];

const DURATION_PRESETS = [
  { slots: 2, label: '1 小时' },
  { slots: 3, label: '1.5 小时' },
  { slots: 4, label: '2 小时' },
  { slots: 5, label: '2.5 小时' },
  { slots: 6, label: '3 小时' },
] as const;

export function CreateRoomPage({
  repository,
  showDemoLink = true,
  onCreated,
  onNavigate,
}: CreateRoomPageProps) {
  const todayKey = useMemo(() => getTodayShanghaiDateKey(), []);
  const dateOptions = useMemo(() => buildUpcomingDateOptions(todayKey, 10), [todayKey]);

  const defaultDates = useMemo(() => {
    const weekend = dateOptions.filter((d) => d.isWeekend).slice(0, 3);
    if (weekend.length >= 2) return weekend.map((d) => d.dateKey);
    return dateOptions.slice(0, 3).map((d) => d.dateKey);
  }, [dateOptions]);

  const [gameTag, setGameTag] = useState<GameTag>('apex');
  const [title, setTitle] = useState<string>('周五晚 Apex 三排');
  const [selectedDates, setSelectedDates] = useState<string[]>(defaultDates);
  const [startHour, setStartHour] = useState<number>(19);
  const [endHour, setEndHour] = useState<number>(2);
  const [targetPlayers, setTargetPlayers] = useState<number>(3);
  const [durationSlots, setDurationSlots] = useState<number>(4);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pending = useRef<PendingMutation | null>(readPending('create'));
  const submitting = useRef(false);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const startId = useId();
  const endId = useId();

  const selectGamePreset = (preset: GamePreset) => {
    setGameTag(preset.tag);
    setErrorMsg(null);
    if (preset.tag === 'custom') {
      setTitle('');
      requestAnimationFrame(() => {
        titleInputRef.current?.focus();
      });
    } else {
      setTitle(preset.defaultTitle);
      setTargetPlayers(preset.defaultPlayers);
    }
  };

  const toggleDate = (dateKey: string) => {
    setErrorMsg(null);
    setSelectedDates((prev) => {
      if (prev.includes(dateKey)) {
        if (prev.length === 1) return prev;
        return prev.filter((d) => d !== dateKey);
      }
      if (prev.length >= 7) return prev;
      return [...prev, dateKey].sort();
    });
  };

  const submitCreate = async () => {
    if (submitting.current) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setErrorMsg('先给这次约局起个名字吧，比如「双人成行」或「吃火锅」～');
      titleInputRef.current?.focus();
      return;
    }
    if (selectedDates.length === 0) {
      setErrorMsg('至少挑一个备选晚上哦。');
      return;
    }

    const nights = selectedDates.map((dk) => buildNightWindow(dk, startHour, 0, endHour, 0));
    if (nights.some((n) => n.to - n.from < durationSlots)) {
      setErrorMsg(`每晚可填时长不能短于「至少玩 ${formatDuration(durationSlots)}」。`);
      return;
    }

    const spec = { title: cleanTitle, gameTag, nights, targetPlayers, durationSlots };
    submitting.current = true;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      pending.current = pendingMutation(pending.current, spec);
      writePending('create', pending.current);
      const created = await repository.createRoom(spec, pending.current.key);
      pending.current = null;
      writePending('create', null);
      onCreated(created.id);
    } catch (err) {
      if (err instanceof RepositoryError && !(err instanceof NetworkError) && err.code !== 'SESSION_REQUIRED') {
        pending.current = null;
        writePending('create', null);
      }
      setErrorMsg((err as Error).message || '创建失败，请稍后重试。');
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitCreate();
  };

  const handleTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      void submitCreate();
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.mobileStage}>
        <header className={styles.topBar}>
          <div className={styles.brandGroup}>
            <span className={styles.brandName}>约局</span>
            <span className={styles.brandSticker}>免登录 · 10秒开黑</span>
          </div>
          {showDemoLink && (
            <a
              href="/r/demo-almost"
              className={styles.demoLink}
              onClick={(e) => {
                e.preventDefault();
                onNavigate('/r/demo-almost');
              }}
            >
              <Sparkles size={14} aria-hidden="true" />
              <span>演示车票</span>
              <ArrowRight size={14} aria-hidden="true" />
            </a>
          )}
        </header>

        <form className={styles.form} onSubmit={handleSubmit}>
          {/* Cozy Illustrated Hero Banner */}
          <section className={styles.heroCard} aria-labelledby="create-heading">
            <HeroSquadIllustration />
            <div className={styles.heroText}>
              <span className={styles.heroBadge}>飞奔赶来开黑中</span>
              <h1 id="create-heading" className={styles.title}>
                今晚约谁一起玩？
              </h1>
              <p className={styles.subtitle}>
                选好游戏和备选晚上，把车票链接丢进群里自动凑齐人。
              </p>
            </div>
          </section>

          {/* 2x2 Illustrated Game Sticker Cards */}
          <section className={styles.sectionCard} aria-label="选择游戏">
            <h2 className={styles.sectionTitle}>玩哪一款？</h2>

            <div className={styles.gameGrid} role="radiogroup" aria-label="游戏预设">
              {GAME_PRESETS.map((preset) => {
                const selected = gameTag === preset.tag;
                return (
                  <button
                    key={preset.tag}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`${styles.gameTile} ${selected ? styles.gameTileActive : ''}`}
                    onClick={() => selectGamePreset(preset)}
                  >
                    <GameStickerArt game={preset.tag} size={86} />
                    <span className={styles.gameLabel}>{preset.label}</span>
                    <span className={styles.gameHint}>{preset.hint}</span>
                  </button>
                );
              })}
            </div>

            <div className={styles.titleInputWrap}>
              <label htmlFor={titleId} className={styles.inputLabel}>
                房间标题
              </label>
              <input
                ref={titleInputRef}
                id={titleId}
                type="text"
                maxLength={32}
                value={title}
                placeholder="输入想玩的游戏或活动名称，如：双人成行～"
                className={styles.input}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setGameTag('custom');
                  setErrorMsg(null);
                }}
                onKeyDown={handleTitleKeyDown}
              />
            </div>
          </section>

          {/* Tear-off Mini Calendars & Evening Window */}
          <section className={styles.sectionCard} aria-label="选择备选时间">
            <div className={styles.labelRow}>
              <h2 className={styles.sectionTitle}>挑哪几个晚上？</h2>
              <span className={`${styles.hint} tabular`}>已选 {selectedDates.length} 晚</span>
            </div>

            <div className={styles.dateGrid} role="group" aria-label="候选日期">
              {dateOptions.map((opt) => {
                const active = selectedDates.includes(opt.dateKey);
                return (
                  <button
                    key={opt.dateKey}
                    type="button"
                    aria-pressed={active}
                    className={`${styles.calCard} ${active ? styles.calCardActive : ''} ${
                      opt.isWeekend ? styles.calWeekend : ''
                    }`}
                    onClick={() => toggleDate(opt.dateKey)}
                  >
                    <span className={styles.calTop}>
                      <span>{opt.weekdayLabel}</span>
                      {active && <Check size={10} strokeWidth={3} aria-hidden="true" />}
                    </span>
                    <span className={styles.calBody}>
                      <span className={`${styles.calDay} tabular`}>{opt.dayNumber}</span>
                      <span className={`${styles.calSub} tabular`}>{opt.monthDayLabel}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.windowRow}>
              <label htmlFor={startId} className={styles.timeCard}>
                <span className={styles.timeCardLabel}>最早几点开</span>
                <select
                  id={startId}
                  className={`${styles.select} tabular`}
                  value={startHour}
                  onChange={(e) => setStartHour(Number(e.target.value))}
                >
                  {START_HOUR_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </label>

              <span className={styles.windowArrow} aria-hidden="true">
                <ArrowRight size={16} />
              </span>

              <label htmlFor={endId} className={styles.timeCard}>
                <span className={styles.timeCardLabel}>最晚玩到</span>
                <select
                  id={endId}
                  className={`${styles.select} tabular`}
                  value={endHour}
                  onChange={(e) => setEndHour(Number(e.target.value))}
                >
                  {END_HOUR_OPTIONS.map((opt) => (
                    <option key={opt.hour} value={opt.hour}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {/* Squad Size & Duration */}
          <section className={styles.sectionCard} aria-label="发车门槛">
            <div className={styles.field}>
              <span className={styles.sectionTitle}>几人凑齐发车？</span>
              <div className={styles.playersRow}>
                <div className={styles.stepper}>
                  <button
                    type="button"
                    className={styles.stepperBtn}
                    aria-label="减少人数"
                    disabled={targetPlayers <= 2}
                    onClick={() => setTargetPlayers((p) => Math.max(2, p - 1))}
                  >
                    <Minus size={16} aria-hidden="true" />
                  </button>
                  <span className={`${styles.stepperValue} tabular`}>{targetPlayers} 人</span>
                  <button
                    type="button"
                    className={styles.stepperBtn}
                    aria-label="增加人数"
                    disabled={targetPlayers >= 10}
                    onClick={() => setTargetPlayers((p) => Math.min(10, p + 1))}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>

                <div className={styles.seatDotsPreview} aria-hidden="true">
                  {Array.from({ length: targetPlayers }).map((_, idx) => {
                    const tone = getAvatarTone(`seat-${idx}`);
                    return (
                      <span
                        key={idx}
                        className={styles.miniSeatDot}
                        style={{
                          backgroundColor: tone.bg,
                          borderColor: tone.border,
                          color: tone.ink,
                        }}
                      >
                        {idx + 1}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.sectionTitle}>至少连玩多久？</span>
              <div className={styles.durationPills} role="group" aria-label="最短游玩时长">
                {DURATION_PRESETS.map((d) => (
                  <button
                    key={d.slots}
                    type="button"
                    aria-pressed={durationSlots === d.slots}
                    className={`${styles.durationPill} ${
                      durationSlots === d.slots ? styles.durationPillActive : ''
                    } tabular`}
                    onClick={() => {
                      setDurationSlots(d.slots);
                      setErrorMsg(null);
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Sticky Thumb-Zone Bottom CTA */}
          <div className={styles.bottomDock}>
            {errorMsg && (
              <p className={styles.errorBanner} role="alert">
                <AlertCircle size={15} aria-hidden="true" />
                <span>{errorMsg}</span>
              </p>
            )}
            <button type="submit" className={styles.submitBtn} disabled={isSubmitting}>
              <Sparkles size={16} aria-hidden="true" />
              <span>{isSubmitting ? '正在印刷车票…' : '生成开黑车票'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
