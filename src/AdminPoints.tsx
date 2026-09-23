import { useCallback, useEffect, useState } from 'react';
import {
  Calculator,
  Coins,
  Gift,
  History,
  Info,
  Package,
  Percent,
  Plus,
  Smartphone,
  Trash2,
  Users,
} from 'lucide-react';
import {
  api,
  moment,
  pingChannelLabel,
  pingTypeLabel,
  pings,
  won,
  type AdminPings,
  type Member,
  type PingProduct,
} from './api';
import { Empty, Modal } from './App';

// 슈퍼관리자 포인트(핑) 관리: 현황 · 충전 상품 · 가격 정책 · 분배 비율 · 지급/회수.
type Tab = 'overview' | 'products' | 'policy' | 'rates' | 'adjust';
const tabs: { id: Tab; name: string; icon: typeof Coins }[] = [
  { id: 'overview', name: '현황', icon: Coins },
  { id: 'products', name: '충전 상품', icon: Package },
  { id: 'policy', name: '가격 정책', icon: Calculator },
  { id: 'rates', name: '분배 비율', icon: Percent },
  { id: 'adjust', name: '지급 · 회수', icon: Gift },
];
const emptyProduct = {
  channel: 'web' as PingProduct['channel'],
  name: '',
  price: 10000,
  pings: 100,
  bonus_pings: 0,
  badge: '',
  active: true,
  sort_order: 0,
};
const n = (v: unknown) => Number(v) || 0;

export default function AdminPoints({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState<Tab>('overview'),
    [data, setData] = useState<AdminPings | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<AdminPings>('/admin/pings'));
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
  if (error)
    return <Empty title="포인트 현황을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
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
      {tab === 'overview' && <Overview data={data} />}
      {tab === 'products' && <Products data={data} busy={busy} run={run} />}
      {tab === 'policy' && <Policy data={data} busy={busy} run={run} />}
      {tab === 'rates' && <Rates data={data} busy={busy} run={run} />}
      {tab === 'adjust' && <Adjust data={data} busy={busy} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<unknown>, message: string) => Promise<boolean>;

function Overview({ data }: { data: AdminPings }) {
  const s = data.summary;
  const cash = data.charges.reduce((t, c) => t + n(c.amount), 0);
  const fee = data.charges.reduce((t, c) => t + n(c.channel_fee), 0);
  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <Coins size={18} />
            <span>충전 결제액</span>
          </div>
          <strong>{won(cash)}</strong>
          <small>결제 채널 수수료 {won(fee)} · 순매출 {won(cash - fee)}</small>
        </div>
        <div className="stat-card">
          <div>
            <Gift size={18} />
            <span>발행 핑</span>
          </div>
          <strong>{pings(n(s.issued_paid) + n(s.issued_bonus))}</strong>
          <small>
            충전 {pings(s.issued_paid)} · 보너스·지급 {pings(s.issued_bonus)}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <History size={18} />
            <span>사용 핑</span>
          </div>
          <strong>{pings(s.spent)}</strong>
          <small>
            PD 판매액 {won(n(data.sales.gross))} · PD 몫 {won(n(data.sales.net))}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <Info size={18} />
            <span>미사용 핑 (부채)</span>
          </div>
          <strong>{pings(n(s.outstanding_paid) + n(s.outstanding_bonus))}</strong>
          <small>앞으로 정산될 수 있는 최대 {won(s.liability)}</small>
        </div>
      </div>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>결제 채널별 충전</h3>
            <p>채널 수수료를 뺀 순매출만 PD와 플랫폼이 나눕니다.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>채널</th>
                <th>건수</th>
                <th>결제액</th>
                <th>채널 수수료</th>
                <th>순매출</th>
                <th>충전 · 보너스 핑</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map(({ id, fee_rate }) => {
                const c = data.charges.find((x) => x.channel === id);
                return (
                  <tr key={id}>
                    <td>
                      <strong>{pingChannelLabel[id]}</strong>
                      <small>수수료 {fee_rate}%</small>
                    </td>
                    <td>{n(c?.count)}건</td>
                    <td className="nowrap">{won(n(c?.amount))}</td>
                    <td className="nowrap">{won(n(c?.channel_fee))}</td>
                    <td className="nowrap">{won(n(c?.amount) - n(c?.channel_fee))}</td>
                    <td className="nowrap">
                      {pings(n(c?.pings))} · {pings(n(c?.bonus))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <Ledger rows={data.ledger} />
    </>
  );
}

function Ledger({ rows }: { rows: AdminPings['ledger'] }) {
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>핑 거래 내역</h3>
          <p>최근 {rows.length}건 · 충전 · 사용 · 관리자 지급 · 회수</p>
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
                const delta = n(l.paid_delta) + n(l.bonus_delta);
                return (
                  <tr key={l.id}>
                    <td className="nowrap">{moment(l.created_at)}</td>
                    <td>
                      <strong>{l.user_name}</strong>
                      <small>{l.user_email}</small>
                    </td>
                    <td>
                      <span className={'status-chip ' + (l.type === 'spend' ? 'neutral' : '')}>
                        {pingTypeLabel[l.type] || l.type}
                      </span>
                    </td>
                    <td>
                      {l.type === 'spend' && l.title
                        ? `${l.title} ${l.episode ? l.episode + '화' : '전체'}`
                        : l.memo}
                      {l.actor_name && <small>처리 {l.actor_name}</small>}
                    </td>
                    <td className="nowrap">
                      {delta > 0 ? '+' : ''}
                      {pings(delta)}
                      {n(l.bonus_delta) !== 0 && <small>보너스 {l.bonus_delta}</small>}
                    </td>
                    <td className="nowrap">{pings(n(l.paid_after) + n(l.bonus_after))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="아직 핑 거래가 없어요" text="충전이나 지급이 생기면 여기에 쌓입니다." />
      )}
    </section>
  );
}

function Products({ data, busy, run }: { data: AdminPings; busy: boolean; run: Run }) {
  const [channel, setChannel] = useState<PingProduct['channel']>('web'),
    [editing, setEditing] = useState<(typeof emptyProduct & { id?: string }) | null>(null);
  const list = data.products.filter((p) => p.channel === channel);
  const fee = data.channels.find((c) => c.id === channel)?.fee_rate ?? 0;
  const unit = data.settings.ping_unit_won;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>충전 상품</h3>
          <p>기준 {won(10000)} = {pings(10000 / unit)}. 보너스 구간과 뱃지를 자유롭게 정하세요.</p>
        </div>
        <button
          className="primary compact"
          onClick={() => setEditing({ ...emptyProduct, channel, sort_order: list.length })}
        >
          <Plus size={16} /> 상품 추가
        </button>
      </div>
      <div className="member-tabs">
        {(['web', 'app_store', 'google_play'] as const).map((c) => (
          <button key={c} className={channel === c ? 'active' : ''} onClick={() => setChannel(c)}>
            {c === 'web' ? <Coins size={15} /> : <Smartphone size={15} />}
            {pingChannelLabel[c]}
            <i>{data.products.filter((p) => p.channel === c).length}</i>
          </button>
        ))}
      </div>
      {channel !== 'web' && (
        <div className="info-box">
          <Info size={18} />
          인앱결제는 아직 연동 전이라 앱에서는 판매되지 않습니다. 스토어 수수료 {fee}%를 뺀 금액이
          순매출이 되므로, 웹과 같은 순매출을 원하면 앱 가격을 약{' '}
          {won(Math.ceil(10000 / (1 - fee / 100) / 100) * 100)}(웹 {won(10000)} 기준)으로 잡으세요.
          스토어 가격 등급에 맞춰 조정해야 합니다.
        </div>
      )}
      {list.length ? (
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>상품</th>
                <th>가격</th>
                <th>충전 + 보너스</th>
                <th>1핑 순매출</th>
                <th>판매</th>
                <th>상태</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const unitNet = (p.price * (100 - fee)) / 100 / p.pings;
                const bonusRate = p.pings ? Math.round((p.bonus_pings / p.pings) * 1000) / 10 : 0;
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>{p.badge || '뱃지 없음'} · 순서 {p.sort_order}</small>
                    </td>
                    <td className="nowrap">{won(p.price)}</td>
                    <td className="nowrap">
                      {pings(p.pings)}
                      {p.bonus_pings > 0 && (
                        <small className="lime">
                          +{pings(p.bonus_pings)} ({bonusRate}%)
                        </small>
                      )}
                    </td>
                    <td className="nowrap">{won(Math.floor(unitNet * 10) / 10)}</td>
                    <td>{n(p.sold)}건</td>
                    <td>
                      <span className={'status-chip ' + (p.active ? '' : 'neutral')}>
                        {p.active ? '판매 중' : '중지'}
                      </span>
                    </td>
                    <td className="nowrap">
                      <button
                        className="secondary compact"
                        onClick={() =>
                          setEditing({
                            id: p.id,
                            channel: p.channel,
                            name: p.name,
                            price: p.price,
                            pings: p.pings,
                            bonus_pings: p.bonus_pings,
                            badge: p.badge,
                            active: !!p.active,
                            sort_order: n(p.sort_order),
                          })
                        }
                      >
                        수정
                      </button>{' '}
                      <button
                        className="secondary compact"
                        aria-label={p.name + ' 삭제'}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api('/admin/pings/products/' + p.id, 'DELETE'),
                            n(p.sold) ? '판매 이력이 있어 판매 중지로 바꿨어요.' : '상품을 삭제했어요.',
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="등록된 상품이 없어요" text="상품 추가로 충전 구간을 만들어 주세요." />
      )}
      {editing && (
        <Modal title={editing.id ? '충전 상품 수정' : '충전 상품 추가'} close={() => !busy && setEditing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const { id, ...body } = editing;
              const ok = await run(
                () =>
                  id
                    ? api('/admin/pings/products/' + id, 'PATCH', body)
                    : api('/admin/pings/products', 'POST', body),
                '충전 상품을 저장했어요.',
              );
              if (ok) setEditing(null);
            }}
          >
            <div className="form-columns">
              <label>
                채널
                <select
                  value={editing.channel}
                  onChange={(e) =>
                    setEditing({ ...editing, channel: e.target.value as PingProduct['channel'] })
                  }
                >
                  {(['web', 'app_store', 'google_play'] as const).map((c) => (
                    <option key={c} value={c}>
                      {pingChannelLabel[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                상품명
                <input
                  value={editing.name}
                  maxLength={40}
                  required
                  placeholder="예: 300핑"
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
            </div>
            <div className="form-columns">
              <label>
                가격 (원)
                <input
                  type="number"
                  min={100}
                  max={10000000}
                  value={editing.price}
                  onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })}
                  required
                />
              </label>
              <label>
                충전 핑
                <input
                  type="number"
                  min={1}
                  value={editing.pings}
                  onChange={(e) => setEditing({ ...editing, pings: Number(e.target.value) })}
                  required
                />
              </label>
              <label>
                보너스 핑
                <input
                  type="number"
                  min={0}
                  value={editing.bonus_pings}
                  onChange={(e) => setEditing({ ...editing, bonus_pings: Number(e.target.value) })}
                />
              </label>
            </div>
            <div className="form-columns">
              <label>
                뱃지
                <input
                  value={editing.badge}
                  maxLength={12}
                  placeholder="예: 인기, 최대 혜택"
                  onChange={(e) => setEditing({ ...editing, badge: e.target.value })}
                />
              </label>
              <label>
                표시 순서
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={editing.sort_order}
                  onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })}
                />
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                판매 중
              </label>
            </div>
            <div className="info-box">
              <Info size={18} />
              기준가로는 {pings(Math.floor(editing.price / unit))}에 해당합니다. 보너스 핑도 사용되면
              같은 단가로 PD에게 정산되고, 그 비용은 플랫폼이 부담합니다. 이미 충전된 핑의 단가는
              바뀌지 않습니다.
            </div>
            <button className="primary full" disabled={busy}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}

function Policy({ data, busy, run }: { data: AdminPings; busy: boolean; run: Run }) {
  const pick = () => ({
    ping_unit_won: data.settings.ping_unit_won,
    default_episode_pings: data.settings.default_episode_pings,
    title_unlock_discount: data.settings.title_unlock_discount,
    platform_fee_rate: data.settings.platform_fee_rate,
    pg_fee_rate: data.settings.pg_fee_rate,
    app_store_fee_rate: data.settings.app_store_fee_rate,
    google_play_fee_rate: data.settings.google_play_fee_rate,
  });
  const [form, setForm] = useState(pick);
  const num = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: Number(e.target.value) });
  // 1만원 충전 → 5핑 회차 1편을 열었을 때 채널별로 PD·플랫폼이 받는 금액
  const sample = [
    { id: 'web', fee: form.pg_fee_rate },
    { id: 'app_store', fee: form.app_store_fee_rate },
    { id: 'google_play', fee: form.google_play_fee_rate },
  ].map(({ id, fee }) => {
    // 입력을 지우는 중(0)에는 0으로 나누지 않도록 최소 1원으로 계산합니다.
    const unitNet = (10000 * (100 - fee)) / 100 / (10000 / Math.max(1, Number(form.ping_unit_won) || 1));
    const gross = Math.floor(unitNet * form.default_episode_pings);
    const platform = Math.round((gross * form.platform_fee_rate) / 100);
    return { id, fee, gross, platform, pd: gross - platform, store: Math.round((10000 * fee) / 100) };
  });
  const tenLocked = 10 * form.default_episode_pings;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>핑 가격 정책</h3>
          <p>바꾼 값은 저장 이후의 충전·사용부터 적용됩니다. 이미 기록된 정산은 그대로입니다.</p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await run(() => api('/admin/settings', 'PUT', form), '핑 가격 정책을 저장했어요.');
        }}
      >
        <h4 className="spaced-title">핑 가격</h4>
        <div className="form-columns">
          <label>
            1핑 기준가 (원)
            <input type="number" min={1} max={10000} value={form.ping_unit_won} onChange={num('ping_unit_won')} required />
          </label>
          <label>
            기본 회차 가격 (핑)
            <input type="number" min={1} max={1000} value={form.default_episode_pings} onChange={num('default_episode_pings')} required />
          </label>
          <label>
            작품 전체 열기 할인 (%)
            <input type="number" min={0} max={90} step={1} value={form.title_unlock_discount} onChange={num('title_unlock_discount')} required />
          </label>
        </div>
        <p className="muted settings-note">
          예) 잠긴 회차 10편 = {pings(tenLocked)} → 전체 열기{' '}
          {pings(Math.max(form.default_episode_pings, Math.ceil((tenLocked * (100 - form.title_unlock_discount)) / 100)))}
          . 작품마다 회차 핑은 ‘작품 판매 설정’에서 따로 정할 수 있어요.
        </p>
        <h4 className="spaced-title">분배 · 결제 채널 수수료</h4>
        <div className="form-columns">
          <label>
            플랫폼 몫 (%) · 공통
            <input type="number" min={0} max={90} step={0.1} value={form.platform_fee_rate} onChange={num('platform_fee_rate')} required />
          </label>
          <label>
            웹 결제(PG) 수수료 (%)
            <input type="number" min={0} max={20} step={0.1} value={form.pg_fee_rate} onChange={num('pg_fee_rate')} required />
          </label>
        </div>
        <div className="form-columns">
          <label>
            App Store 수수료 (%)
            <input type="number" min={0} max={50} step={0.1} value={form.app_store_fee_rate} onChange={num('app_store_fee_rate')} required />
          </label>
          <label>
            Google Play 수수료 (%)
            <input type="number" min={0} max={50} step={0.1} value={form.google_play_fee_rate} onChange={num('google_play_fee_rate')} required />
          </label>
        </div>
        <div className="info-box">
          <Info size={18} />
          정산 방식: 결제 채널 수수료(PG · 스토어)를 먼저 빼고, 남은 순매출을 PD {100 - form.platform_fee_rate} : 플랫폼{' '}
          {form.platform_fee_rate}로 나눕니다. 그래서 인앱결제 수수료가 붙어도 PD·플랫폼 비율은 그대로 지켜지고,
          같은 핑이라도 인앱으로 충전된 핑은 정산 금액이 수수료만큼 적어집니다.
        </div>
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>{won(10000)} 충전 후 {pings(form.default_episode_pings)} 회차 1편</th>
                <th>채널 수수료</th>
                <th>판매액(순)</th>
                <th>플랫폼</th>
                <th>PD</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{pingChannelLabel[r.id]}</strong>
                    <small>충전 1만원 중 수수료 {won(r.store)}</small>
                  </td>
                  <td>{r.fee}%</td>
                  <td className="nowrap">{won(r.gross)}</td>
                  <td className="nowrap">{won(r.platform)}</td>
                  <td className="nowrap">
                    <b className="lime">{won(r.pd)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="primary full" disabled={busy}>
          {busy ? '저장 중…' : '가격 정책 저장'}
        </button>
      </form>
    </section>
  );
}

function Rates({ data, busy, run }: { data: AdminPings; busy: boolean; run: Run }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const base = data.settings.platform_fee_rate;
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>PD별 분배 비율</h3>
          <p>
            공통 비율은 PD {100 - base} : 플랫폼 {base}입니다. 특정 PD만 다르게 정할 수 있고, 저장
            이후 판매부터 적용됩니다.
          </p>
        </div>
        <Users size={22} className="lime" />
      </div>
      <div className="table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>PD</th>
              <th>현재 적용</th>
              <th>플랫폼 몫 (%)</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {data.rates.map((r) => {
              const custom = r.platform_fee_rate !== null && r.platform_fee_rate !== undefined;
              const rate = custom ? n(r.platform_fee_rate) : base;
              const value = edits[r.id] ?? String(rate);
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <small>{r.email}</small>
                  </td>
                  <td className="nowrap">
                    PD {100 - rate} : 플랫폼 {rate}
                    <small>{custom ? `개별 설정 · ${moment(r.updated_at)}` : '공통 비율'}</small>
                  </td>
                  <td>
                    <input
                      className="rate-input"
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      aria-label={r.name + ' 플랫폼 몫'}
                      value={value}
                      onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })}
                    />
                  </td>
                  <td className="nowrap">
                    <button
                      className="secondary compact"
                      disabled={busy || value === '' || Number(value) === rate}
                      onClick={() =>
                        void run(
                          () =>
                            api('/admin/pings/rates/' + r.id, 'PUT', {
                              platform_fee_rate: Number(value),
                            }),
                          `${r.name} 분배 비율을 저장했어요.`,
                        ).then((ok) => {
                          // 저장 후에는 편집값을 지워 입력창이 서버 값(rate)을 다시 보여 주게 합니다.
                          if (!ok) return;
                          setEdits((prev) => {
                            const next = { ...prev };
                            delete next[r.id];
                            return next;
                          });
                        })
                      }
                    >
                      저장
                    </button>{' '}
                    {custom && (
                      <button
                        className="secondary compact"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api('/admin/pings/rates/' + r.id, 'PUT', { platform_fee_rate: null }),
                            `${r.name}을(를) 공통 비율로 되돌렸어요.`,
                          )
                        }
                      >
                        공통으로
                      </button>
                    )}
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

function Adjust({ data, busy, run }: { data: AdminPings; busy: boolean; run: Run }) {
  const [members, setMembers] = useState<Member[]>([]),
    [query, setQuery] = useState(''),
    [form, setForm] = useState({ userId: '', action: 'grant', pings: 10, memo: '' });
  useEffect(() => {
    api<{ members: Member[] }>('/admin/members')
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }, [data]);
  const matched = members
    .filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);
  const target = members.find((m) => m.id === form.userId);
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>핑 지급 · 회수</h3>
            <p>
              보상·이벤트로 지급한 핑은 보너스 핑으로 쌓이고, 사용되면 기준가(1핑 ={' '}
              {won(data.settings.ping_unit_won)})로 PD에게 정산됩니다. 회수는 보너스 핑부터 뺍니다.
            </p>
          </div>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!target) return;
            const ok = await run(
              () => api('/admin/pings/adjust', 'POST', form),
              `${target.name}님에게 ${pings(form.pings)}을 ${form.action === 'grant' ? '지급' : '회수'}했어요.`,
            );
            if (ok) setForm({ ...form, memo: '' });
          }}
        >
          <label className="management-search">
            <Users size={17} />
            <input
              aria-label="회원 검색"
              placeholder="이름 또는 이메일로 회원 찾기"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="point-members">
            {matched.map((m) => (
              <button
                type="button"
                key={m.id}
                className={form.userId === m.id ? 'active' : ''}
                onClick={() => setForm({ ...form, userId: m.id })}
              >
                <strong>{m.name}</strong>
                <small>{m.email}</small>
                <span>{pings(n(m.ping_paid) + n(m.ping_bonus))}</span>
              </button>
            ))}
          </div>
          <div className="form-columns">
            <label>
              구분
              <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                <option value="grant">지급 (보너스 핑)</option>
                <option value="revoke">회수</option>
              </select>
            </label>
            <label>
              핑
              <input
                type="number"
                min={1}
                max={100000}
                value={form.pings}
                onChange={(e) => setForm({ ...form, pings: Number(e.target.value) })}
                required
              />
            </label>
          </div>
          <label>
            사유 (회원 내역과 운영 기록에 남습니다)
            <input
              value={form.memo}
              minLength={2}
              maxLength={200}
              required
              placeholder="예: 재생 오류 보상"
              onChange={(e) => setForm({ ...form, memo: e.target.value })}
            />
          </label>
          <button className="primary full" disabled={busy || !target}>
            {target
              ? `${target.name}님에게 ${pings(form.pings)} ${form.action === 'grant' ? '지급' : '회수'}`
              : '회원을 먼저 선택해 주세요'}
          </button>
        </form>
      </section>
      <Ledger rows={data.ledger.filter((l) => l.type === 'grant' || l.type === 'revoke')} />
    </>
  );
}
