import styles from './MascotBadge.module.css';

export type MascotMood = 'create' | 'waiting' | 'happy' | 'closed';

type MascotBadgeProps = Readonly<{
  mood: MascotMood;
  size?: number;
}>;

export function MascotBadge({ mood, size = 56 }: MascotBadgeProps) {
  const bgTint =
    mood === 'happy'
      ? '#EEF1FF'
      : mood === 'waiting'
        ? '#FFF6D4'
        : mood === 'closed'
          ? '#F7EFE5'
          : '#FFF0ED';

  const ringTint =
    mood === 'happy'
      ? '#C4CCFA'
      : mood === 'waiting'
        ? '#F2C65A'
        : mood === 'closed'
          ? '#DFCFC0'
          : '#FFC4BA';

  return (
    <div
      className={`${styles.badge} ${mood === 'happy' || mood === 'create' ? styles.bob : ''}`}
      style={{ width: size, height: size, backgroundColor: bgTint, borderColor: ringTint }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={size - 6} height={size - 6} fill="none">
        {/* Soft crown for closed */}
        {mood === 'closed' && (
          <path
            d="M22 15 L25 7 L32 12 L39 7 L42 15 Z"
            fill="#FFD464"
            stroke="#C78A1B"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        )}

        {/* Cute round ears */}
        <circle cx="20" cy="19" r="6" fill="#FFFFFF" stroke="#4D3D36" strokeWidth="2.4" />
        <circle cx="44" cy="19" r="6" fill="#FFFFFF" stroke="#4D3D36" strokeWidth="2.4" />
        <circle cx="20" cy="19.5" r="2.8" fill="#FFB3A7" />
        <circle cx="44" cy="19.5" r="2.8" fill="#FFB3A7" />

        {/* Plump mochi body */}
        <rect
          x="13"
          y="17"
          width="38"
          height="34"
          rx="18"
          fill="#FFFFFF"
          stroke="#4D3D36"
          strokeWidth="2.5"
        />

        {/* Rosy cheeks */}
        <ellipse cx="21" cy="36" rx="4.2" ry="2.4" fill="#FFB3A7" opacity="0.85" />
        <ellipse cx="43" cy="36" rx="4.2" ry="2.4" fill="#FFB3A7" opacity="0.85" />

        {/* Eyes & mouth by mood */}
        {mood === 'happy' ? (
          <>
            <path
              d="M22 31 Q24.5 27.5 27 31"
              stroke="#4D3D36"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M37 31 Q39.5 27.5 42 31"
              stroke="#4D3D36"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M28 35 Q32 40 36 35"
              stroke="#4D3D36"
              strokeWidth="2.4"
              strokeLinecap="round"
              fill="#FF8C7A"
            />
          </>
        ) : mood === 'waiting' ? (
          <>
            <circle cx="24" cy="30.5" r="2.4" fill="#4D3D36" />
            <circle cx="24.8" cy="29.6" r="0.8" fill="#FFFFFF" />
            <path
              d="M37 31 Q39.5 28 42 31"
              stroke="#4D3D36"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <path
              d="M29.5 35.5 Q32 37.8 34.5 35.5"
              stroke="#4D3D36"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </>
        ) : mood === 'closed' ? (
          <>
            <path
              d="M22 30.5 Q24.5 33 27 30.5"
              stroke="#4D3D36"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <path
              d="M37 30.5 Q39.5 33 42 30.5"
              stroke="#4D3D36"
              strokeWidth="2.3"
              strokeLinecap="round"
            />
            <path
              d="M29.5 35.5 Q32 38 34.5 35.5"
              stroke="#4D3D36"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </>
        ) : (
          <>
            <circle cx="24.5" cy="30.5" r="2.5" fill="#4D3D36" />
            <circle cx="39.5" cy="30.5" r="2.5" fill="#4D3D36" />
            <circle cx="25.3" cy="29.6" r="0.85" fill="#FFFFFF" />
            <circle cx="40.3" cy="29.6" r="0.85" fill="#FFFFFF" />
            <path
              d="M29 35.2 Q32 38.4 35 35.2"
              stroke="#4D3D36"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </>
        )}

        {/* Little decorative sparkle / heart */}
        {mood === 'create' && (
          <path
            d="M52 13 C52 10.8 49 10.5 48.2 12.6 C47.4 10.5 44.4 10.8 44.4 13 C44.4 15.6 48.2 18.2 48.2 18.2 C48.2 18.2 52 15.6 52 13 Z"
            fill="#FF7D6B"
          />
        )}
        {mood === 'happy' && (
          <>
            <path
              d="M11 10 L12.3 13 L15.3 14.3 L12.3 15.6 L11 18.6 L9.7 15.6 L6.7 14.3 L9.7 13 Z"
              fill="#5563DE"
            />
            <path
              d="M54 11 L55 13.4 L57.4 14.4 L55 15.4 L54 17.8 L53 15.4 L50.6 14.4 L53 13.4 Z"
              fill="#FF7D6B"
            />
          </>
        )}
        {mood === 'waiting' && (
          <path
            d="M53 12 L54.2 14.8 L57 16 L54.2 17.2 L53 20 L51.8 17.2 L49 16 L51.8 14.8 Z"
            fill="#F2A922"
          />
        )}
      </svg>
    </div>
  );
}
