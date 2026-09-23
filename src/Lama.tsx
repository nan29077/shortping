import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Gift, History, Info, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { api, lama, lamaTypeLabel, moment, uuid, won, type LamaProduct, type LamaState } from './api';
import { Empty, Modal } from './App';

// PD 라마 지갑: 충전(테스트 결제) · 정산 수익 전환 · 사용 내역
export default function LamaWalletPanel({ notify, onChanged }: { notify: (s: string) => void; onChanged?: () => void }) {
  const [state, setState] = useState<LamaState | null>(null),
    [error, setError] = useState(''),
    [pick, setPick] = useState<LamaProduct | null>(null),
    [converting, setConverting] = useState(false),
    [busy, setBusy] = useState(false);
  // 같은 상품 결제창에서 다시 누르면 같은 멱등키를 써서, 응답이 끊겨도 두 번 충전되지 않게 합니다.
  const chargeKey = useMemo(() => (pick ? uuid() : ''), [pick]);
  const load = useCallback(async () => {
    try {
      setState(await api<LamaState>('/lama'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Empty title="라마 지갑을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!state)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const w = state.wallet;
  const p = state.policy;
  const tax = Math.floor((state.convertible * p.withholding_rate) / 110);
  const payable = state.convertible - tax - Math.floor(tax * 0.1);
  const convertLama = Math.ceil(payable / p.unit_won);
  const convertBonus = Math.floor((convertLama * p.convert_bonus_rate) / 100);
  return (
    <div className="lama-panel">
      <div className="wallet-card lama-card">
        <div>
          <span>
            <Sparkles size={16} /> 사용 가능한 라마
          </span>
          <strong>{lama(w.total)}</strong>
        </div>
        <dl>
          <div>
            <dt>충전 라마</dt>
            <dd>{lama(w.paid)}</dd>
          </div>
          <div>
            <dt>보너스 라마</dt>
            <dd>{lama(w.bonus)}</dd>
          </div>
          <div>
            <dt>작업 예약 중</dt>
            <dd>{lama(w.held)}</dd>
          </div>
        </dl>
        <p>
          1라마 = {won(p.unit_won)} · AI 작업을 시작할 때 예상 라마를 예약하고, 끝나면 실제 사용량만 차감한 뒤 나머지를
          돌려드려요. 실패하면 전액 돌려드려요.
          {p.daily_limit > 0 && ` · 하루 사용 한도 ${lama(p.daily_limit)}`}
        </p>
      </div>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>라마 충전</h3>
            <p>숏핑 스튜디오의 기획·이미지·음성·영상 제작에 써요. 보너스 라마부터 먼저 사용돼요.</p>
          </div>
        </div>
        <div className="ping-products">
          {state.products.map((x) => (
            <button key={x.id} className="ping-product" onClick={() => setPick(x)}>
              {x.badge && <span className="ping-badge">{x.badge}</span>}
              <strong>
                <Sparkles size={17} />
                {lama(x.lama)}
              </strong>
              {x.bonus_lama > 0 ? (
                <small className="lime">
                  <Gift size={12} /> +{lama(x.bonus_lama)} 보너스
                </small>
              ) : (
                <small>&nbsp;</small>
              )}
              <b>{won(x.price)}</b>
            </button>
          ))}
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>
              <ArrowRightLeft size={17} /> 정산 수익을 라마로 바꾸기
            </h3>
            <p>
              출금 가능한 정산 금액 전액을 라마로 바꿔요. 출금과 같은 세금 규칙(비사업자 원천징수{' '}
              {p.withholding_rate}%, 사업자 부가세 {p.vat_rate}% 가산)을 적용한 금액이 라마로 들어와요.
            </p>
          </div>
        </div>
        <div className="convert-box">
          <div>
            <span>출금 가능 정산 금액</span>
            <strong>{won(state.convertible)}</strong>
          </div>
          <div>
            <span>바뀔 라마(비사업자 기준 예상)</span>
            <strong className="lime">
              {state.convertible > 0 ? lama(convertLama + convertBonus) : '-'}
            </strong>
          </div>
          <button
            className="primary"
            disabled={state.convertible < p.convert_min || busy}
            onClick={() => setConverting(true)}
          >
            라마로 바꾸기
          </button>
        </div>
        {state.convertible < p.convert_min && (
          <p className="muted settings-note">{won(p.convert_min)}부터 바꿀 수 있어요.</p>
        )}
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>
              <History size={17} /> 라마 내역
            </h3>
          </div>
        </div>
        <div className="ping-ledger">
          {state.ledger.map((l) => {
            const delta = Number(l.paid_delta) + Number(l.bonus_delta);
            return (
              <div key={l.id} className="ping-ledger-row">
                <span className={'ledger-type ' + (delta > 0 ? 'charge' : l.type === 'revoke' ? 'revoke' : '')}>
                  {lamaTypeLabel[l.type] || l.type}
                </span>
                <div>
                  <strong>{l.memo || lamaTypeLabel[l.type]}</strong>
                  <small>
                    {moment(l.created_at)} · 잔액 {lama(Number(l.paid_after) + Number(l.bonus_after))}
                    {Number(l.held_after) > 0 && ` · 예약 ${lama(l.held_after)}`}
                  </small>
                </div>
                <b className={delta > 0 ? 'lime' : ''}>
                  {delta > 0 ? '+' : ''}
                  {lama(delta)}
                </b>
              </div>
            );
          })}
          {!state.ledger.length && <p className="muted">아직 라마 내역이 없어요.</p>}
        </div>
      </section>
      {pick && (
        <Modal title="라마 충전하기" close={() => !busy && setPick(null)}>
          <div className="checkout-product">
            <Wallet size={42} className="lime" />
            <div>
              <h3>
                {lama(pick.lama)}
                {pick.bonus_lama > 0 && ` + 보너스 ${lama(pick.bonus_lama)}`}
              </h3>
              <p>충전 후 {lama(w.total + pick.lama + pick.bonus_lama)}</p>
            </div>
          </div>
          <div className="checkout-price">
            <span>결제 금액</span>
            <strong>{won(pick.price)}</strong>
          </div>
          <div className="info-box">
            <ShieldCheck size={18} />
            {state.demo
              ? '개발용 테스트 결제입니다. 실제 결제나 청구는 발생하지 않습니다.'
              : '결제 연동을 준비하고 있어요.'}
          </div>
          <button
            className="primary full"
            disabled={busy || !state.demo}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/lama/charge', 'POST', { productId: pick.id, idempotencyKey: chargeKey });
                setPick(null);
                await load();
                onChanged?.();
                notify(`${lama(pick.lama + pick.bonus_lama)}를 충전했어요.`);
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '처리 중…' : '테스트 결제로 충전하기'}
          </button>
        </Modal>
      )}
      {converting && (
        <Modal title="정산 수익을 라마로 바꾸기" close={() => !busy && setConverting(false)}>
          <div className="checkout-price">
            <span>바꿀 정산 금액</span>
            <strong>{won(state.convertible)}</strong>
          </div>
          <div className="info-box">
            <Info size={18} />
            출금 가능한 정산 금액 전액이 바뀌며 되돌릴 수 없어요. 세금은 출금과 똑같이 처리되어 정산 · 세무 내역에
            ‘라마 전환’ 지급으로 남아요. 10원 미만은 올림해서 드려요.
          </div>
          <button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api<{ lama: number; bonus: number }>('/lama/convert', 'POST');
                setConverting(false);
                await load();
                onChanged?.();
                notify(`${lama(r.lama + r.bonus)}로 바꿨어요.`);
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '처리 중…' : '라마로 바꾸기'}
          </button>
        </Modal>
      )}
    </div>
  );
}
