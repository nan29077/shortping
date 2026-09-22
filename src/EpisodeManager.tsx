import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Captions,
  Check,
  FileVideo,
  ImageIcon,
  Pencil,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  Upload,
  X,
} from 'lucide-react';
import { api, lama, type Drama } from './api';
import { Modal } from './App';
import type { ManagedDrama } from './ContentReview';
import { episodeNumberFrom, MAX_VIDEO_MB, uploadVideo, type UploadHandle } from './upload';

// 회차 관리: 여러 회차 한 번에 올리기(분할·이어 올리기), 자동 사전 점검, 자막, 포스터 후보.
type QueueItem = {
  key: string;
  file: File;
  number: number;
  title: string;
  status: 'ready' | 'uploading' | 'saving' | 'done' | 'error';
  progress: number;
  error?: string;
  warnings?: string[];
  handle?: UploadHandle;
};
const statusText: Record<QueueItem['status'], string> = {
  ready: '대기',
  uploading: '업로드 중',
  saving: '검사·등록 중',
  done: '등록 완료',
  error: '실패',
};

export default function EpisodeManager({
  d,
  demo,
  notify,
  close,
}: {
  d: Drama;
  demo: boolean;
  notify: (s: string) => void;
  close: () => void;
}) {
  const [detail, setDetail] = useState<ManagedDrama | null>(null),
    [queue, setQueue] = useState<QueueItem[]>([]),
    [running, setRunning] = useState(false),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<{ number: number; title: string; video: string; duration: number } | null>(null),
    [removeNumber, setRemoveNumber] = useState<number | null>(null),
    [frames, setFrames] = useState<string[] | null>(null),
    [dragging, setDragging] = useState(false),
    [loadError, setLoadError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const subtitleFor = useRef<number>(0);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const load = async () => {
    try {
      setDetail(await api<ManagedDrama>('/studio/dramas/' + d.id));
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [d.id]);
  const nextNumber = () =>
    Math.max(0, ...(detail?.episodes.map((e) => e.number) || []), ...queue.map((q) => q.number)) + 1;
  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type === 'video/mp4' || f.name.toLowerCase().endsWith('.mp4'));
    if (!list.length) {
      notify('MP4 영상 파일을 선택해 주세요.');
      return;
    }
    const taken = new Set([...(detail?.episodes.map((e) => e.number) || []), ...queue.map((q) => q.number)]);
    let fallback = nextNumber();
    const items = list
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
      .map((file) => {
        let number = episodeNumberFrom(file.name) ?? 0;
        if (!number || queue.some((q) => q.number === number)) {
          while (taken.has(fallback)) fallback++;
          number = fallback;
        }
        taken.add(number);
        const tooBig = file.size > MAX_VIDEO_MB * 1024 * 1024;
        return {
          key: crypto.randomUUID(),
          file,
          number,
          title: `${number}화`,
          status: tooBig ? 'error' : 'ready',
          progress: 0,
          error: tooBig ? `${MAX_VIDEO_MB}MB를 넘는 파일이에요.` : undefined,
        } as QueueItem;
      });
    setQueue((prev) => [...prev, ...items]);
  };
  const patch = (key: string, value: Partial<QueueItem>) =>
    setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, ...value } : q)));
  const runQueue = async () => {
    if (running) return;
    setRunning(true);
    abort.current = new AbortController();
    let ok = 0;
    for (const item of queue.filter((q) => q.status === 'ready' || q.status === 'error')) {
      if (item.file.size > MAX_VIDEO_MB * 1024 * 1024) continue;
      patch(item.key, { status: 'uploading', error: undefined });
      try {
        const result = await uploadVideo(item.file, (progress) => patch(item.key, { progress }), {
          signal: abort.current.signal,
          handle: item.handle,
          onHandle: (handle) => patch(item.key, { handle }),
        });
        patch(item.key, { status: 'saving', progress: 1, warnings: result.warnings });
        await api('/studio/dramas/' + d.id + '/episodes', 'POST', {
          number: item.number,
          title: item.title.trim() || `${item.number}화`,
          video: result.url,
          duration: Math.max(1, result.duration),
        });
        patch(item.key, { status: 'done' });
        ok++;
      } catch (e) {
        patch(item.key, { status: 'error', error: (e as Error).message });
        if (abort.current.signal.aborted) break;
      }
    }
    setRunning(false);
    await load();
    if (ok) notify(`${ok}개 회차를 등록했어요.`);
  };
  const locked = !!detail && !['draft', 'rejected'].includes(detail.status);
  const last = detail?.episodes.length ? Math.max(...detail.episodes.map((e) => e.number)) : 0;
  // 업로드 영상용 AI 도구(라마 사용): 작업을 걸고 끝날 때까지 기다립니다.
  const [toolBusy, setToolBusy] = useState('');
  const aiTool = async (key: string, path: string, body: Record<string, unknown>, done: (output: { url?: string }) => Promise<void> | void) => {
    setToolBusy(key);
    try {
      const r = await api<{ id: string; lama: number }>(path, 'POST', body);
      notify(`AI가 작업을 시작했어요. 최대 ${lama(r.lama)}가 예약돼요.`);
      for (let i = 0; i < 600; i++) {
        await new Promise((x) => setTimeout(x, 1500));
        const j = await api<{ status: string; error: string; output: { url?: string }; charged_lama: number }>('/studio/ai/tools/jobs/' + r.id);
        if (j.status === 'succeeded') {
          await done(j.output);
          notify(`완료했어요. ${lama(j.charged_lama)}를 썼어요.`);
          return;
        }
        if (j.status === 'failed' || j.status === 'canceled') {
          notify('AI 작업이 실패해 라마를 돌려드렸어요. ' + (j.error || ''));
          return;
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      notify(message.includes('약관') ? '숏핑 스튜디오(AI 드라마 제작) 메뉴에서 이용 약관에 먼저 동의해 주세요.' : message);
    } finally {
      setToolBusy('');
    }
  };
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={d.title + ' · 회차 관리'}
      className="episode-manager"
      close={() => {
        if (!running && !busy) close();
      }}
    >
      {loadError && (
        <p role="alert" className="review-alert">
          {loadError}
          <button className="secondary compact" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {locked && <div className="info-box">심사 중이거나 공개된 작품은 회차를 바꿀 수 없어요.</div>}
      {detail && detail.episodes.length > 0 && (
        <div className="episode-list">
          {detail.episodes.map((e) => (
            <div key={e.id} className="episode-item">
              <div className="episode-item-head">
                <FileVideo size={16} />
                <strong>
                  {e.number}화 · {e.title}
                </strong>
                <span className={'source-chip ' + (e.source || 'upload')}>
                  {e.source === 'studio' ? 'AI 스튜디오' : '업로드'}
                </span>
                <small>
                  {e.duration}초{e.width ? ` · ${e.width}×${e.height}` : ''}
                </small>
              </div>
              {!!e.warnings?.length && (
                <ul className="precheck-list">
                  {e.warnings.map((w) => (
                    <li key={w}>
                      <AlertTriangle size={12} /> {w}
                    </li>
                  ))}
                </ul>
              )}
              {!locked && (
                <div className="episode-item-tools">
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={busy || running}
                    onClick={() => setEditing({ number: e.number, title: e.title, video: e.video, duration: e.duration })}
                  >
                    <Pencil size={13} /> 제목
                  </button>
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={busy || running}
                    onClick={() => {
                      subtitleFor.current = e.number;
                      subtitleInput.current?.click();
                    }}
                  >
                    <Captions size={13} /> {e.has_subtitles ? '자막 교체' : '자막 올리기'}
                  </button>
                  {!!e.has_subtitles && (
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={busy || running}
                      onClick={() =>
                        void act(
                          () => api(`/studio/dramas/${d.id}/episodes/${e.number}/subtitles`, 'DELETE'),
                          `${e.number}화 자막을 지웠어요.`,
                        )
                      }
                    >
                      자막 삭제
                    </button>
                  )}
                  {!e.has_subtitles && e.source !== 'studio' && (
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={busy || running || !!toolBusy}
                      title="음성 인식 AI로 대사를 받아 자막을 만들어요 (라마 사용)"
                      onClick={() =>
                        void aiTool('sub' + e.number, '/studio/ai/tools/subtitles', { dramaId: d.id, number: e.number }, () => load())
                      }
                    >
                      <Wand2 size={13} /> {toolBusy === 'sub' + e.number ? '자막 만드는 중…' : 'AI 자동 자막'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={busy || running}
                    onClick={() =>
                      void act(async () => {
                        const r = await api<{ frames: string[] }>('/studio/media/frames', 'POST', { video: e.video });
                        setFrames(r.frames);
                      }, '포스터 후보를 만들었어요. 마음에 드는 장면을 고르세요.')
                    }
                  >
                    <ImageIcon size={13} /> 포스터 후보
                  </button>
                  {e.number === last && (
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={busy || running}
                      onClick={() => setRemoveNumber(e.number)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <input
        ref={subtitleInput}
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={async (ev) => {
          const file = ev.target.files?.[0];
          ev.target.value = '';
          if (!file) return;
          if (file.size > 190 * 1024) {
            notify('자막 파일은 190KB 이하로 올려 주세요.');
            return;
          }
          const text = await file.text();
          const n = subtitleFor.current;
          await act(
            () => api(`/studio/dramas/${d.id}/episodes/${n}/subtitles`, 'POST', { text }),
            `${n}화 자막을 등록했어요.`,
          );
        }}
      />
      {!locked && detail && (
        <div className="form-actions start ai-tools-row">
          <button
            type="button"
            className="secondary compact"
            disabled={!!toolBusy || busy}
            title="작품 정보로 AI 포스터를 만들어 후보로 보여줘요 (라마 사용)"
            onClick={() =>
              void aiTool('poster', '/studio/ai/tools/poster', { dramaId: d.id }, (out) => {
                if (out.url) setFrames([out.url, ...(frames || [])].slice(0, 6));
              })
            }
          >
            <Wand2 size={13} /> {toolBusy === 'poster' ? 'AI 포스터 만드는 중…' : 'AI 포스터 만들기'}
          </button>
        </div>
      )}
      {frames && (
        <div className="frame-picker">
          <strong>포스터로 쓸 장면을 고르세요</strong>
          <div>
            {frames.map((f) => (
              <button
                key={f}
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api('/studio/dramas/' + d.id + '/poster', 'PUT', { image: f });
                    setFrames(null);
                  }, '작품 포스터를 바꿨어요.')
                }
              >
                <img src={f} alt="영상 장면 포스터 후보" />
              </button>
            ))}
          </div>
          <button type="button" className="text-link" onClick={() => setFrames(null)}>
            닫기
          </button>
        </div>
      )}
      {removeNumber !== null && (
        <div className="review-alert">
          {removeNumber}화 등록을 삭제할까요? 원본 파일은 유지됩니다.
          <div className="form-actions">
            <button className="secondary" disabled={busy} onClick={() => setRemoveNumber(null)}>
              취소
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api('/studio/dramas/' + d.id + '/episodes/' + removeNumber, 'DELETE');
                  setRemoveNumber(null);
                }, '회차 등록을 삭제했어요.')
              }
            >
              회차 삭제 확인
            </button>
          </div>
        </div>
      )}
      {editing && (
        <form
          className="episode-title-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            void act(async () => {
              await api('/studio/dramas/' + d.id + '/episodes', 'POST', editing);
              setEditing(null);
            }, `${editing.number}화 제목을 저장했어요.`);
          }}
        >
          <label>
            {editing.number}화 제목
            <input
              value={editing.title}
              maxLength={100}
              required
              onChange={(ev) => setEditing({ ...editing, title: ev.target.value })}
            />
          </label>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              취소
            </button>
            <button className="primary" disabled={busy}>
              저장
            </button>
          </div>
        </form>
      )}
      {detail?.issues.length ? <div className="info-box">{detail.issues.join(' ')}</div> : null}
      {!locked && (
        <>
          <label
            className={'video-drop' + (dragging ? ' dragging' : '')}
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(ev) => {
              ev.preventDefault();
              setDragging(false);
              addFiles(ev.dataTransfer.files);
            }}
          >
            <Upload size={27} />
            <strong>회차 영상 여러 개를 한 번에 올리기</strong>
            <small>
              H.264 MP4 · 세로 9:16 권장 · 회차당 최대 {MAX_VIDEO_MB}MB · 파일 이름의 “03화”, “EP03”로 회차를
              자동 인식해요
            </small>
            <input
              type="file"
              accept="video/mp4"
              multiple
              disabled={running}
              onChange={(ev) => {
                if (ev.target.files) addFiles(ev.target.files);
                ev.target.value = '';
              }}
            />
          </label>
          {queue.length > 0 && (
            <div className="upload-queue">
              {queue.map((q) => (
                <div key={q.key} className={'upload-row ' + q.status}>
                  <div className="upload-row-main">
                    <label>
                      회차
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={q.number}
                        disabled={q.status !== 'ready' && q.status !== 'error'}
                        onChange={(ev) => patch(q.key, { number: Number(ev.target.value) || 1 })}
                      />
                    </label>
                    <label className="grow">
                      제목
                      <input
                        value={q.title}
                        maxLength={100}
                        disabled={q.status !== 'ready' && q.status !== 'error'}
                        onChange={(ev) => patch(q.key, { title: ev.target.value })}
                      />
                    </label>
                    {q.status === 'ready' && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={q.file.name + ' 빼기'}
                        onClick={() => setQueue((prev) => prev.filter((x) => x.key !== q.key))}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <small className="upload-file">
                    {q.file.name} · {(q.file.size / 1024 / 1024).toFixed(1)}MB ·{' '}
                    <b>{statusText[q.status]}</b>
                    {q.status === 'done' && <Check size={12} />}
                    {detail?.episodes.some((e) => e.number === q.number) && q.status === 'ready' &&
                      ' · 기존 회차를 교체해요'}
                  </small>
                  {(q.status === 'uploading' || q.status === 'saving') && (
                    <div className="progress" aria-label={`${q.number}화 업로드 ${Math.round(q.progress * 100)}%`}>
                      <span style={{ width: `${Math.round(q.progress * 100)}%` }} />
                    </div>
                  )}
                  {q.error && <small className="danger">{q.error}</small>}
                  {!!q.warnings?.length && (
                    <ul className="precheck-list">
                      {q.warnings.map((w) => (
                        <li key={w}>
                          <AlertTriangle size={12} /> {w}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
              <div className="form-actions">
                {running ? (
                  <button type="button" className="secondary" onClick={() => abort.current?.abort()}>
                    업로드 멈추기
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setQueue((prev) => prev.filter((q) => q.status !== 'done'))}
                  >
                    완료 항목 지우기
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={running || !queue.some((q) => q.status === 'ready' || q.status === 'error')}
                  onClick={() => void runQueue()}
                >
                  {queue.some((q) => q.status === 'error') ? <RotateCcw size={15} /> : <Upload size={15} />}
                  {running ? '올리는 중…' : queue.some((q) => q.status === 'error') ? '이어서 올리기' : '모두 올리기'}
                </button>
              </div>
            </div>
          )}
          {demo && (
            <button
              className="secondary full"
              type="button"
              disabled={running || busy}
              onClick={() =>
                void act(
                  () =>
                    api('/studio/dramas/' + d.id + '/episodes', 'POST', {
                      number: last + 1,
                      title: `${last + 1}화`,
                      video: '/demo/preview.mp4',
                      duration: 12,
                    }),
                  `${last + 1}화에 개발용 샘플 영상을 등록했어요.`,
                )
              }
            >
              <Sparkles size={15} /> 개발용 샘플로 {last + 1}화 추가
            </button>
          )}
          <p className="demo-footnote">
            업로드가 끊기면 ‘이어서 올리기’로 멈춘 지점부터 다시 올려요. 회차 등록 후 작품 목록에서 심사를
            요청하세요.
          </p>
        </>
      )}
    </Modal>
  );
}
