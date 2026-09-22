import { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Cpu,
  Globe2,
  KeyRound,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { api, capabilityLabel, won, type AdminAi } from './api';

export default function AiReadiness({
  data,
  go,
  busy,
  run,
}: {
  data: AdminAi;
  go: (tab: 'providers' | 'models' | 'policy' | 'routes' | 'jobs') => void;
  busy: boolean;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
}) {
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('all');
  const real = data.providers.filter((p) => p.kind !== 'mock');
  const allowCn = !!Number(data.settings.ai_allow_cn);
  const enabled = !!Number(data.settings.ai_enabled);
  const reason = (p: (typeof real)[number]) => {
    if (!p.active) return '사용 중지';
    if (!p.has_key) return 'API 키 등록 필요';
    if (p.kind === 'kling' && !p.has_secret) return '시크릿 키 등록 필요';
    if (p.country === 'CN' && !allowCn) return '중국 모델 정책으로 제한';
    if (p.cooldown_until) return '장애 후 일시 제외';
    if (p.monthly_budget_won > 0 && p.month_cost >= p.monthly_budget_won)
      return '이번 달 예산 소진';
    if (p.status !== 'ok')
      return p.status === 'error' ? '연결 오류 · 재확인 필요' : '연결 확인 필요';
    if (!data.models.some((m) => m.provider_id === p.id && m.active)) return '활성 모델 등록 필요';
    return '연결 확인됨';
  };
  const verified = real.filter((p) => reason(p) === '연결 확인됨');
  const models = data.models.filter(
    (m) => m.active && verified.some((p) => p.id === m.provider_id),
  );
  const capabilities = ['text', 'image', 'tts', 'video', 'stt'] as const;
  const rows = real.filter(
    (p) =>
      (country === 'all' || (country === 'cn' ? p.country === 'CN' : p.country !== 'CN')) &&
      [p.name, p.kind, p.country].join(' ').toLowerCase().includes(query.toLowerCase().trim()),
  );
  const checklist = [
    {
      text: '공급사와 API 키 등록',
      done: real.some((p) => p.has_key),
      tab: 'providers' as const,
      detail: '키는 나중에 등록할 수 있어요. 키 입력 전에는 실제 생성이 준비되지 않아요.',
    },
    {
      text: '연결 확인 및 모델 활성화',
      done: verified.length > 0,
      tab: 'models' as const,
      detail: '공급사 연결을 확인하고 작업별 모델 ID와 가격을 설정하세요.',
    },
    {
      text: '월 예산과 PD 사용 한도 설정',
      done:
        Number(data.settings.ai_monthly_budget_won) > 0 &&
        Number(data.settings.ai_daily_limit_lama) > 0,
      tab: 'policy' as const,
      detail: '0은 무제한일 수 있어요. 비용 한도 · 정책에서 운영 기준을 확인하세요.',
    },
    {
      text: '기본 제작 모델 준비',
      done: ['text', 'image', 'tts'].every((c) => models.some((m) => m.capability === c)),
      tab: 'routes' as const,
      detail: '기획·이미지·음성 모델부터 준비하세요. 영상과 자동 자막은 추가로 연결할 수 있어요.',
    },
  ];
  return (
    <div className="ai-readiness">
      <section className="creator-welcome admin-connect-hero">
        <div>
          <span className="eyebrow">AI CONTROL CENTER</span>
          <h2>
            연결은 관리자에게,
            <br />
            창작은 PD에게.
          </h2>
          <p>
            공급사 등록 → 키 연결 → 모델·가격 → 사용 정책 순서로 준비하세요.
            <br />
            키를 등록하지 않은 서비스도 미리 구성해 둘 수 있어요.
          </p>
          <button className="primary" onClick={() => go('providers')}>
            <KeyRound size={16} /> 공급사 · API 키 관리 <ArrowRight size={15} />
          </button>
        </div>
        <div className="connection-score">
          <strong>
            {verified.length}
            <small> / {real.length}</small>
          </strong>
          <span>연결 확인된 실제 공급사</span>
          <small>개발용 모의 AI는 집계에서 제외</small>
        </div>
      </section>
      <div className="ai-quick-policies">
        <label>
          <ShieldCheck size={21} />
          <span>
            <strong>새 AI 제작 요청 허용</strong>
            <small>중지해도 이미 실행 중인 작업은 별도로 확인하세요.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="새 AI 제작 요청 허용"
            checked={enabled}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.checked;
              void run(
                () => api('/admin/settings', 'PUT', { ai_enabled: value ? 1 : 0 }),
                value ? '새 AI 제작 요청을 허용했어요.' : '새 AI 제작 요청을 중지했어요.',
              );
            }}
          />
        </label>
        <label>
          <Globe2 size={21} />
          <span>
            <strong>중국 공급사 모델 허용</strong>
            <small>PD의 프로젝트별 제외 설정은 별도로 적용돼요.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="중국 공급사 모델 허용"
            checked={allowCn}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.checked;
              void run(
                () => api('/admin/settings', 'PUT', { ai_allow_cn: value ? 1 : 0 }),
                value ? '중국 모델 사용을 허용했어요.' : '중국 모델을 새 요청에서 제외했어요.',
              );
            }}
          />
        </label>
      </div>
      {!enabled && (
        <div className="info-box">
          현재 새 AI 제작 요청이 중지되어 있어요. 진행 중인 작업은 작업 모니터에서 확인하세요.{' '}
          <button className="text-link" onClick={() => go('jobs')}>
            작업 모니터
          </button>
        </div>
      )}
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>운영 준비 체크리스트</h3>
            <p>
              아래 상태는 등록 정보 기준이에요. 실제 품질·결제 검증은 키 등록 후 별도로 진행하세요.
            </p>
          </div>
          <span className="status-chip neutral">
            {checklist.filter((c) => c.done).length} / 4 준비
          </span>
        </div>
        <div className="ai-setup-grid">
          {checklist.map((c, i) => (
            <button key={c.text} onClick={() => go(c.tab)}>
              {c.done ? <CheckCircle2 className="lime" /> : <Circle />}
              <span>
                <small>0{i + 1}</small>
                <strong>{c.text}</strong>
                <p>{c.detail}</p>
              </span>
              <Chevron />
            </button>
          ))}
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>작업별 연결 현황</h3>
            <p>
              키·활성 상태·연결 확인·국가 정책·공급사 예산을 반영한 준비 상태입니다. PD별 한도와
              플랫폼 예산은 실행 시 추가 적용돼요.
            </p>
          </div>
        </div>
        <div className="ai-capability-grid">
          {capabilities.map((c) => {
            const list = models.filter((m) => m.capability === c);
            return (
              <button key={c} onClick={() => go('models')}>
                <Cpu size={20} />
                <strong>{capabilityLabel[c]}</strong>
                <span className={'status-chip ' + (!enabled || !list.length ? 'neutral' : '')}>
                  {!enabled
                    ? '운영 중지'
                    : list.length
                      ? `${list.length}개 연결 확인`
                      : '연결 준비 필요'}
                </span>
                <small>
                  {list
                    .slice(0, 2)
                    .map((m) => m.label)
                    .join(' · ') || '모델 · 가격에서 설정하세요'}
                </small>
              </button>
            );
          })}
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>공급사 준비 상태</h3>
            <p>중국 모델도 동일한 화면에서 키·지역·모델·예산을 관리해요.</p>
          </div>
        </div>
        <div className="creator-project-toolbar">
          <label className="creator-search">
            <Search size={16} />
            <input
              aria-label="AI 공급사 검색"
              placeholder="공급사 이름 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="공급사 국가 필터"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            <option value="all">모든 국가</option>
            <option value="cn">중국 공급사</option>
            <option value="other">중국 외 공급사</option>
          </select>
        </div>
        <div className="ai-provider-readiness">
          {rows.map((p) => (
            <article key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <small>
                  {p.country || '국가 미설정'} ·{' '}
                  {data.models.filter((m) => m.provider_id === p.id).length}개 모델 · 이번 달{' '}
                  {won(p.month_cost)}
                </small>
              </div>
              <span className={'status-chip ' + (reason(p) === '연결 확인됨' ? '' : 'neutral')}>
                {reason(p)}
              </span>
              <button className="secondary compact" onClick={() => go('providers')}>
                연결 설정
              </button>
            </article>
          ))}
        </div>
        {!rows.length && (
          <div className="info-box">
            {real.length
              ? '검색 조건에 맞는 공급사가 없어요.'
              : '등록된 실제 공급사가 없어요. 공급사 프리셋을 추가한 뒤, 준비가 되면 API 키를 등록하세요.'}
          </div>
        )}
      </section>
    </div>
  );
}
function Chevron() {
  return <ArrowRight size={15} />;
}
