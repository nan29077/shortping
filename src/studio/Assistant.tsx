import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Loader2, RotateCcw, Send, Sparkles, Trash2, X } from 'lucide-react';
import { api, ApiError, lama, type StudioChat } from '../api';
import type { WS } from './ws/shared';
import { HUB_CAPS } from './ModelHub';

// AI 조수(2026-09-24): 바이브 코딩처럼 말로 요청하면 실행 계획을 보여 주고, 승인하면 실행해요.
// 대화는 무료이고, 계획 안의 AI 작업만 평소처럼 라마가 들어요. 직접 고친 내용은 되돌릴 수 있어요.
const SUGGEST = ['이 회차 대본 진단해 줘', '3번 컷 배경을 비 오는 밤으로 바꿔 줘', '빈 컷 이미지 모두 만들어 줘', '2번 컷 대사를 "지금 말해. 다 알고 있어."로 바꿔 줘', '긴장감 있는 배경음악 깔아 줘'];

export default function Assistant({ ws, focus, close }: { ws: WS; focus: string; close: () => void }) {
  const chat = ws.data.chat || [];
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [skip, setSkip] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const thinking = chat.some((m) => m.status === 'thinking');
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [chat.length, thinking]);
  // 지금 모델 설정(자동/직접 · 품질)을 계획 가격과 실행에 그대로 씁니다.
  const choices = Object.fromEntries(HUB_CAPS.map((c) => [c, { requested: ws.mode === 'auto' ? 'auto' : ws.choices[c].requested, tier: ws.choices[c].tier }]));
  const send = async (msg = text) => {
    const m = msg.trim();
    if (!m || sending || thinking) return;
    setSending(true);
    try {
      await api(`/studio/ai/projects/${ws.data.project.id}/assistant`, 'POST', { message: m, episodeId: ws.episode?.id, focus: focus || undefined, choices });
      setText('');
      await ws.load();
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const apply = async (m: StudioChat, budgetOk = false): Promise<void> => {
    setBusy(m.id);
    try {
      const r = await api<{ results: { ok?: boolean; message?: string }[] }>(`/studio/ai/projects/${ws.data.project.id}/assistant/${m.id}/apply`, 'POST', { skip: skip[m.id] || [], choices, ...(budgetOk ? { budgetOk: true } : {}) });
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.filter((x) => x.ok === false).length;
      ws.notify(bad ? `${ok}개 실행, ${bad}개는 실행하지 못했어요.` : `${ok}개 작업을 실행했어요.`);
      await ws.load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'project_budget') {
        if (await ws.ask({ title: '프로젝트 예산을 넘어요', text: (e as Error).message + ' 그래도 실행할까요?', ok: '예산 넘어도 실행' })) return apply(m, true);
      } else {
        if (e instanceof ApiError && e.code === 'insufficient_lama') ws.goLama();
        ws.notify((e as Error).message);
      }
    } finally {
      setBusy('');
    }
  };
  const act = async (m: StudioChat, what: 'undo' | 'dismiss') => {
    if (what === 'undo' && !(await ws.ask({ title: '되돌릴까요?', text: '이 계획으로 고친 내용을 실행 전으로 돌려요. 진행 중인 AI 작업은 멈추고 라마를 돌려드려요(이미 만든 결과는 버전 기록에 남아요).', ok: '되돌리기' }))) return;
    setBusy(m.id);
    try {
      await api(`/studio/ai/projects/${ws.data.project.id}/assistant/${m.id}/${what}`, 'POST');
      if (what === 'undo') ws.notify('되돌렸어요.');
      await ws.load();
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const clear = async () => {
    if (!(await ws.ask({ title: '대화를 지울까요?', text: '이 프로젝트의 AI 조수 대화 기록을 지워요. 이미 실행한 작업과 결과는 그대로예요.', ok: '지우기', danger: true }))) return;
    try {
      await api(`/studio/ai/projects/${ws.data.project.id}/assistant`, 'DELETE');
      await ws.load();
    } catch (e) {
      ws.notify((e as Error).message);
    }
  };
  const focusText = (() => {
    const e = ws.episode;
    const i = e ? e.shots.findIndex((s) => s.id === focus) : -1;
    return e && i >= 0 ? `${e.number}화 ${i + 1}번 컷` : e ? `${e.number}화` : '';
  })();
  return (
    <aside className="asst" aria-label="AI 조수">
      <header className="asst-head">
        <Bot size={17} />
        <div>
          <b>AI 조수</b>
          <small>말로 요청하면 계획을 보여 드려요 · 대화 무료</small>
        </div>
        {chat.length > 0 && (
          <button type="button" className="icon-button" aria-label="대화 지우기" onClick={() => void clear()}>
            <Trash2 size={15} />
          </button>
        )}
        <button type="button" className="icon-button" aria-label="AI 조수 닫기" onClick={close}>
          <X size={16} />
        </button>
      </header>
      <div className="asst-list" ref={list}>
        {!chat.length && (
          <div className="asst-empty">
            <Sparkles size={20} />
            <p>
              “3번 컷 배경을 밤으로”, “대사를 더 짧게”처럼 편하게 말해 주세요. 제가 할 일을 정리해서 보여 드리고, 확인하시면 실행해요.
            </p>
            <div className="asst-suggest">
              {SUGGEST.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void send(s)} disabled={sending || thinking}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="asst-msg me">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={'asst-msg bot ' + m.status}>
              {m.status === 'thinking' ? (
                <span className="asst-typing">
                  <Loader2 size={13} className="spin" /> 계획을 세우는 중…
                </span>
              ) : (
                <p>{m.content}</p>
              )}
              {m.plan.length > 0 && <PlanCard m={m} skip={skip[m.id] || []} setSkip={(v) => setSkip({ ...skip, [m.id]: v })} />}
              {m.status === 'ready' && (
                <div className="asst-actions">
                  <button type="button" className="primary compact" disabled={busy === m.id} onClick={() => void apply(m)}>
                    <Check size={14} /> {planTotal(m, skip[m.id] || []) ? `${lama(planTotal(m, skip[m.id] || []))}로 실행` : '실행 (무료)'}
                  </button>
                  <button type="button" className="secondary compact" disabled={busy === m.id} onClick={() => void act(m, 'dismiss')}>
                    그만두기
                  </button>
                </div>
              )}
              {m.status === 'applying' && (
                <span className="asst-typing">
                  <Loader2 size={13} className="spin" /> 실행하는 중…
                </span>
              )}
              {m.status === 'applied' && (
                <div className="asst-actions">
                  <span className="asst-done">
                    <Check size={13} /> 실행했어요
                  </span>
                  <button type="button" className="text-link" disabled={busy === m.id} onClick={() => void act(m, 'undo')}>
                    <RotateCcw size={12} /> 되돌리기
                  </button>
                </div>
              )}
              {m.status === 'undone' && <span className="asst-done muted">되돌렸어요</span>}
              {m.status === 'declined' && <span className="asst-done muted">실행하지 않았어요</span>}
            </div>
          ),
        )}
      </div>
      <form
        className="asst-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {focusText && <small className="asst-focus">지금 보는 곳: {focusText}</small>}
        <div>
          <textarea
            rows={2}
            maxLength={600}
            value={text}
            placeholder={thinking ? '답을 만드는 중이에요…' : '무엇을 바꿀까요? 예: 3번 컷 표정을 더 화나게'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary" aria-label="보내기" disabled={!text.trim() || sending || thinking}>
            {sending ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
      </form>
    </aside>
  );
}

const planTotal = (m: StudioChat, skip: number[]) => m.plan.reduce((n, a, i) => n + (a.ok && !a.error && !skip.includes(i) ? Number(a.lama || 0) : 0), 0);

function PlanCard({ m, skip, setSkip }: { m: StudioChat; skip: number[]; setSkip: (v: number[]) => void }) {
  const editable = m.status === 'ready';
  const results = m.result?.results || [];
  return (
    <ol className="asst-plan">
      {m.plan.map((a, i) => {
        const usable = a.ok && !a.error;
        const res = results.find((r) => r.i === i);
        return (
          <li key={i} className={usable ? '' : 'off'}>
            {editable && usable ? (
              <input type="checkbox" aria-label={a.label + ' 포함'} checked={!skip.includes(i)} onChange={(e) => setSkip(e.target.checked ? skip.filter((x) => x !== i) : [...skip, i])} />
            ) : (
              <span className="asst-plan-dot">{i + 1}</span>
            )}
            <div>
              <b>
                {a.label}
                {a.what && <small> · {a.what}</small>}
              </b>
              {a.fields && (
                <small className="asst-fields">
                  {Object.entries(a.fields)
                    .map(([k, v]) => `${fieldName[k] || k}: ${String(v).slice(0, 60)}`)
                    .join(' / ')}
                </small>
              )}
              {a.reason && <small>{a.reason}</small>}
              {!usable && <small className="danger">{a.note || a.error}</small>}
              {res?.message && <small className={res.ok ? 'lime' : 'danger'}>{res.message}</small>}
            </div>
            <em>{usable ? (a.type.startsWith('edit_') ? '무료' : a.lama ? lama(a.lama) : '') : ''}</em>
          </li>
        );
      })}
    </ol>
  );
}
const fieldName: Record<string, string> = { dialogue: '대사', visual: '화면', emotion: '감정', seconds: '길이', camera: '카메라', camera_move: '움직임', speed: '빠르기', description: '설명', look: '외모', voice_style: '말투', title: '제목', summary: '줄거리', tone: '톤', style: '스타일' };
