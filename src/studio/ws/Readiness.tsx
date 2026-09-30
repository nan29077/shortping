import { AlertTriangle, ArrowRight, Check } from 'lucide-react';
import type { StudioProjectDetail } from '../../api';
import { verifyOf } from './DramaParts';
import type { TabId, WS } from './shared';

// 힉스필드 · 폴로 벤치마킹 3단계(2026-09-30): 순서를 강제하지 않는 대신, 공개 전에 빠진 단계를 한눈에 알려 줘요.
// 막지는 않아요(서버가 꼭 필요한 것만 막아요). 각 줄을 누르면 그 자리로 가요.
export type ReadyItem = { id: string; text: string; ok: boolean; must?: boolean; tab: TabId; episodeId?: string };

export function readiness(d: StudioProjectDetail): ReadyItem[] {
  const eps = d.episodes;
  const shots = eps.flatMap((e) => e.shots);
  const lines = shots.filter((s) => s.dialogue.trim());
  const noScript = eps.filter((e) => !e.shots.length);
  const noImage = shots.filter((s) => !s.image && !s.video && !s.lipsync);
  const noAudio = lines.filter((s) => !s.audio);
  const unverified = shots.filter((s) => s.image && !verifyOf(s));
  const badVerify = shots.filter((s) => verifyOf(s) && !verifyOf(s)!.ok);
  const notComposed = eps.filter((e) => e.shots.length && !(e.video && e.status === 'composed'));
  const stale = eps.filter((e) => e.video && e.status !== 'composed' && e.status !== 'composing');
  const castNoImage = d.characters.filter((c) => !c.image);
  const firstEp = (list: { id: string }[]) => list[0]?.id;
  return [
    { id: 'cast', text: castNoImage.length ? `인물 기준 이미지가 없는 인물 ${castNoImage.length}명 (${castNoImage.slice(0, 3).map((c) => c.name).join(', ')}${castNoImage.length > 3 ? ' 등' : ''})` : d.characters.length ? '인물 기준 이미지 준비됨' : '등록된 인물 없음(선택)', ok: !castNoImage.length, tab: 'plan' },
    { id: 'script', text: noScript.length ? `대본이 없는 회차 ${noScript.length}개 (${noScript.map((e) => e.number + '화').slice(0, 4).join(', ')})` : `모든 회차 대본 준비됨 (${eps.length}화)`, ok: !noScript.length, must: true, tab: 'script', episodeId: firstEp(noScript) },
    { id: 'image', text: !shots.length ? '컷이 없어요 (대본이나 빈 컷부터)' : noImage.length ? `이미지가 없는 컷 ${noImage.length}개` : `모든 컷 이미지 있음 (${shots.length}컷)`, ok: !noImage.length && shots.length > 0, must: true, tab: 'scene', episodeId: eps.find((e) => e.shots.some((s) => noImage.includes(s)))?.id },
    { id: 'audio', text: noAudio.length ? `음성이 없는 대사 컷 ${noAudio.length}개` : lines.length ? '대사 음성 모두 있음' : '대사 컷 없음', ok: !noAudio.length, tab: 'scene', episodeId: eps.find((e) => e.shots.some((s) => noAudio.includes(s)))?.id },
    { id: 'verify', text: badVerify.length ? `AI 검수에서 문제가 나온 컷 ${badVerify.length}개` : unverified.length ? `AI 검수를 안 한 컷 ${unverified.length}개 (선택 · 라마 소액)` : shots.length ? 'AI 검수 완료' : '검수할 컷 없음', ok: !badVerify.length && !unverified.length, tab: 'scene', episodeId: eps.find((e) => e.shots.some((s) => badVerify.includes(s) || unverified.includes(s)))?.id },
    { id: 'compose', text: stale.length ? `합성한 뒤 내용이 바뀐 회차 ${stale.length}개 (다시 합성)` : notComposed.length ? `합성하지 않은 회차 ${notComposed.length}개` : `모든 회차 합성 완료`, ok: !notComposed.length && !stale.length, must: true, tab: 'finish' },
    { id: 'poster', text: d.project.poster ? '대표 포스터 있음' : '대표 포스터 없음(첫 컷이나 AI 포스터로 만들 수 있어요)', ok: !!d.project.poster, tab: 'finish' },
  ];
}

export function ReadyChecklist({ ws, compact = false }: { ws: WS; compact?: boolean }) {
  const items = readiness(ws.data);
  const missing = items.filter((x) => !x.ok);
  const must = missing.filter((x) => x.must);
  if (compact && !missing.length) return null;
  return (
    <div className={'ready-list' + (compact ? ' compact' : '')} role="region" aria-label="공개 전 확인">
      <div className="ready-head">
        {missing.length ? <AlertTriangle size={14} /> : <Check size={14} />}
        <strong>{missing.length ? `공개 전 확인 ${missing.length}개${must.length ? ` · 꼭 필요한 것 ${must.length}개` : ''}` : '공개 준비가 다 됐어요'}</strong>
        {!compact && <small className="muted">순서는 자유예요. 꼭 필요한 것만 채우면 검수를 신청할 수 있고, 나머지는 품질을 위해 권해요.</small>}
      </div>
      <ul>
        {(compact ? missing : items).map((x) => (
          <li key={x.id} className={(x.ok ? 'ok' : x.must ? 'must' : 'opt')}>
            <i aria-hidden="true">{x.ok ? <Check size={11} /> : x.must ? '!' : '·'}</i>
            <span>{x.text}</span>
            {!x.ok && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  if (x.episodeId) ws.setEpisodeId(x.episodeId);
                  ws.goTab(x.tab);
                }}
              >
                채우러 가기 <ArrowRight size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
