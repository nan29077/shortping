import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import { asset } from './platform';
import { useConfirm } from './confirm';
import './admin-quality.css';
import NumberInput from './NumberInput';

// 모델 품질 시험 · 품질 대시보드(6단계, 2026-09-30) — 최고 관리자 전용
// 1) 같은 시험 문제를 여러 모델에 보내고(라마 차감 없음, 원가는 플랫폼 부담) AI 검수로 자동 채점해요.
// 2) 모델별 시험 점수 · 인물 닮음 · 원가 · 걸린 시간과, 실제 PD 사용 실적(성공률 · 원가 · 시간 · 실제 AI 검수 점수)을 한 표로 봐요.
// 3) '비용 한도 · 정책'의 품질 가중치를 올리면 자동 선택이 점수 높은 모델을 먼저 골라요.
type Bench = { id: string; name: string; capability: 'image' | 'video'; prompt: string; ref_image: string; seconds: number };
type Run = { id: string; benchmark_id: string; bench_name: string; capability: string; model_id: string; model_label: string | null; status: string; result_url: string; score: number | null; face: number | null; cost_won: number; seconds: number | null; summary: string; error: string; created_at: string };
type Model = { id: string; label: string; capability: string; tier: string; active: number; provider: string };
type Row = Model & {
  bench: { runs: number; done: number; failed: number; score: number | null; face: number | null; cost_won: number | null; seconds: number | null } | null;
  usage: { jobs: number; success: number | null; failed: number; cost_won: number | null; lama: number; seconds: number | null } | null;
  real: { samples: number; score: number | null; face: number | null } | null;
  quality: number | null;
  quality_samples: number;
};
const STATUS: Record<string, string> = { running: '만드는 중', scoring: '채점 중', done: '완료', failed: '실패', unscored: '채점 못 함', queued: '대기' };
const CAP: Record<string, string> = { image: '이미지', video: '영상', tts: '음성', lipsync: '입 모양', upscale: '화질(이미지)', upscale_video: '화질(영상)', text: '글' };
const won = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v).toLocaleString('ko-KR')}원`);
const dash = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);

export default function AdminAiQuality({ notify, goPolicy }: { notify: (s: string) => void; goPolicy: () => void }) {
  const [data, setData] = useState<{ benchmarks: Bench[]; runs: Run[]; models: Model[] } | null>(null);
  const [board, setBoard] = useState<{ models: Row[]; weight: number } | null>(null);
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', capability: 'image' as 'image' | 'video', prompt: '', ref_image: '', seconds: 5 });
  const [ask, confirmUi] = useConfirm();
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api<{ benchmarks: Bench[]; runs: Run[]; models: Model[] }>('/admin/ai/bench'), api<{ models: Row[]; weight: number }>('/admin/ai/quality')]);
      setData(a);
      setBoard(b);
    } catch (e) {
      notify((e as Error).message);
    }
  }, [notify]);
  useEffect(() => {
    void load();
  }, [load]);
  // 진행 중인 시험이 있으면 3초마다 새로 봐요.
  const pending = !!data?.runs.some((r) => ['running', 'scoring', 'queued'].includes(r.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [pending, load]);
  const rows = useMemo(() => (board?.models || []).filter((m) => ['image', 'video'].includes(m.capability) || m.usage || m.real), [board]);
  if (!data || !board)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const run = async (b: Bench) => {
    const models = pick[b.id] || [];
    if (!models.length) return notify('시험할 모델을 골라 주세요.');
    if (!(await ask({ title: `‘${b.name}’ 시험`, text: `고른 모델 ${models.length}개에 같은 문제를 보내요. 라마는 들지 않지만 공급사 원가는 플랫폼이 부담해요.`, ok: '시험 시작' }))) return;
    setBusy(true);
    try {
      const r = await api<{ runs: unknown[]; skipped: { model: string; reason: string }[] }>(`/admin/ai/bench/${b.id}/run`, 'POST', { models });
      notify(`${r.runs.length}개 모델로 시험을 시작했어요.${r.skipped.length ? ` 건너뜀 ${r.skipped.length}개: ${r.skipped.map((x) => x.reason).join(' / ')}` : ''}`);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    setBusy(true);
    try {
      await api('/admin/ai/bench', 'POST', form);
      setAdding(false);
      setForm({ name: '', capability: 'image', prompt: '', ref_image: '', seconds: 5 });
      await load();
      notify('시험 문제를 추가했어요.');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (b: Bench) => {
    if (!(await ask({ title: '시험 문제 지우기', text: `‘${b.name}’과 지난 시험 기록을 지워요.`, ok: '지우기', danger: true }))) return;
    try {
      await api(`/admin/ai/bench/${b.id}`, 'DELETE');
      await load();
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <div className="aq">
      {confirmUi}
      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>
              <FlaskConical size={16} /> 모델 품질표
            </h3>
            <p className="muted">
              시험 점수(같은 문제 · 자동 채점)와 실제 PD 작업 실적(최근 30일) · 실제 AI 검수 점수(최근 60일)를 함께 봐요. 품질 점수는 시험과 실제 검수를 합친 평균(표본 3개 이상)이에요.
            </p>
          </div>
          <button type="button" className="secondary compact" onClick={() => void load()}>
            <RefreshCw size={13} /> 새로 보기
          </button>
        </div>
        <p className="settings-note">
          자동 선택 품질 가중치: <b>{board.weight}</b>
          {board.weight ? '' : ' (꺼짐)'} ·{' '}
          <button type="button" className="text-link" onClick={goPolicy}>
            ‘비용 한도 · 정책’에서 바꾸기
          </button>
        </p>
        <div className="table-scroll">
          <table className="management-table aq-table">
            <thead>
              <tr>
                <th>모델</th>
                <th>종류</th>
                <th>품질 점수</th>
                <th>시험 점수</th>
                <th>시험 닮음</th>
                <th>시험 원가 · 시간</th>
                <th>실제 작업(30일)</th>
                <th>성공률</th>
                <th>실제 원가 · 시간</th>
                <th>실제 검수 점수</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={m.active ? '' : 'off'}>
                  <td>
                    <b>{m.label}</b>
                    <small className="muted"> · {m.provider}</small>
                  </td>
                  <td>{CAP[m.capability] || m.capability}</td>
                  <td>{m.quality === null ? <span className="muted">표본 {m.quality_samples}</span> : <b className={m.quality >= 85 ? 'good' : m.quality < 70 ? 'bad' : ''}>{m.quality}</b>}</td>
                  <td>{m.bench ? `${dash(m.bench.score)} (${m.bench.done}/${m.bench.runs})` : '—'}</td>
                  <td>{dash(m.bench?.face)}</td>
                  <td>{m.bench ? `${won(m.bench.cost_won)} · ${dash(m.bench.seconds, '초')}` : '—'}</td>
                  <td>{m.usage ? `${m.usage.jobs}건` : '—'}</td>
                  <td>{m.usage?.success === null || m.usage?.success === undefined ? '—' : `${m.usage.success}%`}</td>
                  <td>{m.usage ? `${won(m.usage.cost_won)} · ${dash(m.usage.seconds, '초')}` : '—'}</td>
                  <td>{m.real ? `${dash(m.real.score)} (${m.real.samples})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>시험 문제</h3>
            <p className="muted">문제를 고르고 비교할 모델을 체크한 뒤 ‘시험’을 누르세요. 결과는 AI 검수로 자동 채점돼요(라마 차감 없음).</p>
          </div>
          <button type="button" className="secondary compact" onClick={() => setAdding(!adding)}>
            <Plus size={13} /> 문제 추가
          </button>
        </div>
        {adding && (
          <form
            className="aq-add"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="form-columns">
              <label>
                이름
                <input required minLength={2} maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label>
                종류
                <select value={form.capability} onChange={(e) => setForm({ ...form, capability: e.target.value as 'image' | 'video' })}>
                  <option value="image">이미지</option>
                  <option value="video">영상</option>
                </select>
              </label>
            </div>
            <label>
              프롬프트(영어 권장)
              <textarea required minLength={10} maxLength={800} rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
            </label>
            <div className="form-columns">
              <label>
                기준 얼굴 이미지 주소(선택 · 인물 닮음 채점용)
                <input value={form.ref_image} placeholder="/uploads/….jpg" onChange={(e) => setForm({ ...form, ref_image: e.target.value.trim() })} />
              </label>
              {form.capability === 'video' && (
                <label>
                  영상 길이(초)
                  <NumberInput min={2} max={10} value={form.seconds} onChange={(e) => setForm({ ...form, seconds: Number(e.target.value) || 5 })} />
                </label>
              )}
            </div>
            <div className="form-actions start">
              <button className="primary" disabled={busy}>
                추가
              </button>
            </div>
          </form>
        )}
        <div className="aq-benches">
          {data.benchmarks.map((b) => {
            const models = data.models.filter((m) => m.capability === b.capability);
            const chosen = pick[b.id] || [];
            const last = data.runs.filter((r) => r.benchmark_id === b.id).slice(0, 8);
            return (
              <article key={b.id} className="aq-bench">
                <div className="aq-bench-head">
                  <b>{b.name}</b>
                  <small className="muted">{b.capability === 'video' ? `영상 ${b.seconds}초` : '이미지'}</small>
                  <button type="button" className="icon-button" aria-label={`${b.name} 지우기`} onClick={() => void remove(b)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <p className="aq-prompt">{b.prompt}</p>
                <div className="chip-row">
                  {models.map((m) => {
                    const on = chosen.includes(m.id);
                    return (
                      <button
                        type="button"
                        key={m.id}
                        className={'chip' + (on ? ' active' : '')}
                        aria-pressed={on}
                        disabled={(!on && chosen.length >= 8) || !m.active}
                        title={m.active ? '' : '꺼진 모델은 시험할 수 없어요. 모델 · 가격에서 켜 주세요.'}
                        onClick={() => setPick({ ...pick, [b.id]: on ? chosen.filter((x) => x !== m.id) : [...chosen, m.id] })}
                      >
                        {m.label}
                        {m.active ? '' : ' (꺼짐)'}
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="primary compact" disabled={busy || !chosen.length} onClick={() => void run(b)}>
                  <Play size={13} /> 시험 {chosen.length ? `(${chosen.length}개 모델)` : ''}
                </button>
                {last.length > 0 && (
                  <div className="aq-results">
                    {last.map((r) => (
                      <figure key={r.id} className={'aq-result ' + r.status}>
                        {r.result_url ? r.capability === 'video' ? <video src={asset(r.result_url)} muted playsInline preload="metadata" controls /> : <img src={asset(r.result_url)} alt="" loading="lazy" /> : <span className="aq-empty">{STATUS[r.status] || r.status}</span>}
                        <figcaption>
                          <b>{r.model_label || r.model_id}</b>
                          <span>
                            {r.status === 'done' ? `${r.score}점${r.face !== null ? ` · 닮음 ${r.face}` : ''}` : STATUS[r.status] || r.status}
                            {r.seconds ? ` · ${r.seconds}초` : ''}
                            {r.cost_won ? ` · ${won(r.cost_won)}` : ''}
                          </span>
                          {(r.summary || r.error) && <small title={r.summary || r.error}>{r.summary || r.error}</small>}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
