import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Eye, Info, Mail, MessageSquare, Scale, Send, ShieldAlert } from 'lucide-react';
import { api, moment, won } from './api';
import { Empty } from './App';
import NumberInput from './NumberInput';

// 최고 관리자 운영 화면 모음(2026-09-29)
//  - MessagingPanel: 이메일·문자 발송 방식(사용 안 함·기록만·웹훅) 설정, 테스트 발송, 최근 발송 기록
//  - ReadinessWarnings: 운영 점검 경고(프록시 설정·암호화 키·발송 설정)
//  - SubscriptionRulesPanel: 구독 배분 규칙(진행률 기준·구독자별 상한)과 이번 달 배분 미리보기
//  - SubscriptionOverrideEditor: 회원 상세에서 PD별 가중치·제외·상한 설정
//  - RevealAccount: 계좌번호 전체 보기(운영 기록이 남아요)

type Notify = (s: string) => void;
type Provider = { id: string; label: string; channels: string[] };
type MessagingConfig = {
  email_provider: string;
  sms_provider: string;
  webhook_url: string;
  sender_name: string;
  sender_email: string;
  sender_number: string;
  secret_set: boolean;
};
type OutboxRow = {
  id: string;
  channel: 'email' | 'sms';
  provider: string;
  recipient: string;
  subject: string;
  body: string;
  purpose: string;
  status: 'sent' | 'failed' | 'disabled';
  error: string;
  created_at: string;
};
const purposeLabel: Record<string, string> = {
  password_reset: '비밀번호 재설정',
  phone_verify: '휴대폰 인증',
  test: '테스트 발송',
};
const statusLabel: Record<string, string> = { sent: '보냄', failed: '실패', disabled: '꺼짐' };

export function MessagingPanel({ notify }: { notify: Notify }) {
  const [data, setData] = useState<{ config: MessagingConfig; providers: Provider[]; outbox: OutboxRow[]; production: boolean } | null>(null),
    [form, setForm] = useState<Omit<MessagingConfig, 'secret_set'> | null>(null),
    [secret, setSecret] = useState(''),
    [clearSecret, setClearSecret] = useState(false),
    [test, setTest] = useState({ channel: 'email' as 'email' | 'sms', to: '' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<NonNullable<typeof data>>('/admin/messaging');
      setData(r);
      const { secret_set, ...rest } = r.config;
      void secret_set;
      setForm(rest);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Empty title="발송 설정을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data || !form)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const options = (channel: string) => data.providers.filter((p) => p.channels.includes(channel));
  const usesWebhook = form.email_provider === 'webhook' || form.sms_provider === 'webhook';
  return (
    <>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">MESSAGING</span>
            <h3>이메일 · 문자 발송 설정</h3>
            <p>비밀번호 찾기 메일과 휴대폰 인증 문자를 어떤 방식으로 보낼지 정해요.</p>
          </div>
          <Mail size={22} className="lime" />
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/admin/messaging', 'PUT', {
                ...form,
                // 비밀값은 새로 입력했을 때만 보내고, '지우기'를 고르면 빈 값으로 보냅니다.
                ...(secret ? { secret } : clearSecret ? { secret: '' } : {}),
              });
              setSecret('');
              setClearSecret(false);
              await load();
              notify('발송 설정을 저장했어요.');
            } catch (err) {
              notify((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-columns">
            <label>
              이메일 발송 방식
              <select value={form.email_provider} onChange={(e) => setForm({ ...form, email_provider: e.target.value })}>
                {options('email').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              문자 발송 방식
              <select value={form.sms_provider} onChange={(e) => setForm({ ...form, sms_provider: e.target.value })}>
                {options('sms').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {data.production && (form.email_provider === 'log' || form.sms_provider === 'log') && (
            <p className="review-alert" role="alert">
              ‘기록만 남기기’는 실제로 메일·문자를 보내지 않아요. 운영 환경에서는 웹훅이나 업체 연결을 골라 주세요.
            </p>
          )}
          <h4 className="spaced-title">웹훅 (외부 발송 중계)</h4>
          <label>
            웹훅 주소
            <input
              type="url"
              placeholder="https://relay.example.com/shortping"
              value={form.webhook_url}
              onChange={(e) => setForm({ ...form, webhook_url: e.target.value })}
              maxLength={500}
              required={usesWebhook}
            />
          </label>
          <label>
            비밀값 (요청 머리글 X-Shortping-Secret · 서명 X-Shortping-Signature)
            <input
              type="password"
              autoComplete="new-password"
              placeholder={data.config.secret_set ? '설정됨 · 바꿀 때만 입력' : '설정되지 않음'}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                if (e.target.value) setClearSecret(false);
              }}
              maxLength={500}
            />
          </label>
          {data.config.secret_set && (
            <label className="settings-toggle">
              <span>
                <strong>저장된 비밀값 지우기</strong>
                <small>지금 비밀값: 설정됨 (화면에는 다시 보여 주지 않아요)</small>
              </span>
              <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} disabled={!!secret} />
            </label>
          )}
          <h4 className="spaced-title">보내는 사람</h4>
          <div className="form-columns">
            <label>
              보내는 이름
              <input value={form.sender_name} maxLength={40} onChange={(e) => setForm({ ...form, sender_name: e.target.value })} />
            </label>
            <label>
              보내는 이메일
              <input type="email" value={form.sender_email} maxLength={254} onChange={(e) => setForm({ ...form, sender_email: e.target.value })} />
            </label>
            <label>
              발신 번호
              <input value={form.sender_number} maxLength={20} placeholder="02-000-0000" onChange={(e) => setForm({ ...form, sender_number: e.target.value })} />
            </label>
          </div>
          <div className="info-box">
            <Info size={18} />
            웹훅은 {'{ channel, to, subject, text, html, from, purpose }'} JSON을 POST로 보내요. SendGrid · NHN Cloud · 알리고 ·
            솔라피 같은 업체는 이 JSON을 받아 업체 API로 넘기는 작은 중계 서버로 연결하면 돼요. 업체를 서버에 직접 붙일 때는
            server/messaging.mjs의 providers에 한 항목만 더하면 이 목록에 나타나요.
          </div>
          <button className="primary full" disabled={busy}>
            {busy ? '저장 중…' : '발송 설정 저장'}
          </button>
        </form>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>테스트 발송</h3>
            <p>저장한 설정으로 한 통을 보내 봐요. 결과는 아래 발송 기록에 남아요.</p>
          </div>
          <Send size={20} className="lime" />
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api('/admin/messaging/test', 'POST', test);
              notify('테스트 발송을 마쳤어요.');
            } catch (err) {
              notify((err as Error).message);
            } finally {
              setBusy(false);
              await load();
            }
          }}
        >
          <div className="form-columns">
            <label>
              종류
              <select value={test.channel} onChange={(e) => setTest({ ...test, channel: e.target.value as 'email' | 'sms' })}>
                <option value="email">이메일</option>
                <option value="sms">문자</option>
              </select>
            </label>
            <label>
              받는 곳
              <input
                value={test.to}
                required
                maxLength={254}
                placeholder={test.channel === 'email' ? 'me@example.com' : '010-1234-5678'}
                onChange={(e) => setTest({ ...test, to: e.target.value })}
              />
            </label>
          </div>
          <button className="secondary full" disabled={busy}>
            테스트 발송
          </button>
        </form>
      </section>
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>최근 발송 기록</h3>
            <p>최근 50건 · 받는 사람은 가려서 보여 주고, 재설정 링크·인증번호가 담긴 본문은 표시하지 않아요.</p>
          </div>
          <MessageSquare size={20} className="lime" />
        </div>
        {data.outbox.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>종류</th>
                  <th>용도</th>
                  <th>받는 사람</th>
                  <th>방식</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {data.outbox.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{moment(r.created_at)}</td>
                    <td>{r.channel === 'sms' ? '문자' : '이메일'}</td>
                    <td>
                      {purposeLabel[r.purpose] || r.purpose || '-'}
                      {r.body && <small>{r.body.slice(0, 80)}</small>}
                    </td>
                    <td className="nowrap">{r.recipient}</td>
                    <td>{data.providers.find((p) => p.id === r.provider)?.label || r.provider}</td>
                    <td>
                      <span className={'status-chip ' + (r.status === 'sent' ? '' : 'neutral')}>{statusLabel[r.status] || r.status}</span>
                      {r.error && <small>{r.error}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">아직 발송 기록이 없어요.</p>
        )}
      </section>
    </>
  );
}

type Warning = { id: string; level: 'danger' | 'warning' | 'info'; title: string; text: string };
export function ReadinessWarnings({ compact = false }: { compact?: boolean }) {
  const [warnings, setWarnings] = useState<Warning[] | null>(null);
  useEffect(() => {
    api<{ warnings: Warning[] }>('/admin/readiness')
      .then((r) => setWarnings(r.warnings))
      .catch(() => setWarnings([]));
  }, []);
  const shown = (warnings || []).filter((w) => !compact || w.level !== 'info');
  if (!shown.length) return null;
  return (
    <section className="management-panel readiness-warnings" aria-label="운영 점검 경고">
      <div className="panel-heading">
        <div>
          <h3>
            <ShieldAlert size={18} /> 운영 점검
          </h3>
          <p>서비스를 운영하기 전에 확인해 주세요.</p>
        </div>
      </div>
      {shown.map((w) => (
        <div key={w.id} className={'readiness-item ' + w.level} role={w.level === 'danger' ? 'alert' : undefined}>
          {w.level === 'info' ? <Info size={17} /> : <AlertTriangle size={17} />}
          <div>
            <strong>{w.title}</strong>
            <p>{w.text}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

type SubSettings = {
  sub_view_rules_enabled: number;
  sub_min_progress_pct: number;
  sub_cap_per_drama: number;
  sub_cap_per_user: number;
};
type PreviewShare = {
  pd_id: string;
  name: string;
  views: number;
  weight: number;
  multiplier: number;
  excluded: boolean;
  cap_pct: number;
  effective: number;
  capped: boolean;
  gross: number;
};
type Preview = {
  period: string;
  pool: number;
  counted_views: number;
  capped_views: number;
  undistributed: number;
  shares: PreviewShare[];
};
const thisMonth = () => {
  const d = new Date(Date.now() + 9 * 3600000);
  return d.toISOString().slice(0, 7);
};
export function SubscriptionRulesPanel({ notify }: { notify: Notify }) {
  const [form, setForm] = useState<SubSettings | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [period, setPeriod] = useState(thisMonth),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: SubSettings }>('/admin/settings');
      setForm({
        sub_view_rules_enabled: Number(r.settings.sub_view_rules_enabled ?? 1),
        sub_min_progress_pct: Number(r.settings.sub_min_progress_pct ?? 30),
        sub_cap_per_drama: Number(r.settings.sub_cap_per_drama ?? 20),
        sub_cap_per_user: Number(r.settings.sub_cap_per_user ?? 200),
      });
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadPreview = useCallback(async (p: string) => {
    try {
      setPreview(await api<Preview>('/admin/subscription/preview?period=' + p));
    } catch (e) {
      notify((e as Error).message);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadPreview(period);
  }, [period, loadPreview]);
  if (error) return <Empty title="구독 배분 설정을 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!form) return null;
  const num = (key: keyof SubSettings) => (e: { target: { value: string } }) => setForm({ ...form, [key]: Number(e.target.value) });
  return (
    <section className="management-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SUBSCRIPTION POOL</span>
          <h3>구독 배분 규칙</h3>
          <p>숏핑 패스 매출(결제 수수료 제외)을 PD에게 ‘인정 재생 수 × PD 가중치’ 비율로 나눠요. 월 마감 때 적용돼요.</p>
        </div>
        <Scale size={22} className="lime" />
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('/admin/settings', 'PUT', form);
            await loadPreview(period);
            notify('구독 배분 규칙을 저장했어요.');
          } catch (err) {
            notify((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="settings-toggle">
          <span>
            <strong>인정 재생 규칙 사용</strong>
            <small>끄면 예전처럼 구독자가 재생을 시작한 유료 회차를 모두 셉니다(PD별 개별 설정은 그대로 적용).</small>
          </span>
          <input
            type="checkbox"
            checked={form.sub_view_rules_enabled === 1}
            onChange={(e) => setForm({ ...form, sub_view_rules_enabled: e.target.checked ? 1 : 0 })}
          />
        </label>
        <div className="form-columns">
          <label>
            인정 기준 (회차 길이의 %)
            <NumberInput min={0} max={100} value={form.sub_min_progress_pct} onChange={num('sub_min_progress_pct')} required />
          </label>
          <label>
            구독자 1명 · 작품당 월 최대 (회, 0=제한 없음)
            <NumberInput min={0} max={10000} value={form.sub_cap_per_drama} onChange={num('sub_cap_per_drama')} required />
          </label>
          <label>
            구독자 1명 · 월 전체 최대 (회, 0=제한 없음)
            <NumberInput min={0} max={100000} value={form.sub_cap_per_user} onChange={num('sub_cap_per_user')} required />
          </label>
        </div>
        <p className="muted settings-note">
          인정 기준은 조회수(인기순)에도 같이 쓰여요. PD별 가중치 · 배분 제외 · 상한(풀의 %)은 ‘전체 회원’ 상세에서 정해요.
        </p>
        <button className="primary full" disabled={busy}>
          {busy ? '저장 중…' : '구독 배분 규칙 저장'}
        </button>
      </form>
      <div className="panel-heading spaced-title">
        <div>
          <h4>배분 미리보기</h4>
          <p className="muted">지금 규칙으로 계산한 결과예요. 저장되지 않아요.</p>
        </div>
        <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="미리볼 달" />
      </div>
      {preview && (
        <>
          <p className="muted">
            구독 풀 {won(preview.pool)} · 인정 재생 {preview.counted_views.toLocaleString('ko-KR')}회 · 상한으로 빠진 재생{' '}
            {preview.capped_views.toLocaleString('ko-KR')}회
            {preview.undistributed ? ` · 배분되지 않고 남는 금액 ${won(preview.undistributed)}` : ''}
          </p>
          {preview.shares.length ? (
            <div className="table-scroll">
              <table className="management-table">
                <thead>
                  <tr>
                    <th>PD</th>
                    <th>인정 재생</th>
                    <th>가중치</th>
                    <th>가중 재생</th>
                    <th>배분액(세전)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.shares.map((s) => (
                    <tr key={s.pd_id}>
                      <td>
                        <strong>{s.name || s.pd_id}</strong>
                        {s.excluded && <small>배분 제외</small>}
                        {s.cap_pct > 0 && <small>상한 {s.cap_pct}%{s.capped ? ' · 상한 적용됨' : ''}</small>}
                      </td>
                      <td>
                        {s.weight.toLocaleString('ko-KR')}
                        {s.views !== s.weight && <small>기록 {s.views.toLocaleString('ko-KR')}</small>}
                      </td>
                      <td>×{s.multiplier}</td>
                      <td>{s.effective.toLocaleString('ko-KR')}</td>
                      <td className="nowrap">
                        <b className="lime">{won(s.gross)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">이 달에는 배분할 재생 기록이 없어요.</p>
          )}
        </>
      )}
    </section>
  );
}

type Override = { weight: number; excluded: number | boolean; cap_pct: number; memo: string; updated_at?: string } | null;
export function SubscriptionOverrideEditor({
  memberId,
  initial,
  notify,
  onSaved,
}: {
  memberId: string;
  initial: Override;
  notify: Notify;
  onSaved?: () => void;
}) {
  const [form, setForm] = useState({
    weight: Number(initial?.weight ?? 1),
    excluded: Boolean(Number(initial?.excluded ?? 0)),
    cap_pct: Number(initial?.cap_pct ?? 0),
    memo: initial?.memo || '',
  });
  const [busy, setBusy] = useState(false);
  const save = async (body: typeof form, message: string) => {
    setBusy(true);
    try {
      await api('/admin/members/' + memberId + '/subscription-override', 'PUT', body);
      setForm(body);
      notify(message);
      onSaved?.();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="subscription-override"
      onSubmit={(e) => {
        e.preventDefault();
        void save(form, '구독 배분 개별 설정을 저장했어요.');
      }}
    >
      <h4>구독 배분 개별 설정</h4>
      <p className="muted">
        배분액 = 구독 풀 × (이 PD의 인정 재생 × 가중치) ÷ (전체 PD 합계). 상한을 넘는 몫은 다른 PD에게 다시 나눠요.
        {initial?.updated_at ? ` · 마지막 변경 ${moment(initial.updated_at)}` : ''}
      </p>
      <div className="form-columns">
        <label>
          가중치 (0~5배)
          <NumberInput min={0} max={5} step={0.1} value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} required />
        </label>
        <label>
          상한 (풀의 %, 0=없음)
          <NumberInput min={0} max={100} step={0.1} value={form.cap_pct} onChange={(e) => setForm({ ...form, cap_pct: Number(e.target.value) })} required />
        </label>
      </div>
      <label className="settings-toggle">
        <span>
          <strong>구독 배분에서 제외</strong>
          <small>이 PD 작품의 재생은 배분에 넣지 않아요(다른 PD 몫이 그만큼 늘어요).</small>
        </span>
        <input type="checkbox" checked={form.excluded} onChange={(e) => setForm({ ...form, excluded: e.target.checked })} />
      </label>
      <label>
        메모 (운영 기록용)
        <input value={form.memo} maxLength={200} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="예) 독점 계약 가중치" />
      </label>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void save({ weight: 1, excluded: false, cap_pct: 0, memo: '' }, '구독 배분 개별 설정을 기본값으로 되돌렸어요.')}
        >
          기본값으로
        </button>
        <button className="primary" disabled={busy}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </form>
  );
}

// 계좌번호 전체 보기: 목록에는 가린 번호만 보이고, 이 버튼을 누를 때 운영 기록을 남기고 전체 번호를 받아 옵니다.
export function RevealAccount({ kind, id, masked, notify }: { kind: 'payout' | 'tax'; id: string; masked: string; notify: Notify }) {
  const [full, setFull] = useState('');
  const [busy, setBusy] = useState(false);
  if (!masked) return null;
  return (
    <span className="reveal-account">
      <span className="nowrap">{full || masked}</span>
      {!full && (
        <button
          type="button"
          className="text-link"
          disabled={busy}
          aria-label="계좌번호 전체 보기 (운영 기록에 남아요)"
          title="전체 번호 보기 · 운영 기록에 남아요"
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ account_number: string }>(`/admin/${kind === 'payout' ? 'payouts' : 'tax'}/${id}/account`, 'POST');
              setFull(r.account_number);
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Eye size={14} /> 전체 보기
        </button>
      )}
    </span>
  );
}
