import { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Copy,
  Film,
  Lightbulb,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';

export const lessons = [
  {
    id: 'start',
    tag: '시작하기',
    title: '첫 작품, 어디서부터 시작하나요?',
    intro:
      '처음에는 1화 · 30초로 작게 시작해 보세요. 한 편을 완성한 뒤 회차를 늘리면 시행착오와 제작 비용을 줄일 수 있어요.',
    steps: [
      '아이디어만 있다면 AI 드라마 제작, 완성된 영상이 있다면 내 작품 · 회차를 선택하세요.',
      '주인공이 원하는 것, 그것을 막는 문제, 마지막 반전을 한 줄로 정리하세요.',
      '장르 템플릿으로 프로젝트를 만들고 기획안을 확인하세요. 프로젝트 생성 자체는 무료예요.',
    ],
    tip: '자동 제작도 먼저 예상 라마와 최대 사용량을 확인하세요. 첫 작품은 단계별 제작을 추천해요.',
    sample:
      '비밀을 숨긴 신입사원이 자신의 정체를 아는 팀장과 계약을 맺는다. 계약의 마지막 조건은 서로 사랑하지 않는 것.',
    destination: 'ai',
    action: 'AI 제작 시작하기',
  },
  {
    id: 'plan',
    tag: '기획',
    title: '짧아도 다음 화가 궁금한 이야기',
    intro:
      '한 회차에는 한 가지 사건만 담으세요. 시작은 궁금하게, 중간은 빠르게, 마지막은 다음 장면을 기다리게 만들어요.',
    steps: [
      '첫 3초에 질문이나 예상 밖의 상황을 보여 주세요.',
      '주인공의 목표와 갈등을 선명하게 적고 장르·분위기를 선택하세요.',
      '기획 저장 후 AI 기획안을 만들어요. 생성된 제목·줄거리·회차 구성은 직접 수정할 수 있어요.',
    ],
    tip: 'AI 버튼을 누르기 전에 수정한 기획을 저장해야 새 내용으로 만들 수 있어요.',
    sample:
      '0~3초: 낯선 사람이 주인공의 이름을 부른다. 3~20초: 두 사람만 아는 비밀이 드러난다. 마지막: 문밖에서 같은 목소리가 들린다.',
    destination: 'ai',
    action: '기획하러 가기',
  },
  {
    id: 'cast',
    tag: '캐릭터',
    title: '같은 인물로 이어지는 장면 만들기',
    intro:
      '주요 인물은 2~3명으로 시작하세요. 외모·의상·말투를 구체적으로 정하면 장면마다 인물을 알아보기 쉬워져요.',
    steps: [
      '이름·역할·성격과 외모를 입력하고 저장하세요.',
      '기준 이미지를 만든 뒤 얼굴과 의상을 확인하세요. AI 결과가 항상 같지는 않으므로 다음 장면도 확인해야 해요.',
      '목소리를 고르고 샘플을 들어 보세요. 이미지·음성 생성에는 라마가 사용돼요.',
    ],
    tip: '마음에 드는 결과는 버전 목록에서 다시 선택할 수 있어요.',
    sample:
      'Korean woman in her late twenties, short black bob, cream trench coat, calm expression, soft natural light, consistent facial features',
    destination: 'ai',
    action: '캐릭터 만들러 가기',
  },
  {
    id: 'script',
    tag: '대본',
    title: '컷과 대사를 쉽게 나누는 방법',
    intro:
      '컷은 카메라가 보여 주는 한 장면이에요. 한 컷에 한 행동을 담고 대사는 짧게 나누면 편집하기 좋아요.',
    steps: [
      '회차를 선택하고 AI 대본을 만들거나 컷을 직접 추가하세요.',
      '장면 설명은 이야기, 화면 묘사는 실제 보일 모습, 대사는 인물이 말하는 내용이에요.',
      '대사마다 화자를 지정하고 길이를 맞추세요. 컷을 이동해 순서를 바꿀 수도 있어요.',
    ],
    tip: '대사를 수정하면 기존 음성과 다를 수 있어요. 해당 컷의 음성을 다시 만들고 다시 합성하세요.',
    sample:
      '장면: 비 오는 버스 정류장. 화면: 젖은 편지를 쥔 손 클로즈업. 대사: “이 편지, 네가 보낸 거야?” 길이: 5초.',
    destination: 'ai',
    action: '대본 편집하러 가기',
  },
  {
    id: 'board',
    tag: '이미지 · 음성',
    title: '영상 비용을 쓰기 전에 먼저 확인하기',
    intro:
      '스토리보드는 컷별 이미지로 이야기를 미리 보는 과정이에요. 여기서 흐름을 확정하면 영상 재생성을 줄일 수 있어요.',
    steps: [
      '빈 컷 이미지 모두를 눌러 스토리보드를 채우세요.',
      '화자가 지정된 대사의 음성을 만들고 발음과 속도를 들어 보세요.',
      '회차 미리보기로 컷 순서·대사·자막을 확인하세요. 미리보기 자체는 무료예요.',
    ],
    tip: '어색한 컷만 다시 만들면 다른 컷은 그대로 유지돼요. 생성 전 예상 라마를 확인하세요.',
    sample: '',
    destination: 'ai',
    action: '스토리보드 확인하기',
  },
  {
    id: 'video',
    tag: '영상 · 합성',
    title: '이미지에서 완성된 세로 영상까지',
    intro:
      '컷 영상 생성은 선택이에요. 이미지와 음성만으로도 움직임을 넣은 회차 영상을 합성할 수 있어요.',
    steps: [
      '움직임이 필요한 컷에만 영상을 만들어 보세요.',
      '합성 · 포스터에서 회차를 합성하고 완성된 영상과 자막을 확인하세요.',
      '대표 이미지를 골라 포스터로 지정하세요. 수정한 컷은 다시 합성해야 최종 영상에 반영돼요.',
    ],
    tip: '합성은 라마를 차감하지 않아요. AI 영상 생성은 길이와 모델에 따라 비용이 달라져요.',
    sample: '',
    destination: 'ai',
    action: '영상 완성하러 가기',
  },
  {
    id: 'upload',
    tag: '직접 업로드',
    title: '만들어 둔 영상을 여러 회차로 등록하기',
    intro:
      '외부 편집 도구로 완성한 영상도 올릴 수 있어요. 파일명을 회차 순서로 정리하면 더 편리해요.',
    steps: [
      '내 작품 · 회차에서 새 작품의 제목·소개·포스터를 등록하세요.',
      '01화.mp4, 02화.mp4처럼 번호를 붙인 H.264 MP4를 선택하세요. 회당 최대 500MB이며 세로 9:16을 권장해요.',
      '업로드 점검 결과와 회차 번호를 확인하고 SRT/VTT 자막 또는 AI 자막 도구를 사용하세요.',
    ],
    tip: '통신이 끊기면 업로드 화면의 재시도 안내를 따라 주세요. 파일 선택만으로 심사 요청까지 완료되지는 않아요.',
    sample: '01화_처음만난밤.mp4\n02화_계약의조건.mp4\n03화_들켜버린비밀.mp4',
    destination: 'contents',
    action: '내 작품 · 회차 열기',
  },
  {
    id: 'export',
    tag: '심사 · 공개',
    title: '첫 공개 전, 마지막으로 확인할 것',
    intro:
      '영상 완성과 공개는 별도 단계예요. AI 제작은 작품으로 내보낸 다음 심사를 신청하고, 관리자가 승인하면 공개돼요.',
    steps: [
      '포스터·소개·무료 회차와 유료 회차 가격(핑)을 확인하세요.',
      '1화부터 회차가 이어지는지, 음성·자막·영상이 정상인지 직접 재생해 보세요.',
      '권리 보유·초상권·AI 사용 여부를 확인하고 심사를 신청하세요. 반려된 경우 사유에 맞게 수정해 다시 제출하세요.',
    ],
    tip: '핑은 시청자가 회차를 여는 포인트, 라마는 PD가 AI 제작에 쓰는 포인트예요.',
    sample: '',
    destination: 'contents',
    action: '심사 상태 확인하기',
  },
  {
    id: 'cost',
    tag: '비용 · 문제 해결',
    title: '라마와 AI 연결 상태 이해하기',
    intro:
      'API 키와 AI 공급사는 최고관리자가 설정해요. PD는 사용 가능한 모델과 예상 라마만 확인하면 돼요.',
    steps: [
      '라마 부족: 지갑에서 보유·예약 내역을 확인하고 필요한 만큼 충전하세요. 현재 테스트 충전은 실결제가 아니에요.',
      '모델 없음: 관리자에게 작업 종류(글·이미지·음성·영상)를 알려 주세요. 라마 충전만으로 모델이 연결되지는 않아요.',
      '작업 실패: 실패 이유와 반환 내역을 확인하고 입력을 줄이거나 다른 모델을 선택하세요. 자동 제작이 멈추면 원인을 해결한 뒤 다시 시작하세요.',
    ],
    tip: '중국 모델 사용을 원하지 않으면 프로젝트 기획에서 제외할 수 있어요. 다른 국가의 사용 가능한 모델이 필요해요.',
    sample: '',
    destination: 'lama',
    action: '라마 지갑 확인하기',
  },
];
const faqs = [
  [
    'AI 키가 없어도 제작을 시작할 수 있나요?',
    '프로젝트 기획과 직접 업로드는 준비할 수 있어요. 실제 AI 생성에는 관리자의 모델 연결이 필요해요. 개발용 모의 AI 결과는 실제 생성 품질과 다릅니다.',
  ],
  [
    '자동 제작 버튼을 누르면 바로 공개되나요?',
    '아니요. 자동 제작은 회차 합성까지 도와줘요. 결과 확인, 포스터 선택, 작품 내보내기와 심사 요청이 필요해요.',
  ],
  [
    '예전 이미지가 더 마음에 들어요.',
    '해당 컷이나 인물의 버전 목록에서 이전 결과를 선택하세요. 완성 영상에도 반영하려면 다시 합성하세요.',
  ],
  [
    '회차 수정 후 영상이 그대로예요.',
    '저장된 컷 내용과 합성된 영상은 별도예요. 음성·이미지를 필요에 맞게 재생성하고 합성 및 내보내기를 다시 진행하세요.',
  ],
];

export default function ProductionGuide({
  go,
  notify,
}: {
  go: (destination: string) => void;
  notify: (text: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('start');
  const [checked, setChecked] = useState<string[]>([]);
  const visible = lessons.filter((l) =>
    [l.title, l.tag, l.intro, l.tip, ...l.steps]
      .join(' ')
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const lesson = visible.find((l) => l.id === selected) || visible[0];
  const checks = [
    '포스터와 작품 소개를 확인했어요',
    '1화부터 회차 순서가 맞아요',
    '소리와 자막을 직접 재생해 확인했어요',
    '무료 회차와 핑 가격을 확인했어요',
    '권리와 AI 사용 여부를 확인했어요',
  ];
  return (
    <div className="production-guide">
      <section className="creator-welcome">
        <div>
          <span className="eyebrow">SHORTPING CREATOR ACADEMY</span>
          <h2>
            처음이어도 괜찮아요.
            <br />한 편씩, 나만의 드라마.
          </h2>
          <p>아이디어부터 첫 공개까지. 필요한 순간에 꺼내 보는 제작 매뉴얼이에요.</p>
          <button className="primary" onClick={() => go('ai')}>
            <Sparkles size={16} /> 제작 시작하기 <ArrowRight size={16} />
          </button>
        </div>
        <div className="guide-visual" aria-hidden="true">
          <div className="guide-film">
            <Film size={36} />
            <span>
              YOUR FIRST
              <br />
              SHORT DRAMA
            </span>
            <i>01 / ACTION</i>
          </div>
          <span className="guide-sticker">
            <Clapperboard size={18} /> 작은 시작, 새로운 이야기
          </span>
        </div>
      </section>
      <div className="guide-routes">
        <button
          onClick={() => {
            setQuery('');
            setSelected('start');
          }}
        >
          <Sparkles />
          <span>
            <strong>아이디어만 있어요</strong>
            <small>AI로 첫 작품 만들기</small>
          </span>
          <ChevronRight />
        </button>
        <button
          onClick={() => {
            setQuery('');
            setSelected('upload');
          }}
        >
          <Upload />
          <span>
            <strong>영상이 준비됐어요</strong>
            <small>업로드부터 심사까지</small>
          </span>
          <ChevronRight />
        </button>
        <button
          onClick={() => {
            setQuery('');
            setSelected('cost');
          }}
        >
          <Lightbulb />
          <span>
            <strong>제작 중 막혔어요</strong>
            <small>비용·실패·연결 안내</small>
          </span>
          <ChevronRight />
        </button>
      </div>
      <label className="creator-search">
        <Search size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="궁금한 내용을 검색하세요. 예: 자막, 비용, 포스터"
          aria-label="제작 매뉴얼 검색"
        />
        {query && (
          <button onClick={() => setQuery('')} type="button">
            지우기
          </button>
        )}
      </label>
      <div className="guide-layout">
        <nav aria-label="제작 가이드 목차">
          {visible.map((l, i) => (
            <button
              key={l.id}
              onClick={() => setSelected(l.id)}
              aria-current={lesson?.id === l.id ? 'page' : undefined}
            >
              <span>{String(i + 1).padStart(2, '0')}</span>
              <div>
                <small>{l.tag}</small>
                <strong>{l.title}</strong>
              </div>
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        {lesson ? (
          <article className="guide-lesson" key={lesson.id}>
            <span className="eyebrow">
              <BookOpen size={14} /> {lesson.tag}
            </span>
            <h3>{lesson.title}</h3>
            <p className="guide-intro">{lesson.intro}</p>
            <ol>
              {lesson.steps.map((s, i) => (
                <li key={s}>
                  <b>{i + 1}</b>
                  <p>{s}</p>
                </li>
              ))}
            </ol>
            <aside>
              <Lightbulb size={20} />
              <p>
                <strong>작업이 쉬워지는 팁</strong>
                {lesson.tip}
              </p>
            </aside>
            {lesson.sample && (
              <div className="guide-sample">
                <div>
                  <strong>바로 활용하는 예시</strong>
                  <button
                    className="text-link"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(lesson.sample);
                        notify('예시를 복사했어요. 제작 화면에 붙여 넣어 보세요.');
                      } catch {
                        notify('복사하지 못했어요. 예시를 직접 선택해 복사해 주세요.');
                      }
                    }}
                  >
                    <Copy size={14} /> 복사
                  </button>
                </div>
                <p>{lesson.sample}</p>
              </div>
            )}
            <button className="secondary" onClick={() => go(lesson.destination)}>
              {lesson.action}
              <ArrowRight size={15} />
            </button>
          </article>
        ) : (
          <div className="guide-lesson">
            <h3>검색 결과가 없어요</h3>
            <p>다른 단어로 검색하거나 전체 매뉴얼을 확인하세요.</p>
            <button className="secondary" onClick={() => setQuery('')}>
              전체 매뉴얼 보기
            </button>
          </div>
        )}
      </div>
      <div className="guide-bottom">
        <section className="management-panel">
          <span className="eyebrow">
            <ShieldCheck size={14} /> READY TO PUBLISH
          </span>
          <h3>공개 전 셀프 체크</h3>
          <p className="muted">
            이 체크는 연습용이며 작품의 권리 신고나 심사 요청을 대신하지 않아요.
          </p>
          {checks.map((c) => (
            <label className="guide-check" key={c}>
              <input
                type="checkbox"
                checked={checked.includes(c)}
                onChange={(e) =>
                  setChecked((x) => (e.target.checked ? [...x, c] : x.filter((a) => a !== c)))
                }
              />
              {c}
            </label>
          ))}
          <small aria-live="polite">
            <CheckCircle2 size={14} /> {checked.length} / {checks.length} 확인 · 이 화면을 닫으면
            초기화돼요
          </small>
        </section>
        <section className="management-panel">
          <h3>많이 궁금해하는 이야기</h3>
          {faqs.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </section>
      </div>
    </div>
  );
}
