import { Check, ChevronRight, Circle } from 'lucide-react';
import type { StudioProjectDetail } from '../api';

export type StepId = 'plan' | 'cast' | 'script' | 'board' | 'video' | 'compose' | 'export';
export type StepState = { id: StepId; done: number; total: number; ok: boolean; optional?: boolean };

// 프로젝트의 단계별 진행 상태를 계산합니다(라마·서버 호출 없이 화면에서만 계산).
export function progressOf(d: StudioProjectDetail): StepState[] {
  const shots = d.episodes.flatMap((e) => e.shots);
  const lines = shots.filter((s) => s.dialogue.trim() && s.speaker_id);
  const scripted = d.episodes.filter((e) => e.shots.length).length;
  const composed = d.episodes.filter((e) => e.video).length;
  const exported = d.episodes.filter((e) => e.exported_at).length;
  const planned = !!d.characters.length && d.episodes.some((e) => e.summary.trim());
  return [
    { id: 'plan', done: planned ? 1 : 0, total: 1, ok: planned },
    { id: 'cast', done: d.characters.filter((c) => c.image).length, total: d.characters.length, ok: !!d.characters.length && d.characters.every((c) => c.image) },
    { id: 'script', done: scripted, total: d.episodes.length, ok: !!d.episodes.length && scripted === d.episodes.length },
    {
      id: 'board',
      done: shots.filter((s) => s.image).length + lines.filter((s) => s.audio).length,
      total: shots.length + lines.length,
      ok: !!shots.length && shots.every((s) => s.image) && lines.every((s) => s.audio),
    },
    { id: 'video', done: shots.filter((s) => s.video).length, total: shots.length, ok: !!shots.length && shots.every((s) => s.video), optional: true },
    { id: 'compose', done: composed, total: d.episodes.length, ok: !!d.episodes.length && composed === d.episodes.length },
    { id: 'export', done: exported && d.drama && ['pending', 'published'].includes(d.drama.status) ? 1 : 0, total: 1, ok: !!exported && !!d.drama && ['pending', 'published'].includes(d.drama.status) },
  ];
}

const nextText: Record<StepId, string> = {
  plan: '한 줄 아이디어로 AI 기획안을 만들어 인물과 회차 구성을 채워요.',
  cast: '인물 기준 이미지로 장면 사이의 얼굴과 의상을 맞추는 데 도움을 줘요. 결과는 직접 확인해 주세요.',
  script: '회차별 대본(컷·대사)을 AI로 써요.',
  board: '컷마다 스토리보드 이미지와 대사 음성을 만들어요. “미리보기”로 바로 확인할 수 있어요.',
  video: '컷 영상은 선택이에요. 없으면 스토리보드 이미지가 천천히 움직이는 화면으로 합성돼요.',
  compose: '컷과 음성을 이어 붙여 회차 영상을 만들어요. 라마가 들지 않아요.',
  export: '작품으로 내보내고 검수를 신청하면 공개 준비가 끝나요.',
};

export function nextStep(list: StepState[]): StepState | undefined {
  return list.find((s) => !s.ok && !s.optional);
}

export default function ProgressBar({
  list,
  names,
  go,
}: {
  list: StepState[];
  names: Record<StepId, string>;
  go: (id: StepId) => void;
}) {
  const required = list.filter((s) => !s.optional);
  const pct = Math.round((required.filter((s) => s.ok).length / required.length) * 100);
  const next = nextStep(list);
  return (
    <div className="studio-progress">
      <div className="studio-progress-bar" role="progressbar" aria-label="제작 진행률" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: pct + '%' }} />
      </div>
      <div className="studio-progress-row">
        <strong>{pct}% 완성</strong>
        {next ? (
          <button className="next-action" onClick={() => go(next.id)}>
            <span>다음 할 일 · {names[next.id]}</span>
            <small>{nextText[next.id]}</small>
            <ChevronRight size={16} />
          </button>
        ) : (
          <span className="next-action done">
            <Check size={15} /> 모든 단계를 마쳤어요. 검수 결과를 기다려 주세요.
          </span>
        )}
      </div>
    </div>
  );
}

export function StepMark({ s }: { s?: StepState }) {
  if (!s) return null;
  if (s.ok) return <Check size={12} className="step-ok" aria-label="완료" />;
  if (s.total && s.done) return <em className="step-count">{s.done}/{s.total}</em>;
  return <Circle size={9} className="step-todo" aria-hidden="true" />;
}
