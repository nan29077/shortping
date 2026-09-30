import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Brush, Eraser, Loader2, RotateCcw, SplitSquareHorizontal, Wand2, X } from 'lucide-react';
import { api, parseJson, type ShotVerify, type StudioShot } from '../../api';
import { asset } from '../../platform';
import { JobBadge, isBusy } from '../parts';
import { useFocusTrap, type WS } from './shared';

// 컷 보정(2026-09-29, 힉스필드 벤치마킹 3단계)
// - 말로 고치기(기존) + 붓으로 칠한 부분만 고치기(마스크) + 표정·시선만 다시(버튼 한 번)
// - 전후 비교 슬라이더: 방금 고친 이미지와 이전 이미지를 밀어서 비교
// AI 검수가 찾은 문제는 위치가 있으면 붓이 미리 칠해진 상태로 열려요.
const QUICK: { group: string; items: { label: string; text: string }[] }[] = [
  {
    group: '표정만',
    items: [
      { label: '미소', text: '인물 표정만 옅은 미소로 바꿔 줘(얼굴·옷·배경은 그대로)' },
      { label: '놀람', text: '인물 표정만 깜짝 놀란 얼굴로 바꿔 줘(얼굴·옷·배경은 그대로)' },
      { label: '슬픔', text: '인물 표정만 눈물이 고인 슬픈 얼굴로 바꿔 줘(얼굴·옷·배경은 그대로)' },
      { label: '분노', text: '인물 표정만 화가 난 얼굴로 바꿔 줘(얼굴·옷·배경은 그대로)' },
    ],
  },
  {
    group: '시선만',
    items: [
      { label: '카메라 보기', text: '인물 시선만 카메라를 똑바로 보게 바꿔 줘(나머지는 그대로)' },
      { label: '옆 보기', text: '인물 시선만 화면 옆쪽을 보게 바꿔 줘(나머지는 그대로)' },
      { label: '아래 보기', text: '인물 시선만 아래를 내려다보게 바꿔 줘(나머지는 그대로)' },
    ],
  },
];
type Issue = ShotVerify['issues'][number];

export function RetouchPanel({
  ws,
  s,
  run,
  preset,
  clearPreset,
}: {
  ws: WS;
  s: StudioShot;
  run: (label: string, action: string, cap: 'image', opts: { instruction?: string; options?: Record<string, unknown> }) => Promise<void>;
  preset: Issue[] | null;
  clearPreset: () => void;
}) {
  const [text, setText] = useState('');
  const [painting, setPainting] = useState(false);
  // 방금 칠한 영역(비용 확인 창에서 취소해도 다시 칠하지 않고 바로 다시 보낼 수 있게)
  const [last, setLast] = useState<{ mask: string; text: string; image: string } | null>(null);
  const busy = isBusy(ws.data.jobs, s.id, 'shot_image_edit');
  // 보낸 뒤 새 '부분 수정' 작업이 실제로 생기면 입력을 비워요(비용 확인에서 취소하면 그대로 남아요).
  // 보낼 때 있던 작업 목록과 비교하고(서버 · 기기 시계 차이 무관), 1분이 지나면 기다리지 않아요.
  const sent = useRef<{ ids: Set<string>; at: number } | null>(null);
  useEffect(() => {
    const x = sent.current;
    if (!x) return;
    if (Date.now() - x.at > 60000) {
      sent.current = null;
      return;
    }
    if (ws.data.jobs.some((j) => j.target_id === s.id && j.kind === 'shot_image_edit' && !x.ids.has(j.id))) {
      sent.current = null;
      setText('');
    }
  }, [ws.data.jobs, s.id]);
  // AI 검수의 '문제 부분만 고치기'로 들어오면 붓 창을 바로 열어요.
  useEffect(() => {
    if (preset) setPainting(true);
  }, [preset]);
  if (!s.image) return null;
  return (
    <div className="rt-panel">
      <form
        className="ws-edit-image"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (text.trim().length < 2) return;
          // 입력은 작업이 실제로 시작된 뒤에만 비워요(비용 확인 창에서 취소하면 그대로 남아요).
          sent.current = { ids: new Set(ws.data.jobs.filter((j) => j.target_id === s.id && j.kind === 'shot_image_edit').map((j) => j.id)), at: Date.now() };
          void run('이미지 부분 고치기', 'shot_image_edit', 'image', { instruction: text.trim() });
        }}
      >
        <input aria-label="이미지 고칠 내용" value={text} maxLength={300} placeholder="이미지 고치기 · 예: 배경을 밤으로, 우산 들게" onChange={(ev) => setText(ev.target.value)} />
        <button className="secondary compact" disabled={text.trim().length < 2 || busy}>
          <Wand2 size={13} /> 고치기
        </button>
        <button type="button" className="secondary compact" disabled={busy} title="고칠 곳만 붓으로 칠하면 나머지는 그대로 둬요" onClick={() => setPainting(true)}>
          <Brush size={13} /> 칠해서 고치기
        </button>
        <JobBadge jobs={ws.data.jobs} targetId={s.id} kind="shot_image_edit" />
      </form>
      {last && last.image === s.image && !busy && (
        <button type="button" className="chip rt-again" onClick={() => void run('칠한 부분 고치기', 'shot_image_edit', 'image', { instruction: last.text, options: { mask: last.mask } })}>
          <Brush size={11} /> 방금 칠한 곳 다시 보내기 · {last.text.slice(0, 18)}
        </button>
      )}
      {/* 4단계(2026-09-30): 인물 · 배경 바꾸기 — 고른 인물 · 장소의 기준 이미지를 참고로 붙여요(라마 차감). */}
      <div className="rt-swap" role="group" aria-label="인물 · 배경 바꾸기">
        <select
          aria-label="인물 바꾸기"
          value=""
          disabled={busy}
          onChange={(ev) => {
            const who = ws.data.characters.find((c) => c.id === ev.target.value);
            if (who) void run(`인물을 ${who.name}(으)로 바꾸기`, 'shot_image_edit', 'image', { instruction: text.trim(), options: { swap: 'character', swapId: who.id } });
          }}
        >
          <option value="">인물 바꾸기…</option>
          {ws.data.characters.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.image}>
              {c.name}
              {c.image ? '' : ' (기준 이미지 필요)'}
            </option>
          ))}
        </select>
        <select
          aria-label="배경 바꾸기"
          value=""
          disabled={busy}
          onChange={(ev) => {
            const v = ev.target.value;
            if (v === '_text') {
              if (text.trim().length < 2) return ws.notify('위 칸에 어떤 배경으로 바꿀지 적은 뒤 골라 주세요. 예: 비 오는 골목');
              void run('배경 바꾸기', 'shot_image_edit', 'image', { instruction: text.trim(), options: { swap: 'background' } });
              return;
            }
            const where = (ws.data.locations || []).find((l) => l.id === v);
            if (where) void run(`배경을 ${where.name}(으)로 바꾸기`, 'shot_image_edit', 'image', { instruction: text.trim(), options: { swap: 'background', swapId: where.id } });
          }}
        >
          <option value="">배경 바꾸기…</option>
          {(ws.data.locations || []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="_text">위 칸에 적은 배경으로</option>
        </select>
        <small className="muted">인물 · 옷 · 자세는 그대로 두고 바꿔요.</small>
      </div>
      <div className="rt-quick" role="group" aria-label="표정 · 시선만 다시">
        {QUICK.map((g) => (
          <span key={g.group} className="rt-quick-row">
            <b>{g.group}</b>
            {g.items.map((x) => (
              <button type="button" key={x.label} className="chip" disabled={busy} onClick={() => void run(`${g.group} ${x.label}`, 'shot_image_edit', 'image', { instruction: x.text })}>
                {x.label}
              </button>
            ))}
          </span>
        ))}
      </div>
      {painting && (
        <MaskEditor
          ws={ws}
          s={s}
          busy={busy}
          issues={preset || []}
          close={() => {
            setPainting(false);
            clearPreset();
          }}
          submit={async (maskUrl, instruction) => {
            setLast({ mask: maskUrl, text: instruction, image: s.image });
            setPainting(false);
            clearPreset();
            await run('칠한 부분 고치기', 'shot_image_edit', 'image', { instruction, options: { mask: maskUrl } });
          }}
        />
      )}
    </div>
  );
}

// 붓으로 고칠 곳 칠하기. 마스크는 이미지 원래 크기의 흑백 PNG(흰색 = 고칠 곳)로 올려요.
// 마스크 캔버스 최대 크기 2048px(서버 제한 4096px) — 큰 이미지는 비율을 지켜 줄여 휴대폰 메모리를 아껴요.
const MAX_MASK = 2048;
function MaskEditor({ ws, s, busy, issues, close, submit }: { ws: WS; s: StudioShot; busy: boolean; issues: Issue[]; close: () => void; submit: (maskUrl: string, instruction: string) => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [brush, setBrush] = useState(8); // 화면 폭의 %가 아니라 이미지 폭의 1/100 단위
  const [erase, setErase] = useState(false);
  const [painted, setPainted] = useState(false);
  const [text, setText] = useState(() => issues.map((x) => x.text).join(' / ').slice(0, 280));
  const [sending, setSending] = useState(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const trap = useFocusTrap<HTMLDivElement>();
  useEffect(() => closeBtn.current?.focus(), []);
  const ready = (nw: number, nh: number) => {
    const k = Math.min(1, MAX_MASK / Math.max(nw, nh));
    setSize({ w: Math.max(1, Math.round(nw * k)), h: Math.max(1, Math.round(nh * k)) });
  };
  // 캔버스가 붙은 뒤 검은색으로 채우고, AI 검수가 알려 준 문제 위치를 미리 칠해 둡니다.
  useLayoutEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !size.w) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    let any = false;
    ctx.fillStyle = '#fff';
    for (const x of issues)
      if (x.box?.length === 4) {
        const [bx, by, bw, bh] = x.box.map((v) => Math.max(0, Math.min(100, Number(v))));
        if (bw > 0 && bh > 0) {
          ctx.fillRect((bx / 100) * size.w, (by / 100) * size.h, (bw / 100) * size.w, (bh / 100) * size.h);
          any = true;
        }
      }
    setPainted(any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);
  const tryClose = async () => {
    if (painted && !(await ws.ask({ title: '칠한 내용을 버릴까요?', text: '창을 닫으면 칠한 영역과 적은 내용이 사라져요.', ok: '버리기', danger: true }))) return;
    close();
  };
  const point = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * c.width, y: ((ev.clientY - r.top) / r.height) * c.height };
  };
  const draw = (to: { x: number; y: number }) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const from = last.current || to;
    ctx.strokeStyle = erase ? '#000' : '#fff';
    ctx.lineWidth = (brush / 100) * size.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x + 0.01, to.y);
    ctx.stroke();
    last.current = to;
    if (!erase) setPainted(true);
  };
  const reset = () => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.w, size.h);
    setPainted(false);
  };
  const send = async () => {
    const c = canvas.current;
    if (!c || text.trim().length < 2 || !painted) return;
    setSending(true);
    try {
      const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
      if (!blob) throw new Error('칠한 영역을 만들지 못했어요.');
      const form = new FormData();
      form.append('file', blob, 'mask.png');
      const r = await api<{ url: string }>(`/studio/ai/shots/${s.id}/mask`, 'POST', form);
      await submit(r.url, text.trim());
    } catch (e) {
      ws.notify(e instanceof Error ? e.message : '칠한 영역을 올리지 못했어요.');
    } finally {
      setSending(false);
    }
  };
  return (
    <div ref={trap} className="ws-overlay" role="dialog" aria-modal="true" aria-label="칠해서 고치기" onKeyDown={(e) => e.key === 'Escape' && void tryClose()}>
      <div className="ws-overlay-inner rt-editor">
        <div className="fr-picker-head">
          <strong>
            <Brush size={14} /> 고칠 곳만 칠해 주세요
          </strong>
          <button type="button" ref={closeBtn} className="icon-button" aria-label="닫기" onClick={() => void tryClose()}>
            <X size={16} />
          </button>
        </div>
        <div className="rt-body">
          <div className="rt-canvas-wrap" style={size.w ? { aspectRatio: `${size.w} / ${size.h}` } : undefined}>
            <img ref={img} src={asset(s.image)} alt="고칠 컷 이미지" onLoad={(e) => ready(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
            {size.w > 0 && (
              <canvas
                ref={canvas}
                width={size.w}
                height={size.h}
                className={erase ? 'erasing' : ''}
                aria-label="고칠 곳 칠하기"
                onPointerDown={(ev) => {
                  // 왼쪽 버튼(또는 첫 손가락)만 칠해요. 두 번째 손가락은 무시해요.
                  if (ev.button !== 0 || !ev.isPrimary) return;
                  ev.currentTarget.setPointerCapture(ev.pointerId);
                  pointerId.current = ev.pointerId;
                  last.current = null;
                  draw(point(ev));
                }}
                onPointerMove={(ev) => ev.pointerId === pointerId.current && ev.buttons === 1 && draw(point(ev))}
                onPointerUp={() => ((last.current = null), (pointerId.current = null))}
                onPointerCancel={() => ((last.current = null), (pointerId.current = null))}
              />
            )}
          </div>
          <div className="rt-side">
            <div className="dm-seg" role="radiogroup" aria-label="붓 · 지우개">
              <button type="button" role="radio" aria-checked={!erase} className={!erase ? 'on' : ''} onClick={() => setErase(false)}>
                <Brush size={12} /> 붓
              </button>
              <button type="button" role="radio" aria-checked={erase} className={erase ? 'on' : ''} onClick={() => setErase(true)}>
                <Eraser size={12} /> 지우개
              </button>
            </div>
            <label>
              붓 크기 <small className="muted">{brush}</small>
              <input type="range" min={2} max={25} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
            </label>
            <button type="button" className="secondary compact" onClick={reset}>
              <RotateCcw size={12} /> 모두 지우기
            </button>
            <label>
              칠한 곳을 어떻게 바꿀까요?
              <textarea rows={3} maxLength={280} value={text} placeholder="예: 손가락을 자연스럽게, 간판 글자 지우기" onChange={(e) => setText(e.target.value)} />
            </label>
            <small className="muted">칠한 곳만 바꾸고 나머지(얼굴·옷·구도)는 그대로 둬요. 이전 이미지는 버전 기록에 남아요.</small>
            <button type="button" className="primary" disabled={!painted || text.trim().length < 2 || sending || busy} onClick={() => void send()}>
              {sending ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} {!painted ? '먼저 고칠 곳을 칠해 주세요' : '칠한 곳 고치기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 전후 비교: 지금 이미지와 바로 전 버전을 밀어서 비교해요.
export function CompareToggle({ ws, s }: { ws: WS; s: StudioShot }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(50);
  // '이전' = 지금 이미지 바로 앞에 만든 버전(같은 후보 묶음은 건너뜀). 지금 이미지가 기록에 없으면 가장 최근 다른 버전.
  const list = ws.data.assets.filter((a) => a.target_id === s.id && a.kind === 'image').sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cur = list.find((a) => a.url === s.image);
  const before = cur ? list.find((a) => a.created_at < cur.created_at && a.url !== s.image && (!cur.batch || a.batch !== cur.batch)) : list.find((a) => a.url !== s.image);
  if (!s.image || !before) return null;
  return (
    <>
      <button type="button" className="secondary compact" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SplitSquareHorizontal size={13} /> {open ? '비교 닫기' : '이전과 비교'}
      </button>
      {open && (
        <div className="rt-compare" aria-label="이전 이미지와 비교">
          <img src={asset(s.image)} alt="지금 이미지" />
          <span className="rt-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
            <img src={asset(before.url)} alt="이전 이미지" />
          </span>
          <i className="rt-line" style={{ left: `${pos}%` }} aria-hidden="true" />
          <em className="rt-tag l">이전</em>
          <em className="rt-tag r">지금</em>
          <input type="range" min={0} max={100} value={pos} aria-label="비교 위치" onChange={(e) => setPos(Number(e.target.value))} />
        </div>
      )}
    </>
  );
}

// 화질을 이미 올렸는지(지금 파일 기준)
export function upscaledOf(s: StudioShot) {
  const u = parseJson<{ image?: string; video?: string }>(s.upscaled, {});
  return { image: !!s.image && u.image === s.image, video: !!(s.lipsync || s.video) && u.video === (s.lipsync || s.video) };
}
