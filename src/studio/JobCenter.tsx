import { useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, Square, Wallet, X } from 'lucide-react';
import { api, ApiError, lama, type AiModelOption, type Capability, type StudioJob, type StudioProjectDetail } from '../api';
import { Modal } from '../App';

// 작업 · 비용 센터(2026-09-24): 진행 중·끝난·실패한 AI 작업을 한곳에서 보고, 실패한 작업은
// 다른 모델로 바로 다시 시도하고, 프로젝트 예산(라마)을 정해요.
export const jobKindLabel: Record<string, string> = {
  plan: '기획안',
  adapt: '원작 각색',
  bible: '작품 설정집',
  season: '시즌 설계',
  metadata: '작품 소개',
  poster: '포스터',
  thumb_bg: '썸네일 배경',
  music: '배경음악',
  script: '대본',
  diagnose: '대본 진단',
  rewrite_range: '대본 구간 다시 쓰기',
  character_image: '인물 기준 이미지',
  character_ref: '인물 참고 이미지',
  location_image: '장소 이미지',
  voice_sample: '목소리 미리 듣기',
  shot_image: '컷 이미지',
  shot_image_edit: '컷 이미지 고치기',
  shot_tts: '대사 음성',
  shot_video: '컷 영상',
  shot_lipsync: '입 모양 맞추기',
  shot_sfx: '효과음',
  rewrite_shot: '컷 다시 쓰기',
  translate: '묘사 번역',
  assistant: 'AI 조수',
};
export const kindCapability: Record<string, Capability> = {
  plan: 'text', adapt: 'text', bible: 'text', season: 'text', metadata: 'text', script: 'text', diagnose: 'text', rewrite_range: 'text', rewrite_shot: 'text', translate: 'text', assistant: 'text',
  poster: 'image', thumb_bg: 'image', character_image: 'image', character_ref: 'image', location_image: 'image', shot_image: 'image', shot_image_edit: 'image',
  voice_sample: 'tts', shot_tts: 'tts', shot_video: 'video', shot_lipsync: 'lipsync', shot_sfx: 'sfx', music: 'music',
};
const RETRYABLE = new Set(Object.keys(kindCapability).filter((k) => !['thumb_bg', 'translate', 'assistant'].includes(k)));

// 작업 대상 설명(예: 2화 3번 컷, 인물 이름)
export function targetText(d: StudioProjectDetail, j: Pick<StudioJob, 'target_type' | 'target_id'>) {
  if (j.target_type === 'shot') {
    for (const e of d.episodes) {
      const i = e.shots.findIndex((s) => s.id === j.target_id);
      if (i >= 0) return `${e.number}화 ${i + 1}번 컷`;
    }
    return '지운 컷';
  }
  if (j.target_type === 'episode') {
    const e = d.episodes.find((x) => x.id === j.target_id);
    return e ? `${e.number}화` : '';
  }
  if (j.target_type === 'character') return d.characters.find((c) => c.id === j.target_id)?.name || '인물';
  if (j.target_type === 'location') return (d.locations || []).find((l) => l.id === j.target_id)?.name || '장소';
  return '작품 전체';
}
const statusText: Record<string, string> = { queued: '대기 중', running: '만드는 중', succeeded: '완료', failed: '실패', canceled: '취소됨' };
const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function JobCenter({
  data,
  models,
  close,
  reload,
  notify,
  ask,
  goLama,
}: {
  data: StudioProjectDetail;
  models: AiModelOption[];
  close: () => void;
  reload: () => Promise<void>;
  notify: (s: string) => void;
  ask: (a: { title: string; text: string; ok?: string; danger?: boolean }) => Promise<boolean>;
  goLama: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'active' | 'failed'>(data.jobs.some((j) => j.status === 'failed') ? 'failed' : 'all');
  const [busy, setBusy] = useState('');
  const [budget, setBudget] = useState(String(data.project.budget_lama || ''));
  const [pick, setPick] = useState<Record<string, string>>({});
  const jobs = data.jobs.filter((j) => j.kind !== 'translate' && (filter === 'all' || (filter === 'active' ? j.status === 'queued' || j.status === 'running' : j.status === 'failed')));
  const counts = {
    active: data.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    failed: data.jobs.filter((j) => j.status === 'failed').length,
  };
  const limit = Number(data.project.budget_lama || 0);
  const reserved = data.jobs.filter((j) => j.status === 'queued' || j.status === 'running').reduce((n, j) => n + Number(j.estimate_lama), 0);
  const used = Number(data.spent) + reserved;
  const retry = async (j: StudioJob, requested: string, budgetOk = false): Promise<void> => {
    setBusy(j.id);
    try {
      await api(`/studio/ai/jobs/${j.id}/retry`, 'POST', { requested, ...(budgetOk ? { budgetOk: true } : {}) });
      notify(requested === 'auto' ? '다른 모델로 다시 시작했어요.' : '고른 모델로 다시 시작했어요.');
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'project_budget') {
        if (await ask({ title: '프로젝트 예산을 넘어요', text: (e as Error).message + ' 그래도 다시 시도할까요?', ok: '예산 넘어도 진행' })) return retry(j, requested, true);
      } else {
        if (e instanceof ApiError && e.code === 'insufficient_lama') goLama();
        notify((e as Error).message);
      }
    } finally {
      setBusy('');
    }
  };
  const cancel = async (j: StudioJob) => {
    setBusy(j.id);
    try {
      await api(`/studio/ai/jobs/${j.id}/cancel`, 'POST');
      notify('작업을 멈췄어요. 예약한 라마는 돌려드려요.');
      await reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const saveBudget = async () => {
    const n = Math.max(0, Math.round(Number(budget) || 0));
    setBusy('budget');
    try {
      await api(`/studio/ai/projects/${data.project.id}/settings`, 'PATCH', { budget_lama: n });
      notify(n ? `프로젝트 예산을 ${lama(n)}로 정했어요.` : '프로젝트 예산 제한을 없앴어요.');
      await reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <Modal title="작업 · 비용" close={close}>
      <div className="jobc">
        <section className="jobc-budget">
          <div className="jobc-budget-head">
            <Wallet size={15} />
            <b>프로젝트 예산</b>
            <small>{limit ? `${lama(used)} / ${lama(limit)} 사용(진행 중 예약 포함)` : `지금까지 ${lama(data.spent)} 사용 · 제한 없음`}</small>
          </div>
          {limit > 0 && (
            <div className="studio-progress-bar" role="progressbar" aria-label="예산 사용률" aria-valuenow={Math.min(100, Math.round((used / limit) * 100))} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: Math.min(100, (used / limit) * 100) + '%', background: used > limit ? '#ff6b6b' : undefined }} />
            </div>
          )}
          <div className="jobc-budget-form">
            <input type="number" min={0} inputMode="numeric" aria-label="프로젝트 예산(라마)" placeholder="예: 3000 (비우면 제한 없음)" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))} />
            <button type="button" className="secondary compact" disabled={busy === 'budget'} onClick={() => void saveBudget()}>
              저장
            </button>
          </div>
          <small className="muted">예산을 넘는 작업은 실행 전에 한 번 더 확인해요. AI 조수와의 대화는 무료예요.</small>
        </section>
        <div className="hub-seg small" role="tablist" aria-label="작업 거르기">
          {(
            [
              ['all', `전체 ${data.jobs.filter((j) => j.kind !== 'translate').length}`],
              ['active', `진행 ${counts.active}`],
              ['failed', `실패 ${counts.failed}`],
            ] as const
          ).map(([k, t]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
              {t}
            </button>
          ))}
        </div>
        {!jobs.length && <p className="muted jobc-empty">{filter === 'failed' ? '실패한 작업이 없어요.' : filter === 'active' ? '진행 중인 작업이 없어요.' : '최근 3일 동안의 작업이 여기에 보여요.'}</p>}
        <ul className="jobc-list">
          {jobs.map((j) => {
            const cap = kindCapability[j.kind];
            const alts = models.filter((m) => m.capability === cap && m.id !== j.model_ref);
            return (
              <li key={j.id} className={'jobc-item ' + j.status}>
                <div className="jobc-line">
                  <span className="jobc-status">
                    {j.status === 'running' || j.status === 'queued' ? <Loader2 size={13} className="spin" /> : j.status === 'succeeded' ? <Check size={13} /> : j.status === 'failed' ? <AlertTriangle size={13} /> : <X size={13} />}
                    {statusText[j.status]}
                  </span>
                  <b>
                    {jobKindLabel[j.kind] || j.kind} <small>{targetText(data, j)}</small>
                  </b>
                  <em>{j.status === 'succeeded' ? lama(j.charged_lama) : j.status === 'failed' || j.status === 'canceled' ? '반환' : '예약 ' + lama(j.estimate_lama)}</em>
                </div>
                <small className="muted">
                  {j.model_label || '모델'} · {when(j.created_at)}
                  {Number(j.attempts) > 1 ? ` · ${j.attempts}번 시도` : ''}
                </small>
                {j.status === 'failed' && <p className="jobc-error">{j.error || '원인을 알 수 없어요.'}</p>}
                {(j.status === 'queued' || j.status === 'running') && (
                  <button type="button" className="text-link" disabled={busy === j.id} onClick={() => void cancel(j)}>
                    <Square size={11} /> 멈추기
                  </button>
                )}
                {(j.status === 'failed' || j.status === 'canceled') && RETRYABLE.has(j.kind) && (
                  <div className="jobc-retry">
                    <button type="button" className="secondary compact" disabled={busy === j.id} onClick={() => void retry(j, 'auto')}>
                      <RotateCcw size={12} /> {alts.length ? '다른 모델로 자동 재시도' : '다시 시도'}
                    </button>
                    {alts.length > 0 && (
                      <>
                        <select aria-label="다시 시도할 모델" value={pick[j.id] || ''} onChange={(e) => setPick({ ...pick, [j.id]: e.target.value })}>
                          <option value="">모델 골라서…</option>
                          {alts.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label} · {lama(m.lama_per_unit)}
                            </option>
                          ))}
                        </select>
                        <button type="button" className="secondary compact" disabled={!pick[j.id] || busy === j.id} onClick={() => void retry(j, pick[j.id])}>
                          이 모델로
                        </button>
                      </>
                    )}
                    <small className="muted">처음 예상 {lama(j.estimate_lama)} 안팎</small>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
