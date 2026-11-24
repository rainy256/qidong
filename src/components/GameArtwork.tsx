import { useState } from 'react';
import type { GameTag } from '../domain/types';
import styles from './GameArtwork.module.css';

export function inferGameTag(title: string, explicit?: GameTag): GameTag {
  if (explicit) return explicit;
  const lower = title.toLowerCase();
  if (lower.includes('apex')) return 'apex';
  if (lower.includes('gta')) return 'gta';
  if (title.includes('塔科夫') || title.includes('塔可夫') || lower.includes('tarkov')) return 'tarkov';
  return 'custom';
}

export function HeroSquadIllustration() {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <div className={styles.heroWrap}>
      <img
        src="/art/hero-runner.png?v=2"
        alt="飞奔赶来开黑的小伙伴"
        loading="eager"
        decoding="async"
        className={styles.heroImg}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

type GameStickerArtProps = Readonly<{
  game: GameTag;
  size?: number;
}>;

export function GameStickerArt({ game, size = 76 }: GameStickerArtProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={styles.stickerWrap}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {!failed ? (
        <img
          src={`/art/game-${game}.png?v=3`}
          alt=""
          width={size}
          height={size}
          loading="eager"
          decoding="async"
          className={styles.stickerImg}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={styles.fallbackBadge}>{game.toUpperCase()}</span>
      )}
    </div>
  );
}
