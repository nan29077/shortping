import { useRef, useState } from 'react';
import { Layers, Pause, Play, ShieldCheck, Star, X } from 'lucide-react';
import { parseJson, studioMedia, type ShotVerify, type StudioAsset, type StudioShot } from '../../api';
import { asset } from '../../platform';
import { runningCount, type WS } from './shared';

// 후보 여러 장(2026-09-29, 힉스필드 벤치마킹 4단계)
// AI 결과는 매번 달라서, 중요한 컷은 후보를 한 번에 여러 장 만들어 나란히 보고 고르면 다시 누르는 시간이 줄어요.
// 기본은 1장(비용 그대로), 필요할 때만 늘려요. 후보를 AI 검수하면 가장 좋은 후보에 '추천'을 달아 줘요.
export function CandidateButtons({ kind, disabled, onRun }: { kind: 'image' | 'video'; disabled: boolean; onRun: (n: number) => void }) {
  const options = kind === 'image' ? [2, 3, 4] : [2];
  return (
    <select
      className="version-select cand-select"
      aria-label={kind === 'image' ? '이미지 후보 여러 장 만들기' : '영상 후보 여러 개 만들기'}
      title={kind === 'image' ? '같은 설정으로 후보를 여러 장 만들어 골라요(장수만큼 라마)' : '중요한 컷만 — 후보 2개를 만들어 골라요(2배 라마)'}
      value=""
      disabled={disabled}
      onChange={(e) => e.target.value && onRun(Number(e.target.value))}
    >
      <option value="">{kind === 'image' ? '후보 여러 장…' : '후보 2개…'}</option>
      {options.map((n) => (
        <option key={n} value={n}>
          {kind === 'image' ? `후보 ${n}장 만들기` : `영상 후보 ${n}개 만들기`}
        </option>
      ))}
    </select>
  );
}

export function CandidateTray({ ws, s, onVerify }: { ws: WS; s: StudioShot; onVerify: () => void }) {
  const [hidden, setHidden] = useState('');
  const tray = useRef<HTMLDivElement>(null);
  // 영상 후보 나란히 비교(4단계): 모두 처음으로 돌려 동시에 재생해요.
  const playAll = () => {
    const vids = [...(tray.current?.querySelectorAll('video') || [])];
    for (const v of vids) {
      v.pause();
      v.currentTime = 0;
    }
    for (const v of vids) void v.play().catch(() => {});
  };
  const mine = ws.data.assets.filter((a) => a.target_id === s.id && a.batch && (a.kind === 'image' || a.kind === 'video'));
  if (!mine.length) return null;
  // 가장 최근 후보 묶음
  const latest = mine.reduce((a, b) => (a.created_at > b.created_at ? a : b)).batch!;
  if (hidden === latest) return null;
  const list = mine.filter((a) => a.batch === latest).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const kind = list[0].kind;
  // 후보를 만든 뒤 따로 새 결과를 만들었고 지금 쓰는 것도 후보가 아니면, 지난 후보 칸은 접어 둬요(버전 기록에는 남음).
  const newest = list[list.length - 1].created_at;
  const laterSingle = ws.data.assets.some((a) => a.target_id === s.id && a.kind === kind && !a.batch && a.created_at > newest);
  const inUse = list.some((a) => a.url === (kind === 'image' ? s.image : s.video));
  if (laterSingle && !inUse) return null;
  const pending = runningCount(ws.data.jobs, (j) => j.target_id === s.id && (j.kind === 'shot_image' || j.kind === 'shot_video'));
  const verifying = runningCount(ws.data.jobs, (j) => j.kind === 'verify_asset' && list.some((a) => a.id === j.target_id));
  const scores = list.map((a) => parseJson<ShotVerify | null>(a.verify, null));
  const unchecked = kind === 'image' ? list.filter((_, i) => !scores[i]).length : 0;
  const best = scores.reduce<{ i: number; score: number }>((acc, v, i) => (v && v.ok && v.score > acc.score ? { i, score: v.score } : acc), { i: -1, score: -1 });
  const current = kind === 'image' ? s.image : s.video;
  return (
    <div className="cand-tray" aria-label="후보 고르기" ref={tray}>
      <div className="cand-head">
        <b>
          <Layers size={13} /> 후보 {list.length}
          {pending ? ` · 만드는 중 ${pending}` : ''}
        </b>
        {kind === 'image' && unchecked > 0 && !pending && (
          <button type="button" className="secondary compact" disabled={verifying > 0} title="후보마다 얼굴·손·글자를 AI가 확인하고 가장 좋은 후보에 추천을 달아요(라마 소액)" onClick={onVerify}>
            <ShieldCheck size={12} /> {verifying ? `검수 중 ${verifying}` : `후보 ${unchecked}장 AI 검수`}
          </button>
        )}
        {kind === 'video' && list.length > 1 && (
          <button type="button" className="secondary compact" title="후보 영상을 처음부터 동시에 틀어 나란히 비교해요" onClick={playAll}>
            <Play size={12} /> 나란히 재생
          </button>
        )}
        <button type="button" className="icon-button" aria-label="후보 칸 닫기" onClick={() => setHidden(latest)}>
          <X size={14} />
        </button>
      </div>
      <div className="cand-grid">
        {list.map((a, i) => (
          <Candidate key={a.id} a={a} v={scores[i]} best={i === best.i} current={a.url === current} use={() => ws.useAsset(a.id)} />
        ))}
      </div>
      <small className="muted">
        {inUse ? '' : '지금 컷에 쓰는 것은 이 후보들 중 하나가 아니에요. '}
        마음에 드는 후보의 ‘이걸로 쓰기’를 누르면 이 컷에 넣어요. 나머지는 버전 기록에 남아요.
      </small>
    </div>
  );
}

function Candidate({ a, v, best, current, use }: { a: StudioAsset; v: ShotVerify | null; best: boolean; current: boolean; use: () => void }) {
  const face = v?.faces?.length ? Math.min(...v.faces.map((f) => Number(f.match))) : null;
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // 영상 후보: PC는 올리면, 휴대폰은 ▶를 눌러 재생해요(누르기만 해서 바로 적용되지 않게 재생과 고르기를 나눴어요).
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().then(() => setPlaying(true), () => {});
    else {
      el.pause();
      setPlaying(false);
    }
  };
  return (
    <div className={'cand-item' + (current ? ' on' : '') + (best ? ' best' : '')} title={v ? `${v.summary || ''}` : ''}>
      {a.kind === 'video' ? (
        <>
          <video
            ref={video}
            src={studioMedia(a.url)}
            muted
            loop
            playsInline
            preload="metadata"
            onMouseEnter={(e) => void e.currentTarget.play().then(() => setPlaying(true), () => {})}
            onMouseLeave={(e) => (e.currentTarget.pause(), setPlaying(false))}
          />
          <button type="button" className="cand-play" aria-label={playing ? '멈추기' : '재생'} onClick={toggle}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </>
      ) : (
        <img src={asset(a.url)} alt="" loading="lazy" />
      )}
      {best && (
        <em className="cand-best">
          <Star size={10} /> 추천
        </em>
      )}
      {v && (
        <small className={'cand-score' + (v.ok ? '' : ' bad')} title="AI 검수 점수(100점 만점) · 인물 닮음(100 = 기준 이미지와 같음)">
          {v.ok ? `AI 점수 ${v.score}` : `문제 ${v.issues.length || 1}곳`}
          {face !== null ? ` · 닮음 ${Math.round(face)}` : ''}
        </small>
      )}
      <button type="button" className="cand-use" aria-pressed={current} disabled={current} onClick={use}>
        {current ? '사용 중' : '이걸로 쓰기'}
      </button>
    </div>
  );
}
