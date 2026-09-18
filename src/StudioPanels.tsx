import { useState } from 'react';
import { ArrowRight, CheckCircle2, Download, Search } from 'lucide-react';
import { won, type Order, type Drama, type User } from './api';
import { Empty } from './App';
import type { StudioData } from './Studio';

const date = (value: string) => new Date(value).toLocaleString('ko-KR');
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function downloadCsv(name: string, rows: (string | number)[][]) {
  // Quoting alone does not prevent spreadsheet formula execution.
  const safe = (value: string | number) => {
    let text = String(value);
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const url = URL.createObjectURL(
    new Blob(['\uFEFF' + rows.map((row) => row.map(safe).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StudioInsights({ data }: { data: StudioData }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date();
    day.setDate(day.getDate() - 6 + i);
    const key = localDay(day);
    return {
      label: `${day.getMonth() + 1}/${day.getDate()}`,
      amount: data.orders
        .filter((o) => localDay(new Date(o.created_at)) === key)
        .reduce((n, o) => n + o.amount, 0),
    };
  });
  const max = Math.max(...days.map((d) => d.amount), 1);
  const statuses = [
    ['published', '공개 중'],
    ['pending', '심사 대기'],
    ['draft', '임시저장'],
    ['rejected', '반려'],
  ];
  return (
    <div className="insights-grid">
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">LAST 7 DAYS</span>
            <h3>최근 7일 테스트 매출</h3>
          </div>
          <strong className="lime">{won(days.reduce((n, d) => n + d.amount, 0))}</strong>
        </div>
        <div
          className="revenue-chart"
          role="img"
          aria-label={days.map((d) => `${d.label} ${won(d.amount)}`).join(', ')}
        >
          {days.map((d) => (
            <div className="chart-column" key={d.label}>
              <small>{won(d.amount)}</small>
              <div className="chart-track">
                <span style={{ height: `${Math.max(3, (d.amount / max) * 100)}%` }} />
              </div>
              <span>{d.label}</span>
            </div>
          ))}
        </div>
        <p className="panel-footnote">실제 청구되지 않은 테스트 결제 · 브라우저 현지 날짜 기준</p>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">CONTENT PIPELINE</span>
            <h3>작품 진행 현황</h3>
          </div>
          <span className="tag-outline">{data.dramas.length}편</span>
        </div>
        <div className="pipeline-list">
          {statuses.map(([status, label]) => {
            const n = data.dramas.filter((d) => d.status === status).length;
            return (
              <div key={status}>
                <span>
                  <i className={'pipeline-dot ' + status} />
                  {label}
                </span>
                <div>
                  <i style={{ width: `${(n / Math.max(1, data.dramas.length)) * 100}%` }} />
                </div>
                <strong>{n}</strong>
              </div>
            );
          })}
        </div>
        <p className="panel-footnote">회차 업로드 → 심사 요청 → 관리자 승인 → 공개</p>
      </section>
    </div>
  );
}

export function StudioOrders({ orders }: { orders: Order[] }) {
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [from, setFrom] = useState(''),
    [until, setUntil] = useState(''),
    [page, setPage] = useState(0);
  const filtered = orders.filter(
    (o) =>
      (kind === 'all' || kind === o.kind) &&
      `${o.id} ${o.title || '숏핑 패스 구독'}`.toLowerCase().includes(query.toLowerCase()) &&
      (!from || localDay(new Date(o.created_at)) >= from) &&
      (!until || localDay(new Date(o.created_at)) <= until),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 15)),
    current = Math.min(page, pages - 1);
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>주문 내역 조회</h3>
          <p>
            {filtered.length}건 · 합계 {won(filtered.reduce((n, o) => n + o.amount, 0))}
          </p>
        </div>
        <button
          className="secondary compact"
          disabled={!filtered.length}
          onClick={() =>
            downloadCsv('숏핑-주문.csv', [
              ['주문번호', '작품', '유형', '금액(원)', '상태', '주문일'],
              ...filtered.map((o) => [
                o.id,
                o.title || '숏핑 패스',
                o.kind === 'drama' ? '개별 구매' : '구독',
                o.amount,
                o.status,
                date(o.created_at),
              ]),
            ])
          }
        >
          <Download size={16} />
          CSV 내보내기
        </button>
      </div>
      <div className="management-toolbar">
        <label className="management-search">
          <Search size={17} />
          <input
            aria-label="주문 검색"
            placeholder="작품명 또는 주문번호"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="주문 유형"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">전체 유형</option>
          <option value="drama">개별 구매</option>
          <option value="subscription">구독</option>
        </select>
      </div>
      <div className="date-filter">
        <label>
          시작일
          <input
            type="date"
            value={from}
            max={until || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span>—</span>
        <label>
          종료일
          <input
            type="date"
            value={until}
            min={from || undefined}
            onChange={(e) => {
              setUntil(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <button
          onClick={() => {
            setFrom('');
            setUntil('');
            setQuery('');
            setKind('all');
            setPage(0);
          }}
        >
          초기화
        </button>
      </div>
      {filtered.length ? (
        <>
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>주문 / 작품</th>
                  <th>유형</th>
                  <th>주문일</th>
                  <th>금액</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(current * 15, current * 15 + 15).map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.title || '숏핑 패스 30일'}</strong>
                      <small>{o.id}</small>
                    </td>
                    <td>{o.kind === 'drama' ? '개별 구매' : '구독'}</td>
                    <td>{date(o.created_at)}</td>
                    <td className="nowrap">{won(o.amount)}</td>
                    <td>
                      <span className="status-chip">테스트 완료</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button disabled={!current} onClick={() => setPage(current - 1)}>
              이전
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>
              다음
            </button>
          </div>
        </>
      ) : (
        <Empty
          title="해당 주문이 없어요"
          text="검색 조건을 변경하거나 시청자 계정으로 테스트 구매를 진행하세요."
        />
      )}
      <p className="panel-footnote">
        CSV에는 현재 검색 조건에 맞는 전체 주문이 포함됩니다. 실제 결제·환불·정산은 결제사 연동 후
        제공됩니다.
      </p>
    </section>
  );
}

const actionLabel = (action: string) =>
  action === 'published'
    ? '작품 공개 승인'
    : action === 'rejected'
      ? '작품 반려'
      : action === 'support:replied'
        ? '문의 답변 등록'
        : action.startsWith('user:')
          ? '회원 권한 · 상태 변경'
          : action;
export function StudioAudit({
  logs,
  dramas,
  users,
}: {
  logs: StudioData['logs'];
  dramas: Drama[];
  users: User[];
}) {
  const [query, setQuery] = useState('');
  const target = (id: string) =>
    dramas.find((d) => d.id === id)?.title || users.find((u) => u.id === id)?.name || id;
  const filtered = logs.filter((l) =>
    `${l.name} ${actionLabel(l.action)} ${target(l.target_id)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>운영 감사 기록</h3>
          <p>최근 30건 · 서버에 저장된 변경 이력</p>
        </div>
      </div>
      <label className="management-search">
        <Search size={17} />
        <input
          aria-label="운영 기록 검색"
          placeholder="담당자, 작업 또는 대상 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {filtered.length ? (
        <div className="audit-timeline">
          {filtered.map((l) => (
            <article key={l.id}>
              <CheckCircle2 size={18} />
              <div>
                <strong>{actionLabel(l.action)}</strong>
                <p>
                  {l.name} · {target(l.target_id)}
                </p>
                <small>
                  {date(l.created_at)} · {l.action}
                </small>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="표시할 운영 기록이 없어요"
          text="작품 심사, 회원 변경, 문의 답변이 이곳에 기록됩니다."
        />
      )}
    </section>
  );
}

export function StudioSubscriptions({
  subscriptions,
}: {
  subscriptions: StudioData['subscriptions'];
}) {
  const [query, setQuery] = useState(''),
    [state, setState] = useState('all');
  const active = (s: StudioData['subscriptions'][number]) =>
    new Date(s.expires_at).getTime() > Date.now();
  const filtered = subscriptions.filter(
    (s) =>
      `${s.name} ${s.email}`.toLowerCase().includes(query.toLowerCase()) &&
      (state === 'all' || (state === 'active') === active(s)),
  );
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <h3>숏핑 패스 구독 현황</h3>
          <p>
            이용 중 {subscriptions.filter(active).length}명 · 만료{' '}
            {subscriptions.filter((s) => !active(s)).length}명
          </p>
        </div>
        <span className="tag-outline">30일 이용권</span>
      </div>
      <div className="management-toolbar">
        <label className="management-search">
          <Search size={17} />
          <input
            aria-label="구독 회원 검색"
            placeholder="이름 또는 이메일 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select aria-label="구독 상태" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="all">전체 상태</option>
          <option value="active">이용 중</option>
          <option value="expired">만료</option>
        </select>
      </div>
      {filtered.length ? (
        <div className="table-scroll">
          <table className="management-table">
            <thead>
              <tr>
                <th>회원</th>
                <th>만료일</th>
                <th>상태</th>
                <th>갱신</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.user_id}>
                  <td>
                    <strong>{s.name}</strong>
                    <small>{s.email}</small>
                  </td>
                  <td>{date(s.expires_at)}</td>
                  <td>
                    <span className={'status-chip ' + (active(s) ? '' : 'neutral')}>
                      {active(s) ? '이용 중' : '만료'}
                    </span>
                  </td>
                  <td>{s.auto_renew ? '자동 갱신' : '자동 갱신 없음'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="해당 구독 내역이 없어요"
          text="테스트 구독을 구매하면 이용 현황이 표시됩니다."
        />
      )}
      <p className="panel-footnote">
        현재 테스트 패스는 자동 결제되지 않습니다. 회원은 마이페이지에서 테스트 구독을 종료할 수
        있습니다.
      </p>
    </section>
  );
}

export function StudioOperations({ operations: op }: { operations: StudioData['operations'] }) {
  if (!op) return null;
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>현재 서비스 연결 상태</h3>
            <p>서버 환경 설정 기준 · 비밀키는 표시하지 않습니다.</p>
          </div>
        </div>
        <div className="service-grid">
          {[
            ['실행 환경', op.environment === 'production' ? '운영' : '로컬 개발', true],
            ['데이터베이스', op.database, true],
            ['이메일 로그인', '연결됨', true],
            ['테스트 로그인 · 결제', op.demo ? '사용 중' : '비활성화', op.demo],
            ['Android 스토어 링크', op.androidReady ? '설정됨' : '출시 준비 중', op.androidReady],
            ['iOS 스토어 링크', op.iosReady ? '설정됨' : '출시 준비 중', op.iosReady],
            ['카카오 · 네이버 · Google', '소셜 로그인 연동 예정', false],
            ['실결제 · 앱 내 결제', '결제사 및 IAP 연동 예정', false],
          ].map(([label, value, ok]) => (
            <div key={String(label)}>
              <span>{label}</span>
              <strong>
                <i className={ok ? 'connected' : ''} />
                {value}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <section className="management-panel release-note">
        <h3>출시 준비 안내</h3>
        <p>
          AWS 배포 시 PostgreSQL과 HTTPS 도메인을 설정하고 테스트 로그인을 비활성화합니다. 앱 스토어
          링크는 서버 환경 변수로 관리합니다.
        </p>
        <p>
          현재 영상은 기능 확인용 샘플입니다. 실제 드라마 영상과 이용약관, 결제 정책을 준비한 뒤
          정식 서비스를 운영하세요.
        </p>
      </section>
    </>
  );
}

export function StudioGuide({ admin, onCreate }: { admin: boolean; onCreate: () => void }) {
  const steps = admin
    ? [
        ['콘텐츠 심사', '심사 대기 작품의 소개, 가격, 무료 회차 수와 영상을 검토합니다.'],
        [
          '승인 또는 반려',
          '승인하면 시청자 화면에 공개됩니다. 수정이 필요하면 반려 사유를 입력해 PD에게 전달합니다.',
        ],
        [
          '계정과 운영 관리',
          '회원 권한 및 상태를 변경하고 주문·구독·문의와 운영 기록을 확인합니다.',
        ],
      ]
    : [
        ['작품 정보 등록', '제목, 한 줄 소개, 시놉시스, 장르, 가격과 포스터를 입력합니다.'],
        [
          '회차 업로드',
          '1화부터 순서대로 제목과 영상을 등록합니다. 업로드 제한은 파일당 250MB입니다.',
        ],
        [
          '심사 요청과 공개',
          '영상을 모두 등록한 뒤 심사를 요청합니다. 반려 시 의견을 확인하고 수정 후 다시 요청할 수 있습니다.',
        ],
      ];
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">START YOUR STORY</span>
          <h3>{admin ? '슈퍼관리자 운영 가이드' : 'PD 작품 등록 가이드'}</h3>
        </div>
      </div>
      <div className="guide-steps">
        {steps.map(([title, body], i) => (
          <article key={title}>
            <b>0{i + 1}</b>
            <div>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </article>
        ))}
      </div>
      <button className="primary" onClick={onCreate}>
        새 작품 등록하기
        <ArrowRight size={17} />
      </button>
      <p className="panel-footnote">
        PD는 본인 작품과 개별 구매 매출만 확인합니다. 구독 매출 배분과 실제 정산은 별도 연동
        예정입니다.
      </p>
    </section>
  );
}
