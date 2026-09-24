import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, Settings2 } from 'lucide-react';
import type { AiFamily, AiModelOption, StudioEpisode, StudioFeatures, StudioJob, StudioProjectDetail } from '../../api';
import { type Choice, type ChoiceKey, type Choices, type ModelMode } from '../parts';
import { capabilityLabel } from '../../api';
import type { SaveState } from '../hooks';

export type TabId = 'plan' | 'script' | 'scene' | 'finish';
export const TABS: { id: TabId; name: string; hint: string }[] = [
  { id: 'plan', name: '기획 · 설정', hint: '이야기 · 설정집 · 인물 · 장소' },
  { id: 'script', name: '대본', hint: '회차별 대본 · 진단 · 버전' },
  { id: 'scene', name: '장면 편집', hint: '이미지 · 음성 · 영상 · 소리' },
  { id: 'finish', name: '완성 · 공개', hint: '합성 · 예고편 · 썸네일 · 공개' },
];

export type RunOpts = { targetId?: string; instruction?: string; options?: Record<string, unknown>; tier?: 'draft' | 'standard' | 'premium'; requested?: string };
// 작업 공간의 탭들이 함께 쓰는 값과 함수
export type WS = {
  data: StudioProjectDetail;
  load: () => Promise<void>;
  notify: (s: string) => void;
  models: AiModelOption[];
  families: AiFamily[];
  features?: StudioFeatures;
  mode: ModelMode;
  openModels: () => void;
  setFocus: (shotId: string) => void;
  focus: string;
  choices: Choices;
  setChoice: (k: ChoiceKey, c: Choice) => void;
  run: (label: string, action: string, cap: ChoiceKey, opts?: RunOpts) => void;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<boolean>;
  busy: boolean;
  useAsset: (id: string) => void;
  ask: (a: { title: string; text: string; ok?: string; danger?: boolean }) => Promise<boolean>;
  episode: StudioEpisode | undefined;
  setEpisodeId: (id: string) => void;
  goTab: (t: TabId) => void;
  goLama: () => void;
  preview: (e: StudioEpisode) => void;
};

export const episodeStatus: Record<string, string> = {
  outline: '줄거리',
  scripted: '대본 완성',
  composing: '합성 중',
  composed: '합성 완료',
  compose_failed: '합성 실패',
};
export const epLabel = (e: { number: number; title: string }) => (e.title.startsWith(`${e.number}화`) ? e.title : `${e.number}화 · ${e.title}`);
export const hasModel = (models: AiModelOption[], cap: string) => models.some((m) => m.capability === cap);
export const runningCount = (jobs: StudioJob[], pred: (j: StudioJob) => boolean) => jobs.filter((j) => (j.status === 'queued' || j.status === 'running') && pred(j)).length;

// 자동 저장 상태 표시
export function SaveBadge({ state, error, dirty, hint }: { state: SaveState; error?: string; dirty?: boolean; hint?: string }) {
  if (state === 'saving')
    return (
      <small className="save-state saving" role="status">
        <Loader2 size={11} className="spin" /> 저장 중…
      </small>
    );
  if (state === 'error')
    return (
      <small className="save-state error" role="alert" title={error}>
        <AlertTriangle size={11} /> 저장하지 못했어요{error ? ` · ${error}` : ''}
      </small>
    );
  if (hint)
    return (
      <small className="save-state" role="status">
        {hint}
      </small>
    );
  if (dirty)
    return (
      <small className="save-state" role="status">
        입력하면 자동으로 저장돼요
      </small>
    );
  if (state === 'saved')
    return (
      <small className="save-state saved" role="status">
        <Check size={11} /> 저장됨
      </small>
    );
  return null;
}

// AI 모델 · 품질 요약(누르면 모델 센터가 열려요)
const tierShort: Record<string, string> = { draft: '초안', standard: '표준', premium: '고급' };
export function ModelSettings({ ws, caps }: { ws: WS; caps: ChoiceKey[] }) {
  const summary = caps
    .filter((c) => ws.models.some((m) => m.capability === c))
    .map((c) => {
      const ch = ws.choices[c];
      const m = ws.mode === 'manual' && ch.requested !== 'auto' ? ws.models.find((x) => x.id === ch.requested) : null;
      return `${capabilityLabel[c]} ${m ? m.label : '자동'}·${tierShort[ch.tier]}`;
    })
    .join('  ');
  return (
    <div className="ws-models">
      <button type="button" className="ws-models-toggle" onClick={ws.openModels}>
        <Settings2 size={13} /> AI 모델 · 품질 <b className={'mode-pill ' + ws.mode}>{ws.mode === 'auto' ? '자동' : '직접'}</b>
        <small>{summary}</small>
        <ChevronDown size={13} />
      </button>
    </div>
  );
}

// 회차 고르기(대본·장면·완성 탭 공통)
export function EpisodeSwitcher({ ws }: { ws: WS }) {
  const { data, episode } = ws;
  if (data.episodes.length < 2) return null;
  return (
    <div className="ws-episodes" role="tablist" aria-label="회차 고르기">
      {data.episodes.map((e) => {
        const media = e.shots.length ? e.shots.filter((s) => s.image || s.video).length / e.shots.length : 0;
        return (
          <button key={e.id} role="tab" aria-selected={episode?.id === e.id} className={episode?.id === e.id ? 'active' : ''} onClick={() => ws.setEpisodeId(e.id)}>
            <b>{e.number}화</b>
            <i>{episodeStatus[e.status] || e.status}</i>
            <span className="ws-ep-meter" aria-hidden="true">
              <u style={{ width: `${Math.round(media * 100)}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

// 접을 수 있는 섹션
export function Section({
  title,
  desc,
  actions,
  children,
  defaultOpen = true,
  id,
  badge,
}: {
  title: string;
  desc?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  id?: string;
  badge?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={'management-panel ws-section' + (open ? '' : ' closed')} id={id}>
      <div className="ws-section-head">
        <button type="button" className="ws-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDown size={15} />
          <span>
            <strong>
              {title} {badge}
            </strong>
            {desc && <small>{desc}</small>}
          </span>
        </button>
        {open && actions && <div className="ws-section-actions">{actions}</div>}
      </div>
      {open && <div className="ws-section-body">{children}</div>}
    </section>
  );
}

// 준비 중(모델 없음 · 가격 미설정) 안내
export function NotReady({ what }: { what: string }) {
  return <small className="ws-not-ready">{what}은(는) 준비 중이에요. 관리자가 AI 모델과 라마 가격을 정하면 쓸 수 있어요.</small>;
}
