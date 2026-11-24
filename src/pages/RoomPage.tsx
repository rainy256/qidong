import { Lock, Plus, RefreshCw, Sparkles, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  NotFoundError,
  RevisionConflictError,
  RoomClosedError,
  type RoomRepository,
} from '../api/repository';
import { CloseRoomDialog } from '../components/CloseRoomDialog';
import { CopyAction } from '../components/CopyAction';
import { NightEditor } from '../components/NightEditor';
import { RecommendationCard } from '../components/RecommendationCard';
import { RosterDisclosure } from '../components/RosterDisclosure';
import { formatSyncClock } from '../domain/time';
import type { Answer, ConnectionState, RoomSnapshot } from '../domain/types';
import styles from './RoomPage.module.css';

type RoomPageProps = Readonly<{
  roomId: string;
  justCreated: boolean;
  repository: RoomRepository;
  denyClipboard: boolean;
  onNavigate: (path: string) => void;
  onRoomLoaded: (snapshot: RoomSnapshot | null) => void;
}>;

export function RoomPage({
  roomId,
  justCreated,
  repository,
  denyClipboard,
  onNavigate,
  onRoomLoaded,
}: RoomPageProps) {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('live');

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; isConflict: boolean } | null>(null);
  const [showCreatedBanner, setShowCreatedBanner] = useState(justCreated);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    onRoomLoaded(snapshot);
  }, [onRoomLoaded, snapshot]);

  const loadRoom = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    setLoadError(null);
    const ac = new AbortController();
    try {
      const snap = await repository.getRoom(roomId, ac.signal);
      setSnapshot(snap);
      setConnectionState('live');
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (err instanceof NotFoundError) {
        setNotFound(true);
        setSnapshot(null);
      } else {
        setLoadError((err as Error).message || '加载失败，请重试。');
      }
    } finally {
      setLoading(false);
    }
  }, [repository, roomId]);

  useEffect(() => {
    setShowCreatedBanner(justCreated);
    setSaveError(null);
    void loadRoom();
  }, [justCreated, loadRoom]);

  useEffect(() => {
    if (!snapshot || snapshot.id !== roomId) return;
    const unsub = repository.subscribe(roomId, snapshot.roomRevision, {
      onSnapshot: (incoming) => {
        setSnapshot((prev) => {
          if (!prev || prev.id !== roomId) return incoming;
          const viewerChanged =
            incoming.viewer.memberId !== prev.viewer.memberId ||
            incoming.viewer.canClose !== prev.viewer.canClose ||
            incoming.viewer.mineRevision !== prev.viewer.mineRevision;
          if (incoming.roomRevision < prev.roomRevision && !viewerChanged) {
            return prev;
          }
          if (incoming.roomRevision === prev.roomRevision && !viewerChanged) {
            return prev;
          }
          return incoming;
        });
      },
      onConnection: (state) => {
        setConnectionState(state);
      },
    });
    return unsub;
  }, [repository, roomId, snapshot?.id]);

  const inviteUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/r/${roomId}`
      : `https://yueju.example/r/${roomId}`;

  const handleSaveMine = async (nickname: string, answer: Answer): Promise<boolean> => {
    if (!snapshot) return false;
    setIsSaving(true);
    setSaveError(null);
    const mutationId = `save_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      const updated = await repository.saveMine(roomId, {
        nickname,
        answer,
        baseMineRevision: snapshot.viewer.mineRevision,
        mutationId,
      });
      setSnapshot(updated);
      setIsSaving(false);
      return true;
    } catch (err) {
      setIsSaving(false);
      if (err instanceof RevisionConflictError) {
        setSaveError({ message: err.message, isConflict: true });
      } else if (err instanceof RoomClosedError) {
        setSaveError({ message: err.message, isConflict: false });
        void loadRoom();
      } else {
        setSaveError({
          message: (err as Error).message || '保存失败，草稿仍保留在本地，请重试。',
          isConflict: false,
        });
      }
      return false;
    }
  };

  const handleConfirmClose = async () => {
    if (!snapshot || isClosing) return;
    setIsClosing(true);
    const mutationId = `close_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const updated = await repository.closeRoom(roomId, mutationId);
      setSnapshot(updated);
      setCloseDialogOpen(false);
    } catch (err) {
      setSaveError({
        message: (err as Error).message || '关闭收集失败，请重试。',
        isConflict: false,
      });
      setCloseDialogOpen(false);
    } finally {
      setIsClosing(false);
    }
  };

  const scrollToEditor = () => {
    document.getElementById('time-picker')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (loading && !snapshot) {
    return (
      <div className={styles.page}>
        <div className={styles.mobileStage}>
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCardTall} />
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyStateShell}>
          <h1 className={styles.notFoundTitle}>找不到这张开黑车票</h1>
          <p className={styles.notFoundDesc}>可能链接复制不完整，或者小房间已经过期啦。</p>
          <button type="button" className={styles.backHomeBtn} onClick={() => onNavigate('/')}>
            去发一张新车票
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot && loadError) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyStateShell}>
          <h1 className={styles.notFoundTitle}>暂时打不开房间</h1>
          <p className={styles.notFoundDesc}>{loadError}</p>
          <button type="button" className={styles.backHomeBtn} onClick={() => void loadRoom()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot) return null;

  const isClosed = snapshot.closedAt !== null;
  const earliestStart = snapshot.nights[0]?.from ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.mobileStage}>
        {/* Compact Mobile Top Utility Strip */}
        <header className={styles.topUtility}>
          <span className={styles.brandWord}>
            <Sparkles size={14} className={styles.brandSpark} aria-hidden="true" />
            <span>约局车票</span>
          </span>

          <a
            href="/"
            className={styles.newRoomLink}
            onClick={(e) => {
              e.preventDefault();
              onNavigate('/');
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>发起新车队</span>
          </a>
        </header>

        {showCreatedBanner && (
          <div className={styles.createdTip} role="status">
            <div className={styles.createdTipBody}>
              <p className={styles.createdTipTitle}>车票建好啦～</p>
              <p className={styles.createdTipText}>
                把链接丢进群里即可直接填时间，下次用当前浏览器打开仍可管理。
              </p>
              <CopyAction
                text={inviteUrl}
                label="复制邀请链接"
                variant="secondary"
                denyClipboard={denyClipboard}
              />
            </div>
            <button
              type="button"
              className={styles.dismissTipBtn}
              aria-label="关闭提示"
              onClick={() => setShowCreatedBanner(false)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}

        {snapshot.viewer.canClose && !isClosed && (
          <div className={styles.ownerBar}>
            <span className={styles.ownerNote}>房主管理 · 链接可直接群发</span>
            <div className={styles.ownerActions}>
              <CopyAction
                text={inviteUrl}
                label="复制链接"
                variant="ghost"
                denyClipboard={denyClipboard}
              />
              <button
                type="button"
                className={styles.closeRoomBtn}
                onClick={() => setCloseDialogOpen(true)}
              >
                <Lock size={13} aria-hidden="true" />
                <span>结束收集</span>
              </button>
            </div>
          </div>
        )}

        {connectionState !== 'live' && (
          <div className={styles.offlineBanner} role="status">
            <WifiOff size={15} aria-hidden="true" className={styles.offlineIcon} />
            <span className="tabular">
              {connectionState === 'offline'
                ? `离线状态 · 显示 ${formatSyncClock(snapshot.syncedAt)} 同步的结果`
                : '同步重连中…'}
            </span>
            <button type="button" className={styles.retrySyncBtn} onClick={() => void loadRoom()}>
              <RefreshCw size={13} aria-hidden="true" />
              <span>刷新</span>
            </button>
          </div>
        )}

        <main className={styles.stack}>
          <RecommendationCard
            snapshot={snapshot}
            earliestStart={earliestStart}
            inviteUrl={inviteUrl}
            isOffline={connectionState === 'offline'}
            denyClipboard={denyClipboard}
            onJumpToEditor={scrollToEditor}
          />

          <NightEditor
            snapshot={snapshot}
            earliestStart={earliestStart}
            isSaving={isSaving}
            saveError={saveError}
            onSave={handleSaveMine}
            onRefreshLatest={() => {
              setSaveError(null);
              void loadRoom();
            }}
            onClearError={() => setSaveError(null)}
          />

          <RosterDisclosure
            submissions={snapshot.submissions}
            nights={snapshot.nights}
            viewerMemberId={snapshot.viewer.memberId}
          />
        </main>
      </div>

      <CloseRoomDialog
        open={closeDialogOpen}
        roomTitle={snapshot.title}
        isBusy={isClosing}
        onCancel={() => setCloseDialogOpen(false)}
        onConfirm={() => void handleConfirmClose()}
      />
    </div>
  );
}
