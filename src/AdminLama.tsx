import { useCallback, useEffect, useState } from 'react';
import { Gift, History, Package, Plus, Settings2, Sparkles, Trash2, Wallet } from 'lucide-react';
import { api, lama, lamaTypeLabel, moment, won, type AdminLama, type LamaProduct } from './api';
import { Empty, Modal } from './App';

// 슈퍼관리자 · 라마 관리: 현황, 충전 상품, 지급·회수, 지갑·내역, 전환·체험 정책
type Tab = 'overview' | 'products' | 'adjust' | 'policy';
const n = (v: unknown) => Number(v) || 0;
const emptyProduct = { name: '', price: 10000, lama: 1000, bonus_lama: 0, badge: '', active: true, sort_order: 0 };

export default function AdminLamaPanel({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview'),
    [data, setData] = useState<AdminLama | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<(typeof emptyProduct & { id?: string }) | null>(null),
    [adjust, setAdjust] = useState({ userId: '', action: 'grant', lama: 100, memo: '' }),
    [policy, setPolicy] = useState<{ lama_signup_bonus: number; lama_convert_min: number; lama_convert_bonus_rate: number } | null>(null);
  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api<AdminLama>('/admin/lama'), api<{ settings: Record<string, number> }>('/admin/settings')]);
      setData(d);
      setPolicy((cur) => cur || { lama_signup_bonus: n(s.settings.lama_signup_bonus), lama_convert_min: n(s.settings.lama_convert_min), lama_convert_bonus_rate: n(s.settings.lama_convert_bonus_rate) });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      notify(message);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (error) return <Empty title="라마 현황을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data || !policy)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const s = data.summary;
  const target = data.wallets.find((w) => w.id === adjust.userId);
  return (
    <div className="admin-points">
      <div className="member-tabs">
        {(
          [
            ['overview', '현황', Wallet],
            ['products', '충전 상품', Package],
            ['adjust', '지급 · 회수', Gift],
            ['policy', '전환 · 체험 정책', Settings2],
          ] as const
        ).map(([id, name, Icon]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon size={15} />
            {name}
          </button>
        ))}
      </div>
      {tab === 'overview' && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <div>
                <Wallet size={18} />
                <span>라마 충전 결제액</span>
              </div>
              <strong>{won(s.charge_amount)}</strong>
              <small>
                {n(s.charge_count)}건 · PG 수수료 {won(s.charge_fee)}
              </small>
            </div>
            <div className="stat-card">
              <div>
                <Sparkles size={18} />
                <span>AI 제작에 쓴 라마</span>
              </div>
              <strong>{lama(s.spent_lama)}</strong>
              <small>
                ≈ {won(s.spent_won)} · AI 원가 {won(s.ai_cost_won)} · 이익 {won(s.spent_won - s.ai_cost_won)}
              </small>
            </div>
            <div className="stat-card">
              <div>
                <History size={18} />
                <span>정산 → 라마 전환</span>
              </div>
              <strong>{won(s.convert_amount)}</strong>
              <small>
                {n(s.convert_count)}건 · {lama(s.convert_lama)} 지급
              </small>
            </div>
            <div className="stat-card">
              <div>
                <Gift size={18} />
                <span>미사용 라마 (부채)</span>
              </div>
              <strong>{lama(s.outstanding_paid + s.outstanding_bonus)}</strong>
              <small>
                충전 {lama(s.outstanding_paid)} · 보너스 {lama(s.outstanding_bonus)} · 예약 {lama(s.held)}
              </small>
            </div>
          </div>
          <section className="management-panel">
            <div className="panel-heading">
              <div>
                <h3>PD 라마 지갑</h3>
              </div>
            </div>
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>PD</th>
                    <th>충전</th>
                    <th>보너스</th>
                    <th>예약 중</th>
                  </tr>
                </thead>
                <tbody>
                  {data.wallets.map((w) => (
                    <tr key={w.id}>
                      <td>
                        <strong>{w.name}</strong>
                        <small>{w.email}</small>
                      </td>
                      <td>{lama(n(w.paid))}</td>
                      <td>{lama(n(w.bonus))}</td>
                      <td>{lama(n(w.held))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <Ledger rows={data.ledger} />
        </>
      )}
      {tab === 'products' && (
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>라마 충전 상품</h3>
              <p>기준 1라마 = 10원. PD 스튜디오(웹)에서만 판매해요. 판매 이력이 있는 상품은 삭제 대신 판매 중지돼요.</p>
            </div>
            <button className="primary compact" onClick={() => setEditing({ ...emptyProduct, sort_order: data.products.length })}>
              <Plus size={15} /> 상품 추가
            </button>
          </div>
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>상품</th>
                  <th>가격</th>
                  <th>라마 + 보너스</th>
                  <th>판매</th>
                  <th>상태</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p: LamaProduct) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>{p.badge || '뱃지 없음'}</small>
                    </td>
                    <td>{won(p.price)}</td>
                    <td>
                      {lama(p.lama)}
                      {p.bonus_lama > 0 && <small className="lime">+{lama(p.bonus_lama)} ({Math.round((p.bonus_lama / p.lama) * 1000) / 10}%)</small>}
                    </td>
                    <td>{n(p.sold)}건</td>
                    <td>
                      <span className={'status-chip ' + (p.active ? '' : 'neutral')}>{p.active ? '판매 중' : '중지'}</span>
                    </td>
                    <td className="nowrap">
                      <button className="secondary compact" onClick={() => setEditing({ id: p.id, name: p.name, price: p.price, lama: p.lama, bonus_lama: p.bonus_lama, badge: p.badge, active: !!p.active, sort_order: n(p.sort_order) })}>
                        수정
                      </button>{' '}
                      <button className="secondary compact" aria-label={p.name + ' 삭제'} disabled={busy} onClick={() => void run(() => api('/admin/lama/products/' + p.id, 'DELETE'), '상품을 정리했어요.')}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tab === 'adjust' && (
        <>
          <section className="management-panel">
            <div className="panel-heading">
              <div>
                <h3>라마 지급 · 회수</h3>
                <p>지급한 라마는 보너스 라마로 쌓여요. 회수는 보너스부터 빼며, 예약 중인 라마는 회수할 수 없어요.</p>
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api('/admin/lama/adjust', 'POST', adjust), `${target?.name}님에게 ${lama(adjust.lama)}를 ${adjust.action === 'grant' ? '지급' : '회수'}했어요.`).then((ok) => ok && setAdjust({ ...adjust, memo: '' }));
              }}
            >
              <label>
                PD
                <select value={adjust.userId} required onChange={(e) => setAdjust({ ...adjust, userId: e.target.value })}>
                  <option value="">선택</option>
                  {data.wallets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.email}) · {lama(n(w.paid) + n(w.bonus))}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-columns">
                <label>
                  구분
                  <select value={adjust.action} onChange={(e) => setAdjust({ ...adjust, action: e.target.value })}>
                    <option value="grant">지급 (보너스)</option>
                    <option value="revoke">회수</option>
                  </select>
                </label>
                <label>
                  라마
                  <input type="number" min={1} value={adjust.lama} onChange={(e) => setAdjust({ ...adjust, lama: Number(e.target.value) })} />
                </label>
              </div>
              <label>
                사유
                <input value={adjust.memo} minLength={2} maxLength={200} required placeholder="예: 제작 지원 이벤트" onChange={(e) => setAdjust({ ...adjust, memo: e.target.value })} />
              </label>
              <button className="primary full" disabled={busy || !target}>
                {target ? `${target.name}님에게 ${lama(adjust.lama)} ${adjust.action === 'grant' ? '지급' : '회수'}` : 'PD를 선택해 주세요'}
              </button>
            </form>
          </section>
          <Ledger rows={data.ledger.filter((l) => ['grant', 'revoke', 'welcome'].includes(l.type))} />
        </>
      )}
      {tab === 'policy' && (
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>전환 · 체험 정책</h3>
              <p>PD가 정산 수익을 라마로 바꿀 때의 최소 금액과 보너스, 처음 방문한 PD에게 주는 체험 라마를 정해요.</p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api('/admin/settings', 'PUT', policy), '라마 정책을 저장했어요.');
            }}
          >
            <div className="form-columns">
              <label>
                체험 라마 (PD 첫 방문)
                <input type="number" min={0} max={100000} value={policy.lama_signup_bonus} onChange={(e) => setPolicy({ ...policy, lama_signup_bonus: Number(e.target.value) })} />
              </label>
              <label>
                전환 최소 금액 (원)
                <input type="number" min={0} value={policy.lama_convert_min} onChange={(e) => setPolicy({ ...policy, lama_convert_min: Number(e.target.value) })} />
              </label>
              <label>
                전환 보너스 (%)
                <input type="number" min={0} max={50} step={0.5} value={policy.lama_convert_bonus_rate} onChange={(e) => setPolicy({ ...policy, lama_convert_bonus_rate: Number(e.target.value) })} />
              </label>
            </div>
            <div className="info-box">
              전환은 출금과 같은 세금 규칙(비사업자 원천징수, 사업자 부가세 가산)을 적용한 지급액을 라마로 드리고, 세무 대장에 ‘라마
              전환’ 지급으로 남아요. 전환 보너스는 보너스 라마로 지급돼요.
            </div>
            <button className="primary full" disabled={busy}>
              저장
            </button>
          </form>
        </section>
      )}
      {editing && (
        <Modal title={editing.id ? '충전 상품 수정' : '충전 상품 추가'} close={() => !busy && setEditing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const { id, ...body } = editing;
              const ok = await run(() => (id ? api('/admin/lama/products/' + id, 'PATCH', body) : api('/admin/lama/products', 'POST', body)), '충전 상품을 저장했어요.');
              if (ok) setEditing(null);
            }}
          >
            <label>
              상품명
              <input value={editing.name} required maxLength={40} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <div className="form-columns">
              <label>
                가격 (원)
                <input type="number" min={1000} value={editing.price} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value), lama: Math.floor(Number(e.target.value) / 10) })} />
              </label>
              <label>
                라마
                <input type="number" min={1} value={editing.lama} onChange={(e) => setEditing({ ...editing, lama: Number(e.target.value) })} />
              </label>
              <label>
                보너스 라마
                <input type="number" min={0} value={editing.bonus_lama} onChange={(e) => setEditing({ ...editing, bonus_lama: Number(e.target.value) })} />
              </label>
            </div>
            <div className="form-columns">
              <label>
                뱃지
                <input value={editing.badge} maxLength={12} onChange={(e) => setEditing({ ...editing, badge: e.target.value })} />
              </label>
              <label>
                순서
                <input type="number" min={0} max={999} value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} />
              </label>
              <label className="inline-check">
                <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                판매 중
              </label>
            </div>
            <button className="primary full" disabled={busy}>
              저장
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Ledger({ rows }: { rows: AdminLama['ledger'] }) {
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>라마 거래 내역</h3>
          <p>최근 {rows.length}건</p>
        </div>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>일시</th>
                <th>회원</th>
                <th>구분</th>
                <th>내용</th>
                <th>변동</th>
                <th>잔액</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const d = n(l.paid_delta) + n(l.bonus_delta);
                return (
                  <tr key={l.id}>
                    <td className="nowrap">{moment(l.created_at)}</td>
                    <td>
                      <strong>{l.user_name}</strong>
                      <small>{l.user_email}</small>
                    </td>
                    <td>{lamaTypeLabel[l.type] || l.type}</td>
                    <td>
                      {l.memo}
                      {l.actor_name && <small>처리 {l.actor_name}</small>}
                    </td>
                    <td className="nowrap">
                      {d > 0 ? '+' : ''}
                      {lama(d)}
                      {n(l.held_delta) !== 0 && <small>예약 {n(l.held_delta) > 0 ? '+' : ''}{lama(n(l.held_delta))}</small>}
                    </td>
                    <td className="nowrap">{lama(n(l.paid_after) + n(l.bonus_after))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="라마 거래가 없어요" text="충전이나 지급이 생기면 여기에 쌓여요." />
      )}
    </section>
  );
}
