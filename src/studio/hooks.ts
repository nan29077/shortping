import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// 입력하면 잠시 뒤 자동으로 저장합니다. 화면을 떠나거나 다른 항목으로 바뀌기 전에는 남은 변경을 바로 저장합니다.
// - value: 지금 폼 값, saved: 서버에 저장된 값(같으면 저장하지 않음)
// - save: 실제 저장 함수(실패하면 throw)
// - enabled: false면(값이 아직 올바르지 않을 때 등) 저장하지 않고 기다립니다.
// 비교용 키: 앞뒤 공백은 서버가 잘라 저장하므로 비교할 때도 무시해요(끝 공백 하나로 '저장 안 됨'이 계속되지 않도록).
export const formKey = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.trim() : x));
export function useAutosave<T>(value: T, saved: T, save: (v: T, base: T) => Promise<unknown>, { delay = 900, enabled = true } = {}) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const latest = useRef(value);
  const saveRef = useRef(save);
  const enabledRef = useRef(enabled);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  // 기준값: 서버 값이 바뀌면 서버 값으로, 저장에 성공하면 보낸 값으로 맞춥니다.
  // (서버 값을 다시 불러오기 전에 원래 값으로 되돌려 써도 저장되게 합니다.)
  const savedKey = formKey(saved);
  const serverKey = useRef(savedKey);
  const baseline = useRef(savedKey);
  const baseObj = useRef<T>(saved);
  if (serverKey.current !== savedKey) {
    serverKey.current = savedKey;
    baseline.current = savedKey;
    baseObj.current = saved;
  }
  latest.current = value;
  saveRef.current = save;
  enabledRef.current = enabled;
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current;
    const snapshot = latest.current;
    const key = formKey(snapshot);
    if (key === baseline.current) return true;
    if (!enabledRef.current) return false;
    setState('saving');
    let ok = false;
    const job = (async () => {
      try {
        await saveRef.current(snapshot, baseObj.current as T);
        baseObj.current = snapshot;
        baseline.current = key;
        setState('saved');
        setError('');
        ok = true;
      } catch (e) {
        setState('error');
        setError((e as Error).message);
      }
    })();
    inflight.current = job;
    await job;
    inflight.current = null;
    return ok;
  }, []);
  const valueKey = formKey(value);
  const dirty = valueKey !== baseline.current;
  useEffect(() => {
    if (!enabled || !dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [valueKey, dirty, enabled, delay, flush]);
  // 화면을 떠날 때(탭 닫기 · 다른 화면) 남은 변경 저장
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      // 화면이 사라진 뒤의 저장 실패는 아무도 못 보므로 작업 공간에 신호를 보내 토스트로 알려요(2026-09-30 점검).
      const hadChanges = formKey(latest.current) !== baseline.current;
      void flush().then((ok) => {
        if (!ok && hadChanges && enabledRef.current) window.dispatchEvent(new CustomEvent('sp:save-error', { detail: '' }));
      });
    };
  }, [flush]);
  // blocked: 고친 내용이 있는데 값이 올바르지 않아 저장을 기다리는 중(예: 길이 칸이 비었을 때)
  return { state: dirty && state === 'saved' ? ('idle' as SaveState) : state, dirty, error, flush, blocked: dirty && !enabled };
}

// 바뀐 칸만 골라 보냅니다(다른 탭·팀원이 고친 칸을 옛 값으로 덮어쓰지 않도록).
export function changedFields<T extends object>(v: T, base: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(v) as (keyof T)[]) if (JSON.stringify(v[k]) !== JSON.stringify(base?.[k])) out[k] = v[k];
  return out;
}

// 서버 값이 바뀌면(AI 결과 등) 사용자가 손대지 않은 폼만 새 값으로 맞춥니다.
export function useSyncedForm<T>(server: T): [T, (v: T | ((p: T) => T)) => void] {
  const [form, setForm] = useState<T>(server);
  const last = useRef(JSON.stringify(server));
  const snap = JSON.stringify(server);
  useEffect(() => {
    if (snap === last.current) return;
    const prev = last.current;
    // 손대지 않은 칸(앞뒤 공백 차이만 있는 경우 포함)만 새 서버 값으로 맞춰요. 고친 칸은 그대로 둬요.
    setForm((cur) => {
      const before = JSON.parse(prev);
      const next = JSON.parse(snap);
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !next || typeof next !== 'object') return formKey(cur) === formKey(before) ? (next as T) : cur;
      const out: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
      for (const k of Object.keys(next)) if (formKey((cur as Record<string, unknown>)[k]) === formKey(before?.[k])) out[k] = next[k];
      return out as T;
    });
    last.current = snap;
  }, [snap]);
  return [form, setForm];
}

export const hasHangul = (s: string) => /[가-힣]/.test(s || '');

// 옆 패널(AI 조수 · 의견 등) 접근성: 열면 패널 안으로 초점을 옮기고, Esc로 닫고, 닫으면 연 버튼으로 초점을 돌려줘요.
// 확인 창 · 다른 모달이 떠 있으면 Esc는 그쪽이 먼저 받아요.
export function usePanelFocus(ref: { current: HTMLElement | null }, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>('textarea, input, button:not([disabled])');
    (first || box)?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || document.querySelector('.modal-backdrop')) return;
      ev.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev?.isConnected) prev.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
