import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Sparkles, X } from 'lucide-react';
import {
  api,
  ApiError,
  capabilityLabel,
  jobStatusLabel,
  lama,
  tierLabel,
  unitLabel,
  won,
  type AiModelOption,
  type Capability,
  type LamaWallet,
  type StudioAsset,
  type StudioJob,
} from '../api';
import { Modal } from '../App';

export type Choice = { requested: string; tier: 'draft' | 'standard' | 'premium' };
export type Choices = Record<'text' | 'image' | 'tts' | 'video', Choice>;
export const defaultChoices: Choices = {
  text: { requested: 'auto', tier: 'standard' },
  image: { requested: 'auto', tier: 'standard' },
  tts: { requested: 'auto', tier: 'standard' },
  video: { requested: 'auto', tier: 'draft' },
};

// 작업별 AI 모델 고르기: "자동(추천)"이면 품질 등급과 장면 특성으로 가장 알맞은 모델을 서버가 고릅니다.
export function ModelPicker({
  capability,
  models,
  value,
  onChange,
}: {
  capability: Capability;
  models: AiModelOption[];
  value: Choice;
  onChange: (c: Choice) => void;
}) {
  const list = models.filter((m) => m.capability === capability);
  const chosen = list.find((m) => m.id === value.requested);
  return (
    <div className="model-picker">
      <span>{capabilityLabel[capability]}</span>
      <select
        aria-label={capabilityLabel[capability] + ' 모델'}
        value={value.requested}
        onChange={(e) => onChange({ ...value, requested: e.target.value })}
      >
        <option value="auto">자동 선택 (추천)</option>
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · {m.provider}
            {m.country === 'CN' ? ' (중국)' : ''} · {lama(m.lama_per_unit)}/{unitLabel[m.unit]}
          </option>
        ))}
      </select>
      {value.requested === 'auto' ? (
        <select
          aria-label={capabilityLabel[capability] + ' 품질'}
          value={value.tier}
          onChange={(e) => onChange({ ...value, tier: e.target.value as Choice['tier'] })}
        >
          {Object.entries(tierLabel).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <small>{chosen ? `${tierLabel[chosen.tier]} · 최대 ${chosen.max_seconds}초` : ''}</small>
      )}
      {!list.length && <small className="danger">연결된 모델이 없어요</small>}
    </div>
  );
}

// 실행 전 예상 라마를 보여 주고 확인을 받습니다.
export function useRunner({
  projectId,
  notify,
  onRan,
  onNeedLama,
}: {
  projectId: string;
  notify: (s: string) => void;
  onRan: () => void;
  onNeedLama: () => void;
}) {
  const [pending, setPending] = useState<{
    idempotencyKey: string;
    label: string;
    body: Record<string, unknown>;
    estimate: { lama: number; jobs: number; model: string; won: number; wallet: LamaWallet };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async (label: string, body: Record<string, unknown>) => {
    try {
      const estimate = await api<{ lama: number; jobs: number; model: string; won: number; wallet: LamaWallet }>(
        `/studio/ai/projects/${projectId}/estimate`,
        'POST',
        body,
      );
      setPending({ label, body, estimate, idempotencyKey: crypto.randomUUID() });
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const confirm = pending && (
    <Modal title={pending.label} close={() => !busy && setPending(null)}>
      <div className="run-confirm">
        <div>
          <span>AI 모델</span>
          <strong>{pending.estimate.model}</strong>
        </div>
        <div>
          <span>작업 수</span>
          <strong>{pending.estimate.jobs}건</strong>
        </div>
        <div>
          <span>예상 라마 (최대)</span>
          <strong className="lime">
            {lama(pending.estimate.lama)} <small>≈ {won(pending.estimate.won)}</small>
          </strong>
        </div>
        <div>
          <span>사용 가능 라마</span>
          <strong className={pending.estimate.wallet.total < pending.estimate.lama ? 'danger' : ''}>
            {lama(pending.estimate.wallet.total)}
          </strong>
        </div>
      </div>
      <p className="muted settings-note">
        예상치만큼 먼저 예약하고, 끝나면 실제 사용량만 차감해요. 실패하면 전액 돌려드려요.
      </p>
      {pending.estimate.wallet.total < pending.estimate.lama ? (
        <button
          className="primary full"
          onClick={() => {
            setPending(null);
            onNeedLama();
          }}
        >
          라마 충전하러 가기
        </button>
      ) : (
        <button
          className="primary full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/studio/ai/projects/${projectId}/run`, 'POST', {
                ...pending.body,
                idempotencyKey: pending.idempotencyKey,
              });
              setPending(null);
              notify('AI가 작업을 시작했어요. 끝나면 화면에 바로 반영돼요.');
              onRan();
            } catch (e) {
              if (e instanceof ApiError && e.code === 'insufficient_lama') onNeedLama();
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Sparkles size={16} /> {busy ? '시작하는 중…' : `${lama(pending.estimate.lama)}로 실행`}
        </button>
      )}
    </Modal>
  );
  return { ask, confirm };
}

export function JobBadge({ jobs, targetId, kind }: { jobs: StudioJob[]; targetId: string; kind: string }) {
  const job = jobs.find((j) => j.target_id === targetId && j.kind === kind);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'running')
    return (
      <span className="job-badge running">
        <Loader2 size={12} className="spin" /> {jobStatusLabel[job.status]}
      </span>
    );
  if (job.status === 'failed')
    return (
      <span className="job-badge failed" title={job.error}>
        <AlertTriangle size={12} /> 실패 · 라마 반환
      </span>
    );
  if (job.status === 'succeeded')
    return (
      <span className="job-badge done" title={job.model_label || ''}>
        <Check size={12} /> {lama(job.charged_lama)} 사용
      </span>
    );
  return (
    <span className="job-badge">
      <X size={12} /> {jobStatusLabel[job.status]}
    </span>
  );
}
export const isBusy = (jobs: StudioJob[], targetId: string, kind: string) =>
  jobs.some((j) => j.target_id === targetId && j.kind === kind && (j.status === 'queued' || j.status === 'running'));

export function Versions({
  assets,
  targetId,
  kind,
  current,
  onUse,
}: {
  assets: StudioAsset[];
  targetId: string;
  kind: string;
  current: string;
  onUse: (id: string) => void;
}) {
  const list = assets.filter((a) => a.target_id === targetId && a.kind === kind);
  if (list.length < 2) return null;
  return (
    <select
      className="version-select"
      aria-label="버전 고르기"
      value={list.find((a) => a.url === current)?.id || ''}
      onChange={(e) => e.target.value && onUse(e.target.value)}
    >
      <option value="">버전 {list.length}개</option>
      {list.map((a, i) => (
        <option key={a.id} value={a.id}>
          v{list.length - i} · {a.model_label || 'AI'} · {new Date(a.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
        </option>
      ))}
    </select>
  );
}
