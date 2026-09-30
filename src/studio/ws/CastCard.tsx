import { CheckCircle2, Circle, ScanFace, Wand2 } from 'lucide-react';
import { parseJson, type StudioCharacter } from '../../api';
import { runningCount, type WS } from './shared';

// 인물 카드 완성하기(2026-09-29, 힉스필드 벤치마킹 2단계)
// 기준 이미지 → 참고 자세(정면·옆·전신·표정) → 목소리까지 채우면 모든 컷에서 같은 얼굴을 유지하기 쉬워요.
// AI 검수에서 나온 '인물 닮음' 점수를 모아, 얼굴이 달라 보이는 컷을 바로 찾아가 고칠 수 있게 해요.
const NEED = ['front', 'side', 'full'] as const;
const FACES = ['smile', 'angry', 'sad'];
export const LOW_MATCH = 70;
type Verify = { faces?: { name: string; match: number }[]; image?: string };

export function faceMatches(ws: WS, c: StudioCharacter) {
  const out: { shotId: string; episodeId: string; label: string; match: number }[] = [];
  for (const e of ws.data.episodes)
    e.shots.forEach((s, i) => {
      const v = parseJson<Verify | null>(s.verify, null);
      if (!v || v.image !== s.image) return;
      const f = (v.faces || []).find((x) => x.name === c.name);
      if (f) out.push({ shotId: s.id, episodeId: e.id, label: `${e.number}화 ${i + 1}번`, match: Math.round(Number(f.match)) });
    });
  return out;
}

export function CastCardStatus({ ws, c, beforeRun }: { ws: WS; c: StudioCharacter; beforeRun: (fn: () => void) => void }) {
  const refs = parseJson<{ pose: string; url: string }[]>(c.refs, []);
  const has = (pose: string) => refs.some((r) => r.pose === pose);
  const missing = [...NEED.filter((p) => !has(p)), ...(FACES.some(has) ? [] : ['smile'])];
  const voice = !!(c.voice || c.voice_sample);
  const steps = [
    { name: '기준 이미지', done: !!c.image },
    { name: `참고 자세 ${4 - missing.length}/4`, done: !missing.length },
    { name: '목소리', done: voice },
  ];
  const done = steps.filter((x) => x.done).length;
  const busy = runningCount(ws.data.jobs, (j) => j.target_id === c.id && ['character_image', 'character_ref'].includes(j.kind)) > 0;
  const fill = () =>
    beforeRun(() => {
      if (!c.image) ws.run(`${c.name} 기준 이미지 만들기`, 'character_image', 'image', { targetId: c.id });
      else if (missing.length) ws.run(`${c.name} 빠진 참고 자세 ${missing.length}장`, 'character_sheet', 'image', { targetId: c.id, options: { poses: missing } });
    });
  const matches = faceMatches(ws, c);
  const avg = matches.length ? Math.round(matches.reduce((n, m) => n + m.match, 0) / matches.length) : null;
  const low = matches.filter((m) => m.match < LOW_MATCH);
  const byEpisode = ws.data.episodes
    .map((e) => {
      const list = matches.filter((m) => m.episodeId === e.id);
      return { episodeId: e.id, number: e.number, count: list.length, avg: list.length ? Math.round(list.reduce((n, m) => n + m.match, 0) / list.length) : 0 };
    })
    .filter((x) => x.count > 0);
  const open = (m: (typeof matches)[number]) => {
    ws.setEpisodeId(m.episodeId);
    ws.setFocus(m.shotId);
    ws.goTab('scene');
  };
  return (
    <div className="cc-status" aria-label={`${c.name} 인물 카드 완성도`}>
      <div className="cc-head">
        <b>인물 카드 {done}/3</b>
        <div className="cc-bar" aria-hidden="true">
          <i style={{ width: `${(done / 3) * 100}%` }} />
        </div>
      </div>
      <ul className="cc-steps">
        {steps.map((x) => (
          <li key={x.name} className={x.done ? 'done' : ''}>
            {x.done ? <CheckCircle2 size={12} /> : <Circle size={12} />} {x.name}
          </li>
        ))}
      </ul>
      {(!c.image || missing.length > 0) && (
        <button type="button" className="secondary compact" disabled={busy} onClick={fill} title="기준 이미지가 없으면 먼저 만들고, 있으면 빠진 참고 자세만 만들어요">
          <Wand2 size={12} /> {busy ? '만드는 중…' : !c.image ? '기준 이미지부터 만들기' : `빠진 자세 ${missing.length}장 채우기`}
        </button>
      )}
      {!voice && <small className="muted">목소리는 아래 ‘목소리 고르기’에서 정해요.</small>}
      <div className={'cc-match' + (low.length ? ' warn' : '')}>
        <ScanFace size={13} />
        {avg === null ? (
          <span>인물 닮음 점수는 컷 이미지를 AI 검수하면 나와요.</span>
        ) : (
          <span>
            인물 닮음 평균 <b>{avg}점</b> · 검수한 컷 {matches.length}개{low.length ? ` · 달라 보이는 컷 ${low.length}개` : ' · 모두 같은 얼굴로 보여요'}
          </span>
        )}
      </div>
      {/* 3단계(2026-09-30) 회차별 닮음: 어느 회차부터 얼굴이 달라지는지 한눈에 */}
      {byEpisode.length > 1 && (
        <div className="cc-eps" aria-label="회차별 인물 닮음">
          {byEpisode.map((x) => (
            <span key={x.episodeId} className={x.avg < LOW_MATCH ? 'warn' : ''} title={`${x.number}화 · 검수한 컷 ${x.count}개`}>
              {x.number}화 <b>{x.avg}</b>
            </span>
          ))}
        </div>
      )}
      {low.length > 0 && (
        <div className="chip-row cc-low">
          {low.slice(0, 8).map((m) => (
            <button type="button" key={m.shotId} className="chip" title="장면 편집에서 이 컷을 열어요" onClick={() => open(m)}>
              {m.label} · {m.match}점
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
