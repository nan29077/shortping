import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, Info, Sparkles, Wand2 } from 'lucide-react';
import { api, capabilityLabel, lama, tagLabel, unitLabel, type AiFamily, type AiModelOption, type Capability, type ModelWhy } from '../api';
import { Modal } from '../App';
import type { Choice, ChoiceKey, Choices, ModelMode } from './parts';

// 모델 센터(2026-09-24): 바이브 코딩 도구처럼 '자동(숏핑이 알아서)'과 '직접 선택'을 오가며 모델을 고릅니다.
// - 자동: 작업마다 가장 알맞은 모델을 숏핑이 고르고, 지금이라면 무엇을 왜 고르는지 보여 줘요.
// - 직접: 모델 카드(잘하는 것·단가·성공률)에서 고르고, 못 하는 작업은 이유와 대신할 방법을 알려 줘요.
export const HUB_CAPS: ChoiceKey[] = ['text', 'image', 'tts', 'video', 'music', 'sfx', 'lipsync'];
const capHint: Record<ChoiceKey, string> = {
  text: '기획안 · 설정집 · 대본 · 대사 다듬기',
  image: '인물 · 장소 · 컷 스토리보드 · 포스터',
  tts: '대사 · 내레이션 목소리',
  video: '컷을 움직이는 영상으로',
  music: '회차 배경음악',
  sfx: '장면 효과음',
  lipsync: '대사에 맞춰 입 모양 움직이기',
};
const tierShort: Record<string, string> = { draft: '초안', standard: '표준', premium: '고급' };
// 받침에 따라 은/는, 을/를
const hasBatchim = (w: string) => {
  const c = w.trim().slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  // 영어 이름은 읽는 소리로 대강 판단(Kling·Wan·Seedream·GLM → 받침 있음, Claude·Kimi·FLUX → 없음)
  return /(m|n|ng|l)$/i.test(w.trim());
};
export const josa = (w: string, a: string, b: string) => w + (hasBatchim(w) ? a : b);
// 로/으로: 받침이 ㄹ이면 '로'
const ro = (w: string) => {
  const t = w.trim();
  const c = t.slice(-1).charCodeAt(0);
  const rieul = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 === 8 : /l$/i.test(t);
  return t + (hasBatchim(t) && !rieul ? '으로' : '로');
};

// 계열(브랜드)이 어떤 작업을 못 할 때의 안내 문구
export function cannotText(f: AiFamily, cap: Capability) {
  const what = capabilityLabel[cap];
  if (!f.caps.includes(cap)) return `${josa(f.name, '은', '는')} ${josa(what, '을', '를')} 만들 수 없어요. ${f.note}`;
  return `${f.name}의 ${what} 모델은 아직 숏핑에 연결되지 않았어요.`;
}

export default function ModelHub({
  models,
  families,
  mode,
  setMode,
  choices,
  setChoice,
  projectId,
  close,
}: {
  models: AiModelOption[];
  families: AiFamily[];
  mode: ModelMode;
  setMode: (m: ModelMode) => void;
  choices: Choices;
  setChoice: (k: ChoiceKey, c: Choice) => void;
  projectId?: string;
  close: () => void;
}) {
  const [why, setWhy] = useState<Record<string, ModelWhy[]>>({});
  const [family, setFamily] = useState('');
  const [open, setOpen] = useState<ChoiceKey | ''>('');
  const tiers = HUB_CAPS.map((c) => choices[c].tier).join(',');
  // 자동이면 지금 어떤 모델을 고를지 미리 봅니다(라마 들지 않음).
  useEffect(() => {
    let alive = true;
    const items = HUB_CAPS.filter((c) => models.some((m) => m.capability === c)).map((c) => ({ capability: c, tier: choices[c].tier }));
    if (!items.length) return;
    api<Record<string, ModelWhy[]>>('/studio/ai/models/explain', 'POST', { items, projectId }).then(
      (r) => alive && setWhy(r),
      () => {},
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers, projectId, models]);
  // 연결된 모델이 있는 계열만(개발용 가짜 AI는 가짜만 있을 때만) 보여 줍니다.
  const connected = useMemo(() => {
    const ids = new Set(models.map((m) => m.family || 'other'));
    const real = families.filter((f) => f.id !== 'mock' && ids.has(f.id));
    return real.length ? real : families.filter((f) => ids.has(f.id));
  }, [models, families]);
  const fam = families.find((f) => f.id === family);
  // 계열로 한 번에 맞추기: 그 계열에 모델이 있으면 그 모델, 없으면 자동으로 두고 이유를 알려 줍니다.
  const applyFamily = (id: string) => {
    setFamily(id);
    setMode('manual');
    for (const c of HUB_CAPS) {
      const list = models.filter((m) => m.capability === c && m.family === id);
      if (!list.length) {
        setChoice(c, { ...choices[c], requested: 'auto' });
        continue;
      }
      const pick = list.find((m) => m.tier === choices[c].tier) || list.find((m) => m.tier === 'standard') || list[0];
      setChoice(c, { ...choices[c], requested: pick.id });
    }
  };
  const setAllTier = (t: Choice['tier']) => HUB_CAPS.forEach((c) => setChoice(c, { ...choices[c], tier: t }));
  const allTier = HUB_CAPS.every((c) => choices[c].tier === choices.text.tier) ? choices.text.tier : '';
  return (
    <Modal title="AI 모델 센터" close={close}>
      <div className="hub">
        <div className="hub-mode" role="radiogroup" aria-label="모델 고르는 방식">
          <button type="button" role="radio" aria-checked={mode === 'auto'} className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>
            <Bot size={16} />
            <span>
              <b>자동 (추천)</b>
              <small>작업마다 숏핑이 가장 알맞은 모델을 골라요</small>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'manual'} className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>
            <Wand2 size={16} />
            <span>
              <b>직접 선택</b>
              <small>작업별로 원하는 모델을 내가 골라요</small>
            </span>
          </button>
        </div>
        <div className="hub-row">
          <span className="hub-label">품질 한 번에</span>
          <div className="hub-seg" role="radiogroup" aria-label="모든 작업 품질">
            {(['draft', 'standard', 'premium'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={allTier === t} className={allTier === t ? 'active' : ''} onClick={() => setAllTier(t)}>
                {tierShort[t]}
                <small>{t === 'draft' ? '싸고 빠르게 초안' : t === 'premium' ? '공개용 최고 품질' : '균형'}</small>
              </button>
            ))}
          </div>
        </div>
        <p className="muted hub-tip">
          <Info size={13} /> 초안으로 전체를 먼저 만들어 보고, 마음에 드는 컷만 ‘고급으로 다시’ 만들면 라마를 아낄 수 있어요.
        </p>
        {connected.length > 0 && (
          <div className="hub-row">
            <span className="hub-label">AI 계열로 맞추기</span>
            <div className="chip-row">
              {connected.map((f) => (
                <button key={f.id} type="button" className={'chip' + (family === f.id ? ' active' : '')} onClick={() => applyFamily(f.id)} title={f.note}>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        )}
        {fam && (
          <div className="hub-guide" role="status">
            <b>
              <Sparkles size={13} /> {ro(fam.name)} 맞췄어요
            </b>
            <p className="hub-guide-note">{fam.note}</p>
            <ul>
              {HUB_CAPS.filter((c) => models.some((m) => m.capability === c)).map((c) => {
                const own = models.find((m) => m.id === choices[c].requested && m.family === fam.id);
                const auto = why[c]?.[0];
                return (
                  <li key={c} className={own ? 'ok' : 'no'}>
                    <strong>{capabilityLabel[c]}</strong>
                    {own ? (
                      <span>{own.label}</span>
                    ) : (
                      <span>
                        {fam.caps.includes(c as Capability) ? '연결된 모델이 없어요' : '만들 수 없어요'} → 자동 추천{auto ? ` · ${auto.label}` : ''}
                        {c === 'video' && <em> (영상 없이 합성하면 컷 이미지에 카메라 움직임을 넣어 무료로 만들 수도 있어요)</em>}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="hub-caps">
          {HUB_CAPS.map((c) => {
            const list = models.filter((m) => m.capability === c);
            const ch = choices[c];
            const chosen = list.find((m) => m.id === ch.requested);
            const auto = why[c]?.[0];
            const manual = mode === 'manual' && ch.requested !== 'auto' && chosen;
            const cant = connected.filter((f) => !f.caps.includes(c as Capability) && f.id !== 'mock');
            const expanded = open === c;
            return (
              <section key={c} className={'hub-cap' + (expanded ? ' open' : '')}>
                <button type="button" className="hub-cap-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? '' : c)} disabled={!list.length}>
                  <span>
                    <b>{capabilityLabel[c]}</b>
                    <small>{capHint[c]}</small>
                  </span>
                  <em>
                    {!list.length
                      ? '준비 중'
                      : manual
                        ? chosen.label
                        : `자동${auto ? ' · ' + auto.label : ''}`}
                    <i className={'tier-dot ' + ch.tier}>{tierShort[ch.tier]}</i>
                  </em>
                </button>
                {!list.length && (
                  <p className="hub-empty">
                    관리자가 {capabilityLabel[c]} 모델과 라마 가격을 정하면 쓸 수 있어요.
                    {c === 'video' && ' 영상 없이도 컷 이미지에 카메라 움직임을 넣어 무료로 합성할 수 있어요.'}
                  </p>
                )}
                {expanded && list.length > 0 && (
                  <div className="hub-cap-body">
                    {auto && (mode === 'auto' || ch.requested === 'auto') && (
                      <p className="hub-why">
                        <b>지금 자동이면 {auto.label}</b>
                        {auto.why.length ? ' · ' + auto.why.join(' · ') : ''}
                      </p>
                    )}
                    <div className="hub-seg small" role="radiogroup" aria-label={capabilityLabel[c] + ' 품질'}>
                      {(['draft', 'standard', 'premium'] as const).map((t) => (
                        <button key={t} type="button" role="radio" aria-checked={ch.tier === t} className={ch.tier === t ? 'active' : ''} onClick={() => setChoice(c, { ...ch, tier: t })}>
                          {tierShort[t]}
                        </button>
                      ))}
                    </div>
                    <div className="model-cards" role="radiogroup" aria-label={capabilityLabel[c] + ' 모델'}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={ch.requested === 'auto'}
                        className={'model-card' + (ch.requested === 'auto' ? ' selected' : '')}
                        onClick={() => setChoice(c, { ...ch, requested: 'auto' })}
                      >
                        <b>
                          <Bot size={13} /> 자동 선택
                        </b>
                        <small>품질·장면에 맞춰 숏핑이 골라요. 실패하면 다음 후보로 다시 시도해요.</small>
                        {ch.requested === 'auto' && <Check size={14} className="model-card-check" />}
                      </button>
                      {list.map((m) => (
                        <ModelCard
                          key={m.id}
                          m={m}
                          selected={ch.requested === m.id}
                          recommended={auto?.id === m.id}
                          onPick={() => {
                            setChoice(c, { ...ch, requested: m.id });
                            setMode('manual');
                          }}
                        />
                      ))}
                    </div>
                    {cant.length > 0 && (
                      <ul className="hub-cant">
                        {cant.map((f) => (
                          <li key={f.id}>{cannotText(f, c as Capability)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <button type="button" className="primary full" onClick={close}>
          <Check size={15} /> 적용하고 닫기
        </button>
      </div>
    </Modal>
  );
}

function ModelCard({ m, selected, recommended, onPick }: { m: AiModelOption; selected: boolean; recommended: boolean; onPick: () => void }) {
  const tags = String(m.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => tagLabel[t])
    .slice(0, 4);
  const st = m.stats && m.stats.jobs >= 3 ? m.stats : null;
  return (
    <button type="button" role="radio" aria-checked={selected} className={'model-card' + (selected ? ' selected' : '') + (m.cooling ? ' cooling' : '')} onClick={onPick}>
      <b>
        {m.label}
        {recommended && <i className="model-badge">추천</i>}
      </b>
      <small>
        {m.provider}
        {m.country === 'CN' ? ' · 중국' : ''} · {tierShort[m.tier] || m.tier}
      </small>
      <span className="model-card-price">
        {lama(m.lama_per_unit)}/{unitLabel[m.unit] || m.unit}
        {m.capability === 'video' ? ` · 최대 ${m.max_seconds}초` : ''}
      </span>
      {tags.length > 0 && (
        <span className="model-card-tags">
          {tags.map((t) => (
            <i key={t}>{tagLabel[t]}</i>
          ))}
          {m.image_input && m.capability === 'video' && <i>이미지로 시작</i>}
        </span>
      )}
      {st && (
        <span className="model-card-stats">
          성공률 {Math.round((st.success || 0) * 100)}%{st.seconds ? ` · 평균 ${st.seconds}초` : ''}
        </span>
      )}
      {m.cooling && <span className="danger model-card-stats">잠시 장애로 쉬는 중</span>}
      {selected && <Check size={14} className="model-card-check" />}
    </button>
  );
}
