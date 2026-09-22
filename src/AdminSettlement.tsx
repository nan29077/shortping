import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Banknote,
  CalendarCheck,
  Check,
  Download,
  Landmark,
  Radio,
  Receipt,
  RefreshCw,
  Settings2,
  Star,
  Tag,
  Wallet,
} from 'lucide-react';
import {
  settleKindLabel,
  api,
  day,
  moment,
  won,
  type AdminSettlement as AdminSettlementData,
  type AdminTax,
  type Channel,
  type Drama,
  type PlatformSettings,
  type Payout,
} from './api';
import { Empty, Modal, navigate } from './App';
import { downloadCsv } from './StudioPanels';
import { entryStatus, payoutStatus } from './Settlement';

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const lastMonth = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
};

export function AdminSettlementPanel({
  section,
  notify,
}: {
  section: 'settlements' | 'payouts';
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<AdminSettlementData | null>(null),
    [error, setError] = useState(''),
    [month, setMonth] = useState(''),
    [busy, setBusy] = useState(false),
    [closing, setClosing] = useState(lastMonth()),
    [payout, setPayout] = useState<Payout | null>(null),
    [memo, setMemo] = useState(''),
    [filter, setFilter] = useState('requested');
  const load = useCallback(async (key: string) => {
    try {
      setData(await api<AdminSettlementData>('/admin/settlements' + (key ? '?month=' + key : '')));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load(month);
  }, [load, month]);
  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      await load(month);
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error)
    return <Empty title="정산 정보를 불러오지 못했어요" text={error} action={() => void load(month)} label="다시 시도" />;
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );

  if (section === 'payouts') {
    const payouts = data.payouts.filter((p) => filter === 'all' || p.status === filter);
    return (
      <>
        <div className="stats-grid two">
          <div className="stat-card">
            <div>
              <Receipt size={18} />
              <span>승인 대기</span>
            </div>
            <strong>{data.payouts.filter((p) => p.status === 'requested').length}건</strong>
            <small>
              {won(
                data.payouts
                  .filter((p) => p.status === 'requested')
                  .reduce((n, p) => n + p.payable, 0),
              )}{' '}
              지급 예정
            </small>
          </div>
          <div className="stat-card">
            <div>
              <Banknote size={18} />
              <span>누적 지급</span>
            </div>
            <strong>{won(data.payouts.filter((p) => p.status === 'paid').reduce((n, p) => n + p.payable, 0))}</strong>
            <small>{data.payouts.filter((p) => p.status === 'paid').length}건 완료</small>
          </div>
        </div>
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>출금 요청 관리</h3>
              <p>승인 → 지급 완료 순서로 처리합니다. 지급대행 연동 시 이 단계가 자동화됩니다.</p>
            </div>
            <button
              className="secondary compact"
              disabled={!payouts.length}
              onClick={() =>
                downloadCsv('숏핑-출금요청.csv', [
                  ['신청일', 'PD', '구분', '정산기준액', '부가세', '원천징수', '지급액', '은행', '계좌', '예금주', '상태'],
                  ...payouts.map((p) => [
                    moment(p.requested_at),
                    p.pd_name || '',
                    p.business_type === 'business' ? '사업자' : '비사업자',
                    p.amount,
                    p.vat,
                    p.income_tax + p.local_tax,
                    p.payable,
                    p.bank_name,
                    p.account_number,
                    p.account_holder,
                    payoutStatus[p.status],
                  ]),
                ])
              }
            >
              <Download size={16} />
              지급 명세 CSV
            </button>
          </div>
          <div className="studio-filters">
            {[
              ['requested', '승인 대기'],
              ['approved', '지급 예정'],
              ['paid', '지급 완료'],
              ['rejected', '반려'],
              ['all', '전체'],
            ].map(([v, t]) => (
              <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>
                {t}
              </button>
            ))}
          </div>
          {payouts.length ? (
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>신청일 / PD</th>
                    <th>구분</th>
                    <th>정산 기준액</th>
                    <th>세금</th>
                    <th>지급액</th>
                    <th>상태</th>
                    <th>처리</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.pd_name}</strong>
                        <small>{moment(p.requested_at)}</small>
                      </td>
                      <td>{p.business_type === 'business' ? '사업자' : '비사업자'}</td>
                      <td className="nowrap">{won(p.amount)}</td>
                      <td className="nowrap muted">
                        {p.business_type === 'business'
                          ? `+${won(p.vat)}`
                          : `-${won(p.income_tax + p.local_tax)}`}
                      </td>
                      <td className="nowrap">
                        <b>{won(p.payable)}</b>
                        {p.method === 'lama' && <small>{Number(p.lama).toLocaleString('ko-KR')}라마</small>}
                      </td>
                      <td>
                        <span className={'status-chip ' + p.status}>{p.method === 'lama' ? '라마 전환' : payoutStatus[p.status]}</span>
                      </td>
                      <td>
                        <button
                          className="secondary compact"
                          onClick={() => {
                            setPayout(p);
                            setMemo('');
                          }}
                        >
                          관리
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="해당 상태의 출금 요청이 없어요" text="PD가 출금을 신청하면 이곳에 표시됩니다." />
          )}
        </section>
        {payout && (
          <Modal title="출금 요청 처리" close={() => !busy && setPayout(null)}>
            <h3>{payout.pd_name}</h3>
            <p className="muted">{payout.pd_email}</p>
            <div className="payout-summary">
              <div>
                <span>정산 기준액</span>
                <strong>{won(payout.amount)}</strong>
              </div>
              <div>
                <span>{payout.business_type === 'business' ? '부가세' : '원천징수'}</span>
                <strong>
                  {payout.business_type === 'business'
                    ? '+' + won(payout.vat)
                    : '-' + won(payout.income_tax + payout.local_tax)}
                </strong>
              </div>
              <div className="total">
                <span>실지급액</span>
                <strong className="lime">{won(payout.payable)}</strong>
              </div>
            </div>
            <div className="payout-account">
              <Landmark size={16} />
              <span>
                {payout.bank_name} {payout.account_number}
              </span>
              <small>예금주 {payout.account_holder}</small>
            </div>
            {payout.business_type === 'business' ? (
              <div className="info-box">
                사업자 PD입니다. 세금계산서를 수취한 뒤 지급 완료로 변경하세요. 공급가{' '}
                {won(payout.amount)} / 부가세 {won(payout.vat)}.
              </div>
            ) : (
              <div className="info-box">
                비사업자 PD입니다. 사업소득 원천징수 소득세 {won(payout.income_tax)} · 지방소득세{' '}
                {won(payout.local_tax)}를 차감해 지급하고 원천징수 신고에 반영하세요.
              </div>
            )}
            <label>
              처리 메모 (반려 시 필수)
              <input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} />
            </label>
            <div className="form-actions">
              {payout.status === 'requested' && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api('/admin/payouts/' + payout.id, 'POST', { action: 'approved', memo });
                      setPayout(null);
                    }, '출금을 승인했어요.')
                  }
                >
                  승인
                </button>
              )}
              {['requested', 'approved'].includes(payout.status) && (
                <>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api('/admin/payouts/' + payout.id, 'POST', {
                          action: 'rejected',
                          memo,
                        });
                        setPayout(null);
                      }, '출금을 반려했어요. 정산 금액이 복구됩니다.')
                    }
                  >
                    반려
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api('/admin/payouts/' + payout.id, 'POST', { action: 'paid', memo });
                        setPayout(null);
                      }, '지급 완료로 처리했어요.')
                    }
                  >
                    지급 완료
                  </button>
                </>
              )}
            </div>
          </Modal>
        )}
      </>
    );
  }

  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <Wallet size={18} />
            <span>총 판매액</span>
          </div>
          <strong>{won(data.totals.gross)}</strong>
          <small>플랫폼 수수료 {won(data.totals.fee)}</small>
        </div>
        <div className="stat-card">
          <div>
            <Receipt size={18} />
            <span>정산 예정</span>
          </div>
          <strong>{won(data.totals.pending)}</strong>
          <small>확정 전 금액</small>
        </div>
        <div className="stat-card">
          <div>
            <Banknote size={18} />
            <span>출금 가능</span>
          </div>
          <strong>{won(data.totals.available)}</strong>
          <small>PD가 신청 가능한 금액</small>
        </div>
        <div className="stat-card">
          <div>
            <CalendarCheck size={18} />
            <span>지급 완료</span>
          </div>
          <strong>{won(data.totals.paid)}</strong>
          <small>신청 중 {won(data.totals.requested)}</small>
        </div>
      </div>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>구독 매출 월 마감</h3>
            <p>
              숏핑 패스 매출을 해당 월 시청 회차 비중으로 PD에게 배분합니다. 같은 달을 다시 마감해도
              중복 정산되지 않습니다.
            </p>
          </div>
        </div>
        <div className="inline-form">
          <input
            type="month"
            value={closing}
            max={lastMonth()}
            onChange={(e) => setClosing(e.target.value)}
            aria-label="마감할 월"
          />
          <button
            className="primary compact"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ pool: number; shares: unknown[] }>(
                  '/admin/settlements/close',
                  'POST',
                  { period: closing },
                );
                notify(
                  r.shares.length
                    ? `${closing} 구독 매출 ${won(r.pool)}을 ${r.shares.length}개 방송국에 배분했어요.`
                    : `${closing}에는 배분할 구독 매출이 없어요.`,
                );
              }, '구독 정산을 마감했어요.')
            }
          >
            <RefreshCw size={15} />월 마감 실행
          </button>
        </div>
        {data.closed.length > 0 && (
          <div className="closed-periods">
            {data.closed.map((c) => (
              <span key={c.period}>
                {c.period} · {c.creators}개 방송국 · {won(c.gross)}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>PD별 정산 현황</h3>
            <p>{data.creators.length}명 · 방송국 운영 계정 기준</p>
          </div>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="정산 월 필터"
          />
        </div>
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>PD</th>
                <th>구분</th>
                <th>판매액</th>
                <th>수수료</th>
                <th>정산 예정</th>
                <th>출금 가능</th>
                <th>지급 완료</th>
              </tr>
            </thead>
            <tbody>
              {data.creators.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    <small>{c.email}</small>
                  </td>
                  <td>
                    <span className={'status-chip ' + (c.verified ? '' : 'neutral')}>
                      {c.business_type === 'business' ? '사업자' : '비사업자'}
                      {c.verified ? ' · 검증' : ''}
                    </span>
                  </td>
                  <td className="nowrap">{won(c.gross)}</td>
                  <td className="nowrap muted">{won(c.fee)}</td>
                  <td className="nowrap">{won(c.pending)}</td>
                  <td className="nowrap">
                    <b>{won(c.available)}</b>
                  </td>
                  <td className="nowrap">{won(c.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>정산 원장</h3>
            <p>
              {data.entries.length}건{month && ` · ${month}`}
            </p>
          </div>
          <button
            className="secondary compact"
            disabled={!data.entries.length}
            onClick={() =>
              downloadCsv('숏핑-정산원장.csv', [
                ['정산일', 'PD', '구분', '작품', '판매액', '수수료', '정산액', '상태'],
                ...data.entries.map((e) => [
                  moment(e.created_at),
                  e.pd_name || '',
                  settleKindLabel(e.kind),
                  e.drama_title || `${e.period} 구독`,
                  e.gross,
                  e.platform_fee + e.pg_fee,
                  e.net,
                  entryStatus[e.status],
                ]),
              ])
            }
          >
            <Download size={16} />
            원장 CSV
          </button>
        </div>
        {data.entries.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>정산일</th>
                  <th>PD</th>
                  <th>작품 / 구분</th>
                  <th>판매액</th>
                  <th>정산액</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.slice(0, 120).map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{day(e.created_at)}</td>
                    <td>{e.pd_name}</td>
                    <td>
                      <strong>{e.drama_title || `${e.period} 숏핑 패스 배분`}</strong>
                      <small>{settleKindLabel(e.kind)}</small>
                    </td>
                    <td className="nowrap">{won(e.gross)}</td>
                    <td className="nowrap">
                      <b>{won(e.net)}</b>
                    </td>
                    <td>
                      <span className={'status-chip ' + e.status}>{entryStatus[e.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="정산 내역이 없어요" text="테스트 구매가 발생하면 원장이 생성됩니다." />
        )}
      </section>
    </>
  );
}

export function AdminTaxPanel({ notify }: { notify: (s: string) => void }) {
  const [data, setData] = useState<AdminTax | null>(null),
    [error, setError] = useState(''),
    [type, setType] = useState('all'),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<AdminTax['creators'][number] | null>(null),
    [note, setNote] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api<AdminTax>('/admin/tax'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return <Empty title="세무 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const paidOf = (id: string) => data.paid.find((p) => p.pd_id === id);
  const creators = data.creators.filter((c) => type === 'all' || c.business_type === type);
  const totals = data.paid.reduce(
    (acc, p) => ({
      amount: acc.amount + p.amount,
      vat: acc.vat + p.vat,
      withheld: acc.withheld + p.income_tax + p.local_tax,
    }),
    { amount: 0, vat: 0, withheld: 0 },
  );
  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <Receipt size={18} />
            <span>{data.year}년 지급액</span>
          </div>
          <strong>{won(totals.amount)}</strong>
          <small>지급 완료 기준</small>
        </div>
        <div className="stat-card">
          <div>
            <Tag size={18} />
            <span>세금계산서 부가세</span>
          </div>
          <strong>{won(totals.vat)}</strong>
          <small>사업자 PD 합계</small>
        </div>
        <div className="stat-card">
          <div>
            <Banknote size={18} />
            <span>원천징수액</span>
          </div>
          <strong>{won(totals.withheld)}</strong>
          <small>비사업자 사업소득</small>
        </div>
        <div className="stat-card">
          <div>
            <BadgeCheck size={18} />
            <span>검증 완료</span>
          </div>
          <strong>
            {data.creators.filter((c) => c.verified).length} / {data.creators.length}
          </strong>
          <small>세무 정보 확인된 PD</small>
        </div>
      </div>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>PD 세무 관리</h3>
            <p>사업자는 세금계산서, 비사업자는 원천징수로 구분해 처리합니다.</p>
          </div>
          <button
            className="secondary compact"
            disabled={!creators.length}
            onClick={() =>
              downloadCsv('숏핑-세무관리.csv', [
                ['PD', '이메일', '구분', '사업자번호', '상호', '대표자', '업태', '종목', '계좌', '검증', `${data.year}년 지급액`, '부가세', '원천징수'],
                ...creators.map((c) => {
                  const paid = paidOf(c.id);
                  return [
                    c.name,
                    c.email,
                    c.business_type === 'business' ? '사업자' : '비사업자',
                    c.business_no,
                    c.business_name,
                    c.rep_name,
                    c.business_class,
                    c.business_item,
                    `${c.bank_name} ${c.account_number} ${c.account_holder}`,
                    c.verified ? '검증' : '대기',
                    paid?.amount || 0,
                    paid?.vat || 0,
                    (paid?.income_tax || 0) + (paid?.local_tax || 0),
                  ];
                }),
              ])
            }
          >
            <Download size={16} />
            세무 자료 CSV
          </button>
        </div>
        <div className="studio-filters">
          {[
            ['all', '전체'],
            ['business', '사업자'],
            ['individual', '비사업자'],
          ].map(([v, t]) => (
            <button key={v} className={type === v ? 'active' : ''} onClick={() => setType(v)}>
              {t}
            </button>
          ))}
        </div>
        {creators.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>PD</th>
                  <th>구분</th>
                  <th>사업자 정보</th>
                  <th>출금 계좌</th>
                  <th>{data.year}년 세금</th>
                  <th>검증</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {creators.map((c) => {
                  const paid = paidOf(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <small>{c.email}</small>
                      </td>
                      <td>{c.business_type === 'business' ? '사업자' : '비사업자'}</td>
                      <td>
                        {c.business_type === 'business' ? (
                          <>
                            <strong>{c.business_name || '상호 미등록'}</strong>
                            <small>
                              {c.business_no || '번호 미등록'} · {c.rep_name}
                            </small>
                          </>
                        ) : (
                          <small className="muted">원천징수 대상</small>
                        )}
                      </td>
                      <td>
                        {c.bank_name ? (
                          <>
                            <strong>{c.bank_name}</strong>
                            <small>
                              {c.account_number} · {c.account_holder}
                            </small>
                          </>
                        ) : (
                          <small className="muted">미등록</small>
                        )}
                      </td>
                      <td className="nowrap">
                        {c.business_type === 'business'
                          ? '부가세 ' + won(paid?.vat || 0)
                          : '원천징수 ' + won((paid?.income_tax || 0) + (paid?.local_tax || 0))}
                      </td>
                      <td>
                        <span className={'status-chip ' + (c.verified ? '' : 'neutral')}>
                          {c.verified ? '검증' : '대기'}
                        </span>
                      </td>
                      <td>
                        <button
                          className="secondary compact"
                          onClick={() => {
                            setEditing(c);
                            setNote(c.verified_note || '');
                          }}
                        >
                          관리
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="해당 구분의 PD가 없어요" text="회원 관리에서 PD 권한을 부여할 수 있어요." />
        )}
        <p className="panel-footnote">
          주민등록번호 등 민감 식별정보는 저장하지 않습니다. 실제 원천징수 신고와 지급명세서 제출은
          지급대행 연동 시 처리합니다.
        </p>
      </section>
      {editing && (
        <Modal title="PD 세무 구분 관리" close={() => !busy && setEditing(null)}>
          <h3>{editing.name}</h3>
          <p className="muted">{editing.email}</p>
          <label>
            세무 구분
            <select
              value={editing.business_type}
              onChange={(e) =>
                setEditing({ ...editing, business_type: e.target.value as 'individual' | 'business' })
              }
            >
              <option value="individual">비사업자 (원천징수 3.3%)</option>
              <option value="business">사업자 (세금계산서 · 부가세)</option>
            </select>
          </label>
          <label>
            검증 메모
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </label>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/admin/tax/' + editing.id, 'PATCH', {
                    business_type: editing.business_type,
                    verified: false,
                    verified_note: note,
                  });
                  setEditing(null);
                  await load();
                  notify('검증 대기로 변경했어요.');
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              검증 해제
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/admin/tax/' + editing.id, 'PATCH', {
                    business_type: editing.business_type,
                    verified: true,
                    verified_note: note,
                  });
                  setEditing(null);
                  await load();
                  notify('세무 정보를 검증 완료로 저장했어요.');
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Check size={15} />
              검증 완료
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AdminSettingsPanel({ notify }: { notify: (s: string) => void }) {
  const [form, setForm] = useState<PlatformSettings | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: PlatformSettings }>('/admin/settings');
      setForm(r.settings);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return <Empty title="설정을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!form)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const number = (key: keyof PlatformSettings) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: Number(e.target.value) });
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PLATFORM SETTINGS</span>
          <h3>요금 · 정산 정책</h3>
          <p>구독료와 수수료, 정산 주기를 바꾸면 이후 결제와 정산에 즉시 반영됩니다.</p>
        </div>
        <Settings2 size={22} className="lime" />
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/admin/settings', 'PUT', form);
            notify('플랫폼 설정을 저장했어요.');
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h4 className="spaced-title">숏핑 패스 (구독)</h4>
        <div className="form-columns">
          <label>
            구독료 (원)
            <input type="number" min={0} max={1000000} value={form.subscription_price} onChange={number('subscription_price')} required />
          </label>
          <label>
            이용 기간 (일)
            <input type="number" min={1} max={365} value={form.subscription_days} onChange={number('subscription_days')} required />
          </label>
        </div>
        <h4 className="spaced-title">작품 기본값</h4>
        <div className="form-columns">
          <label>
            기본 무료 회차
            <input type="number" min={1} max={50} value={form.default_free_episodes} onChange={number('default_free_episodes')} required />
          </label>
        </div>
        <p className="muted settings-note">
          회차 핑 가격 · 전체 열기 할인 · 충전 상품 · 인앱 수수료는 ‘포인트(핑) 관리’에서 설정합니다.
        </p>
        <h4 className="spaced-title">수수료 · 정산</h4>
        <div className="form-columns">
          <label>
            플랫폼 수수료 (%)
            <input type="number" min={0} max={90} step={0.1} value={form.platform_fee_rate} onChange={number('platform_fee_rate')} required />
          </label>
          <label>
            웹 결제(PG) 수수료 (%)
            <input type="number" min={0} max={20} step={0.1} value={form.pg_fee_rate} onChange={number('pg_fee_rate')} required />
          </label>
          <label>
            판매 확정 (일)
            <input type="number" min={0} max={90} value={form.settle_hold_days} onChange={number('settle_hold_days')} required />
          </label>
        </div>
        <div className="form-columns">
          <label>
            최소 출금 금액 (원)
            <input type="number" min={0} max={10000000} value={form.payout_min} onChange={number('payout_min')} required />
          </label>
          <label>
            원천징수율 (%)
            <input type="number" min={0} max={30} step={0.1} value={form.withholding_rate} onChange={number('withholding_rate')} required />
          </label>
          <label>
            부가세율 (%)
            <input type="number" min={0} max={30} step={0.1} value={form.vat_rate} onChange={number('vat_rate')} required />
          </label>
        </div>
        <label>
          출금 안내 문구
          <input
            value={form.payout_notice}
            onChange={(e) => setForm({ ...form, payout_notice: e.target.value })}
            maxLength={300}
          />
        </label>
        <div className="info-box">
          수수료율 변경은 변경 이후 발생하는 판매부터 적용됩니다. 이미 생성된 정산 내역은 당시
          요율을 유지합니다. 플랫폼 수수료는 공통 비율이며, PD별 개별 비율은 포인트(핑) 관리에서
          정합니다.
        </div>
        <button className="primary full" disabled={busy}>
          {busy ? '저장 중…' : '설정 저장'}
        </button>
      </form>
    </section>
  );
}

export function AdminPricingPanel({
  dramas,
  notify,
  reload,
}: {
  dramas: Drama[];
  notify: (s: string) => void;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Drama | null>(null),
    [form, setForm] = useState({
      free: false,
      episode_pings: 0,
      free_episodes: 3,
      badge: 'NEW',
      status: 'published',
    }),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState('');
  const sellable = dramas.filter(
    (d) =>
      ['published', 'hidden'].includes(d.status) &&
      `${d.title} ${d.genre} ${d.channel_name || ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>작품 판매 설정</h3>
            <p>공개된 작품의 회차 핑 가격, 무료 회차, 노출 상태를 언제든 조정할 수 있습니다.</p>
          </div>
          <span className="tag-outline">{sellable.length}편</span>
        </div>
        <label className="management-search">
          <Tag size={17} />
          <input
            aria-label="작품 검색"
            placeholder="작품명, 장르, 방송국 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {sellable.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>작품</th>
                  <th>방송국</th>
                  <th>판매</th>
                  <th>회차 가격</th>
                  <th>무료 회차</th>
                  <th>뱃지</th>
                  <th>노출</th>
                  <th>설정</th>
                </tr>
              </thead>
              <tbody>
                {sellable.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.title}</strong>
                      <small>
                        {d.genre} · {d.episode_count}회차
                      </small>
                    </td>
                    <td>{d.channel_name || '미지정'}</td>
                    <td className="nowrap">
                      <b>{d.free ? '무료' : '핑 판매'}</b>
                    </td>
                    <td className="nowrap">
                      {d.free ? '-' : d.episode_pings ? d.episode_pings + '핑' : '기본값'}
                    </td>
                    <td className="nowrap">{d.free_episodes}화</td>
                    <td>{d.badge}</td>
                    <td>
                      <span className={'status-chip ' + (d.status === 'published' ? '' : 'neutral')}>
                        {d.status === 'published' ? '공개 중' : '노출 중단'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="secondary compact"
                        onClick={() => {
                          setEditing(d);
                          setForm({
                            free: !!d.free,
                            episode_pings: d.episode_pings || 0,
                            free_episodes: d.free_episodes,
                            badge: ['NEW', 'HOT', '독점', '완결', '추천'].includes(d.badge)
                              ? d.badge
                              : 'NEW',
                            status: d.status,
                          });
                        }}
                      >
                        판매 설정
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="판매 중인 작품이 없어요" text="심사 승인 후 작품이 공개되면 표시됩니다." />
        )}
      </section>
      {editing && (
        <Modal title={editing.title + ' 판매 설정'} close={() => !busy && setEditing(null)}>
          <div className="form-columns">
            <label>
              회차 가격 (핑 · 0이면 기본값)
              <input
                type="number"
                min={0}
                max={1000}
                disabled={form.free}
                value={form.episode_pings}
                onChange={(e) => setForm({ ...form, episode_pings: Number(e.target.value) })}
              />
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={form.free}
                onChange={(e) => setForm({ ...form, free: e.target.checked })}
              />
              전 회차 무료
            </label>
            <label>
              무료 회차
              <input
                type="number"
                min={1}
                max={50}
                value={form.free_episodes}
                onChange={(e) => setForm({ ...form, free_episodes: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="form-columns">
            <label>
              뱃지
              <select value={form.badge} onChange={(e) => setForm({ ...form, badge: e.target.value })}>
                {['NEW', 'HOT', '독점', '완결', '추천'].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <label>
              노출 상태
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="published">공개 중</option>
                <option value="hidden">노출 중단</option>
              </select>
            </label>
          </div>
          <div className="info-box">
            가격을 0원으로 설정하면 모든 회차가 무료로 공개됩니다. 회차 구매 가격을 0원으로 두면
            요금 정책의 기본 회차 가격이 적용됩니다. 이미 구매한 시청자의 권한은 유지됩니다.
          </div>
          <button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/admin/dramas/' + editing.id + '/pricing', 'PATCH', form);
                setEditing(null);
                await reload();
                notify('판매 설정을 저장했어요.');
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '저장 중…' : '판매 설정 저장'}
          </button>
        </Modal>
      )}
    </>
  );
}

export function AdminChannelsPanel({
  notify,
  reloadChannels,
}: {
  notify: (s: string) => void;
  reloadChannels: () => Promise<void>;
}) {
  const [channels, setChannels] = useState<Channel[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Channel | null>(null);
  const load = useCallback(async () => {
    try {
      setChannels(await api<Channel[]>('/admin/channels'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return <Empty title="방송국 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!channels)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>방송국 관리</h3>
            <p>추천으로 지정하면 메인 화면과 방송국 목록 상단에 노출됩니다.</p>
          </div>
          <span className="tag-outline">{channels.length}개</span>
        </div>
        {channels.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>방송국</th>
                  <th>운영 PD</th>
                  <th>작품</th>
                  <th>구독자</th>
                  <th>상태</th>
                  <th>추천</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.name}</strong>
                      <small>/{c.slug}</small>
                    </td>
                    <td>{c.owner_name}</td>
                    <td className="nowrap">{c.drama_count}편</td>
                    <td className="nowrap">{c.followers}</td>
                    <td>
                      <span className={'status-chip ' + (c.status === 'active' ? '' : 'neutral')}>
                        {c.status === 'active' ? '공개 중' : c.status === 'draft' ? '준비 중' : '숨김'}
                      </span>
                    </td>
                    <td>{c.featured ? <Star size={15} className="lime" /> : '-'}</td>
                    <td>
                      <div className="row-actions">
                        <button className="secondary compact" onClick={() => setEditing(c)}>
                          관리
                        </button>
                        <button
                          className="secondary compact"
                          onClick={() => navigate('channel/' + c.id)}
                        >
                          보기
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="개설된 방송국이 없어요" text="PD가 방송국을 개설하면 이곳에서 관리합니다." />
        )}
      </section>
      {editing && (
        <Modal title="방송국 노출 관리" close={() => !busy && setEditing(null)}>
          <h3>
            <Radio size={17} /> {editing.name}
          </h3>
          <p className="muted">
            {editing.owner_name} · 작품 {editing.drama_count}편
          </p>
          <label>
            공개 상태
            <select
              value={editing.status}
              onChange={(e) => setEditing({ ...editing, status: e.target.value })}
            >
              <option value="active">공개</option>
              <option value="draft">준비 중</option>
              <option value="hidden">숨김</option>
            </select>
          </label>
          <label>
            메인 추천
            <select
              value={editing.featured ? '1' : '0'}
              onChange={(e) => setEditing({ ...editing, featured: Number(e.target.value) })}
            >
              <option value="1">추천 노출</option>
              <option value="0">노출 안 함</option>
            </select>
          </label>
          <label>
            추천 순서 (작을수록 먼저)
            <input
              type="number"
              min={0}
              max={99}
              value={editing.featured_order}
              onChange={(e) => setEditing({ ...editing, featured_order: Number(e.target.value) })}
            />
          </label>
          <button
            className="primary full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/admin/channels/' + editing.id, 'PATCH', {
                  status: editing.status,
                  featured: !!editing.featured,
                  featured_order: editing.featured_order,
                });
                setEditing(null);
                await load();
                await reloadChannels();
                notify('방송국 노출 설정을 저장했어요.');
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '저장 중…' : '저장'}
          </button>
        </Modal>
      )}
    </>
  );
}
