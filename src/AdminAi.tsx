import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Clapperboard,
  Cpu,
  Download,
  KeyRound,
  Plug,
  Plus,
  RotateCcw,
  Route,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import {
  ADMIN_CAPS,
  Analytics,
  capLabel,
  capUnit,
  DiscoverModal,
  needsPrice,
  PRICE_REQUIRED,
  PriceMissingChip,
  ProjectsTab,
  RoutesTab,
  SafetyTab,
  type AdminCap,
} from './AdminAiExtra';
import AiReadiness from './AdminAiReadiness';
import {
  api,
  jobKindLabel,
  jobStatusLabel,
  lama,
  moment,
  tierLabel,
  unitLabel,
  won,
  type AdminAi,
  type AiModelRow,
  type AiProviderView,
} from './api';
import { Empty, Modal } from './App';
import { useConfirm } from './confirm';
import { asset } from './platform';

// 슈퍼관리자 · AI 연결 관리: 공급사(중국 포함)와 API 키, 모델·가격·자동 선택 규칙, 비용 한도, 작업 모니터
type Tab =
  | 'readiness'
  | 'overview'
  | 'providers'
  | 'models'
  | 'matrix'
  | 'routes'
  | 'policy'
  | 'jobs'
  | 'projects'
  | 'limits'
  | 'safety';
const tabs: { id: Tab; name: string; icon: typeof Cpu }[] = [
  { id: 'readiness', name: '연결 준비', icon: ShieldCheck },
  { id: 'overview', name: '사용 현황', icon: Activity },
  { id: 'providers', name: 'AI 공급사 · API 키', icon: KeyRound },
  { id: 'models', name: '모델 · 가격', icon: Cpu },
  { id: 'matrix', name: '모델 능력표', icon: Activity },
  { id: 'routes', name: '라우팅 규칙', icon: Route },
  { id: 'policy', name: '비용 한도 · 정책', icon: Settings2 },
  { id: 'jobs', name: '작업 모니터', icon: Plug },
  { id: 'projects', name: '프로젝트 모니터', icon: Clapperboard },
  { id: 'limits', name: 'PD별 한도', icon: Users },
  { id: 'safety', name: '안전 기록', icon: ShieldCheck },
];
const statusChip: Record<string, string> = { ok: '연결됨', error: '오류', unknown: '확인 전' };
const countryLabel: Record<string, string> = {
  US: '미국',
  CN: '중국',
  KR: '한국',
  EU: '유럽',
  JP: '일본',
};
const n = (v: unknown) => Number(v) || 0;

export default function AdminAiPanel({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState<Tab>('readiness'),
    [data, setData] = useState<AdminAi | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminAi>('/admin/ai'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      await load();
      if (message) notify(message);
      return r;
    } catch (e) {
      notify((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  if (error)
    return (
      <Empty
        title="AI 연결 정보를 불러오지 못했어요"
        text={error}
        action={() => void load()}
        label="다시 시도"
      />
    );
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  return (
    <div className="admin-points">
      <div className="member-tabs">
        {tabs.map(({ id, name, icon: Icon }) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={15} />
            {name}
          </button>
        ))}
      </div>
      {tab === 'readiness' && <AiReadiness data={data} go={setTab} busy={busy} run={run} />}
      {tab === 'overview' && <Overview data={data} />}
      {tab === 'providers' && <Providers data={data} busy={busy} run={run} />}
      {tab === 'models' && <Models data={data} busy={busy} run={run} notify={notify} />}
      {tab === 'matrix' && <ModelMatrix data={data} />}
      {tab === 'policy' && <Policy data={data} busy={busy} run={run} />}
      {tab === 'jobs' && <Jobs data={data} busy={busy} run={run} reload={load} />}
      {tab === 'limits' && <Limits data={data} busy={busy} run={run} />}
      {tab === 'routes' && <RoutesTab data={data} busy={busy} run={run} />}
      {tab === 'projects' && <ProjectsTab />}
      {tab === 'safety' && <SafetyTab />}
    </div>
  );
}
type Run = (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;

function Overview({ data }: { data: AdminAi }) {
  const m = data.usage.month;
  const budget = n(data.settings.ai_monthly_budget_won);
  const revenue = n(m.lama) * 10;
  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <Cpu size={18} />
            <span>이번 달 AI 원가</span>
          </div>
          <strong>{won(n(m.cost_won))}</strong>
          <small>
            {budget
              ? `월 예산 ${won(budget)}의 ${Math.round((n(m.cost_won) / budget) * 100)}%`
              : '월 예산 무제한'}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <Activity size={18} />
            <span>라마 매출(사용분)</span>
          </div>
          <strong>{won(revenue)}</strong>
          <small>
            {lama(n(m.lama))} · 원가 대비{' '}
            {n(m.cost_won) ? Math.round((revenue / n(m.cost_won)) * 100) + '%' : '-'}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <Plug size={18} />
            <span>작업</span>
          </div>
          <strong>{n(m.jobs)}건</strong>
          <small>
            진행 중 {n(m.active)} · 실패 {n(m.failed)}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <KeyRound size={18} />
            <span>연결된 공급사</span>
          </div>
          <strong>
            {data.providers.filter((p) => p.active && (p.has_key || p.kind === 'mock')).length}곳
          </strong>
          <small>
            모델 {data.models.filter((x) => x.active).length}개 · 중국{' '}
            {data.providers.filter((p) => p.country === 'CN').length}곳
          </small>
        </div>
      </div>
      {data.providers.some((p) => p.cooldown_until) && (
        <div className="info-box warn-box">
          <ShieldAlert size={18} />
          연속 실패로 잠시 자동 제외된 공급사:{' '}
          {data.providers
            .filter((p) => p.cooldown_until)
            .map((p) => p.name)
            .join(', ')}{' '}
          · ‘AI 공급사’ 탭에서 바로 되살릴 수 있어요.
        </div>
      )}
      {!n(data.settings.ai_allow_cn) && (
        <div className="info-box">
          중국 AI 모델 사용이 꺼져 있어요. PD 화면에서 중국 모델이 보이지 않아요.
        </div>
      )}
      <Analytics />
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>모델별 사용량 (이번 달)</h3>
          </div>
        </div>
        {data.usage.byModel.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>모델</th>
                  <th>작업</th>
                  <th>작업 수</th>
                  <th>실패</th>
                  <th>원가</th>
                  <th>라마 매출</th>
                </tr>
              </thead>
              <tbody>
                {data.usage.byModel.map((r) => (
                  <tr key={r.model_ref || r.label}>
                    <td>{r.label || '삭제된 모델'}</td>
                    <td>{capLabel(r.capability, data.capabilities)}</td>
                    <td>{n(r.jobs)}</td>
                    <td>{n(r.failed)}</td>
                    <td className="nowrap">{won(n(r.cost_won))}</td>
                    <td className="nowrap">{won(n(r.lama) * 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="이번 달 AI 작업이 없어요" text="PD가 숏핑 스튜디오를 쓰면 여기에 쌓여요." />
        )}
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>PD별 사용량 (이번 달)</h3>
          </div>
        </div>
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>PD</th>
                <th>작업</th>
                <th>사용 라마</th>
                <th>원가</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.byUser.map((r) => (
                <tr key={r.user_id}>
                  <td>
                    <strong>{r.name}</strong>
                    <small>{r.email}</small>
                  </td>
                  <td>{n(r.jobs)}</td>
                  <td>{lama(n(r.lama))}</td>
                  <td>{won(n(r.cost_won))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Providers({ data, busy, run }: { data: AdminAi; busy: boolean; run: Run }) {
  const [ask, confirmUi] = useConfirm();
  const [editing, setEditing] = useState<
    (Partial<AiProviderView> & { api_key?: string; secret?: string; clear_key?: boolean }) | null
  >(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [discover, setDiscover] = useState<AiProviderView | null>(null);
  const catalog = data.catalog;
  return (
    <>
      {confirmUi}
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>AI 공급사 · API 키</h3>
            <p>
              API 키는 서버에 암호화해 저장하고 화면에는 끝 4자리만 보여요. 키를 새로 입력할 때만
              바뀌어요. 지역 엔드포인트(중국 본토/해외)나 프록시를 쓰려면 기본 주소를 바꾸세요.
            </p>
          </div>
          <button
            className="primary compact"
            onClick={() =>
              setEditing({ kind: 'openai', name: '', base_url: '', country: 'US', active: 1 })
            }
          >
            <Plus size={15} /> 직접 추가
          </button>
        </div>
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>공급사</th>
                <th>종류</th>
                <th>국가</th>
                <th>API 키</th>
                <th>상태</th>
                <th>이번 달 원가 · 한도</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <small>{p.base_url || '기본 주소'}</small>
                  </td>
                  <td>{p.kind === 'mock' ? '개발용' : catalog[p.kind]?.label || p.kind}</td>
                  <td>{countryLabel[p.country] || p.country || '-'}</td>
                  <td className="nowrap">
                    {p.kind === 'mock' ? (
                      '필요 없음'
                    ) : p.has_key ? (
                      p.key_hint + (p.has_secret ? ' · 시크릿' : '')
                    ) : (
                      <span className="danger">미입력</span>
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        'status-chip ' +
                        (p.status === 'ok' ? '' : p.status === 'error' ? 'rejected' : 'neutral')
                      }
                    >
                      {p.active ? statusChip[p.status] || p.status : '사용 안 함'}
                    </span>
                    {(tested[p.id] || p.last_error) && (
                      <small title={tested[p.id] || p.last_error}>
                        {(tested[p.id] || p.last_error).slice(0, 60)}
                      </small>
                    )}
                    {p.cooldown_until ? (
                      <small className="danger">
                        연속 실패 {p.fail_streak}회 ·{' '}
                        {new Date(p.cooldown_until).toLocaleTimeString('ko-KR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        까지 자동 제외
                      </small>
                    ) : p.fail_streak > 0 ? (
                      <small>연속 실패 {p.fail_streak}회</small>
                    ) : null}
                  </td>
                  <td className="nowrap">
                    {won(n(p.month_cost))}
                    {n(p.monthly_budget_won) > 0 && (
                      <>
                        <small
                          className={n(p.month_cost) >= n(p.monthly_budget_won) ? 'danger' : ''}
                        >
                          / {won(n(p.monthly_budget_won))} (
                          {Math.round((n(p.month_cost) / n(p.monthly_budget_won)) * 100)}%)
                        </small>
                        <span className="mini-progress">
                          <i
                            style={{
                              width:
                                Math.min(100, (n(p.month_cost) / n(p.monthly_budget_won)) * 100) +
                                '%',
                            }}
                          />
                        </span>
                      </>
                    )}
                    <small>동시 {n(p.max_concurrency) || '제한 없음'}</small>
                  </td>
                  <td className="nowrap">
                    <button
                      className="secondary compact"
                      disabled={busy}
                      onClick={async () => {
                        const r = (await run(() =>
                          api<{ ok: boolean; message: string }>(
                            `/admin/ai/providers/${p.id}/test`,
                            'POST',
                          ),
                        )) as { ok: boolean; message: string } | null;
                        if (r)
                          setTested((x) => ({ ...x, [p.id]: (r.ok ? '✓ ' : '✗ ') + r.message }));
                      }}
                    >
                      연결 테스트
                    </button>{' '}
                    {(p.cooldown_until || p.fail_streak > 0) && (
                      <>
                        <button
                          className="secondary compact"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => api(`/admin/ai/providers/${p.id}/reset`, 'POST'),
                              `${p.name}을(를) 다시 사용해요.`,
                            )
                          }
                        >
                          <RotateCcw size={13} /> 되살리기
                        </button>{' '}
                      </>
                    )}
                    {p.has_list && p.has_key && (
                      <>
                        <button className="secondary compact" onClick={() => setDiscover(p)}>
                          <Download size={13} /> 모델 불러오기
                        </button>{' '}
                      </>
                    )}
                    {p.kind !== 'mock' && (
                      <>
                        <button className="secondary compact" onClick={() => setEditing({ ...p })}>
                          수정
                        </button>{' '}
                        <button
                          className="secondary compact"
                          aria-label={p.name + ' 삭제'}
                          disabled={busy}
                          onClick={async () => {
                            const models = data.models.filter((m) => m.provider_id === p.id).length;
                            if (
                              !(await ask({
                                title: `${p.name}을(를) 삭제할까요?`,
                                text: `저장된 API 키와 이 공급사의 모델 ${models}개도 함께 정리돼요. 사용 기록이 있으면 삭제 대신 사용 중지로 바뀌어요. 이 공급사 모델을 쓰던 라우팅 규칙은 다른 모델로 넘어가요.`,
                                ok: '공급사 삭제',
                                danger: true,
                              }))
                            )
                              return;
                            void run(
                              () => api('/admin/ai/providers/' + p.id, 'DELETE'),
                              '공급사를 정리했어요. 사용 기록이 있으면 비활성화돼요.',
                            );
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>프리셋으로 빠르게 추가</h3>
            <p>
              공급사와 추천 모델을 한 번에 만들어요. 추가 후 ‘수정’에서 API 키만 넣으면 돼요. 모델
              ID와 가격은 공급사 문서로 꼭 확인하세요.
            </p>
          </div>
        </div>
        <div className="preset-grid">
          {data.presets.map((p) => (
            <button
              key={p.name}
              disabled={busy}
              onClick={() =>
                void run(
                  () => api('/admin/ai/presets', 'POST', { name: p.name }),
                  `${p.name} 공급사와 모델 ${p.models}개를 추가했어요. API 키를 입력해 주세요.`,
                )
              }
            >
              <strong>{p.name}</strong>
              <small>
                {countryLabel[p.country] || p.country} ·{' '}
                {p.capabilities.map((c) => capLabel(c, data.capabilities)).join(' · ')} · 모델{' '}
                {p.models}개
              </small>
            </button>
          ))}
        </div>
      </section>
      {editing && (
        <Modal
          title={editing.id ? '공급사 수정' : '공급사 추가'}
          close={() => !busy && setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const body = {
                name: editing.name,
                kind: editing.kind,
                base_url: editing.base_url || '',
                region: editing.region || '',
                country: editing.country || '',
                active: !!editing.active,
                sort_order: Number(editing.sort_order || 0),
                max_concurrency: Number(editing.max_concurrency || 0),
                monthly_budget_won: Number(editing.monthly_budget_won || 0),
                ...(editing.api_key ? { api_key: editing.api_key } : {}),
                ...(editing.secret ? { secret: editing.secret } : {}),
                ...(editing.clear_key ? { clear_key: true } : {}),
              };
              const r = await run(
                () =>
                  editing.id
                    ? api('/admin/ai/providers/' + editing.id, 'PATCH', body)
                    : api('/admin/ai/providers', 'POST', body),
                '공급사를 저장했어요.',
              );
              if (r) setEditing(null);
            }}
          >
            <div className="form-columns">
              <label>
                이름
                <input
                  value={editing.name || ''}
                  required
                  maxLength={60}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label>
                종류 (API 형식)
                <select
                  value={editing.kind}
                  onChange={(e) => setEditing({ ...editing, kind: e.target.value })}
                >
                  {Object.entries(catalog).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              기본 주소 (비워 두면 {catalog[editing.kind || 'openai']?.base || '필수 입력'})
              <input
                value={editing.base_url || ''}
                maxLength={300}
                placeholder={catalog[editing.kind || 'openai']?.base}
                onChange={(e) => setEditing({ ...editing, base_url: e.target.value })}
              />
            </label>
            <div className="form-columns">
              <label>
                국가
                <select
                  value={editing.country || ''}
                  onChange={(e) => setEditing({ ...editing, country: e.target.value })}
                >
                  <option value="">선택</option>
                  {Object.entries(countryLabel).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={!!editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })}
                />
                사용
              </label>
            </div>
            <div className="form-columns">
              <label>
                동시 작업 수 (0 = 제한 없음)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editing.max_concurrency ?? 0}
                  onChange={(e) =>
                    setEditing({ ...editing, max_concurrency: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                월 원가 한도 (원 · 0 = 무제한)
                <input
                  type="number"
                  min={0}
                  value={editing.monthly_budget_won ?? 0}
                  onChange={(e) =>
                    setEditing({ ...editing, monthly_budget_won: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label>
              API 키 {editing.has_key ? `(현재 ${editing.key_hint} · 바꿀 때만 입력)` : ''}
              <input
                type="password"
                autoComplete="off"
                value={editing.api_key || ''}
                maxLength={2000}
                onChange={(e) => setEditing({ ...editing, api_key: e.target.value })}
              />
            </label>
            {catalog[editing.kind || '']?.secretLabel && (
              <label>
                {catalog[editing.kind || '']?.secretLabel}
                <input
                  type="password"
                  autoComplete="off"
                  value={editing.secret || ''}
                  maxLength={2000}
                  onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                />
              </label>
            )}
            {editing.has_key && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!!editing.clear_key}
                  onChange={(e) => setEditing({ ...editing, clear_key: e.target.checked })}
                />
                <span>저장된 키 삭제</span>
              </label>
            )}
            <div className="info-box">
              <ShieldAlert size={18} />
              중국 공급사를 쓰면 PD가 입력한 글·이미지가 중국 서버로 전송될 수 있어요. 스튜디오 이용
              약관에 고지돼 있어요.
            </div>
            <button className="primary full" disabled={busy}>
              저장
            </button>
          </form>
        </Modal>
      )}
      {discover && (
        <DiscoverModal provider={discover} data={data} run={run} close={() => setDiscover(null)} />
      )}
    </>
  );
}

const emptyModel = {
  provider_id: '',
  capability: 'video' as AdminCap,
  model_id: '',
  label: '',
  tier: 'standard',
  cost_usd: 0.1,
  price_lama: 0,
  tags: [] as string[],
  max_seconds: 10,
  image_input: true,
  active: true,
  priority: 50,
  notes: '',
};
function Models({
  data,
  busy,
  run,
  notify,
}: {
  data: AdminAi;
  busy: boolean;
  run: Run;
  notify: (s: string) => void;
}) {
  const [cap, setCap] = useState<AdminCap | 'all'>('all');
  const [ask, confirmUi] = useConfirm();
  const [editing, setEditing] = useState<
    (typeof emptyModel & { id?: string; mock?: boolean }) | null
  >(null);
  const [trying, setTrying] = useState<AiModelRow | null>(null);
  const list = data.models.filter((m) => cap === 'all' || m.capability === cap);
  const providers = data.providers.filter((p) => p.kind !== 'mock');
  const s = data.settings;
  const [factor, setFactor] = useState('1.1');
  const unpriced = data.models.filter((m) => m.active && needsPrice(m));
  return (
    <section className="management-panel">
      {confirmUi}
      <div className="panel-heading">
        <div>
          <h3>모델 · 가격 · 자동 선택</h3>
          <p>
            라마 가격은 고정 단가를 넣지 않으면 ‘원가(USD) × 환율 {n(s.usd_krw_rate)}원 × 마진{' '}
            {n(s.ai_margin_rate)}% ÷ 10원’으로 계산돼요. 자동 선택은 품질 등급 → 장면 태그 →
            우선순위 → 가격 순으로 골라요.
          </p>
        </div>
        <button
          className="primary compact"
          disabled={!providers.length}
          onClick={() => setEditing({ ...emptyModel, provider_id: providers[0]?.id || '' })}
        >
          <Plus size={15} /> 모델 추가
        </button>
      </div>
      {unpriced.length > 0 && (
        <div className="info-box warn-box">
          <ShieldAlert size={18} />
          <span>
            배경음악·효과음·입 모양 맞추기 모델은 최고관리자가 라마 고정 단가를 정해야 PD에게
            열려요. 지금 가격이 없는 모델 {unpriced.length}개(
            {unpriced
              .map((m) => m.label)
              .slice(0, 3)
              .join(', ')}
            {unpriced.length > 3 ? ' 등' : ''})는 PD 화면에 ‘준비 중’으로 보여요.
          </span>
        </div>
      )}
      <div className="member-tabs">
        {(['all', ...ADMIN_CAPS] as const).map((c) => (
          <button key={c} className={cap === c ? 'active' : ''} onClick={() => setCap(c)}>
            {c === 'all' ? '전체' : capLabel(c, data.capabilities)}
            <i>
              {c === 'all'
                ? data.models.length
                : data.models.filter((m) => m.capability === c).length}
            </i>
          </button>
        ))}
      </div>
      <div className="bulk-bar">
        <label>
          일괄 조정
          <select
            aria-label="가격 일괄 조정 작업"
            value={cap}
            onChange={(e) => setCap(e.target.value as AdminCap | 'all')}
          >
            <option value="all">전체 모델</option>
            {ADMIN_CAPS.map((c) => (
              <option key={c} value={c}>
                {capLabel(c, data.capabilities)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary compact"
          disabled={busy}
          onClick={async () => {
            // 새 기능(가격 필수) 모델의 고정 단가를 지우면 PD에게 다시 ‘준비 중’으로 닫혀요.
            const closing = cap === 'all' || PRICE_REQUIRED.includes(cap);
            if (
              closing &&
              !(await ask({
                title: '자동 계산으로 되돌릴까요?',
                text:
                  (cap === 'all' ? '전체 모델의' : `${capLabel(cap, data.capabilities)} 모델의`) +
                  ' 고정 단가를 지워요. 배경음악·효과음·입 모양 맞추기 모델은 가격이 없어지면 PD에게 ‘준비 중’으로 닫혀요.',
                ok: '자동 계산으로',
                danger: true,
              }))
            )
              return;
            void run(
              () => api('/admin/ai/models/bulk', 'POST', { action: 'auto', capability: cap }),
              '고정 단가를 지우고 자동 계산으로 되돌렸어요.',
            );
          }}
        >
          자동 계산으로
        </button>
        <label>
          현재 가격 ×
          <input
            type="number"
            step="0.05"
            min={0.1}
            max={10}
            value={factor}
            onChange={(e) => setFactor(e.target.value)}
          />
        </label>
        <button
          className="secondary compact"
          disabled={busy || !(Number(factor) >= 0.1 && Number(factor) <= 10)}
          onClick={() =>
            void run(
              () =>
                api('/admin/ai/models/bulk', 'POST', {
                  action: 'multiply',
                  factor: Number(factor),
                  capability: cap,
                }),
              `라마 가격을 ${factor}배로 고정했어요.`,
            )
          }
        >
          배율 적용
        </button>
      </div>
      <div className="table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>모델</th>
              <th>공급사</th>
              <th>작업</th>
              <th>등급</th>
              <th>원가</th>
              <th>라마 가격</th>
              <th>태그</th>
              <th>우선</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'muted-row'}>
                <td>
                  <strong>{m.label}</strong>
                  <small>{m.model_id}</small>
                </td>
                <td>
                  {m.provider_name}
                  {data.providers.find((p) => p.id === m.provider_id)?.country === 'CN' && (
                    <small className="cn-badge">중국</small>
                  )}
                </td>
                <td>{capLabel(m.capability, data.capabilities)}</td>
                <td>{tierLabel[m.tier]}</td>
                <td className="nowrap">
                  ${m.cost_usd}/{unitLabel[m.unit]}
                </td>
                <td className="nowrap">
                  {needsPrice(m) ? '-' : `${lama(m.lama_per_unit)}/${unitLabel[m.unit] || m.unit}`}
                  <small>
                    {m.price_lama > 0
                      ? '고정 단가'
                      : needsPrice(m)
                        ? `자동 계산 시 ${lama(m.lama_per_unit)}`
                        : '자동 계산'}
                  </small>
                  {needsPrice(m) && <PriceMissingChip />}
                </td>
                <td>
                  <small>{m.tags || '-'}</small>
                </td>
                <td>{m.priority}</td>
                <td className="nowrap">
                  <button
                    className="secondary compact"
                    onClick={() => setTrying(m)}
                    disabled={m.capability === 'stt' || (m.capability as AdminCap) === 'lipsync'}
                    title={
                      m.capability === 'stt'
                        ? '음성 인식 모델은 업로드 영상 자막 만들기에서 시험해 주세요.'
                        : (m.capability as AdminCap) === 'lipsync'
                          ? '입 모양 맞추기는 영상과 음성이 필요해 스튜디오 컷에서 시험해 주세요.'
                          : undefined
                    }
                  >
                    시험
                  </button>{' '}
                  <button
                    className="secondary compact"
                    onClick={() =>
                      setEditing({
                        id: m.id,
                        mock: m.kind === 'mock',
                        provider_id: m.provider_id,
                        capability: m.capability as AdminCap,
                        model_id: m.model_id,
                        label: m.label,
                        tier: m.tier,
                        cost_usd: n(m.cost_usd),
                        price_lama: n(m.price_lama),
                        tags: m.tags ? m.tags.split(',').filter(Boolean) : [],
                        max_seconds: n(m.max_seconds),
                        image_input: !!m.image_input,
                        active: !!m.active,
                        priority: n(m.priority),
                        notes: m.notes || '',
                      })
                    }
                  >
                    수정
                  </button>{' '}
                  {m.kind !== 'mock' && (
                    <button
                      className="secondary compact"
                      aria-label={m.label + ' 삭제'}
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !(await ask({
                            title: `${m.label} 모델을 삭제할까요?`,
                            text: '사용 기록이 있으면 삭제 대신 사용 중지로 바뀌어요. 이 모델을 쓰던 라우팅 규칙은 다음 모델로 넘어가요.',
                            ok: '모델 삭제',
                            danger: true,
                          }))
                        )
                          return;
                        void run(
                          () => api('/admin/ai/models/' + m.id, 'DELETE'),
                          '모델을 정리했어요.',
                        );
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal
          title={editing.id ? '모델 수정' : '모델 추가'}
          close={() => !busy && setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const { id, mock: _mock, ...body } = editing;
              const r = await run(
                () =>
                  id
                    ? api('/admin/ai/models/' + id, 'PATCH', body)
                    : api('/admin/ai/models', 'POST', body),
                '모델을 저장했어요.',
              );
              if (r) setEditing(null);
            }}
          >
            {editing.mock && (
              <div className="info-box">
                개발용 가짜 모델은 가격·등급·태그·우선순위·사용 여부만 바꿀 수 있어요.
              </div>
            )}
            <div className="form-columns">
              <label>
                공급사
                <select
                  value={editing.provider_id}
                  disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, provider_id: e.target.value })}
                >
                  {data.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                작업
                <select
                  value={editing.capability}
                  disabled={editing.mock}
                  onChange={(e) =>
                    setEditing({ ...editing, capability: e.target.value as AdminCap })
                  }
                >
                  {ADMIN_CAPS.map((c) => (
                    <option key={c} value={c}>
                      {capLabel(c, data.capabilities)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-columns">
              <label>
                화면 이름
                <input
                  value={editing.label}
                  required
                  maxLength={60}
                  disabled={editing.mock}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                />
              </label>
              <label>
                모델 ID (공급사 문서 그대로)
                <input
                  value={editing.model_id}
                  required
                  maxLength={200}
                  disabled={editing.mock}
                  placeholder="예: veo-3.1-generate-preview"
                  onChange={(e) => setEditing({ ...editing, model_id: e.target.value })}
                />
              </label>
            </div>
            <div className="form-columns">
              <label>
                품질 등급
                <select
                  value={editing.tier}
                  onChange={(e) => setEditing({ ...editing, tier: e.target.value })}
                >
                  {Object.entries(tierLabel).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                원가 USD / {unitLabel[capUnit[editing.capability]]}
                <input
                  type="number"
                  step="0.0001"
                  min={0}
                  value={editing.cost_usd}
                  onChange={(e) => setEditing({ ...editing, cost_usd: Number(e.target.value) })}
                />
              </label>
              <label>
                {PRICE_REQUIRED.includes(editing.capability)
                  ? `고정 라마 단가 (필수 · ${unitLabel[capUnit[editing.capability]]}당)`
                  : '고정 라마 단가 (0 = 자동)'}
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  value={editing.price_lama}
                  onChange={(e) => setEditing({ ...editing, price_lama: Number(e.target.value) })}
                />
              </label>
            </div>
            {PRICE_REQUIRED.includes(editing.capability) && !(editing.price_lama > 0) && (
              <div className="info-box warn-box">
                <ShieldAlert size={18} />
                {capLabel(editing.capability, data.capabilities)} 모델은 라마 고정 단가를 정해야
                PD에게 열려요. 0으로 두면 PD 화면에 ‘준비 중’으로 보여요.
              </div>
            )}
            <div className="form-columns">
              <label>
                우선순위 (0~100)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editing.priority}
                  onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })}
                />
              </label>
              {['video', 'music', 'sfx', 'lipsync'].includes(editing.capability) && (
                <label>
                  최대 길이(초)
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={editing.max_seconds}
                    disabled={editing.mock}
                    onChange={(e) =>
                      setEditing({ ...editing, max_seconds: Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                사용
              </label>
            </div>
            {editing.capability === 'video' && !editing.mock && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={editing.image_input}
                  onChange={(e) => setEditing({ ...editing, image_input: e.target.checked })}
                />
                <span>첫 장면 이미지 입력 지원 (스토리보드에서 시작하는 영상)</span>
              </label>
            )}
            <fieldset className="tag-picker">
              <legend>자동 선택 태그 (이 모델이 잘하는 장면)</legend>
              {data.tags.map((t) => (
                <label key={t} className={editing.tags.includes(t) ? 'on' : ''}>
                  <input
                    type="checkbox"
                    checked={editing.tags.includes(t)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        tags: e.target.checked
                          ? [...editing.tags, t]
                          : editing.tags.filter((x) => x !== t),
                      })
                    }
                  />
                  {t}
                </label>
              ))}
            </fieldset>
            <label>
              메모
              <input
                value={editing.notes}
                maxLength={300}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </label>
            <button className="primary full" disabled={busy}>
              저장
            </button>
          </form>
        </Modal>
      )}
      {trying && <TryModal model={trying} notify={notify} close={() => setTrying(null)} />}
    </section>
  );
}

// 관리자 모델 시험 실행: 작업이 끝날 때까지 기다리고, 창을 닫으면 확인(폴링)을 멈춥니다.
type TryJob = {
  status: string;
  error: string;
  error_detail?: string;
  output: { text?: string; url?: string };
};
const TRY_TIMEOUT_MS = 6 * 60 * 1000;
const tryPrompt = (c: string) =>
  c === 'tts'
    ? '안녕하세요, 숏핑입니다.'
    : c === 'music'
      ? '비 오는 밤 도시, 잔잔하고 쓸쓸한 피아노 배경음악'
      : c === 'sfx'
        ? '젖은 아스팔트 위를 뛰어가는 구두 발소리'
        : 'A rainy neon street at night, a woman in a trench coat looks back';
const mediaLink = (url: string) =>
  url.startsWith('/uploads/') && !/\.(mp4|mp3|wav)$/.test(url)
    ? url
    : '/api/studio/media/' + url.split('/').pop();
function TryModal({
  model,
  notify,
  close,
}: {
  model: AiModelRow;
  notify: (s: string) => void;
  close: () => void;
}) {
  const [prompt, setPrompt] = useState(() => tryPrompt(model.capability));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; url?: string; failed?: boolean } | null>(
    null,
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const start = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ id: string }>(`/admin/ai/models/${model.id}/try`, 'POST', { prompt });
      const deadline = Date.now() + TRY_TIMEOUT_MS;
      let misses = 0;
      while (alive.current) {
        await new Promise((x) => setTimeout(x, 1500));
        if (!alive.current) return;
        let j: TryJob;
        try {
          j = await api<TryJob>('/admin/ai/jobs/' + r.id);
          misses = 0;
        } catch (e) {
          // 잠깐의 네트워크 오류는 넘기고, 연달아 실패하면 멈춥니다.
          if (++misses >= 5) throw e;
          continue;
        }
        if (!alive.current) return;
        if (!['queued', 'running'].includes(j.status)) {
          if (j.status === 'succeeded') {
            setResult({
              text:
                j.output.text ||
                (j.output.url ? '완료했어요. 아래에서 결과를 확인하세요.' : '완료'),
              url: j.output.url ? mediaLink(j.output.url) : undefined,
            });
            notify('시험이 끝났어요.');
          } else {
            // 관리자 시험 실행은 정리된 문구와 공급사 원문을 함께 보여 줍니다.
            const failure =
              j.error_detail && j.error_detail !== j.error
                ? `${j.error}\n원문: ${j.error_detail}`
                : j.error;
            setResult({
              text:
                (j.status === 'canceled' ? '취소됨: ' : '실패: ') +
                (failure || '원인을 알 수 없어요.'),
              failed: true,
            });
            notify('시험이 실패했어요.');
          }
          return;
        }
        if (Date.now() > deadline) {
          setResult({
            text: '6분이 지나도 끝나지 않았어요. 작업은 계속 진행되니 ‘작업 모니터’에서 결과를 확인해 주세요.',
            failed: true,
          });
          return;
        }
      }
    } catch (e) {
      if (alive.current)
        setResult({ text: '시험을 진행하지 못했어요: ' + (e as Error).message, failed: true });
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const url = result?.url || '';
  return (
    <Modal title={`${model.label} 시험`} close={close}>
      <p className="muted">
        관리자 시험은 라마를 쓰지 않고 플랫폼 원가로 처리돼요. 결과는 작업 모니터에서도 볼 수
        있어요.{busy ? ' 창을 닫아도 작업은 계속 진행돼요.' : ''}
      </p>
      <label>
        입력
        <textarea
          value={prompt}
          rows={3}
          maxLength={500}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      {result && (
        <pre className={'try-result' + (result.failed ? ' danger' : '')}>{result.text}</pre>
      )}
      {url && (
        <div className="try-media">
          {/\.(mp4)$/.test(url) ? (
            <video src={asset(url)} controls playsInline style={{ width: '100%', maxHeight: 360 }} />
          ) : /\.(mp3|wav)$/.test(url) ? (
            <audio src={asset(url)} controls style={{ width: '100%' }} />
          ) : (
            <img src={asset(url)} alt="시험 결과" style={{ maxWidth: '100%', maxHeight: 360 }} />
          )}
          <a className="text-link" href={url} target="_blank" rel="noreferrer">
            새 창에서 결과 열기
          </a>
        </div>
      )}
      <button
        className="primary full"
        disabled={busy || prompt.trim().length < 2}
        onClick={() => void start()}
      >
        {busy ? '만드는 중… 끝날 때까지 기다려요' : result ? '다시 시험' : '시험 실행'}
      </button>
    </Modal>
  );
}

function Policy({ data, busy, run }: { data: AdminAi; busy: boolean; run: Run }) {
  const s = data.settings;
  const [f, setF] = useState({
    ai_enabled: n(s.ai_enabled),
    usd_krw_rate: n(s.usd_krw_rate),
    ai_margin_rate: n(s.ai_margin_rate),
    ai_monthly_budget_won: n(s.ai_monthly_budget_won),
    ai_daily_limit_lama: n(s.ai_daily_limit_lama),
    ai_concurrency: n(s.ai_concurrency),
    ai_blocked_terms: String(s.ai_blocked_terms || ''),
    ai_allow_cn: n(s.ai_allow_cn),
    ai_breaker_failures: n(s.ai_breaker_failures) || 5,
    ai_breaker_cooldown_min: n(s.ai_breaker_cooldown_min) || 10,
    ai_weight_cost: s.ai_weight_cost === undefined ? 50 : n(s.ai_weight_cost),
    ai_weight_speed: n(s.ai_weight_speed),
    ai_weight_reliability: n(s.ai_weight_reliability),
    ai_assistant_enabled: s.ai_assistant_enabled === undefined ? 1 : n(s.ai_assistant_enabled),
    ai_assistant_daily_limit: s.ai_assistant_daily_limit === undefined ? 100 : n(s.ai_assistant_daily_limit),
    studio_upload_enabled: s.studio_upload_enabled === undefined ? 1 : n(s.studio_upload_enabled),
    studio_upload_image_mb: n(s.studio_upload_image_mb) || 10,
    studio_upload_video_mb: n(s.studio_upload_video_mb) || 200,
    studio_upload_video_seconds: n(s.studio_upload_video_seconds) || 60,
    studio_upload_audio_mb: n(s.studio_upload_audio_mb) || 25,
    studio_upload_audio_seconds: n(s.studio_upload_audio_seconds) || 120,
  });
  // 빈 칸은 빈 칸으로 두고(저장 시 막음), 숫자만 숫자로 바꿉니다. 지운 칸이 0(무제한)으로 저장되지 않게 합니다.
  const num = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value === '' ? ('' as unknown as number) : Number(e.target.value) });
  const [ask, confirmUi] = useConfirm();
  return (
    <section className="management-panel">
      {confirmUi}
      <div className="panel-heading">
        <div>
          <h3>비용 한도 · 정책</h3>
          <p>
            플랫폼 전체 월 AI 원가 한도와 PD 하루 사용 한도를 정해요. 한도를 넘는 작업은 시작 전에
            막혀요.
          </p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const unlimited = [
            Number(f.ai_monthly_budget_won) === 0 && Number(s.ai_monthly_budget_won) !== 0
              ? '월 AI 원가 한도'
              : '',
            Number(f.ai_daily_limit_lama) === 0 && Number(s.ai_daily_limit_lama) !== 0
              ? 'PD 하루 사용 한도'
              : '',
          ].filter(Boolean);
          if (
            unlimited.length &&
            !(await ask({
              title: '한도를 없앨까요?',
              text: `${unlimited.join(', ')}를 0(무제한)으로 저장합니다. AI 원가가 제한 없이 나갈 수 있어요.`,
              ok: '무제한으로 저장',
              danger: true,
            }))
          )
            return;
          void run(() => api('/admin/settings', 'PUT', f), 'AI 정책을 저장했어요.');
        }}
      >
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!f.ai_enabled}
            onChange={(e) => setF({ ...f, ai_enabled: e.target.checked ? 1 : 0 })}
          />
          <span>AI 제작 사용 (끄면 새 작업이 모두 멈춰요. 진행 중인 작업은 끝까지 처리돼요)</span>
        </label>
        <div className="form-columns">
          <label>
            월 AI 원가 한도 (원 · 0 = 무제한)
            <input
              type="number"
              min={0}
              required
              value={f.ai_monthly_budget_won}
              onChange={num('ai_monthly_budget_won')}
            />
          </label>
          <label>
            공통 PD 하루 사용 한도 (라마 · 0 = 무제한 · PD별 한도가 있으면 그 값 우선)
            <input
              type="number"
              min={0}
              required
              value={f.ai_daily_limit_lama}
              onChange={num('ai_daily_limit_lama')}
            />
          </label>
        </div>
        <div className="form-columns">
          <label>
            환율 (원/USD)
            <input
              type="number"
              min={100}
              max={10000}
              required
              value={f.usd_krw_rate}
              onChange={num('usd_krw_rate')}
            />
          </label>
          <label>
            라마 마진 (원가 대비 %)
            <input
              type="number"
              min={100}
              max={1000}
              required
              value={f.ai_margin_rate}
              onChange={num('ai_margin_rate')}
            />
          </label>
          <label>
            동시 작업 수
            <input
              type="number"
              min={1}
              max={20}
              required
              value={f.ai_concurrency}
              onChange={num('ai_concurrency')}
            />
          </label>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!f.ai_allow_cn}
            onChange={(e) => setF({ ...f, ai_allow_cn: e.target.checked ? 1 : 0 })}
          />
          <span>
            중국 AI 모델 사용 허용 (Kling·Hailuo·Wan·Seedance·DeepSeek 등 · 끄면 PD 화면·자동
            선택·대체 모델에서 모두 빠져요)
          </span>
        </label>
        <div className="form-columns">
          <label>
            자동 제외: 연속 실패 횟수
            <input
              type="number"
              min={1}
              max={100}
              required
              value={f.ai_breaker_failures}
              onChange={num('ai_breaker_failures')}
            />
          </label>
          <label>
            자동 제외 시간 (분)
            <input
              type="number"
              min={1}
              max={1440}
              required
              value={f.ai_breaker_cooldown_min}
              onChange={num('ai_breaker_cooldown_min')}
            />
          </label>
        </div>
        <p className="muted settings-note">
          공급사가 연속으로 실패하거나 API 키가 거부(401)되면 정한 시간 동안 자동 선택에서 빼고 다른
          모델로 넘겨요.
        </p>
        <label>
          추가 금칙어 (줄마다 하나 · 기본 금칙어: 딥페이크·실존 인물·미성년 선정성 등은 항상 적용)
          <textarea
            rows={4}
            maxLength={5000}
            value={f.ai_blocked_terms}
            onChange={(e) => setF({ ...f, ai_blocked_terms: e.target.value })}
          />
        </label>
        <fieldset className="policy-group">
          <legend>자동 모델 선택 기준</legend>
          <p className="muted settings-note">
            PD가 ‘자동’으로 둘 때 무엇을 더 중요하게 볼지 정해요(0~100). 기본값(비용 50 · 속도 0 · 안정성 0)은 품질 등급과 장면 특성을 먼저 보고
            가격을 적당히 고려하는 방식이에요. 속도·안정성은 최근 14일 실적(평균 처리 시간·성공률)으로 계산해요.
          </p>
          <div className="form-columns">
            {(
              [
                ['ai_weight_cost', '비용 (저렴할수록 우선)'],
                ['ai_weight_speed', '속도 (빠를수록 우선)'],
                ['ai_weight_reliability', '안정성 (성공률 높을수록 우선)'],
              ] as const
            ).map(([k, label]) => (
              <label key={k}>
                {label} <small className="muted">{f[k]}</small>
                <input type="range" min={0} max={100} step={5} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="policy-group">
          <legend>AI 조수 (작업 공간 채팅)</legend>
          <label className="check-row">
            <input type="checkbox" checked={!!f.ai_assistant_enabled} onChange={(e) => setF({ ...f, ai_assistant_enabled: e.target.checked ? 1 : 0 })} />
            <span>AI 조수 사용 (대화는 PD에게 무료 · 원가는 플랫폼 부담 · 실행 계획 속 AI 작업만 라마 차감)</span>
          </label>
          <label>
            PD 1명의 하루 대화 수 (0 = 무제한)
            <input type="number" min={0} max={10000} required value={f.ai_assistant_daily_limit} onChange={num('ai_assistant_daily_limit')} />
          </label>
          {data.assistant && (
            <small className="muted">
              최근 24시간 대화 {data.assistant.today.toLocaleString('ko-KR')}번 · 이번 달 실행된 계획 {data.assistant.applied.toLocaleString('ko-KR')}개 · 이번 달 조수 원가 {won(data.assistant.cost_won)}
            </small>
          )}
        </fieldset>
        <fieldset className="policy-group">
          <legend>내 소재 올리기 (컷마다 PD의 사진 · 영상 · 목소리)</legend>
          <label className="check-row">
            <input type="checkbox" checked={!!f.studio_upload_enabled} onChange={(e) => setF({ ...f, studio_upload_enabled: e.target.checked ? 1 : 0 })} />
            <span>PD가 AI 대신 자기 파일을 올리거나 목소리를 녹음해 쓸 수 있게 하기</span>
          </label>
          <div className="form-columns">
            <label>
              사진 최대 크기 (MB · 1~50)
              <input type="number" min={1} max={50} required value={f.studio_upload_image_mb} onChange={num('studio_upload_image_mb')} />
            </label>
            <label>
              영상 최대 크기 (MB · 1~500)
              <input type="number" min={1} max={500} required value={f.studio_upload_video_mb} onChange={num('studio_upload_video_mb')} />
            </label>
            <label>
              영상 최대 길이 (초 · 3~300)
              <input type="number" min={3} max={300} required value={f.studio_upload_video_seconds} onChange={num('studio_upload_video_seconds')} />
            </label>
          </div>
          <div className="form-columns">
            <label>
              음성 최대 크기 (MB · 1~100)
              <input type="number" min={1} max={100} required value={f.studio_upload_audio_mb} onChange={num('studio_upload_audio_mb')} />
            </label>
            <label>
              음성·녹음 최대 길이 (초 · 3~600)
              <input type="number" min={3} max={600} required value={f.studio_upload_audio_seconds} onChange={num('studio_upload_audio_seconds')} />
            </label>
          </div>
          <small className="muted">영상은 MP4로, 음성은 MP3로 바꿔 저장해요. 컷 하나에는 영상 앞부분 최대 10초가 쓰여요.</small>
        </fieldset>
        <div className="info-box">
          예) Veo 3.1 원가 $0.75/초 × {f.usd_krw_rate}원 × {f.ai_margin_rate}% = 1초당 약{' '}
          {lama((0.75 * f.usd_krw_rate * f.ai_margin_rate) / 100 / 10)}· 5초 컷{' '}
          {lama((0.75 * f.usd_krw_rate * f.ai_margin_rate * 5) / 100 / 10)}
        </div>
        <button className="primary full" disabled={busy}>
          정책 저장
        </button>
      </form>
    </section>
  );
}

// 모델 능력표: AI 계열(브랜드)마다 어떤 작업을 할 수 있는지 · 실제 연결된 모델 · 최근 실적을 한눈에
const MATRIX_CAPS = ['text', 'image', 'video', 'tts', 'stt', 'music', 'sfx', 'lipsync'] as const;
function ModelMatrix({ data }: { data: AdminAi }) {
  const families = data.families || [];
  const models = data.models;
  const famOf = (m: AiModelRow) => m.family || 'other';
  const shown = families.filter((f) => models.some((m) => famOf(m) === f.id) || f.id !== 'mock');
  const other = models.filter((m) => !families.some((f) => f.id === famOf(m)));
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>모델 능력표</h3>
          <p>
            AI 계열마다 원래 할 수 있는 작업(●)과 숏핑에 연결된 모델 수를 보여 줘요. PD 화면에서는 이 표를 바탕으로 “Claude는 영상을 만들 수 없어요 → 다른 모델
            추천”처럼 안내해요.
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="management-table matrix-table">
          <thead>
            <tr>
              <th>AI 계열</th>
              {MATRIX_CAPS.map((c) => (
                <th key={c}>{data.capabilities[c] || c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.id}>
                <td>
                  <b>{f.name}</b>
                  <small className="muted"> {f.maker}</small>
                </td>
                {MATRIX_CAPS.map((c) => {
                  const list = models.filter((m) => famOf(m) === f.id && m.capability === c);
                  const on = list.filter((m) => Number(m.active)).length;
                  const can = f.caps.includes(c);
                  return (
                    <td key={c} className={on ? 'on' : can ? 'can' : 'no'} title={list.map((m) => m.label).join(', ')}>
                      {on ? `● ${on}` : can ? '○' : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted settings-note">● 연결·사용 중인 모델 수 · ○ 할 수 있지만 연결 안 됨 · — 할 수 없는 작업</p>
      <h4 className="matrix-sub">연결된 모델 실적 (최근 14일)</h4>
      <div className="table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>모델</th>
              <th>작업</th>
              <th>등급</th>
              <th>잘하는 것</th>
              <th>단가</th>
              <th>작업 수</th>
              <th>성공률</th>
              <th>평균 시간</th>
            </tr>
          </thead>
          <tbody>
            {[...models]
              .sort((a, b) => a.capability.localeCompare(b.capability) || Number(b.priority) - Number(a.priority))
              .map((m) => (
                <tr key={m.id} className={Number(m.active) ? '' : 'muted'}>
                  <td>
                    <b>{m.label}</b>
                    <small className="muted"> {m.provider_name}</small>
                  </td>
                  <td>{data.capabilities[m.capability] || m.capability}</td>
                  <td>{tierLabel[m.tier] || m.tier}</td>
                  <td>{m.tags || '-'}</td>
                  <td>
                    {lama(m.lama_per_unit)}/{unitLabel[m.unit] || m.unit}
                  </td>
                  <td>{m.stats?.jobs ?? 0}</td>
                  <td className={m.stats?.success != null && m.stats.success < 0.8 ? 'danger' : ''}>{m.stats?.success != null ? Math.round(m.stats.success * 100) + '%' : '-'}</td>
                  <td>{m.stats?.seconds ? m.stats.seconds + '초' : '-'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {other.length > 0 && <p className="muted settings-note">계열을 알 수 없는 모델: {other.map((m) => m.label).join(', ')} — PD 화면에는 그대로 보이지만 계열 안내는 나오지 않아요.</p>}
    </section>
  );
}

function Jobs({
  data,
  busy,
  run,
  reload,
}: {
  data: AdminAi;
  busy: boolean;
  run: Run;
  reload: () => Promise<void>;
}) {
  const [filter, setFilter] = useState('all');
  const [ask, confirmUi] = useConfirm();
  const list = data.jobs.filter((j) => filter === 'all' || j.status === filter);
  return (
    <section className="management-panel">
      {confirmUi}
      <div className="panel-heading">
        <div>
          <h3>작업 모니터</h3>
          <p>최근 150건. 대기 중이거나 멈춘 작업은 취소하면 예약한 라마를 전액 돌려줘요.</p>
        </div>
        <button className="secondary compact" onClick={() => void reload()}>
          새로고침
        </button>
      </div>
      <div className="member-tabs">
        {['all', 'queued', 'running', 'succeeded', 'failed', 'canceled'].map((s) => (
          <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>
            {s === 'all' ? '전체' : jobStatusLabel[s]}
            <i>{s === 'all' ? data.jobs.length : data.jobs.filter((j) => j.status === s).length}</i>
          </button>
        ))}
      </div>
      <div className="table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>시각</th>
              <th>PD</th>
              <th>작업</th>
              <th>모델</th>
              <th>상태</th>
              <th>라마</th>
              <th>원가</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {list.map((j) => (
              <tr key={j.id}>
                <td className="nowrap">{moment(j.created_at)}</td>
                <td>{j.user_name}</td>
                <td>
                  {jobKindLabel[j.kind] || j.kind}
                  <small>
                    {j.requested_model === 'auto' ? `자동 · ${tierLabel[j.tier]}` : '직접 선택'}
                  </small>
                </td>
                <td>
                  {j.model_label || '-'}
                  <small>{j.provider_name}</small>
                </td>
                <td>
                  <span
                    className={
                      'status-chip ' +
                      (j.status === 'succeeded'
                        ? ''
                        : j.status === 'failed'
                          ? 'rejected'
                          : 'neutral')
                    }
                  >
                    {jobStatusLabel[j.status]}
                  </span>
                  {j.error && (
                    <small title={j.error}>
                      <b>PD 안내</b> {j.error.slice(0, 60)}
                    </small>
                  )}
                  {j.error_detail && j.error_detail !== j.error && (
                    <small className="error-detail" title={j.error_detail}>
                      <b>원문</b> {j.error_detail.slice(0, 120)}
                    </small>
                  )}
                  {j.attempts > 0 && <small>재시도 {j.attempts}회</small>}
                </td>
                <td className="nowrap">
                  {j.billed
                    ? `${lama(j.status === 'succeeded' ? j.charged_lama : j.estimate_lama)}`
                    : '무료(시험)'}
                </td>
                <td className="nowrap">{won(n(j.cost_won))}</td>
                <td>
                  {['queued', 'running'].includes(j.status) && (
                    <button
                      className="secondary compact"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          !(await ask({
                            title: '작업을 취소하고 환불할까요?',
                            text: `${j.user_name} PD의 ‘${jobKindLabel[j.kind] || j.kind}’ 작업을 멈추고 예약한 ${lama(j.estimate_lama)}를 돌려줘요. 공급사에서 이미 만들고 있던 결과는 버려지고, 공급사 원가는 청구될 수 있어요.`,
                            ok: '취소 · 환불',
                            danger: true,
                          }))
                        )
                          return;
                        void run(
                          () => api(`/admin/ai/jobs/${j.id}/cancel`, 'POST'),
                          '작업을 취소하고 라마를 돌려줬어요.',
                        );
                      }}
                    >
                      취소 · 환불
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.length && (
        <Empty title="작업이 없어요" text="PD가 숏핑 스튜디오를 쓰면 여기에 쌓여요." />
      )}
    </section>
  );
}

function Limits({ data, busy, run }: { data: AdminAi; busy: boolean; run: Run }) {
  const [edits, setEdits] = useState<
    Record<string, { daily: string; monthly: string; blocked: boolean }>
  >({});
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>PD별 AI 사용 한도</h3>
          <p>
            하루 한도를 비워 두면 공통 하루 한도(
            {n(data.settings.ai_daily_limit_lama)
              ? lama(n(data.settings.ai_daily_limit_lama))
              : '제한 없음'}
            )를, 월 한도를 비워 두면 제한 없음을 따라요.{' '}
            <b>0을 넣으면 그 기간에는 라마가 드는 작업을 할 수 없어요.</b> ‘이용 제한’을 켜면 모든
            새 작업이 막혀요.
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>PD</th>
              <th>하루 한도(라마)</th>
              <th>월 한도(라마)</th>
              <th>이용 제한</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {data.limits.map((l) => {
              const e = edits[l.id] || {
                daily: l.daily_lama == null ? '' : String(l.daily_lama),
                monthly: l.monthly_lama == null ? '' : String(l.monthly_lama),
                blocked: !!n(l.blocked),
              };
              const set = (v: Partial<typeof e>) => setEdits({ ...edits, [l.id]: { ...e, ...v } });
              return (
                <tr key={l.id}>
                  <td>
                    <strong>{l.name}</strong>
                    <small>{l.email}</small>
                  </td>
                  <td>
                    <input
                      className="rate-input"
                      type="number"
                      min={0}
                      placeholder="공통"
                      value={e.daily}
                      onChange={(ev) => set({ daily: ev.target.value })}
                      aria-label={l.name + ' 하루 한도'}
                    />
                  </td>
                  <td>
                    <input
                      className="rate-input"
                      type="number"
                      min={0}
                      placeholder="없음"
                      value={e.monthly}
                      onChange={(ev) => set({ monthly: ev.target.value })}
                      aria-label={l.name + ' 월 한도'}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={e.blocked}
                      onChange={(ev) => set({ blocked: ev.target.checked })}
                      aria-label={l.name + ' 이용 제한'}
                    />
                  </td>
                  <td>
                    <button
                      className="secondary compact"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            api('/admin/ai/limits/' + l.id, 'PUT', {
                              daily_lama: e.daily === '' ? null : Number(e.daily),
                              monthly_lama: e.monthly === '' ? null : Number(e.monthly),
                              blocked: e.blocked,
                            }),
                          `${l.name} 한도를 저장했어요.`,
                        )
                      }
                    >
                      저장
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
