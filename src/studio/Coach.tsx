import { ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../App';
import type { StudioProjectDetail } from '../api';
import { lessons } from './Guide';
import type { StepId } from './Progress';

const hints: Record<StepId, { title: string; description: string; checks: string[] }> = {
  plan: {
    title: '이야기의 씨앗을 심어요',
    description: '주인공과 사건을 한 줄로 적고 저장한 다음, 기획안을 만들어 보세요.',
    checks: ['아이디어와 장르 정하기', '기획 저장하기', 'AI 기획안과 회차 구성 확인하기'],
  },
  cast: {
    title: '주인공을 만나 볼 시간',
    description:
      '인물 정보를 저장하고 기준 이미지와 목소리를 확인해요. 처음에는 주요 인물 2명으로도 충분해요.',
    checks: ['외모·성격 저장하기', '기준 이미지 확인하기', '목소리 미리 듣기'],
  },
  script: {
    title: '한 장면에 한 가지 사건만',
    description:
      '회차를 선택하고 컷별 장면·화자·대사를 다듬어요. 아래 회차 목록으로 이동할 수 있어요.',
    checks: ['회차별 대본 만들기', '대사에 화자 지정하기', '컷 길이와 순서 확인하기'],
  },
  board: {
    title: '이미지와 목소리로 먼저 감상해요',
    description: '비어 있는 컷을 채운 뒤 무료 미리보기로 이야기를 확인하세요.',
    checks: ['컷 이미지 만들기', '대사 음성 만들기', '회차 미리보기'],
  },
  video: {
    title: '움직임이 필요할 때만 만들어요',
    description: '선택 단계예요. 비용을 아끼고 싶다면 이미지와 음성으로 바로 합성해도 좋아요.',
    checks: ['움직임이 필요한 컷 선택', '예상 라마 확인', '결과 영상 확인'],
  },
  compose: {
    title: '컷을 연결하면 한 편이 돼요',
    description:
      '회차를 합성하고 소리·자막을 확인해요. 포스터도 꼭 선택하세요. 합성에는 라마가 들지 않아요.',
    checks: ['회차 합성하기', '완성 영상 재생하기', '포스터 고르기'],
  },
  export: {
    title: '마지막 확인 후 시청자에게',
    description:
      '작품으로 내보낸 뒤 심사를 신청하세요. 반려되었다면 내용을 수정하고 다시 제출할 수 있어요.',
    checks: ['합성된 회차와 포스터 확인', '무료 회차·핑 가격 확인', '내보내기 및 심사 요청'],
  },
};
const stepOrder: StepId[] = ['plan', 'cast', 'script', 'board', 'video', 'compose', 'export'];
export function StepCoach({ step }: { step: StepId }) {
  const [help, setHelp] = useState(false);
  const hint = hints[step];
  const lesson = lessons.find((l) => l.id === (step === 'compose' ? 'video' : step))!;
  return (
    <>
      <aside className="step-coach">
        <div className="coach-badge">
          <Lightbulb size={22} />
        </div>
        <div>
          <span className="eyebrow">
            STEP {String(stepOrder.indexOf(step) + 1).padStart(2, '0')} ·{' '}
            {step === 'video' ? '선택 단계' : '이번 단계 안내'}
          </span>
          <h3>{hint.title}</h3>
          <p>{hint.description}</p>
          <div className="coach-checks">
            {hint.checks.map((c, i) => (
              <span key={c}>
                <b>{i + 1}</b>
                {c}
              </span>
            ))}
          </div>
        </div>
        <button className="text-link" onClick={() => setHelp(true)}>
          <BookOpen size={15} /> 자세한 가이드
        </button>
      </aside>
      {help && (
        <Modal title={lesson.title} close={() => setHelp(false)}>
          <div className="guide-help">
            <p>{lesson.intro}</p>
            <ol>
              {lesson.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <div className="info-box">{lesson.tip}</div>
            <button className="primary full" onClick={() => setHelp(false)}>
              이해했어요 · 작업 계속하기
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function WorkflowFooter({ step, go }: { step: StepId; go: (step: StepId) => void }) {
  const index = stepOrder.indexOf(step);
  return (
    <nav className="workflow-footer" aria-label="제작 단계 이동">
      <button className="secondary" disabled={!index} onClick={() => go(stepOrder[index - 1])}>
        <ChevronLeft size={15} /> 이전 단계
      </button>
      <small>이동만으로 AI 작업이 실행되지는 않아요.</small>
      {index < stepOrder.length - 1 && (
        <button className="primary" onClick={() => go(stepOrder[index + 1])}>
          {step === 'board' ? '영상 단계 살펴보기' : '다음 단계'}
          <ChevronRight size={15} />
        </button>
      )}
    </nav>
  );
}
export function EpisodeNavigator({
  data,
  select,
  selected,
}: {
  data: StudioProjectDetail;
  select: (id: string, step: StepId) => void;
  selected: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="episode-navigator">
      <button
        className="episode-navigator-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          <strong>회차별 제작 현황</strong>
          <small>
            {data.episodes.filter((e) => e.video).length} / {data.episodes.length}화 합성 완료
          </small>
        </span>
        <span>
          {open ? '접기' : '펼치기'} <ChevronRight size={16} />
        </span>
      </button>
      {open && (
        <div className="episode-navigator-grid">
          {data.episodes.map((e) => {
            const complete = e.shots.filter((s) => s.image || s.video).length;
            const target: StepId = !e.shots.length
              ? 'script'
              : complete < e.shots.length
                ? 'board'
                : !e.video
                  ? 'compose'
                  : 'export';
            return (
              <button
                className={selected === e.id ? 'selected' : ''}
                key={e.id}
                onClick={() => select(e.id, target)}
              >
                <span className="episode-number">
                  {e.number}
                  <small>화</small>
                </span>
                <span>
                  <strong>{e.title}</strong>
                  <small>
                    컷 {e.shots.length} · 이미지/영상 {complete} ·{' '}
                    {e.video ? '합성 완료' : '제작 중'}
                  </small>
                </span>
                {e.video ? <Check size={16} /> : <ArrowRight size={16} />}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
