import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  Captions,
  Check,
  ChevronDown,
  ChevronUp,
  Film,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { aiUsageLabel, api, moment } from '../api';
import { kstLabel, useSerialToast } from './EpisodeStatus';
import './serial.css';
import { asset } from '../platform';

// 관리자 · 회차 검수: 이미 공개된 작품에 새로 올라온 회차를 하나씩 확인하고 승인·반려합니다.
export type ReviewEpisode = {
  id: string;
  drama_id: string;
  number: number;
  title: string;
  video: string;
  duration: number;
  source: 'upload' | 'studio';
  review_status: string;
  review_note: string;
  submitted_at: string | null;
  publish_at: string | null;
  has_subtitles: number;
  drama_title: string;
  drama_image: string;
  ai_usage: string | null;
  owner_name: string;
  owner_id: string;
};

export default function EpisodeReviewQueue({
  dramaId,
  notify,
  onChanged,
  embedded = false,
}: {
  // 한 작품의 회차만 보여 줄 때(작품 검토창 안)
  dramaId?: string;
  notify?: (s: string) => void;
  onChanged?: (remaining: number) => void;
  embedded?: boolean;
}) {
  const [items, setItems] = useState<ReviewEpisode[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [local, toastUi] = useSerialToast();
  const say = notify || local;
  const load = useCallback(async () => {
    try {
      const all = await api<ReviewEpisode[]>('/admin/episodes/review');
      const list = dramaId ? all.filter((e) => e.drama_id === dramaId) : all;
      setItems(list);
      setError('');
      setOpen((cur) =>
        cur && list.some((e) => e.id === cur) ? cur : dramaId ? (list[0]?.id ?? null) : null,
      );
      return list;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [dramaId]);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (e: ReviewEpisode, status: 'approved' | 'rejected') => {
    const note = (notes[e.id] || '').trim();
    if (status === 'rejected' && !note) {
      say('반려 사유를 입력해 주세요.');
      return;
    }
    setBusy(e.id);
    try {
      const r = await api<{ ok: boolean; status: 'approved' | 'scheduled' | 'rejected' }>(
        `/admin/episodes/${e.id}/review`,
        'POST',
        { status, note },
      );
      const name = `${e.drama_title} ${e.number}화`;
      say(
        r.status === 'rejected'
          ? `${name}를 반려했어요. PD에게 사유를 알려 드렸어요.`
          : r.status === 'scheduled'
            ? `${name}를 승인했어요. ${kstLabel(e.publish_at)}에 공개돼요.`
            : `${name}를 승인했어요. 지금 시청자에게 공개됐어요.`,
      );
      setNotes((x) => {
        const next = { ...x };
        delete next[e.id];
        return next;
      });
      const list = await load();
      if (list) onChanged?.(list.length);
    } catch (err) {
      say((err as Error).message);
      await load();
    } finally {
      setBusy('');
    }
  };
  if (dramaId && items && !items.length && !error) return null;
  const body = (
    <>
      {error && (
        <p className="review-alert" role="alert">
          {error}{' '}
          <button className="secondary compact" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {!items && !error && <p className="muted">회차 검수 목록을 불러오는 중…</p>}
      {items && !items.length && (
        <p className="muted serial-empty">
          검수를 기다리는 회차가 없어요. 공개된 작품에 새 회차가 올라오면 여기에 보여요.
        </p>
      )}
      <div className="serial-queue">
        {items?.map((e) => {
          const ai = e.source === 'studio' || (!!e.ai_usage && e.ai_usage !== 'none');
          const expanded = open === e.id;
          return (
            <article key={e.id} className={'serial-queue-item' + (expanded ? ' open' : '')}>
              <button
                type="button"
                className="serial-queue-head"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : e.id)}
              >
                <img src={asset(e.drama_image)} alt="" />
                <span className="serial-queue-title">
                  <strong>
                    {e.drama_title} · {e.number}화
                  </strong>
                  <small>
                    {e.title} · {e.duration}초 · {e.owner_name} PD
                  </small>
                  <span className="serial-queue-tags">
                    {ai && (
                      <span
                        className="source-chip studio"
                        title={aiUsageLabel[e.ai_usage || 'none']}
                      >
                        <Sparkles size={10} /> AI 제작
                      </span>
                    )}
                    {!!e.has_subtitles && (
                      <span className="source-chip">
                        <Captions size={10} /> 자막
                      </span>
                    )}
                    {e.publish_at && (
                      <span className="serial-chip scheduled">
                        <CalendarClock size={10} /> {kstLabel(e.publish_at)} 공개 예약
                      </span>
                    )}
                    {e.submitted_at && <small>신청 {moment(e.submitted_at)}</small>}
                  </span>
                </span>
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {expanded && (
                <div className="serial-queue-body">
                  <div className="serial-queue-video">
                    <video
                      key={e.id}
                      controls
                      playsInline
                      preload="metadata"
                      poster={asset(e.drama_image)}
                      src={asset(`/api/play/${e.drama_id}/${e.number}`)}
                    >
                      {e.has_subtitles ? (
                        <track
                          kind="subtitles"
                          srcLang="ko"
                          label="한국어"
                          default
                          src={asset(`/api/subtitles/${e.drama_id}/${e.number}`)}
                        />
                      ) : null}
                    </video>
                  </div>
                  <div className="serial-queue-decision">
                    <dl>
                      <div>
                        <dt>제작 출처</dt>
                        <dd>{e.source === 'studio' ? '숏핑 스튜디오 AI 제작' : '직접 업로드'}</dd>
                      </div>
                      <div>
                        <dt>작품 AI 사용 신고</dt>
                        <dd>{aiUsageLabel[e.ai_usage || 'none'] || e.ai_usage}</dd>
                      </div>
                      <div>
                        <dt>공개 시점</dt>
                        <dd>
                          {e.publish_at
                            ? `${kstLabel(e.publish_at)} 예약 공개`
                            : '승인하면 바로 공개'}
                        </dd>
                      </div>
                      {e.review_note && (
                        <div>
                          <dt>이전 반려 사유</dt>
                          <dd>{e.review_note}</dd>
                        </div>
                      )}
                    </dl>
                    <label>
                      검토 의견 · 반려 시 필수
                      <textarea
                        value={notes[e.id] || ''}
                        maxLength={1000}
                        rows={3}
                        placeholder="고쳐야 할 장면과 이유를 구체적으로 적어 주세요."
                        onChange={(ev) => setNotes((x) => ({ ...x, [e.id]: ev.target.value }))}
                      />
                    </label>
                    <div className="form-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!!busy || !(notes[e.id] || '').trim()}
                        onClick={() => void decide(e, 'rejected')}
                      >
                        <X size={16} /> 반려
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={!!busy}
                        onClick={() => void decide(e, 'approved')}
                      >
                        <Check size={16} />{' '}
                        {busy === e.id
                          ? '처리 중…'
                          : e.publish_at
                            ? '승인 · 예약대로 공개'
                            : '승인 · 바로 공개'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {toastUi}
    </>
  );
  if (embedded)
    return (
      <div className="serial-embedded">
        <h3>
          <Film size={16} /> 회차 검수 <span className="serial-count">{items?.length ?? 0}</span>
        </h3>
        <p className="muted">
          공개 중인 작품에 새로 올라온 회차예요. 회차마다 영상을 확인하고 승인하거나 반려해 주세요.
        </p>
        {body}
      </div>
    );
  return (
    <section className="management-panel serial-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">EPISODE REVIEW</span>
          <h3>
            회차 검수 <span className="serial-count">{items?.length ?? 0}</span>
          </h3>
          <p>연재 중인 작품의 새 회차예요. 승인하면 바로(예약이 있으면 예약한 시각에) 공개돼요.</p>
        </div>
        <button className="secondary compact" onClick={() => void load()}>
          <RefreshCw size={14} /> 새로고침
        </button>
      </div>
      {body}
    </section>
  );
}
