import { useEffect, useRef, useState } from 'react';
import { apiUrl, authHeaders, fetchCredentials } from './platform';
import {
  AlertTriangle,
  CalendarClock,
  Captions,
  Check,
  FileVideo,
  ImageIcon,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  Upload,
  X,
} from 'lucide-react';
import { api, ApiError, lama, uuid, SESSION_EXPIRED_EVENT, type Drama } from './api';
import { Modal } from './App';
import type { ManagedDrama } from './ContentReview';
import { useConfirm } from './confirm';
import { episodeNumberFrom, MAX_VIDEO_MB, uploadVideo, type UploadHandle } from './upload';
import {
  defaultReserveInput,
  EpisodeStatusChip,
  kstInputToIso,
  kstInputValue,
  kstLabel,
  nowKstInput,
} from './serial/EpisodeStatus';
import ThumbAB from './serial/ThumbAB';
import { asset } from './platform';

// 회차 관리: 여러 회차 한 번에 올리기(분할·이어 올리기), 자동 사전 점검, 자막, 포스터 후보.
// 공개 중인 작품은 연재형으로 다음 회차를 올리고 회차마다 검수를 신청합니다(원하면 공개 예약).
type QueueItem = {
  key: string;
  file: File;
  number: number;
  title: string;
  status: 'ready' | 'uploading' | 'saving' | 'done' | 'error';
  progress: number;
  error?: string;
  // 서버가 거절한 경우(400 등): 자동으로 다시 올리지 않고, 고치거나 뺄 때까지 남겨 둡니다.
  //  file  파일 자체 문제(용량·형식) → 빼야 해요
  //  input 회차 번호·제목·순서 문제 → 고치면 다시 올릴 수 있어요
  fatal?: 'file' | 'input';
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
type SerialEpisode = ManagedDrama['episodes'][number] & {
  review_status?: string;
  review_note?: string;
  publish_at?: string | null;
  submitted_at?: string | null;
};
const EDITABLE = ['draft', 'rejected'];
const tooBig = (f: File) => f.size > MAX_VIDEO_MB * 1024 * 1024;
const retryable = (q: QueueItem) =>
  q.status === 'ready' || (q.status === 'error' && !q.fatal && !tooBig(q.file));

// 회차 등록은 응답 코드(400·409)를 봐야 해서 직접 요청합니다.
async function registerEpisode(
  dramaId: string,
  body: { number: number; title: string; video: string; duration: number },
) {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/studio/dramas/${dramaId}/episodes`), {
      method: 'POST',
      credentials: fetchCredentials,
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: '서버에 연결할 수 없어요. 네트워크 상태를 확인해 주세요.',
    };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return {
    ok: res.ok,
    status: res.status,
    error: String(data.error || '회차를 등록하지 못했어요.'),
  };
}

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
    [editing, setEditing] = useState<{
      number: number;
      title: string;
      video: string;
      duration: number;
    } | null>(null),
    [removeNumber, setRemoveNumber] = useState<number | null>(null),
    [frames, setFrames] = useState<string[] | null>(null),
    // 공개 작품에서 만든 장면·AI 포스터(썸네일 비교 후보)
    [pool, setPool] = useState<string[]>([]),
    [submitFor, setSubmitFor] = useState<{ number: number; reserve: boolean; at: string } | null>(
      null,
    ),
    [scheduleFor, setScheduleFor] = useState<{ number: number; at: string } | null>(null),
    [dragging, setDragging] = useState(false),
    [loadError, setLoadError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const subtitleFor = useRef<number>(0);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const [ask, confirmUi] = useConfirm();
  // 모달을 닫으면 AI 도구 결과 확인(폴링)을 멈춥니다.
  const alive = useRef(true);
  const load = async () => {
    try {
      setDetail(await api<ManagedDrama>('/studio/dramas/' + d.id));
      setLoadError('');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, [d.id]);
  const published = detail?.status === 'published';
  const episodes = (detail?.episodes || []) as SerialEpisode[];
  const statusOf = (e?: SerialEpisode) => e?.review_status || 'approved';
  // 이 회차를 고칠 수 있는지(작품이 임시저장·반려이거나, 공개 작품의 공개 전 회차)
  const editable = (e?: SerialEpisode) =>
    published ? !!e && EDITABLE.includes(statusOf(e)) : true;
  // 아직 올리지 않은 항목끼리 회차 번호가 겹치면 뒤 파일이 앞 파일을 덮어쓰므로 올리기 전에 막습니다.
  const duplicates = new Set(
    queue
      .filter((q) => q.status !== 'done')
      .map((q) => q.number)
      .filter((n, i, all) => all.indexOf(n) !== i),
  );
  const nextNumber = () =>
    Math.max(0, ...episodes.map((e) => e.number), ...queue.map((q) => q.number)) + 1;
  // 공개 작품에서 이미 공개됐거나 검수 중인 회차 번호는 새 파일로 바꿀 수 없어요.
  const blocked = (n: number) =>
    published && episodes.some((e) => e.number === n && !EDITABLE.includes(statusOf(e)));
  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter(
      (f) => f.type === 'video/mp4' || f.name.toLowerCase().endsWith('.mp4'),
    );
    if (!list.length) {
      notify('MP4 영상 파일을 선택해 주세요.');
      return;
    }
    const taken = new Set([...episodes.map((e) => e.number), ...queue.map((q) => q.number)]);
    let fallback = nextNumber();
    const items = list
      .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
      .map((file) => {
        let number = episodeNumberFrom(file.name) ?? 0;
        if (!number || queue.some((q) => q.number === number) || blocked(number)) {
          while (taken.has(fallback)) fallback++;
          number = fallback;
        }
        taken.add(number);
        const big = tooBig(file);
        return {
          key: uuid(),
          file,
          number,
          title: `${number}화`,
          status: big ? 'error' : 'ready',
          progress: 0,
          fatal: big ? 'file' : undefined,
          error: big
            ? `${MAX_VIDEO_MB}MB를 넘는 파일이라 올릴 수 없어요. 용량을 줄인 뒤 다시 넣어 주세요.`
            : undefined,
        } as QueueItem;
      });
    setQueue((prev) => [...prev, ...items]);
  };
  const patch = (key: string, value: Partial<QueueItem>) =>
    setQueue((prev) => prev.map((q) => (q.key === key ? { ...q, ...value } : q)));
  // 번호·제목을 고치면 서버가 거절했던 항목도 다시 올릴 수 있어요(용량 초과는 제외).
  const edit = (q: QueueItem, value: Partial<QueueItem>) =>
    patch(
      q.key,
      q.fatal === 'input'
        ? { ...value, status: 'ready', fatal: undefined, error: undefined }
        : value,
    );
  const runQueue = async () => {
    if (running) return;
    if (duplicates.size)
      return notify('대기열에 같은 회차 번호가 있어요. 번호를 고친 뒤 올려 주세요.');
    setRunning(true);
    abort.current = new AbortController();
    let ok = 0;
    for (const item of queue.filter(retryable)) {
      if (blocked(item.number)) {
        patch(item.key, {
          status: 'error',
          fatal: 'input',
          error: `${item.number}화는 이미 공개됐거나 검수 중이라 바꿀 수 없어요. 회차 번호를 고쳐 주세요.`,
        });
        continue;
      }
      patch(item.key, { status: 'uploading', error: undefined });
      let result;
      try {
        result = await uploadVideo(item.file, (progress) => patch(item.key, { progress }), {
          signal: abort.current.signal,
          handle: item.handle,
          onHandle: (handle) => patch(item.key, { handle }),
        });
      } catch (e) {
        // 서버가 파일을 거절한 경우(형식·용량 등)는 다시 올려도 같아서 자동 재시도에서 뺍니다.
        const rejected = e instanceof ApiError && e.code !== 'network' && e.code !== 'unauthorized';
        patch(item.key, {
          status: 'error',
          error: (e as Error).message,
          fatal: rejected ? 'file' : undefined,
          ...(rejected ? { handle: undefined } : {}),
        });
        if (abort.current.signal.aborted) break;
        continue;
      }
      patch(item.key, { status: 'saving', progress: 1, warnings: result.warnings });
      const r = await registerEpisode(d.id, {
        number: item.number,
        title: item.title.trim() || `${item.number}화`,
        video: result.url,
        duration: Math.max(1, result.duration),
      });
      if (r.ok) {
        patch(item.key, { status: 'done' });
        ok++;
      } else {
        // 400(입력 오류)·409(순서·상태 문제)는 번호나 제목을 고쳐야 해서 자동으로 다시 시도하지 않아요.
        patch(item.key, {
          status: 'error',
          error: r.error,
          fatal: r.status === 400 || r.status === 409 ? 'input' : undefined,
        });
      }
      if (abort.current.signal.aborted) break;
    }
    setRunning(false);
    await load();
    if (ok)
      notify(
        published
          ? `${ok}개 회차를 올렸어요. 회차마다 ‘검수 신청’을 눌러 공개를 요청해 주세요.`
          : `${ok}개 회차를 등록했어요.`,
      );
  };
  const locked = !!detail && !['draft', 'rejected', 'published'].includes(detail.status);
  const last = episodes.length ? Math.max(...episodes.map((e) => e.number)) : 0;
  // 업로드 영상용 AI 도구(라마 사용): 작업을 걸고 끝날 때까지 기다립니다.
  const [toolBusy, setToolBusy] = useState('');
  const aiTool = async (
    key: string,
    path: string,
    body: Record<string, unknown>,
    done: (output: { url?: string }) => Promise<void> | void,
  ) => {
    setToolBusy(key);
    try {
      const r = await api<{ id: string; lama: number }>(path, 'POST', body);
      notify(`AI가 작업을 시작했어요. 최대 ${lama(r.lama)}가 예약돼요.`);
      for (let i = 0; i < 600; i++) {
        await new Promise((x) => setTimeout(x, 1500));
        if (!alive.current) return;
        const j = await api<{
          status: string;
          error: string;
          output: { url?: string };
          charged_lama: number;
        }>('/studio/ai/tools/jobs/' + r.id);
        if (!alive.current) return;
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
      notify('AI 작업이 아직 진행 중이에요. 잠시 후 회차 관리를 다시 열어 결과를 확인해 주세요.');
    } catch (e) {
      const message = (e as Error).message;
      notify(
        message.includes('약관')
          ? '숏핑 스튜디오(AI 드라마 제작) 메뉴에서 이용 약관에 먼저 동의해 주세요.'
          : message,
      );
    } finally {
      if (alive.current) setToolBusy('');
    }
  };
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      notify(message);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submitEpisode = async () => {
    if (!submitFor) return;
    let publishAt: string | null = null;
    if (submitFor.reserve) {
      publishAt = kstInputToIso(submitFor.at);
      if (!publishAt) return notify('공개 예약 날짜와 시각을 입력해 주세요.');
      if (new Date(publishAt).getTime() <= Date.now())
        return notify('공개 예약 시각은 지금보다 뒤로 정해 주세요.');
    }
    const n = submitFor.number;
    const ok = await act(
      () => api(`/studio/dramas/${d.id}/episodes/${n}/submit`, 'POST', { publish_at: publishAt }),
      publishAt
        ? `${n}화 검수를 신청했어요. 승인되면 ${kstLabel(publishAt)}에 공개돼요.`
        : `${n}화 검수를 신청했어요. 승인되면 바로 공개돼요.`,
    );
    if (ok) setSubmitFor(null);
  };
  const saveSchedule = async (e: SerialEpisode, at: string | null) => {
    const n = e.number;
    let publishAt: string | null = null;
    if (at !== null) {
      publishAt = kstInputToIso(at);
      if (!publishAt) return notify('공개 예약 날짜와 시각을 입력해 주세요.');
      if (new Date(publishAt).getTime() <= Date.now())
        return notify('공개 예약 시각은 지금보다 뒤로 정해 주세요.');
    } else if (statusOf(e) === 'scheduled') {
      const go = await ask({
        title: '예약을 지우고 바로 공개할까요?',
        text: `${n}화는 이미 승인됐어요. 예약을 지우면 지금 바로 시청자에게 공개돼요.`,
        ok: '바로 공개',
      });
      if (!go) return;
    }
    const ok = await act(
      () =>
        api(`/studio/dramas/${d.id}/episodes/${n}/schedule`, 'PATCH', { publish_at: publishAt }),
      publishAt
        ? `${n}화 공개 예약을 ${kstLabel(publishAt)}로 바꿨어요.`
        : statusOf(e) === 'scheduled'
          ? `${n}화 예약을 지우고 바로 공개했어요.`
          : `${n}화 공개 예약을 지웠어요. 승인되면 바로 공개돼요.`,
    );
    if (ok) setScheduleFor(null);
  };
  const canQueue = queue.some(retryable);
  const hasRetry = queue.some((q) => q.status === 'error' && retryable(q));
  return (
    <Modal
      title={d.title + ' · 회차 관리'}
      className="episode-manager"
      close={() => {
        if (!running && !busy) close();
      }}
    >
      {confirmUi}
      {loadError && (
        <p role="alert" className="review-alert">
          {loadError}
          <button className="secondary compact" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {locked && (
        <div className="info-box">
          {detail?.status === 'pending'
            ? '작품 심사 중에는 회차를 바꿀 수 없어요. 심사가 끝나면 다시 열어 주세요.'
            : '노출이 중단된 작품은 회차를 바꿀 수 없어요.'}
        </div>
      )}
      {published && (
        <div className="info-box serial-info">
          <CalendarClock size={16} />
          <span>
            <b>연재 중인 작품이에요.</b> 공개된 회차는 바꿀 수 없어요. 다음 회차({last + 1}화)를
            올린 뒤 ‘검수 신청’을 누르면 관리자 확인 후 바로, 또는 예약한 시각에 공개돼요.
          </span>
        </div>
      )}
      {detail && episodes.length > 0 && (
        <div className="episode-list">
          {episodes.map((e) => {
            const rs = statusOf(e);
            const canEdit = !locked && editable(e);
            return (
              <div
                key={e.id}
                className={'episode-item' + (published && rs !== 'approved' ? ' serial-' + rs : '')}
              >
                <div className="episode-item-head">
                  <FileVideo size={16} />
                  <strong>
                    {e.number}화 · {e.title}
                  </strong>
                  {published && <EpisodeStatusChip status={rs} publishAt={e.publish_at} />}
                  <span className={'source-chip ' + (e.source || 'upload')}>
                    {e.source === 'studio' ? 'AI 스튜디오' : '업로드'}
                  </span>
                  <small>
                    {e.duration}초{e.width ? ` · ${e.width}×${e.height}` : ''}
                  </small>
                </div>
                {published && rs === 'rejected' && (
                  <p className="serial-note" role="note">
                    <AlertTriangle size={12} /> 반려 사유:{' '}
                    {e.review_note || '관리자가 사유를 남기지 않았어요.'} · 고친 뒤 다시 검수를
                    신청해 주세요.
                  </p>
                )}
                {published && rs === 'pending' && (
                  <p className="serial-note muted">
                    관리자가 회차를 검토하고 있어요.
                    {e.publish_at
                      ? ` 승인되면 ${kstLabel(e.publish_at)}에 공개돼요.`
                      : ' 승인되면 바로 공개돼요.'}
                  </p>
                )}
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
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={busy || running}
                          onClick={() =>
                            setEditing({
                              number: e.number,
                              title: e.title,
                              video: e.video,
                              duration: e.duration,
                            })
                          }
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
                                () =>
                                  api(
                                    `/studio/dramas/${d.id}/episodes/${e.number}/subtitles`,
                                    'DELETE',
                                  ),
                                `${e.number}화 자막을 지웠어요.`,
                              )
                            }
                          >
                            자막 삭제
                          </button>
                        )}
                        {!published && !e.has_subtitles && e.source !== 'studio' && (
                          <button
                            type="button"
                            className="secondary compact"
                            disabled={busy || running || !!toolBusy}
                            title="음성 인식 AI로 대사를 받아 자막을 만들어요 (라마 사용)"
                            onClick={() =>
                              void aiTool(
                                'sub' + e.number,
                                '/studio/ai/tools/subtitles',
                                { dramaId: d.id, number: e.number },
                                () => load(),
                              )
                            }
                          >
                            <Wand2 size={13} />{' '}
                            {toolBusy === 'sub' + e.number ? '자막 만드는 중…' : 'AI 자동 자막'}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={busy || running}
                      title={
                        published ? '영상 장면을 뽑아 썸네일 비교 후보로 쓸 수 있어요' : undefined
                      }
                      onClick={() =>
                        void act(
                          async () => {
                            const r = await api<{ frames: string[] }>(
                              '/studio/media/frames',
                              'POST',
                              { video: e.video },
                            );
                            if (published) setPool((prev) => [...r.frames, ...prev].slice(0, 12));
                            else setFrames(r.frames);
                          },
                          published
                            ? '장면 이미지를 만들었어요. 아래 썸네일 비교에서 후보로 넣을 수 있어요.'
                            : '포스터 후보를 만들었어요. 마음에 드는 장면을 고르세요.',
                        )
                      }
                    >
                      <ImageIcon size={13} /> {published ? '장면 뽑기' : '포스터 후보'}
                    </button>
                    {published && EDITABLE.includes(rs) && (
                      <button
                        type="button"
                        className="primary compact"
                        disabled={busy || running}
                        onClick={() => {
                          setScheduleFor(null);
                          setSubmitFor({
                            number: e.number,
                            reserve: !!e.publish_at,
                            at: e.publish_at ? kstInputValue(e.publish_at) : defaultReserveInput(),
                          });
                        }}
                      >
                        <Send size={13} /> {rs === 'rejected' ? '다시 검수 신청' : '검수 신청'}
                      </button>
                    )}
                    {published && ['pending', 'scheduled'].includes(rs) && (
                      <>
                        <button
                          type="button"
                          className="secondary compact"
                          disabled={busy || running}
                          onClick={() => {
                            setSubmitFor(null);
                            setScheduleFor({
                              number: e.number,
                              at: e.publish_at
                                ? kstInputValue(e.publish_at)
                                : defaultReserveInput(),
                            });
                          }}
                        >
                          <CalendarClock size={13} /> {e.publish_at ? '예약 바꾸기' : '공개 예약'}
                        </button>
                        {e.publish_at && (
                          <button
                            type="button"
                            className="secondary compact"
                            disabled={busy || running}
                            onClick={() => void saveSchedule(e, null)}
                          >
                            {rs === 'scheduled' ? '예약 지우고 바로 공개' : '예약 지우기'}
                          </button>
                        )}
                      </>
                    )}
                    {e.number === last && (!published || rs !== 'approved') && (
                      <button
                        type="button"
                        className="secondary compact"
                        aria-label={`${e.number}화 삭제`}
                        disabled={busy || running}
                        onClick={() => setRemoveNumber(e.number)}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                )}
                {submitFor?.number === e.number && (
                  <form
                    className="serial-form"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void submitEpisode();
                    }}
                  >
                    <strong>{e.number}화 검수 신청</strong>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={submitFor.reserve}
                        onChange={(ev) =>
                          setSubmitFor({ ...submitFor, reserve: ev.target.checked })
                        }
                      />
                      <span>공개 예약 (승인돼도 정한 시각까지 기다렸다가 공개해요)</span>
                    </label>
                    {submitFor.reserve && (
                      <label>
                        공개 시각 (한국 시간)
                        <input
                          type="datetime-local"
                          required
                          min={nowKstInput()}
                          value={submitFor.at}
                          onChange={(ev) => setSubmitFor({ ...submitFor, at: ev.target.value })}
                        />
                      </label>
                    )}
                    <p className="muted">
                      {submitFor.reserve
                        ? '예약 시각 전에 승인되면 그 시각에, 예약 시각이 지나서 승인되면 승인 즉시 공개돼요.'
                        : '관리자가 승인하면 바로 시청자에게 공개돼요.'}
                    </p>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setSubmitFor(null)}
                      >
                        취소
                      </button>
                      <button className="primary" disabled={busy}>
                        <Send size={15} /> 검수 신청
                      </button>
                    </div>
                  </form>
                )}
                {scheduleFor?.number === e.number && (
                  <form
                    className="serial-form"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void saveSchedule(e, scheduleFor.at);
                    }}
                  >
                    <label>
                      {e.number}화 공개 시각 (한국 시간)
                      <input
                        type="datetime-local"
                        required
                        min={nowKstInput()}
                        value={scheduleFor.at}
                        onChange={(ev) => setScheduleFor({ ...scheduleFor, at: ev.target.value })}
                      />
                    </label>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setScheduleFor(null)}
                      >
                        취소
                      </button>
                      <button className="primary" disabled={busy}>
                        <CalendarClock size={15} /> 예약 저장
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
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
            title={
              published
                ? '작품 정보로 AI 포스터를 만들어 썸네일 비교 후보로 보여줘요 (라마 사용)'
                : '작품 정보로 AI 포스터를 만들어 후보로 보여줘요 (라마 사용)'
            }
            onClick={() =>
              void aiTool('poster', '/studio/ai/tools/poster', { dramaId: d.id }, (out) => {
                const url = out.url;
                if (!url || !alive.current) return;
                // 기다리는 동안 새로 만든 후보가 사라지지 않게 최신 값에 더합니다.
                if (published)
                  setPool((prev) => [url, ...prev.filter((x) => x !== url)].slice(0, 12));
                else
                  setFrames((prev) => [url, ...(prev || []).filter((x) => x !== url)].slice(0, 6));
              })
            }
          >
            <Wand2 size={13} />{' '}
            {toolBusy === 'poster' ? 'AI 포스터 만드는 중…' : 'AI 포스터 만들기'}
          </button>
        </div>
      )}
      {frames && !published && (
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
                <img src={asset(f)} alt="영상 장면 포스터 후보" />
              </button>
            ))}
          </div>
          <button type="button" className="text-link" onClick={() => setFrames(null)}>
            닫기
          </button>
        </div>
      )}
      {published && detail && (
        <ThumbAB
          dramaId={d.id}
          poster={asset(detail.image)}
          candidates={pool}
          notify={notify}
          onPosterChanged={() => void load()}
        />
      )}
      {removeNumber !== null && (
        <div className="review-alert">
          {removeNumber}화 등록을 삭제할까요?{' '}
          {published ? '검수 신청과 공개 예약도 함께 취소돼요. ' : ''}원본 파일은 유지됩니다.
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
      {!locked && detail && (
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
              if (!running) addFiles(ev.dataTransfer.files);
            }}
          >
            <Upload size={27} />
            <strong>
              {published
                ? `다음 회차(${last + 1}화부터) 올리기`
                : '회차 영상 여러 개를 한 번에 올리기'}
            </strong>
            <small>
              H.264 MP4 · 세로 9:16 권장 · 회차당 최대 {MAX_VIDEO_MB}MB · 파일 이름의 “03화”,
              “EP03”로 회차를 자동 인식해요
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
              {duplicates.size > 0 && (
                <p className="danger" role="alert">
                  <AlertTriangle size={13} /> 같은 회차 번호(
                  {[...duplicates].sort((a, b) => a - b).join(', ')}화)가 대기열에 두 번 이상
                  있어요. 번호를 고친 뒤 올려 주세요.
                </p>
              )}
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
                        aria-invalid={duplicates.has(q.number) || blocked(q.number) || undefined}
                        disabled={q.status !== 'ready' && q.status !== 'error'}
                        onChange={(ev) => edit(q, { number: Number(ev.target.value) || 1 })}
                      />
                    </label>
                    <label className="grow">
                      제목
                      <input
                        value={q.title}
                        maxLength={100}
                        disabled={q.status !== 'ready' && q.status !== 'error'}
                        onChange={(ev) => edit(q, { title: ev.target.value })}
                      />
                    </label>
                    {(q.status === 'ready' || q.status === 'error') && !running && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={q.file.name + ' 빼기'}
                        title="대기열에서 빼기"
                        onClick={() => setQueue((prev) => prev.filter((x) => x.key !== q.key))}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <small className="upload-file">
                    {q.file.name} · {(q.file.size / 1024 / 1024).toFixed(1)}MB ·{' '}
                    <b>{q.status === 'error' && q.fatal ? '올릴 수 없음' : statusText[q.status]}</b>
                    {q.status === 'done' && <Check size={12} />}
                    {q.status === 'ready' &&
                      blocked(q.number) &&
                      ' · 공개됐거나 검수 중인 회차 번호예요'}
                    {q.status === 'ready' &&
                      !blocked(q.number) &&
                      episodes.some((e) => e.number === q.number) &&
                      ' · 기존 회차를 교체해요'}
                  </small>
                  {(q.status === 'uploading' || q.status === 'saving') && (
                    <div
                      className="progress"
                      aria-label={`${q.number}화 업로드 ${Math.round(q.progress * 100)}%`}
                    >
                      <span style={{ width: `${Math.round(q.progress * 100)}%` }} />
                    </div>
                  )}
                  {q.error && (
                    <small className="danger">
                      {q.error}
                      {q.fatal === 'input'
                        ? ' · 번호나 제목을 고치면 다시 올릴 수 있어요. 필요 없으면 X로 빼 주세요.'
                        : q.fatal === 'file'
                          ? ' · 이 파일은 올릴 수 없어요. X로 빼 주세요.'
                          : ''}
                    </small>
                  )}
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
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => abort.current?.abort()}
                  >
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
                  disabled={running || duplicates.size > 0 || !canQueue}
                  onClick={() => void runQueue()}
                >
                  {hasRetry ? <RotateCcw size={15} /> : <Upload size={15} />}
                  {running ? '올리는 중…' : hasRetry ? '이어서 올리기' : '모두 올리기'}
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
            업로드가 끊기면 ‘이어서 올리기’로 멈춘 지점부터 다시 올려요.{' '}
            {published
              ? '새 회차는 ‘검수 신청’을 눌러야 관리자에게 전달돼요.'
              : '회차 등록 후 작품 목록에서 심사를 요청하세요.'}
          </p>
        </>
      )}
    </Modal>
  );
}
