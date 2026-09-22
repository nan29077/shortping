import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, Plus, RefreshCw, Search, X } from 'lucide-react';
import {
  api,
  capabilityLabel,
  jobKindLabel,
  lama,
  moment,
  tierLabel,
  won,
  type AdminAi,
  type AiAnalytics,
  type AiProjectRow,
  type AiProviderView,
  type AiSafetyRow,
  type Capability,
} from './api';
import { Empty, Modal } from './App';

type Run = (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
const n = (v: unknown) => Number(v) || 0;
const countryLabel: Record<string, string> = { US: '미국', CN: '중국', KR: '한국', EU: '유럽', JP: '일본' };

// ── 일별 원가·매출 차트 + 모델 상태표 ───────────────────────────
export function Analytics() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<AiAnalytics | null>(null);
  const [err, setErr] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api<AiAnalytics>('/admin/ai/analytics?days=' + days)
      .then((r) => alive && (setD(r), setErr('')))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [days]);
  const series = d?.series || [];
  const max = Math.max(1, ...series.map((s) => Math.max(n(s.cost_won), n(s.lama) * 10)));
  const W = 720,
    H = 180,
    pad = 28;
  const bw = series.length ? (W - pad) / series.length : 0;
  const totals = series.reduce((a, s) => ({ cost: a.cost + n(s.cost_won), rev: a.rev + n(s.lama) * 10, jobs: a.jobs + n(s.jobs), failed: a.failed + n(s.failed) }), { cost: 0, rev: 0, jobs: 0, failed: 0 });
  const h = hover !== null ? series[hover] : null;
  const y = (v: number) => H - 20 - (v / max) * (H - 36);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>일별 AI 원가 · 라마 매출</h3>
          <p>
            최근 {days}일 · 원가 {won(totals.cost)} · 매출 {won(totals.rev)} · 작업 {totals.jobs}건 (실패 {totals.failed})
          </p>
        </div>
        <div className="segmented">
          {[7, 30, 90].map((x) => (
            <button key={x} className={days === x ? 'active' : ''} onClick={() => setDays(x)}>
              {x}일
            </button>
          ))}
        </div>
      </div>
      {err && <p className="danger">{err}</p>}
      {d && (
        <>
          <div className="chart-legend">
            <span>
              <i className="cost" /> AI 원가
            </span>
            <span>
              <i className="rev" /> 라마 매출
            </span>
            <span className="chart-readout">{h ? `${h.day} · 원가 ${won(n(h.cost_won))} · 매출 ${won(n(h.lama) * 10)} · 작업 ${h.jobs}건${h.failed ? ` (실패 ${h.failed})` : ''}` : '막대에 올려 보면 날짜별 값이 보여요'}</span>
          </div>
          <svg className="ai-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`최근 ${days}일 일별 AI 원가와 라마 매출 막대 차트`} onMouseLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((t) => (
              <g key={t}>
                <line x1={pad} x2={W} y1={y(max * t)} y2={y(max * t)} className="grid" />
                <text x={0} y={y(max * t) + 3} className="axis">
                  {max * t >= 10000 ? Math.round((max * t) / 10000) + '만' : Math.round(max * t)}
                </text>
              </g>
            ))}
            {series.map((s, i) => {
              const x = pad + i * bw;
              const w = Math.max(1, bw / 2 - 1);
              return (
                <g key={s.day} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                  <rect x={x} y={0} width={bw} height={H} fill="transparent" />
                  <rect className="bar cost" x={x + 1} y={y(n(s.cost_won))} width={w} height={H - 20 - y(n(s.cost_won))} rx={2} />
                  <rect className="bar rev" x={x + 1 + w} y={y(n(s.lama) * 10)} width={w} height={H - 20 - y(n(s.lama) * 10)} rx={2} />
                  {s.failed > 0 && <circle cx={x + bw / 2} cy={H - 8} r={2.5} className="fail-dot" />}
                  {(i === 0 || i === series.length - 1 || (series.length > 10 && i % Math.ceil(series.length / 6) === 0)) && (
                    <text x={x + bw / 2} y={H - 2} textAnchor="middle" className="axis">
                      {s.day.slice(5)}
                    </text>
                  )}
                  {hover === i && <rect x={x} y={4} width={bw} height={H - 24} className="hover" />}
                </g>
              );
            })}
          </svg>
          <h4 className="sub-heading">모델 상태 (최근 {days}일)</h4>
          {d.models.length ? (
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>모델</th>
                    <th>작업</th>
                    <th>성공률</th>
                    <th>평균 소요</th>
                    <th>재시도</th>
                    <th>원가</th>
                    <th>매출</th>
                  </tr>
                </thead>
                <tbody>
                  {d.models.map((m) => (
                    <tr key={m.model_ref}>
                      <td>
                        <strong>{m.label}</strong>
                        <small>
                          {m.provider} {m.country ? `· ${countryLabel[m.country] || m.country}` : ''} · {capabilityLabel[m.capability] || m.capability}
                        </small>
                      </td>
                      <td>{m.jobs}</td>
                      <td>
                        <span className={'health ' + (m.success_rate >= 95 ? 'good' : m.success_rate >= 80 ? 'mid' : 'bad')}>{m.success_rate}%</span>
                      </td>
                      <td>{m.avg_seconds === null ? '-' : m.avg_seconds + '초'}</td>
                      <td>{m.retries}</td>
                      <td className="nowrap">{won(m.cost_won)}</td>
                      <td className="nowrap">{won(m.lama * 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">아직 기록이 없어요.</p>
          )}
        </>
      )}
    </section>
  );
}

// ── 공급사 모델 목록 불러오기 → 바로 등록 ─────────────────────────
export function DiscoverModal({ provider, data, run, close }: { provider: AiProviderView; data: AdminAi; run: Run; close: () => void }) {
  const [list, setList] = useState<{ id: string; added: boolean }[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const caps = (data.catalog[provider.kind]?.capabilities || ['text']) as Capability[];
  const [cap, setCap] = useState<Capability>(caps[0]);
  const [cost, setCost] = useState('');
  const [tier, setTier] = useState('standard');
  const load = async () => {
    setErr('');
    try {
      const r = await api<{ models: { id: string; added: boolean }[] }>(`/admin/ai/providers/${provider.id}/discover`, 'POST');
      setList(r.models);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const shown = (list || []).filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()));
  const add = async (id: string) => {
    const r = await run(
      () =>
        api('/admin/ai/models', 'POST', {
          provider_id: provider.id,
          capability: cap,
          model_id: id,
          label: id.slice(0, 60),
          tier,
          cost_usd: Number(cost),
          price_lama: 0,
          tags: [],
          max_seconds: 10,
          image_input: cap === 'video',
          active: true,
          priority: 50,
          notes: '모델 목록에서 추가',
        }),
      `${id} 모델을 추가했어요. ‘모델 · 가격’에서 태그·가격을 다듬어 주세요.`,
    );
    if (r) setList((l) => l && l.map((m) => (m.id === id ? { ...m, added: true } : m)));
  };
  return (
    <Modal title={`${provider.name} 모델 불러오기`} close={close}>
      <p className="muted">공급사 API에서 쓸 수 있는 모델 ID를 불러왔어요. 작업 종류와 원가를 정한 뒤 ‘추가’를 누르세요. 원가는 공급사 가격표로 꼭 확인하세요.</p>
      <div className="form-columns">
        <label>
          작업
          <select value={cap} onChange={(e) => setCap(e.target.value as Capability)}>
            {caps.map((c) => (
              <option key={c} value={c}>
                {capabilityLabel[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          품질 등급
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {Object.entries(tierLabel).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          원가 USD (단위당)
          <input type="number" step="0.0001" min={0} value={cost} placeholder="필수" onChange={(e) => setCost(e.target.value)} />
        </label>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input value={q} placeholder="모델 ID 검색" onChange={(e) => setQ(e.target.value)} />
      </label>
      {err && (
        <p className="danger">
          {err}{' '}
          <button className="text-link" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}
      {!list && !err && <p className="muted">불러오는 중…</p>}
      <div className="discover-list">
        {shown.map((m) => (
          <div key={m.id}>
            <code>{m.id}</code>
            {m.added ? (
              <span className="status-chip neutral">등록됨</span>
            ) : (
              <button className="secondary compact" disabled={cost === '' || Number(cost) < 0} onClick={() => void add(m.id)}>
                <Plus size={13} /> 추가
              </button>
            )}
          </div>
        ))}
        {list && !shown.length && <p className="muted">맞는 모델이 없어요.</p>}
      </div>
    </Modal>
  );
}

// ── 라우팅 규칙: 작업 × 품질 등급별로 먼저 쓸 모델 순서 ───────────────
export function RoutesTab({ data, busy, run }: { data: AdminAi; busy: boolean; run: Run }) {
  const caps: Capability[] = ['text', 'image', 'tts', 'video'];
  const tiers = ['draft', 'standard', 'premium'];
  const [edit, setEdit] = useState<{ capability: Capability; tier: string; ids: string[]; active: boolean } | null>(null);
  const rule = (c: string, t: string) => data.routes.find((r) => r.capability === c && r.tier === t);
  const label = (id: string) => data.models.find((m) => m.id === id);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>라우팅 규칙</h3>
          <p>
            PD가 ‘자동 선택’을 고르면 여기서 정한 순서대로 모델을 써요. 앞 모델이 실패·일시 차단·예산 초과면 다음 모델로 넘어가고, 규칙이
            없으면 품질 등급 → 장면 태그 → 우선순위 → 가격 순으로 자동으로 골라요.
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="management-table route-table">
          <thead>
            <tr>
              <th>작업</th>
              {tiers.map((t) => (
                <th key={t}>{tierLabel[t]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {caps.map((c) => (
              <tr key={c}>
                <td>
                  <strong>{capabilityLabel[c]}</strong>
                </td>
                {tiers.map((t) => {
                  const r = rule(c, t);
                  const ids = r ? r.model_ids.split(',').filter(Boolean) : [];
                  return (
                    <td key={t}>
                      <button className={'route-cell' + (r && !r.active ? ' off' : '')} onClick={() => setEdit({ capability: c, tier: t, ids, active: r ? !!r.active : true })}>
                        {ids.length ? (
                          <ol>
                            {ids.map((id) => (
                              <li key={id}>{label(id)?.label || '삭제된 모델'}</li>
                            ))}
                          </ol>
                        ) : (
                          <span className="muted">자동</span>
                        )}
                        {r && !r.active && <small>꺼짐</small>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={`${capabilityLabel[edit.capability]} · ${tierLabel[edit.tier]} 규칙`} close={() => !busy && setEdit(null)}>
          <p className="muted">위에 있는 모델부터 써요. 비우고 저장하면 자동 선택으로 돌아가요.</p>
          <ol className="route-edit">
            {edit.ids.map((id, i) => {
              const m = label(id);
              return (
                <li key={id}>
                  <span>
                    <b>{i + 1}</b> {m?.label || '삭제된 모델'} <small>{m ? `${m.provider_name}${data.providers.find((p) => p.id === m.provider_id)?.country === 'CN' ? ' · 중국' : ''}` : ''}</small>
                  </span>
                  <button aria-label="위로" disabled={i === 0} onClick={() => setEdit({ ...edit, ids: edit.ids.map((x, j) => (j === i - 1 ? id : j === i ? edit.ids[i - 1] : x)) })}>
                    <ArrowUp size={13} />
                  </button>
                  <button aria-label="아래로" disabled={i === edit.ids.length - 1} onClick={() => setEdit({ ...edit, ids: edit.ids.map((x, j) => (j === i + 1 ? id : j === i ? edit.ids[i + 1] : x)) })}>
                    <ArrowDown size={13} />
                  </button>
                  <button aria-label="빼기" onClick={() => setEdit({ ...edit, ids: edit.ids.filter((x) => x !== id) })}>
                    <X size={13} />
                  </button>
                </li>
              );
            })}
          </ol>
          <label>
            모델 추가
            <select
              value=""
              onChange={(e) => e.target.value && edit.ids.length < 10 && setEdit({ ...edit, ids: [...edit.ids, e.target.value] })}
            >
              <option value="">모델 고르기</option>
              {data.models
                .filter((m) => m.capability === edit.capability && m.active && !edit.ids.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.provider_name} · {tierLabel[m.tier]} · {lama(m.lama_per_unit)}
                  </option>
                ))}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
            <span>이 규칙 사용</span>
          </label>
          <button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              const r = await run(() => api('/admin/ai/routes', 'PUT', { capability: edit.capability, tier: edit.tier, model_ids: edit.ids, active: edit.active }), edit.ids.length ? '라우팅 규칙을 저장했어요.' : '자동 선택으로 되돌렸어요.');
              if (r) setEdit(null);
            }}
          >
            저장
          </button>
        </Modal>
      )}
    </section>
  );
}

const apStatus: Record<string, string> = { running: '자동 제작 중', paused: '자동 제작 멈춤', done: '자동 제작 완료', stopped: '자동 제작 중지' };
const dramaStatus: Record<string, string> = { draft: '임시저장', pending: '심사 대기', published: '공개 중', rejected: '반려', hidden: '노출 중단' };
// ── 모든 PD의 스튜디오 프로젝트 ────────────────────────────────
export function ProjectsTab() {
  const [rows, setRows] = useState<AiProjectRow[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = () =>
    api<AiProjectRow[]>('/admin/ai/projects')
      .then((r) => (setRows(r), setErr('')))
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    void load();
  }, []);
  const shown = useMemo(() => (rows || []).filter((r) => !q || `${r.title} ${r.owner_name} ${r.owner_email}`.toLowerCase().includes(q.toLowerCase())), [rows, q]);
  const ap = (raw: string) => {
    try {
      return raw ? (JSON.parse(raw) as { status: string; message: string }) : null;
    } catch {
      return null;
    }
  };
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>프로젝트 모니터</h3>
          <p>PD들이 숏핑 스튜디오에서 만들고 있는 프로젝트와 사용 라마·원가, 자동 제작 상태를 봐요.</p>
        </div>
        <button className="secondary compact" onClick={() => void load()}>
          <RefreshCw size={14} /> 새로고침
        </button>
      </div>
      <label className="search-field">
        <Search size={14} />
        <input value={q} placeholder="제목·PD 이름·이메일" onChange={(e) => setQ(e.target.value)} />
      </label>
      {err && <p className="danger">{err}</p>}
      {rows && !rows.length ? (
        <Empty title="아직 스튜디오 프로젝트가 없어요" text="PD가 숏핑 스튜디오에서 프로젝트를 만들면 여기에 보여요." />
      ) : (
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>프로젝트</th>
                <th>PD</th>
                <th>진행</th>
                <th>라마 / 원가</th>
                <th>상태</th>
                <th>수정</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const a = ap(r.autopilot);
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.title}</strong>
                      <small>
                        {r.genre} · {r.episode_count}화{n(r.exclude_cn) ? ' · 중국 모델 제외' : ''}
                      </small>
                    </td>
                    <td>
                      {r.owner_name}
                      <small>{r.owner_email}</small>
                    </td>
                    <td className="nowrap">
                      합성 {n(r.composed)}/{r.episode_count} · 컷 {n(r.shots)}
                      {n(r.active) > 0 && <small className="lime">작업 {r.active}건 진행 중</small>}
                    </td>
                    <td className="nowrap">
                      {lama(n(r.spent))}
                      <small>원가 {won(n(r.cost_won))}</small>
                    </td>
                    <td>
                      {a && (
                        <span className={'status-chip ' + (a.status === 'running' ? '' : 'neutral')} title={a.message}>
                          <Bot size={11} /> {apStatus[a.status] || a.status}
                        </span>
                      )}
                      {r.drama_status && <small>작품: {dramaStatus[r.drama_status] || r.drama_status}</small>}
                    </td>
                    <td className="nowrap">{moment(r.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── 금칙어로 막힌 요청 기록 ─────────────────────────────────
export function SafetyTab() {
  const [rows, setRows] = useState<AiSafetyRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<AiSafetyRow[]>('/admin/ai/safety')
      .then(setRows)
      .catch((e) => setErr((e as Error).message));
  }, []);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>안전 기록</h3>
          <p>금칙어(딥페이크·실존 인물·미성년 선정성 등, 정책 탭의 추가 금칙어 포함)에 걸려 시작 전에 막힌 요청이에요. 라마는 쓰이지 않았어요.</p>
        </div>
      </div>
      {err && <p className="danger">{err}</p>}
      {rows && !rows.length ? (
        <Empty title="막힌 요청이 없어요" text="금칙어에 걸린 요청이 생기면 여기에 남아요." />
      ) : (
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>PD</th>
                <th>금칙어</th>
                <th>요청 내용 일부</th>
                <th>구분</th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{moment(r.created_at)}</td>
                  <td>
                    {r.user_name}
                    <small>{r.user_email}</small>
                  </td>
                  <td>
                    <span className="status-chip rejected">{r.term}</span>
                  </td>
                  <td>
                    <small>{r.excerpt}</small>
                  </td>
                  <td>{jobKindLabel[r.kind] || r.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
