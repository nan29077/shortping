import { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, FlaskConical, ImagePlus, Plus, Trophy } from 'lucide-react';
import { api, count } from '../api';
import { useConfirm } from '../confirm';
import './serial.css';
import { asset } from '../platform';

// 썸네일 A/B 비교(공개 중인 작품 전용): 후보 이미지를 시청자마다 나눠 보여 주고 클릭률로 대표 포스터를 고릅니다.
type Thumb = {
  id: string;
  url: string;
  impressions: number;
  clicks: number;
  active: number;
  winner: number;
  created_at: string;
};
const MAX_ACTIVE = 4;
const MAX_IMAGE_MB = 10;
const ctr = (t: Thumb) =>
  Number(t.impressions) > 0 ? (Number(t.clicks) / Number(t.impressions)) * 100 : 0;

export default function ThumbAB({
  dramaId,
  poster,
  candidates = [],
  notify,
  onPosterChanged,
}: {
  dramaId: string;
  poster: string;
  // 회차 장면·AI 포스터처럼 PD가 방금 만든 이미지(비교 후보로 바로 넣을 수 있어요)
  candidates?: string[];
  notify: (s: string) => void;
  onPosterChanged?: () => void;
}) {
  const [list, setList] = useState<Thumb[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [ask, confirmUi] = useConfirm();
  const load = useCallback(async () => {
    try {
      setList(await api<Thumb[]>(`/studio/dramas/${dramaId}/thumbnails`));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [dramaId]);
  useEffect(() => {
    void load();
  }, [load]);
  const active = (list || []).filter((t) => Number(t.active));
  const running = active.length >= 2;
  const lastWinner = (list || [])
    .filter((t) => Number(t.winner))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const leader =
    running && active.some((t) => Number(t.impressions) > 0)
      ? [...active].sort((a, b) => ctr(b) - ctr(a))[0]
      : null;
  // 이미 비교 중인 이미지와 지금 포스터(비교를 시작하면 자동으로 들어가요)는 후보 목록에서 뺍니다.
  const offer = [...new Set(candidates)].filter(
    (u) => !active.some((t) => t.url === u) && u !== poster,
  );
  const slots = MAX_ACTIVE - (active.length || 1);
  const add = async (url: string) => {
    setBusy(true);
    try {
      await api(`/studio/dramas/${dramaId}/thumbnails`, 'POST', { url });
      await load();
      notify(
        active.length
          ? '비교 후보에 넣었어요.'
          : '썸네일 비교를 시작했어요. 지금 포스터와 새 이미지를 시청자에게 나눠 보여 줘요.',
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (f: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
      return notify('JPG, PNG, WEBP 이미지만 올릴 수 있어요.');
    if (f.size > MAX_IMAGE_MB * 1024 * 1024)
      return notify(`이미지는 ${MAX_IMAGE_MB}MB 이하로 올려 주세요.`);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', f);
      const r = await api<{ url: string }>('/studio/upload', 'POST', form);
      setBusy(false);
      await add(r.url);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const finish = async (t?: Thumb) => {
    const ok = await ask(
      t
        ? {
            title: '이 이미지로 확정할까요?',
            text: '고른 이미지를 대표 포스터로 바꾸고 비교를 끝내요. 끝낸 비교는 다시 이어 갈 수 없어요.',
            ok: '대표 포스터로 확정',
          }
        : {
            title: '지금 결과로 끝낼까요?',
            text: '지금까지 클릭률이 가장 높은 이미지를 대표 포스터로 바꾸고 비교를 끝내요. 노출이 적으면 결과가 우연일 수 있어요.',
            ok: '비교 끝내기',
            danger: true,
          },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/studio/dramas/${dramaId}/thumbnails/finish`, 'POST', t ? { id: t.id } : {});
      await load();
      onPosterChanged?.();
      notify('대표 포스터를 바꾸고 썸네일 비교를 끝냈어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="thumb-ab" aria-label="썸네일 A/B 비교">
      {confirmUi}
      <div className="thumb-ab-head">
        <div>
          <strong>
            <FlaskConical size={15} /> 썸네일 A/B 비교
          </strong>
          <p className="muted">
            후보 이미지를 시청자마다 나눠 보여 주고, 눌러 들어온 비율(클릭률)이 가장 높은 이미지를
            대표 포스터로 써요. 후보마다 노출이 충분히 쌓이면 자동으로 끝나요.
          </p>
        </div>
        {running ? (
          <span className="serial-chip approved">비교 중</span>
        ) : (
          <span className="serial-chip draft">비교 전</span>
        )}
      </div>
      {error && (
        <p className="review-alert" role="alert">
          {error}{' '}
          <button type="button" className="secondary compact" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {list && active.length > 0 && (
        <div className="thumb-ab-grid">
          {active.map((t, i) => (
            <article key={t.id} className={leader?.id === t.id ? 'leading' : ''}>
              <div className="thumb-ab-img">
                <img src={asset(t.url)} alt={`썸네일 후보 ${String.fromCharCode(65 + i)}`} />
                <b>{String.fromCharCode(65 + i)}</b>
                {leader?.id === t.id && (
                  <span className="thumb-ab-lead">
                    <Crown size={11} /> 앞서는 중
                  </span>
                )}
              </div>
              <dl>
                <div>
                  <dt>클릭률</dt>
                  <dd>{Number(t.impressions) ? ctr(t).toFixed(1) + '%' : '-'}</dd>
                </div>
                <div>
                  <dt>노출 · 클릭</dt>
                  <dd>
                    {count(t.impressions)} · {count(t.clicks)}
                  </dd>
                </div>
              </dl>
              {t.url === poster && <small className="muted">지금 대표 포스터</small>}
              <button
                type="button"
                className="secondary compact"
                disabled={busy || !running}
                onClick={() => void finish(t)}
              >
                이 이미지로 확정
              </button>
            </article>
          ))}
        </div>
      )}
      {list && active.length === 1 && (
        <p className="muted">
          후보가 한 장뿐이라 아직 나눠 보여 주지 않아요. 이미지를 한 장 더 넣어 주세요.
        </p>
      )}
      {list && !active.length && (
        <p className="muted">
          이미지를 넣으면 지금 대표 포스터와 함께 비교를 시작해요. 최대 {MAX_ACTIVE}장까지 비교할 수
          있어요.
          {lastWinner && ' 지난 비교에서 고른 이미지가 지금 대표 포스터예요.'}
        </p>
      )}
      {slots > 0 && (
        <div className="thumb-ab-add">
          {offer.length > 0 && (
            <>
              <small>방금 만든 이미지로 후보 추가</small>
              <div className="thumb-ab-offer">
                {offer.slice(0, 6).map((u) => (
                  <button
                    key={u}
                    type="button"
                    disabled={busy}
                    onClick={() => void add(u)}
                    title="비교 후보에 넣기"
                  >
                    <img src={asset(u)} alt="후보로 넣을 이미지" />
                    <span>
                      <Plus size={12} /> 후보로
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <input
            ref={file}
            type="file"
            hidden
            accept="image/jpeg,image/png,image/webp"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              ev.target.value = '';
              if (f) void upload(f);
            }}
          />
          <button
            type="button"
            className="secondary compact"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            <ImagePlus size={13} /> 이미지 올려 후보 추가
          </button>
          <small className="muted">
            {active.length
              ? `${slots}장 더 넣을 수 있어요.`
              : '회차 ‘포스터 후보’나 ‘AI 포스터 만들기’로 만든 이미지도 넣을 수 있어요.'}
          </small>
        </div>
      )}
      {running && (
        <div className="form-actions start">
          <button
            type="button"
            className="secondary compact"
            disabled={busy}
            onClick={() => void finish()}
          >
            <Trophy size={13} /> 지금 결과로 끝내기
          </button>
        </div>
      )}
    </section>
  );
}
