import { useEffect, useState } from 'react';
import { Check, Film, X } from 'lucide-react';
import { Modal } from './App';
import { api, won, type Drama, type Episode } from './api';

export type ManagedDrama = Drama & {
  owner_name: string;
  episodes: (Episode & { video: string })[];
  issues: string[];
  reviews: { id: string; name: string; status: string; note: string; created_at: string }[];
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
  async function load() {
    try {
      setDetail(await api<ManagedDrama>('/studio/dramas/' + drama.id));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [drama.id]);
  const reviewing = admin && detail?.status === 'pending';
  const episode = detail?.episodes.find((e) => e.number === number);
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
        if (!busy) close();
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
              src={detail.image}
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
                  <dt>전체 소장</dt>
                  <dd>{won(detail.price)}</dd>
                </div>
                <div>
                  <dt>무료 공개</dt>
                  <dd>
                    {detail.price === 0
                      ? '전 회차 무료'
                      : detail.episodes.length
                        ? `1~${Math.min(detail.free_episodes, detail.episodes.length)}화`
                        : '등록 회차 없음'}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
          <p className="review-synopsis">{detail.synopsis}</p>
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
                  poster={detail.image}
                  src={'/api/play/' + detail.id + '/' + number}
                  onLoadedData={() => {
                    setLoaded((prev) => (prev.includes(number) ? prev : [...prev, number]));
                    setMediaError('');
                  }}
                  onError={() => {
                    setMediaError(
                      `${number}화 영상을 재생할 수 없습니다. 파일을 확인한 뒤 다시 검토해 주세요.`,
                    );
                    setLoaded((prev) => prev.filter((n) => n !== number));
                  }}
                />
              ) : (
                <p className="muted">등록된 회차가 없습니다.</p>
              )}
              {mediaError && (
                <p className="review-alert" role="alert">
                  {mediaError}
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
                    <small>
                      {e.duration}초 ·{' '}
                      {detail.price === 0 || e.number <= detail.free_episodes ? '무료' : '유료'}
                      {loaded.includes(e.number) ? ' · 재생 준비 확인' : ''}
                    </small>
                  </span>
                  <Film size={15} />
                </button>
              ))}
            </div>
          </div>
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
              <p className="muted">
                승인하려면 포스터와 모든 회차의 재생 준비 상태를 확인해 주세요. ({loaded.length}/
                {detail.episodes.length}화)
              </p>
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
                    !posterReady ||
                    !!detail.issues.length ||
                    !detail.episodes.length ||
                    detail.episodes.some((e) => !loaded.includes(e.number))
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
    </Modal>
  );
}
