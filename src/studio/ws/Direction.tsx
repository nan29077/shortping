import { useMemo, useState } from 'react';
import { Clapperboard, ChevronDown, ChevronUp, Info, Sparkles } from 'lucide-react';
import direction from '../../../server/ai/direction.json';
import type { StudioShot } from '../../api';
import type { WS } from './shared';

// 컷 연출 카드(2026-09-29, 힉스필드 벤치마킹 1단계)
// 전문 용어 대신 '움직이는 예시 카드'를 보고 고르고, 자주 쓰는 조합은 '연출 세트' 한 번으로 적용해요.
// 대본을 컷으로 나눌 때 AI가 미리 채워 두므로, PD는 바꾸고 싶을 때만 손대면 돼요.
export type Move = { id: string; en: string; anim: string; hint: string; complex?: boolean; fallback?: string };
export type Preset = { id: string; name: string; hint: string; camera: string; angle: string; lens: string; move: string; strength: string; light?: string; tone?: string; genre?: string };
export const MOVES = direction.moves as Move[];
export const PRESETS = direction.presets as Preset[];
export const SIZES = direction.sizes as { id: string; hint: string; legacy?: boolean }[];
export const ANGLES = direction.angles as { id: string; hint: string }[];
export const LENSES = direction.lenses as { id: string; hint: string }[];
export const STRENGTHS = direction.strengths as { id: string; label: string }[];
export const MOVE_IDS = MOVES.map((m) => m.id);
// 기본으로 보여 줄 움직임(나머지는 '더 보기')
const COMMON = ['고정', '천천히 다가가기', '천천히 멀어지기', '빠르게 다가가기', '따라가기', '핸드헬드', '인물 주위 돌기', '현기증 효과'];
// 카메라 제어가 강한 계열·끝 장면을 받는 계열(서버 model-guide.mjs와 같음)
export const CAMERA_STRONG = ['kling', 'gemini', 'seed', 'gpt', 'mock'];
export const END_FRAME = ['kling', 'gemini', 'seed', 'mock'];

export type DirectionValue = { camera: string; camera_move: string; angle: string; lens: string; move_strength: string; light?: string; tone?: string };
const matches = (v: DirectionValue, p: Preset) =>
  v.camera === p.camera && v.camera_move === p.move && v.angle === p.angle && v.lens === p.lens && v.move_strength === p.strength && (p.light === undefined || v.light === p.light) && (p.tone === undefined || v.tone === p.tone);
// 조명 · 색감이 정해진 세트(감정 대화 · 긴장 추적 · 로맨틱 클로즈업)는 그것도 함께 바꾸고, 없는 세트는 지금 조명을 그대로 둬요.
export const presetValue = (p: Preset): DirectionValue => ({
  camera: p.camera,
  camera_move: p.move,
  angle: p.angle,
  lens: p.lens,
  move_strength: p.strength,
  ...(p.light !== undefined ? { light: p.light } : {}),
  ...(p.tone !== undefined ? { tone: p.tone } : {}),
});

// 움직임 미리보기: 작은 화면 안의 배경·인물이 카메라 움직임대로 움직여요(마우스를 올리거나 고른 카드만 재생).
export function MovePreview({ anim, label }: { anim: string; label?: string }) {
  return (
    <span className={`dm-frame dm-${anim}`} aria-hidden={label ? undefined : true} aria-label={label}>
      <span className="dm-world">
        <span className="dm-bg">
          <i className="dm-moon" />
          <i className="dm-b1" />
          <i className="dm-b2" />
          <i className="dm-b3" />
        </span>
        <span className="dm-fig">
          <i className="dm-head" />
          <i className="dm-body" />
        </span>
        <span className="dm-fg" />
      </span>
    </span>
  );
}

// 선택한 영상 모델(직접 선택일 때)의 계열
function videoFamily(ws: WS) {
  const ch = ws.choices.video;
  if (ws.mode !== 'manual' || ch.requested === 'auto') return null;
  return ws.models.find((m) => m.id === ch.requested)?.family || null;
}

export function DirectionPanel({ ws, s, value, set, disabled }: { ws: WS; s: StudioShot; value: DirectionValue; set: (v: Partial<DirectionValue>) => void; disabled?: boolean }) {
  const [more, setMore] = useState(() => !!value.camera_move && !COMMON.includes(value.camera_move));
  const move = MOVES.find((m) => m.id === value.camera_move);
  const family = videoFamily(ws);
  const weak = !!move?.complex && !!family && !CAMERA_STRONG.includes(family);
  const shownMoves = more ? MOVES : MOVES.filter((m) => COMMON.includes(m.id) || m.id === value.camera_move);
  const preset = PRESETS.find((p) => matches(value, p));
  const sizes = SIZES.filter((x) => !x.legacy || x.id === value.camera);
  const customSize = value.camera && !SIZES.some((x) => x.id === value.camera);
  const madeAlready = !!(s.image || s.video);
  const stillOnly = !s.video && !s.lipsync;
  return (
    <fieldset className="ws-voice dm-panel" disabled={disabled}>
      <legend>
        <Clapperboard size={13} /> 연출 · 카메라
      </legend>
      <div className="dm-row">
        <span className="dm-label">연출 세트</span>
        <div className="chip-row" role="group" aria-label="연출 세트">
          {/* 작품 장르에 맞는 세트(예: 로맨스 → 감정 대화 · 로맨틱 클로즈업)를 앞에 보여 줘요. */}
          {[...PRESETS].sort((a, b) => Number(!!b.genre && ws.data.project.genre.includes(b.genre)) - Number(!!a.genre && ws.data.project.genre.includes(a.genre))).map((p) => (
            <button type="button" key={p.id} className={'chip' + (preset?.id === p.id ? ' active' : '')} aria-pressed={preset?.id === p.id} title={p.hint} onClick={() => set(presetValue(p))}>
              {p.genre && ws.data.project.genre.includes(p.genre) ? '★ ' : ''}
              {p.name}
            </button>
          ))}
        </div>
        {preset && <small className="muted">{preset.hint}</small>}
      </div>
      <div className="dm-row">
        <span className="dm-label">카메라 움직임</span>
        <div className="dm-moves" role="radiogroup" aria-label="카메라 움직임">
          <button type="button" role="radio" aria-checked={!value.camera_move} className={'dm-card' + (!value.camera_move ? ' on' : '')} onClick={() => set({ camera_move: '' })}>
            <MovePreview anim="auto" />
            <b>자동</b>
            <small>AI가 장면에 맞게</small>
          </button>
          {shownMoves.map((m) => (
            <button type="button" role="radio" aria-checked={value.camera_move === m.id} key={m.id} className={'dm-card' + (value.camera_move === m.id ? ' on' : '')} title={m.hint} onClick={() => set({ camera_move: m.id })}>
              <MovePreview anim={m.anim} />
              <b>{m.id}</b>
              <small>{m.hint}</small>
              {m.complex && <em className="dm-pro">고급</em>}
            </button>
          ))}
        </div>
        <button type="button" className="text-button dm-more" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {more ? '자주 쓰는 움직임만' : `움직임 더 보기 (${MOVES.length - COMMON.length})`}
        </button>
      </div>
      {value.camera_move && value.camera_move !== '고정' && (
        <div className="dm-row dm-inline">
          <span className="dm-label">움직임 강도</span>
          <div className="dm-seg" role="radiogroup" aria-label="움직임 강도">
            {STRENGTHS.map((x) => (
              <button type="button" role="radio" key={x.label} aria-checked={value.move_strength === x.id} className={value.move_strength === x.id ? 'on' : ''} onClick={() => set({ move_strength: x.id })}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {move?.complex && (
        <p className={'dm-note' + (weak ? ' warn' : '')} role="note">
          <Info size={12} />{' '}
          {weak
            ? `지금 고른 영상 모델은 ‘${move.id}’ 같은 복잡한 움직임이 약해요. 이 모델로 만들면 ‘${move.fallback}’(으)로 바꿔 보내요. 모델을 ‘자동’으로 두면 잘 따르는 모델(Kling·Veo·Seedance 등)을 먼저 골라요.`
            : `고급 움직임이에요. 자동 선택이 카메라 움직임을 잘 따르는 모델(Kling·Veo·Seedance 등)을 먼저 골라요. 다른 모델이 만들게 되면 ‘${move.fallback}’(으)로 바꿔 보내요.`}
        </p>
      )}
      <div className="dm-row">
        <span className="dm-label">샷 크기</span>
        <div className="chip-row" role="radiogroup" aria-label="샷 크기">
          <button type="button" role="radio" aria-checked={!value.camera} className={'chip' + (!value.camera ? ' active' : '')} onClick={() => set({ camera: '' })}>
            자동
          </button>
          {sizes.map((x) => (
            <button type="button" role="radio" key={x.id} aria-checked={value.camera === x.id} className={'chip' + (value.camera === x.id ? ' active' : '')} title={x.hint} onClick={() => set({ camera: x.id })}>
              {x.id}
            </button>
          ))}
          {customSize && (
            <button type="button" role="radio" aria-checked className="chip active" title="직접 적은 값">
              {value.camera}
            </button>
          )}
        </div>
      </div>
      <div className="dm-row">
        <span className="dm-label">앵글</span>
        <div className="chip-row" role="radiogroup" aria-label="앵글">
          <button type="button" role="radio" aria-checked={!value.angle} className={'chip' + (!value.angle ? ' active' : '')} onClick={() => set({ angle: '' })}>
            기본
          </button>
          {ANGLES.map((x) => (
            <button type="button" role="radio" key={x.id} aria-checked={value.angle === x.id} className={'chip' + (value.angle === x.id ? ' active' : '')} title={x.hint} onClick={() => set({ angle: x.id })}>
              <i className={`dm-angle dm-angle-${ANGLES.indexOf(x)}`} aria-hidden="true" />
              {x.id}
            </button>
          ))}
        </div>
      </div>
      <div className="dm-row">
        <span className="dm-label">화면 느낌</span>
        <div className="chip-row" role="radiogroup" aria-label="화면 느낌">
          <button type="button" role="radio" aria-checked={!value.lens} className={'chip' + (!value.lens ? ' active' : '')} onClick={() => set({ lens: '' })}>
            기본
          </button>
          {LENSES.map((x) => (
            <button type="button" role="radio" key={x.id} aria-checked={value.lens === x.id} className={'chip' + (value.lens === x.id ? ' active' : '')} title={x.hint} onClick={() => set({ lens: x.id })}>
              {x.id}
            </button>
          ))}
        </div>
      </div>
      <small className="muted dm-foot">
        <Sparkles size={11} /> {madeAlready ? '바꾼 연출은 이미지·영상을 다시 만들 때 반영돼요.' : '이미지·영상을 만들 때 이 연출을 그대로 써요.'}
        {stillOnly ? ' 영상 없이 합성하면 이미지에 이 움직임을 흉내 내요(무료).' : ''}
      </small>
    </fieldset>
  );
}

// 여러 컷에 연출 세트 적용(고른 컷 한 번에)
export function PresetSelect({ onPick, disabled }: { onPick: (p: Preset) => void; disabled?: boolean }) {
  const [v, setV] = useState('');
  const list = useMemo(() => PRESETS, []);
  return (
    <select
      aria-label="연출 세트 한 번에"
      value={v}
      disabled={disabled}
      onChange={(ev) => {
        const p = list.find((x) => x.id === ev.target.value);
        if (p) onPick(p);
        setV('');
      }}
    >
      <option value="">연출 세트 적용…</option>
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.move}
        </option>
      ))}
    </select>
  );
}

// 컷 효과(2026-09-29, 4단계): 합성할 때 입히는 드라마용 효과(무료). 서버 compose.mjs의 EFFECT_NAMES와 같아요.
export const EFFECTS: { id: string; name: string; hint: string }[] = [
  { id: '', name: '없음', hint: '원래 화면 그대로' },
  { id: 'flashback', name: '회상', hint: '색이 빠지고 부드럽게 흐려져요' },
  { id: 'dream', name: '꿈결', hint: '밝고 몽환적으로 번져요' },
  { id: 'tension', name: '긴장', hint: '색이 빠지고 어둡게 조여요' },
  { id: 'mono', name: '흑백', hint: '흑백 화면' },
  { id: 'shock_zoom', name: '충격 줌', hint: '시작하자마자 확 다가가요' },
  { id: 'heartbeat', name: '심장 박동', hint: '두근두근 화면이 뛰어요' },
  { id: 'shake', name: '흔들림', hint: '화면이 계속 흔들려요' },
];
export function EffectPicker({ value, set }: { value: string; set: (v: string) => void }) {
  return (
    <div className="ws-field">
      <span>
        효과 <small className="muted">합성할 때 입혀요(무료)</small>
      </span>
      <div className="chip-row" role="radiogroup" aria-label="컷 효과">
        {EFFECTS.map((x) => (
          <button type="button" role="radio" key={x.id || 'none'} aria-checked={value === x.id} className={'chip fx-chip fx-' + (x.id || 'none') + (value === x.id ? ' active' : '')} title={x.hint} onClick={() => set(x.id)}>
            {x.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 조명 · 시간과 색감 · 카메라 높이 · 렌즈 숫자(2026-09-30, 2단계) ─────────────
export const LIGHTS = direction.lights as { id: string; hint: string }[];
export const TONES = direction.tones as { id: string; hint: string; grade?: string }[];
export const HEIGHTS = direction.heights as { id: string; hint: string }[];
export const FOCALS = direction.focals as number[];
export const APERTURES = direction.apertures as string[];
export type LightValue = { light: string; tone: string; height: string; dof: string; focal: number };
// 조명 스와치(빛 모양을 작은 그림으로)
const LIGHT_SWATCH: Record<string, string> = {
  자연광: 'linear-gradient(135deg,#fff6d8,#9fb8c9)',
  역광: 'radial-gradient(circle at 50% 30%,#fff3c4 0 25%,#2b2233 60%)',
  측광: 'linear-gradient(90deg,#f4d9a8 0 50%,#1b1a22 50%)',
  '부드러운 조명': 'linear-gradient(180deg,#fbe9e4,#d9d2e8)',
  '강한 그림자': 'linear-gradient(120deg,#f2f2f2 0 35%,#0d0d0f 35%)',
  네온: 'linear-gradient(135deg,#ff4fb3,#3d6bff)',
  촛불: 'radial-gradient(circle at 50% 60%,#ffb347 0 20%,#3a1f10 70%)',
  실루엣: 'linear-gradient(180deg,#ffcf8a 0 60%,#111 60%)',
};
const TONE_SWATCH: Record<string, string> = {
  아침: 'linear-gradient(180deg,#cfe7ff,#fff3d6)',
  한낮: 'linear-gradient(180deg,#8ecbff,#fffbe6)',
  노을: 'linear-gradient(180deg,#ff9a5a,#6b3a78)',
  '푸른 새벽': 'linear-gradient(180deg,#2b4a7a,#8aa6c8)',
  밤: 'linear-gradient(180deg,#0b1026,#2a2f55)',
  '비 오는 밤': 'repeating-linear-gradient(100deg,#1a2233 0 6px,#2d3b55 6px 8px)',
  '따뜻한 색감': 'linear-gradient(135deg,#ffcf99,#e89b6b)',
  '차가운 색감': 'linear-gradient(135deg,#9fd8e6,#3f7f99)',
  '빛바랜 필름': 'linear-gradient(135deg,#d8cdb3,#9c9380)',
};
export function LightPanel({ value, set, disabled, pro = true }: { value: LightValue; set: (v: Partial<LightValue>) => void; disabled?: boolean; pro?: boolean }) {
  const [nums, setNums] = useState(() => !!(value.focal || value.dof));
  return (
    <fieldset className="ws-voice dm-panel lt-panel" disabled={disabled}>
      <legend>
        <Sparkles size={13} /> 조명 · 시간과 색감
      </legend>
      <div className="dm-row">
        <span className="dm-label">조명</span>
        <div className="lt-swatches" role="radiogroup" aria-label="조명">
          <button type="button" role="radio" aria-checked={!value.light} className={'lt-sw' + (!value.light ? ' on' : '')} onClick={() => set({ light: '' })}>
            <i style={{ background: 'repeating-conic-gradient(#333 0 25%,#222 0 50%) 0 0/8px 8px' }} />
            <b>자동</b>
          </button>
          {LIGHTS.map((x) => (
            <button type="button" role="radio" key={x.id} aria-checked={value.light === x.id} className={'lt-sw' + (value.light === x.id ? ' on' : '')} title={x.hint} onClick={() => set({ light: x.id })}>
              <i style={{ background: LIGHT_SWATCH[x.id] }} />
              <b>{x.id}</b>
            </button>
          ))}
        </div>
      </div>
      <div className="dm-row">
        <span className="dm-label">시간 · 색감</span>
        <div className="lt-swatches" role="radiogroup" aria-label="시간과 색감">
          <button type="button" role="radio" aria-checked={!value.tone} className={'lt-sw' + (!value.tone ? ' on' : '')} onClick={() => set({ tone: '' })}>
            <i style={{ background: 'repeating-conic-gradient(#333 0 25%,#222 0 50%) 0 0/8px 8px' }} />
            <b>자동</b>
          </button>
          {TONES.map((x) => (
            <button type="button" role="radio" key={x.id} aria-checked={value.tone === x.id} className={'lt-sw' + (value.tone === x.id ? ' on' : '')} title={x.hint} onClick={() => set({ tone: x.id })}>
              <i style={{ background: TONE_SWATCH[x.id] }} />
              <b>{x.id}</b>
              {x.grade && <em className="lt-grade">합성 보정</em>}
            </button>
          ))}
        </div>
        {TONES.find((x) => x.id === value.tone)?.grade && <small className="muted">이 색감은 이미지 · 영상을 만들 때 쓰고, 합성할 때도 색을 한 번 더 맞춰요(무료).</small>}
      </div>
      {pro && (
        <>
          <div className="dm-row dm-inline">
            <span className="dm-label">카메라 높이</span>
            <select aria-label="카메라 높이" value={value.height} onChange={(e) => set({ height: e.target.value })}>
              <option value="">자동</option>
              {HEIGHTS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id} — {x.hint}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="text-button dm-more" aria-expanded={nums} onClick={() => setNums(!nums)}>
            {nums ? <ChevronUp size={12} /> : <ChevronDown size={12} />} 렌즈 숫자로 정하기(전문가)
          </button>
          {nums && (
            <div className="form-columns lt-nums">
              <label>
                초점 거리
                <select value={String(value.focal || 0)} onChange={(e) => set({ focal: Number(e.target.value) })}>
                  <option value="0">자동</option>
                  {FOCALS.map((f) => (
                    <option key={f} value={f}>
                      {f}mm{f <= 24 ? ' · 넓게' : f >= 85 ? ' · 인물 · 압축' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                조리개(심도)
                <select value={value.dof} onChange={(e) => set({ dof: e.target.value })}>
                  <option value="">자동</option>
                  {APERTURES.map((a) => (
                    <option key={a} value={a}>
                      f/{a}
                      {Number(a) <= 2.8 ? ' · 배경 많이 흐림' : Number(a) >= 8 ? ' · 모두 선명' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
