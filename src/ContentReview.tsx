import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Captions,
  Check,
  FileVideo,
  Film,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { Modal } from './App';
import { aiUsageLabel, api, jobKindLabel, type Drama, type Episode } from './api';
import EpisodeManager from './EpisodeManager';
import EpisodeReviewQueue from './serial/EpisodeReviewQueue';
import { EpisodeStatusChip, useSerialToast } from './serial/EpisodeStatus';
import { asset } from './platform';

// 관리자 · 회차 심사 목록(연재형 공개). 콘텐츠 · 심사 화면에서 바로 쓸 수 있게 여기서도 내보냅니다.
export { EpisodeReviewQueue };

export type ManagedDrama = Drama & {
  owner_name: string;
  // 연재형 공개: review_status(approved·draft·pending·rejected·scheduled), review_note, publish_at
  episodes: (Episode & {
    video: string;
    review_status?: string;
    review_note?: string;
    publish_at?: string | null;
    submitted_at?: string | null;
  })[];
  issues: string[];
  // 구버전 로컬 서버가 아직 떠 있는 상태에서도 심사 모달이 깨지지 않도록 선택값으로 받습니다.
  thumbnails?: { id: string; url: string; active: number; reviewed: number }[];
  reviews: { id: string; name: string; status: string; note: string; created_at: string }[];
};
type Provenance = {
  models: {
    kind: string;
    model_label: string | null;
    provider_name: string | null;
    country: string | null;
    jobs: number;
    lama: number;
  }[];
};
export const reviewStatus: Record<string, string> = {
  pending: '심사 요청',
  published: '승인 · 공개',
  rejected: '반려',
};

export default function ContentReview({
  drama,
  admin,
  close,
  onReviewed,
}: {
  drama: Drama;
  admin: boolean;
  close: () => void;
  onReviewed: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ManagedDrama | null>(null);
  const [error, setError] = useState('');
  const [number, setNumber] = useState(1);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [loaded, setLoaded] = useState<number[]>([]);
  const [checked, setChecked] = useState(false);
  const [posterReady, setPosterReady] = useState(false);
  const [thumbnailReady, setThumbnailReady] = useState<string[]>([]);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  // PD: 공개 중인 작품의 회차 관리(연재) 창과 안내 문구
  const [manage, setManage] = useState(false);
  const [demo, setDemo] = useState(false);
  const [say, toastUi] = useSerialToast();
  async function load() {
    try {
      const d = await api<ManagedDrama>('/studio/dramas/' + drama.id);
      const normalized = { ...d, thumbnails: Array.isArray(d.thumbnails) ? d.thumbnails : [] };
      setDetail(normalized);
      setError('');
      if (d.episodes.some((e) => e.source === 'studio'))
        setProvenance(
          await api<Provenance>('/studio/dramas/' + drama.id + '/provenance').catch(() => null),
        );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [drama.id]);
  const reviewing = admin && detail?.status === 'pending';
  const serial = detail?.status === 'published';
  const pendingEpisodes = detail?.episodes.filter((e) => e.review_status === 'pending').length || 0;
  const openManager = async () => {
    const config = await api<{ demo?: boolean }>('/config').catch(() => null);
    setDemo(!!config?.demo);
    setManage(true);
  };
  const episode = detail?.episodes.find((e) => e.number === number);
  // 서버가 확인한 회차: 올릴 때 분석한 길이·가로세로가 있는 영상(개발용 샘플 영상은 예외)
  const serverChecked = (detail?.episodes || [])
    .filter((e) => e.video?.startsWith('/demo/') || (Number(e.duration) > 0 && Number(e.width) > 0 && Number(e.height) > 0))
    .map((e) => e.number);
  // 이 브라우저에서의 재생·이미지 표시 결과(참고용)
  const browserWarning = !detail
    ? ''
    : mediaError
      ? mediaError
      : !posterReady
        ? '이 브라우저에서 포스터 이미지를 불러오지 못했어요.'
        : (detail.thumbnails || []).some((thumb) => !thumbnailReady.includes(thumb.id))
          ? '이 브라우저에서 불러오지 못한 썸네일 후보가 있어요.'
          : '';
  async function decide(status: 'published' | 'rejected') {
    setBusy(true);
    try {
      await api('/admin/dramas/' + drama.id + '/review', 'POST', { status, note });
      await onReviewed();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={reviewing ? '작품 검토 · 심사' : '작품 미리보기'}
      close={() => {
        if (!busy && !manage) close();
      }}
      className="content-review-modal"
    >
      {error && (
        <p className="review-alert" role="alert">
          {error}{' '}
          <button className="secondary compact" onClick={() => void load()}>
            다시 확인
          </button>
        </p>
      )}
      {!detail ? (
        <p className="muted">작품 정보를 불러오는 중…</p>
      ) : (
        <>
          <div className="review-summary">
            <img
              src={asset(detail.image)}
              alt={detail.title + ' 포스터'}
              onLoad={() => setPosterReady(true)}
              onError={() => setPosterReady(false)}
            />
            <div>
              <span className="eyebrow">CONTENT INSPECTION</span>
              <h3>{detail.title}</h3>
              <p>{detail.tagline}</p>
              <dl>
                <div>
                  <dt>등록 PD</dt>
                  <dd>{detail.owner_name}</dd>
                </div>
                <div>
                  <dt>장르 · 회차</dt>
                  <dd>
                    {detail.genre} · {detail.episodes.length}화
                  </dd>
                </div>
                <div>
                  <dt>회차 가격</dt>
                  <dd>
                    {detail.free
                      ? '무료 작품'
                      : detail.episode_pings
                        ? `${detail.episode_pings}핑`
                        : '기본 핑(요금 정책)'}
                  </dd>
                </div>
                <div>
                  <dt>무료 공개</dt>
                  <dd>
                    {detail.free
                      ? '전 회차 무료'
                      : detail.episodes.length
                        ? `1~${Math.min(detail.free_episodes, detail.episodes.length)}화`
                        : '등록 회차 없음'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          {(detail.thumbnails?.length || 0) > 1 && (
            <div className="review-thumbnails">
              <strong>공개 후 비교할 썸네일 후보</strong>
              <p className="muted">작품 승인 시 아래 후보도 함께 승인되어 시청자 반응 비교에 사용됩니다.</p>
              <div className="poster-row">
                {detail.thumbnails?.map((thumb) => (
                  <img
                    key={thumb.id}
                    src={asset(thumb.url)}
                    alt="썸네일 비교 후보"
                    onLoad={() => setThumbnailReady((prev) => (prev.includes(thumb.id) ? prev : [...prev, thumb.id]))}
                    onError={() => setThumbnailReady((prev) => prev.filter((id) => id !== thumb.id))}
                  />
                ))}
              </div>
            </div>
          )}
          <p className="review-synopsis">{detail.synopsis}</p>
          {serial && !admin && (
            <div className="info-box serial-info">
              <FileVideo size={16} />
              <span>
                <b>연재 중인 작품이에요.</b> 다음 회차를 올리고 회차마다 심사를 신청할 수 있어요.
                공개 예약과 썸네일 비교도 회차 관리에서 할 수 있어요.
              </span>
              <button className="primary compact" onClick={() => void openManager()}>
                <FileVideo size={14} /> 회차 관리 · 새 회차 올리기
              </button>
            </div>
          )}
          {(() => {
            const studio = detail.episodes.filter((e) => e.source === 'studio').length;
            const source =
              studio === 0
                ? '직접 업로드'
                : studio === detail.episodes.length
                  ? '숏핑 스튜디오 AI 제작'
                  : '혼합 (업로드 + AI 제작)';
            const warned = detail.episodes.filter((e) => e.warnings?.length);
            const subs = detail.episodes.filter((e) => e.has_subtitles).length;
            return (
              <div className="provenance">
                <div>
                  <span>
                    <Sparkles size={14} /> 제작 출처
                  </span>
                  <strong>{source}</strong>
                </div>
                <div>
                  <span>
                    <ShieldCheck size={14} /> 권리 · 초상권
                  </span>
                  <strong className={Number(detail.rights_confirmed) ? '' : 'danger'}>
                    {Number(detail.rights_confirmed) ? '권리 확인' : '권리 미확인'} ·{' '}
                    {Number(detail.likeness_confirmed) ? '초상권 동의' : '초상권 미확인'}
                  </strong>
                </div>
                <div>
                  <span>AI 사용 신고</span>
                  <strong>
                    {aiUsageLabel[detail.ai_usage || 'none']}
                    {studio ? ` · 스튜디오 제작 ${studio}화` : ''}
                  </strong>
                </div>
                <div>
                  <span>
                    <Captions size={14} /> 자막
                  </span>
                  <strong>
                    {subs}/{detail.episodes.length}화
                  </strong>
                </div>
                {provenance && provenance.models.length > 0 && (
                  <div className="provenance-models">
                    <span>
                      <Sparkles size={14} /> 스튜디오 제작 이력 (사용한 AI 모델)
                    </span>
                    <ul>
                      {provenance.models.map((m, i) => (
                        <li key={i}>
                          {jobKindLabel[m.kind] || m.kind} · {m.model_label || '삭제된 모델'} (
                          {m.provider_name}
                          {m.country === 'CN' ? ' · 중국' : ''}) · {m.jobs}회
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {warned.length > 0 && (
                  <ul className="precheck-list wide">
                    {warned.flatMap((e) =>
                      (e.warnings || []).map((w) => (
                        <li key={e.id + w}>
                          <AlertTriangle size={12} /> {e.number}화: {w}
                        </li>
                      )),
                    )}
                  </ul>
                )}
              </div>
            );
          })()}
          {detail.issues.length > 0 && (
            <div className="review-alert" role="alert">
              <strong>등록 상태 확인 필요</strong>
              {detail.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          )}
          <div className="review-player-grid">
            <div className="review-video">
              {episode ? (
                <video
                  key={number}
                  controls
                  playsInline
                  preload="metadata"
                  poster={asset(detail.image)}
                  src={asset('/api/play/' + detail.id + '/' + number)}
                  onLoadedData={() => {
                    setLoaded((prev) => (prev.includes(number) ? prev : [...prev, number]));
                    setMediaError('');
                  }}
                  onError={() => {
                    setMediaError(`이 브라우저에서 ${number}화 영상을 재생하지 못했어요.`);
                    setLoaded((prev) => prev.filter((n) => n !== number));
                  }}
                >
                  {episode.has_subtitles ? (
                    <track
                      kind="subtitles"
                      srcLang="ko"
                      label="한국어"
                      default
                      src={asset(`/api/subtitles/${detail.id}/${number}`)}
                    />
                  ) : null}
                </video>
              ) : (
                <p className="muted">등록된 회차가 없습니다.</p>
              )}
              {mediaError && (
                <p className="info-box" role="status">
                  <AlertTriangle size={16} /> {mediaError} 코덱에 따라 이 브라우저만 못 여는 경우가 있어요. 승인 여부는 서버가 확인한 영상 정보로 판단해요.
                </p>
              )}
              {episode && (
                <p>
                  {number}화 · {episode.title}{' '}
                  <span>
                    {episode.duration}초{episode.video.startsWith('/demo/') ? ' · 개발용 샘플' : ''}
                  </span>
                </p>
              )}
            </div>
            <div className="review-episodes" aria-label="검토할 회차">
              <strong>
                <Film size={16} /> 회차별 영상 확인
              </strong>
              {detail.episodes.map((e) => (
                <button
                  key={e.id}
                  className={number === e.number ? 'active' : ''}
                  onClick={() => {
                    setNumber(e.number);
                    setMediaError('');
                  }}
                  aria-pressed={number === e.number}
                >
                  <span>
                    {e.number}화 · {e.title}
                    {serial && e.review_status && e.review_status !== 'approved' && (
                      <EpisodeStatusChip status={e.review_status} publishAt={e.publish_at} />
                    )}
                    <small>
                      {e.source === 'studio' ? 'AI · ' : ''}
                      {e.duration}초 ·{' '}
                      {detail.free || e.number <= detail.free_episodes ? '무료' : '유료'}
                      {loaded.includes(e.number) ? ' · 재생 준비 확인' : ''}
                    </small>
                  </span>
                  <Film size={15} />
                </button>
              ))}
            </div>
          </div>
          {admin && serial && pendingEpisodes > 0 && (
            <EpisodeReviewQueue
              dramaId={detail.id}
              embedded
              notify={say}
              onChanged={() => void load()}
            />
          )}
          {reviewing && (
            <div className="review-decision">
              <label>
                검토 의견 · 반려 시 필수
                <textarea
                  value={note}
                  maxLength={1000}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="수정할 회차와 보완 내용을 구체적으로 작성해 주세요."
                />
              </label>
              <label className="review-confirm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                포스터·작품 정보·회차 영상을 검토했으며 공개에 동의합니다.
              </label>
              {/* 승인 가능 여부는 서버가 확인한 파일 정보(길이·가로세로)로 정하고, 이 브라우저에서 재생되는지는 참고용 안내로만 보여 줍니다.
                  (예: 이 PC 브라우저가 못 여는 코덱이어도 서버 검사와 휴대폰 재생에는 문제가 없을 수 있어요) */}
              <p className="muted">
                서버 확인 {serverChecked.length}/{detail.episodes.length}화 · 이 브라우저 재생 확인 {loaded.length}/
                {detail.episodes.length}화
              </p>
              {serverChecked.length < detail.episodes.length && (
                <p className="review-alert" role="alert">
                  서버가 영상 정보(길이·해상도)를 확인하지 못한 회차가 있어요:{' '}
                  {detail.episodes
                    .filter((e) => !serverChecked.includes(e.number))
                    .map((e) => e.number + '화')
                    .join(', ')}
                  . PD에게 다시 올려 달라고 요청해 주세요.
                </p>
              )}
              {browserWarning && (
                <p className="info-box">
                  <AlertTriangle size={16} /> {browserWarning} 서버 확인은 끝났으니 승인할 수 있지만, 다른 기기에서도 한 번 재생해 보길 권해요.
                </p>
              )}
              <div className="form-actions">
                <button
                  className="secondary"
                  disabled={busy || !note.trim()}
                  onClick={() => void decide('rejected')}
                >
                  <X size={17} />
                  반려
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !checked ||
                    !!detail.issues.length ||
                    !detail.episodes.length ||
                    serverChecked.length < detail.episodes.length
                  }
                  onClick={() => void decide('published')}
                >
                  <Check size={17} />
                  {busy ? '처리 중…' : '승인 및 공개'}
                </button>
              </div>
            </div>
          )}
          {!!detail.reviews.length && (
            <div className="review-history">
              <h3>심사 이력</h3>
              {detail.reviews.map((r) => (
                <article key={r.id}>
                  <strong>{reviewStatus[r.status] || r.status}</strong>
                  <small>
                    {r.name} · {new Date(r.created_at).toLocaleString('ko-KR')}
                  </small>
                  {r.note && <p>{r.note}</p>}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {manage && detail && (
        <EpisodeManager
          d={detail}
          demo={demo}
          notify={say}
          close={() => {
            setManage(false);
            void load();
          }}
        />
      )}
      {toastUi}
    </Modal>
  );
}
