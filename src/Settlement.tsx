import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Banknote,
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileSpreadsheet,
  Landmark,
  Receipt,
  Wallet,
} from 'lucide-react';
import {
  settleKindLabel,
  api,
  day,
  localDay,
  moment,
  won,
  type StudioSettlement,
  type SettlementEntry,
  type TaxProfile,
  type User,
} from './api';
import { Empty } from './App';
import { downloadCsv } from './StudioPanels';

export const entryStatus: Record<string, string> = {
  pending: '정산 예정',
  available: '출금 가능',
  requested: '출금 신청 중',
  paid: '지급 완료',
  canceled: '취소',
};
export const payoutStatus: Record<string, string> = {
  requested: '승인 대기',
  approved: '지급 예정',
  paid: '지급 완료',
  rejected: '반려',
};
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (key: string) => `${key.slice(0, 4)}년 ${Number(key.slice(5, 7))}월`;
const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
};

// 판매 확정 → 출금 가능 → 출금 신청 → 지급 완료. The calendar mirrors the seller
// settlement view used by 셀러브릭스 so PDs can reconcile day by day.
export function SettlementCalendar({
  entries,
  month,
  onMonth,
  selected,
  onSelect,
}: {
  entries: SettlementEntry[];
  month: string;
  onMonth: (key: string) => void;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const [year, m] = month.split('-').map(Number);
  const first = new Date(year, m - 1, 1);
  const days = new Date(year, m, 0).getDate();
  const byDay = new Map<string, { net: number; gross: number; count: number }>();
  for (const e of entries) {
    const key = localDay(new Date(e.created_at));
    const cell = byDay.get(key) || { net: 0, gross: 0, count: 0 };
    cell.net += e.net;
    cell.gross += e.gross;
    cell.count += 1;
    byDay.set(key, cell);
  }
  const max = Math.max(1, ...[...byDay.values()].map((c) => c.net));
  const cells = Array.from({ length: first.getDay() }, () => null).concat(
    Array.from({ length: days }, (_, i) => i + 1) as unknown as null[],
  );
  const total = [...byDay.entries()]
    .filter(([key]) => key.startsWith(month))
    .reduce((n, [, c]) => n + c.net, 0);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SETTLEMENT CALENDAR</span>
          <h3>{monthLabel(month)} 정산 달력</h3>
          <p>날짜를 선택하면 해당 일자의 정산 내역만 표시됩니다.</p>
        </div>
        <div className="month-switch">
          <button aria-label="이전 달" onClick={() => onMonth(shiftMonth(month, -1))}>
            <ChevronLeft size={16} />
          </button>
          <strong>{monthLabel(month)}</strong>
          <button
            aria-label="다음 달"
            disabled={month >= monthKey(new Date())}
            onClick={() => onMonth(shiftMonth(month, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="settlement-calendar">
        {['일', '월', '화', '수', '목', '금', '토'].map((label) => (
          <span className="calendar-head" key={label}>
            {label}
          </span>
        ))}
        {cells.map((value, index) => {
          if (!value) return <span className="calendar-cell empty" key={'empty' + index} />;
          const key = `${month}-${String(value).padStart(2, '0')}`;
          const cell = byDay.get(key);
          return (
            <button
              key={key}
              className={'calendar-cell' + (selected === key ? ' selected' : '') + (cell ? ' has' : '')}
              onClick={() => onSelect(selected === key ? '' : key)}
              style={
                cell
                  ? { background: `rgba(196,245,98,${0.06 + (cell.net / max) * 0.16})` }
                  : undefined
              }
            >
              <b>{value}</b>
              {cell && (
                <>
                  <span>{won(cell.net)}</span>
                  <small>{cell.count}건</small>
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="calendar-total">
        <span>
          <CalendarDays size={15} /> {monthLabel(month)} 정산 합계
        </span>
        <strong className="lime">{won(total)}</strong>
      </div>
    </section>
  );
}

function BalanceCards({ balance, rules }: { balance: StudioSettlement['balance']; rules: StudioSettlement['settings'] }) {
  const cards = [
    {
      icon: <Clock3 size={18} />,
      label: '정산 예정',
      value: balance.pending,
      detail: `구매 후 ${rules.settle_hold_days}일 뒤 확정`,
    },
    {
      icon: <Wallet size={18} />,
      label: '출금 가능',
      value: balance.available,
      detail: `최소 ${won(rules.payout_min)}부터`,
    },
    {
      icon: <Receipt size={18} />,
      label: '출금 신청 중',
      value: balance.requested,
      detail: '관리자 승인 대기',
    },
    {
      icon: <CheckCircle2 size={18} />,
      label: '지급 완료',
      value: balance.paid,
      detail: '누적 지급액',
    },
  ];
  return (
    <div className="stats-grid">
      {cards.map((c) => (
        <div className="stat-card" key={c.label}>
          <div>
            {c.icon}
            <span>{c.label}</span>
          </div>
          <strong>{won(c.value)}</strong>
          <small>{c.detail}</small>
        </div>
      ))}
    </div>
  );
}

export default function Settlement({
  user,
  section,
  notify,
}: {
  user: User;
  section: 'settlement' | 'payouts' | 'tax';
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<StudioSettlement | null>(null),
    [error, setError] = useState(''),
    [month, setMonth] = useState(monthKey(new Date())),
    [selected, setSelected] = useState(''),
    [status, setStatus] = useState('all'),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState<TaxProfile | null>(null),
    [confirming, setConfirming] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<StudioSettlement>('/studio/settlement');
      setData(r);
      setForm(r.profile);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, user.id]);
  if (error)
    return (
      <Empty title="정산 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />
    );
  if (!data || !form)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const monthEntries = data.entries.filter((e) => localDay(new Date(e.created_at)).startsWith(month));
  const listed = data.entries.filter(
    (e) =>
      (status === 'all' || e.status === status) &&
      (selected ? localDay(new Date(e.created_at)) === selected : true),
  );
  const ready = data.balance.available >= data.settings.payout_min && data.balance.available > 0;
  const accountReady = !!(form.bank_name && form.account_number && form.account_holder);

  if (section === 'settlement')
    return (
      <>
        <BalanceCards balance={data.balance} rules={data.settings} />
        <div className="info-box">
          시청자가 내 작품에서 핑을 쓰면, 결제 채널 수수료(웹 PG · 앱 스토어)를 뺀 순매출을 PD{' '}
          {100 - data.settings.platform_fee_rate} : 플랫폼 {data.settings.platform_fee_rate}로 나눠
          정산합니다
          {data.settings.default_platform_fee_rate !== undefined &&
          data.settings.default_platform_fee_rate !== data.settings.platform_fee_rate
            ? ' (내 계정 개별 비율 적용)'
            : ''}
          . 보너스·이벤트 핑으로 연 회차도 똑같이 정산돼요. 사용 후 {data.settings.settle_hold_days}일이
          지나면 출금 가능 금액으로 전환되고, 숏핑 패스(구독) 매출은 월 마감 시 시청 회차 비중으로
          배분됩니다.
        </div>
        <SettlementCalendar
          entries={monthEntries}
          month={month}
          onMonth={(key) => {
            setMonth(key);
            setSelected('');
          }}
          selected={selected}
          onSelect={setSelected}
        />
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>정산 내역</h3>
              <p>
                {listed.length}건 · 정산액 {won(listed.reduce((n, e) => n + e.net, 0))}
                {selected && ` · ${selected}`}
              </p>
            </div>
            <button
              className="secondary compact"
              disabled={!listed.length}
              onClick={() =>
                downloadCsv('숏핑-정산내역.csv', [
                  ['정산일', '구분', '작품', '판매액', '수수료', '정산액', '상태', '확정일'],
                  ...listed.map((e) => [
                    moment(e.created_at),
                    settleKindLabel(e.kind),
                    e.drama_title || `${e.period} 구독 정산`,
                    e.gross,
                    e.platform_fee + e.pg_fee,
                    e.net,
                    entryStatus[e.status],
                    day(e.confirm_at),
                  ]),
                ])
              }
            >
              <Download size={16} />
              CSV 내보내기
            </button>
          </div>
          <div className="studio-filters">
            {[
              ['all', '전체'],
              ['pending', '정산 예정'],
              ['available', '출금 가능'],
              ['requested', '출금 신청 중'],
              ['paid', '지급 완료'],
            ].map(([v, t]) => (
              <button key={v} className={status === v ? 'active' : ''} onClick={() => setStatus(v)}>
                {t}
              </button>
            ))}
            {selected && (
              <button className="active" onClick={() => setSelected('')}>
                {selected} 해제 ✕
              </button>
            )}
          </div>
          {listed.length ? (
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>정산일</th>
                    <th>작품 / 구분</th>
                    <th>판매액</th>
                    <th>수수료</th>
                    <th>정산액</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.slice(0, 120).map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap">{day(e.created_at)}</td>
                      <td>
                        <strong>{e.drama_title || `${e.period} 숏핑 패스 배분`}</strong>
                        <small>{settleKindLabel(e.kind)}</small>
                      </td>
                      <td className="nowrap">{won(e.gross)}</td>
                      <td className="nowrap muted">-{won(e.platform_fee + e.pg_fee)}</td>
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
            <Empty
              title="해당 조건의 정산 내역이 없어요"
              text="시청자가 작품을 구매하면 정산 내역이 쌓입니다."
            />
          )}
        </section>
      </>
    );

  if (section === 'payouts')
    return (
      <>
        <BalanceCards balance={data.balance} rules={data.settings} />
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>출금 신청</h3>
              <p>출금 가능 금액 전액을 한 번에 신청합니다.</p>
            </div>
            <span className="tag-outline">
              {form.business_type === 'business' ? '사업자' : '비사업자'}
            </span>
          </div>
          <div className="payout-summary">
            <div>
              <span>출금 가능 금액</span>
              <strong className="lime">{won(data.balance.available)}</strong>
            </div>
            {form.business_type === 'business' ? (
              <>
                <div>
                  <span>부가세 ({data.settings.vat_rate}%)</span>
                  <strong>
                    +{won(Math.round((data.balance.available * data.settings.vat_rate) / 100))}
                  </strong>
                </div>
                <div className="total">
                  <span>세금계산서 발행 후 지급액</span>
                  <strong>
                    {won(
                      data.balance.available +
                        Math.round((data.balance.available * data.settings.vat_rate) / 100),
                    )}
                  </strong>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span>원천징수 ({data.settings.withholding_rate}%)</span>
                  <strong>
                    -
                    {won(
                      Math.floor((data.balance.available * data.settings.withholding_rate) / 110) +
                        Math.floor(
                          Math.floor(
                            (data.balance.available * data.settings.withholding_rate) / 110,
                          ) * 0.1,
                        ),
                    )}
                  </strong>
                </div>
                <div className="total">
                  <span>실지급 예상액</span>
                  <strong>
                    {won(
                      data.balance.available -
                        Math.floor(
                          (data.balance.available * data.settings.withholding_rate) / 110,
                        ) -
                        Math.floor(
                          Math.floor(
                            (data.balance.available * data.settings.withholding_rate) / 110,
                          ) * 0.1,
                        ),
                    )}
                  </strong>
                </div>
              </>
            )}
          </div>
          {!accountReady && (
            <div className="review-alert">
              <AlertCircle size={16} />
              출금 계좌가 등록되지 않았습니다. 세무 · 정산 정보 메뉴에서 먼저 등록해 주세요.
            </div>
          )}
          {accountReady && (
            <div className="payout-account">
              <Landmark size={16} />
              <span>
                {form.bank_name} {form.account_number}
              </span>
              <small>예금주 {form.account_holder}</small>
            </div>
          )}
          {confirming ? (
            <div className="review-alert">
              {won(data.balance.available)}을 출금 신청할까요? 신청 후에는 관리자 승인 전까지 내역이
              잠깁니다.
              <div className="form-actions">
                <button className="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  취소
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api('/studio/payouts', 'POST', {});
                      setConfirming(false);
                      await load();
                      notify('출금을 신청했어요. 관리자 승인 후 지급됩니다.');
                    } catch (e) {
                      notify((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  출금 신청하기
                </button>
              </div>
            </div>
          ) : (
            <button
              className="primary full"
              disabled={!ready || !accountReady || busy}
              onClick={() => setConfirming(true)}
            >
              <Banknote size={17} />
              {ready ? `${won(data.balance.available)} 출금 신청` : '출금 가능 금액이 부족해요'}
            </button>
          )}
          <p className="panel-footnote">{data.settings.payout_notice}</p>
        </section>
        <section className="management-panel">
          <div className="panel-heading">
            <div>
              <h3>출금 내역</h3>
              <p>{data.payouts.length}건</p>
            </div>
          </div>
          {data.payouts.length ? (
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>신청일</th>
                    <th>정산 기준액</th>
                    <th>세금</th>
                    <th>지급액</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payouts.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">{day(p.requested_at)}</td>
                      <td className="nowrap">{won(p.amount)}</td>
                      <td className="nowrap muted">
                        {p.business_type === 'business'
                          ? `부가세 +${won(p.vat)}`
                          : `원천징수 -${won(p.income_tax + p.local_tax)}`}
                      </td>
                      <td className="nowrap">
                        <b>{won(p.payable)}</b>
                      </td>
                      <td>
                        <span className={'status-chip ' + p.status}>{payoutStatus[p.status]}</span>
                        {p.memo && <small>{p.memo}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="출금 내역이 없어요" text="출금 가능 금액이 쌓이면 신청할 수 있어요." />
          )}
        </section>
      </>
    );

  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">TAX PROFILE</span>
          <h3>세무 · 정산 정보</h3>
          <p>사업자 여부에 따라 세금계산서 발행 또는 원천징수로 처리됩니다.</p>
        </div>
        {form.verified ? (
          <span className="status-chip">
            <BadgeCheck size={14} /> 검증 완료
          </span>
        ) : (
          <span className="status-chip neutral">검증 대기</span>
        )}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/studio/tax', 'PUT', {
              business_type: form.business_type,
              business_no: form.business_no,
              business_name: form.business_name,
              rep_name: form.rep_name,
              business_class: form.business_class,
              business_item: form.business_item,
              tax_email: form.tax_email,
              bank_name: form.bank_name,
              account_number: form.account_number,
              account_holder: form.account_holder,
              contact: form.contact,
              address: form.address,
            });
            await load();
            notify('세무 정보를 저장했어요. 관리자 검증 후 출금에 사용됩니다.');
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="tax-type-picker">
          {[
            ['individual', '비사업자', `사업소득 ${data.settings.withholding_rate}% 원천징수 후 지급`],
            ['business', '사업자', `세금계산서 발행 · 부가세 ${data.settings.vat_rate}% 별도 지급`],
          ].map(([value, label, hint]) => (
            <button
              type="button"
              key={value}
              className={form.business_type === value ? 'selected' : ''}
              onClick={() => setForm({ ...form, business_type: value as TaxProfile['business_type'] })}
            >
              <strong>{label}</strong>
              <span>{hint}</span>
            </button>
          ))}
        </div>
        {form.business_type === 'business' && (
          <>
            <div className="form-columns">
              <label>
                사업자등록번호
                <input
                  value={form.business_no}
                  onChange={(e) => setForm({ ...form, business_no: e.target.value })}
                  placeholder="000-00-00000"
                  maxLength={20}
                  required
                />
              </label>
              <label>
                상호
                <input
                  value={form.business_name}
                  onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                  maxLength={60}
                  required
                />
              </label>
            </div>
            <div className="form-columns">
              <label>
                대표자명
                <input
                  value={form.rep_name}
                  onChange={(e) => setForm({ ...form, rep_name: e.target.value })}
                  maxLength={30}
                  required
                />
              </label>
              <label>
                업태
                <input
                  value={form.business_class}
                  onChange={(e) => setForm({ ...form, business_class: e.target.value })}
                  placeholder="정보통신업"
                  maxLength={40}
                />
              </label>
              <label>
                종목
                <input
                  value={form.business_item}
                  onChange={(e) => setForm({ ...form, business_item: e.target.value })}
                  placeholder="영상 콘텐츠 제작"
                  maxLength={40}
                />
              </label>
            </div>
            <label>
              세금계산서 이메일
              <input
                type="email"
                value={form.tax_email}
                onChange={(e) => setForm({ ...form, tax_email: e.target.value })}
                placeholder="tax@example.com"
                maxLength={254}
              />
            </label>
            <label>
              사업장 주소
              <input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                maxLength={120}
              />
            </label>
          </>
        )}
        <h4 className="spaced-title">출금 계좌</h4>
        <div className="form-columns">
          <label>
            은행
            <input
              value={form.bank_name}
              onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
              placeholder="국민은행"
              maxLength={30}
              required
            />
          </label>
          <label>
            계좌번호
            <input
              value={form.account_number}
              onChange={(e) => setForm({ ...form, account_number: e.target.value })}
              placeholder="숫자와 하이픈만"
              maxLength={30}
              required
            />
          </label>
          <label>
            예금주
            <input
              value={form.account_holder}
              onChange={(e) => setForm({ ...form, account_holder: e.target.value })}
              maxLength={30}
              required
            />
          </label>
        </div>
        <label>
          정산 담당 연락처
          <input
            value={form.contact}
            onChange={(e) => setForm({ ...form, contact: e.target.value })}
            placeholder="010-0000-0000"
            maxLength={30}
          />
        </label>
        <div className="info-box">
          <FileSpreadsheet size={17} />
          주민등록번호는 저장하지 않습니다. 비사업자 원천징수 신고에 필요한 정보는 지급대행사 연동
          단계에서 안전하게 수집합니다. 정보를 수정하면 검증 상태가 다시 대기로 바뀝니다.
        </div>
        <button className="primary full" disabled={busy}>
          {busy ? '저장 중…' : '세무 · 정산 정보 저장'}
        </button>
        {form.verified_note && <p className="panel-footnote">관리자 메모: {form.verified_note}</p>}
      </form>
    </section>
  );
}
