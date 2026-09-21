import { useEffect, useState } from 'react';
import { ArrowLeft, Coins, Gift, History, ShieldCheck, Sparkles } from 'lucide-react';
import {
  api,
  moment,
  pingTypeLabel,
  pings,
  won,
  type PingProduct,
  type PingState,
  type User,
  type Wallet,
} from './api';
import { Modal, navigate } from './App';

// 핑 충전 화면. 지금은 테스트 결제이고, PG·인앱결제가 연동되면 결제 승인 후 같은 적립 로직을 탑니다.
export default function PingsPage({
  user,
  demo,
  returnTo,
  notify,
  onCharged,
}: {
  user: User | null;
  demo: boolean;
  returnTo: string;
  notify: (s: string) => void;
  onCharged: () => Promise<void>;
}) {
  const [state, setState] = useState<PingState | null>(null),
    [error, setError] = useState(''),
    [pick, setPick] = useState<PingProduct | null>(null),
    [busy, setBusy] = useState(false);
  const load = () =>
    api<PingState>('/pings')
      .then(setState)
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (user) void load();
  }, [user]);
  if (!user)
    return (
      <div className="page-content pings-page">
        <h1>핑 충전</h1>
        <p className="muted">로그인하면 핑을 충전하고 회차를 열 수 있어요.</p>
        <button className="primary" onClick={() => navigate('login')}>
          로그인
        </button>
      </div>
    );
  if (error) return <div className="page-content pings-page"><p className="muted">{error}</p></div>;
  if (!state)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const wallet: Wallet = state.wallet;
  const unit = state.policy.unit_won;
  const charge = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const r = await api<{ wallet: Wallet; pings: number; bonus: number }>('/pings/charge', 'POST', {
        productId: pick.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setPick(null);
      await Promise.all([load(), onCharged()]);
      notify(
        `${pings(r.pings + r.bonus)}을 충전했어요. 보유 ${pings(r.wallet.total)}` +
          (returnTo ? ' · 보던 화면으로 돌아갈게요.' : ''),
      );
      if (returnTo) navigate(returnTo);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page-content pings-page">
      {returnTo && (
        <button className="text-link back-link" onClick={() => navigate(returnTo)}>
          <ArrowLeft size={15} /> 보던 화면으로 돌아가기
        </button>
      )}
      <span className="eyebrow lime">SHORTPING PING</span>
      <h1>핑 충전</h1>
      <div className="wallet-card">
        <div>
          <span>
            <Coins size={16} /> 보유 핑
          </span>
          <strong>{pings(wallet.total)}</strong>
        </div>
        <dl>
          <div>
            <dt>충전 핑</dt>
            <dd>{pings(wallet.paid)}</dd>
          </div>
          <div>
            <dt>보너스 핑</dt>
            <dd>{pings(wallet.bonus)}</dd>
          </div>
        </dl>
        <p>
          1핑 = {won(unit)} 기준 · 회차는 보통 {pings(state.policy.default_episode_pings)}
          {state.policy.title_unlock_discount > 0 &&
            ` · 작품 전체 열기 ${state.policy.title_unlock_discount}% 할인`}
        </p>
      </div>
      <div className="section-heading">
        <h3>충전 상품</h3>
        <span className="muted">보너스 핑부터 먼저 사용돼요</span>
      </div>
      <div className="ping-products">
        {state.products.map((p) => (
          <button key={p.id} className="ping-product" onClick={() => setPick(p)}>
            {p.badge && <span className="ping-badge">{p.badge}</span>}
            <strong>
              <Coins size={17} />
              {pings(p.pings)}
            </strong>
            {p.bonus_pings > 0 ? (
              <small className="lime">
                <Gift size={12} /> +{pings(p.bonus_pings)} 보너스
              </small>
            ) : (
              <small>&nbsp;</small>
            )}
            <b>{won(p.price)}</b>
          </button>
        ))}
      </div>
      {!state.products.length && <p className="muted">판매 중인 충전 상품이 없어요.</p>}
      <div className="info-box">
        <ShieldCheck size={18} />
        {demo
          ? '개발용 테스트 결제입니다. 실제 청구는 발생하지 않고, 충전 내역과 핑이 DB에 저장됩니다.'
          : '결제 연동을 준비하고 있어요. 곧 충전할 수 있어요.'}
        <br />
        충전한 핑으로 회차를 열면 그 매출이 작품을 만든 PD에게 정산됩니다.
      </div>
      <div className="section-heading">
        <h3>
          <History size={17} /> 핑 내역
        </h3>
      </div>
      <div className="ping-ledger">
        {state.ledger.map((l) => {
          const delta = Number(l.paid_delta) + Number(l.bonus_delta);
          return (
            <div key={l.id} className="ping-ledger-row">
              <span className={'ledger-type ' + l.type}>{pingTypeLabel[l.type] || l.type}</span>
              <div>
                <strong>
                  {l.type === 'spend' && l.title
                    ? `${l.title} ${l.episode ? l.episode + '화' : '전체 열기'}`
                    : l.memo || pingTypeLabel[l.type]}
                </strong>
                <small>
                  {moment(l.created_at)}
                  {Number(l.bonus_delta) !== 0 &&
                    ` · 보너스 ${Number(l.bonus_delta) > 0 ? '+' : ''}${l.bonus_delta}`}
                </small>
              </div>
              <b className={delta > 0 ? 'lime' : ''}>
                {delta > 0 ? '+' : ''}
                {pings(delta)}
              </b>
            </div>
          );
        })}
        {!state.ledger.length && <p className="muted">아직 핑 내역이 없어요.</p>}
      </div>
      {pick && (
        <Modal title="핑 충전하기" close={() => !busy && setPick(null)}>
          <div className="checkout-product">
            <Sparkles size={42} className="lime" />
            <div>
              <h3>
                {pings(pick.pings)}
                {pick.bonus_pings > 0 && ` + 보너스 ${pings(pick.bonus_pings)}`}
              </h3>
              <p>충전 후 보유 {pings(wallet.total + pick.pings + pick.bonus_pings)}</p>
            </div>
          </div>
          <div className="checkout-price">
            <span>결제 금액</span>
            <strong>{won(pick.price)}</strong>
          </div>
          <div className="info-box">
            <ShieldCheck size={18} />
            {demo
              ? '개발용 테스트 결제입니다. 실제 결제나 청구는 발생하지 않습니다.'
              : '실제 결제 연동을 준비하고 있어요.'}
          </div>
          <button className="primary full" disabled={busy || !demo} onClick={charge}>
            {busy ? '처리 중…' : '테스트 결제로 충전하기'}
          </button>
        </Modal>
      )}
    </div>
  );
}
