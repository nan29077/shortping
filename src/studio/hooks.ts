import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// 입력하면 잠시 뒤 자동으로 저장합니다. 화면을 떠나거나 다른 항목으로 바뀌기 전에는 남은 변경을 바로 저장합니다.
// - value: 지금 폼 값, saved: 서버에 저장된 값(같으면 저장하지 않음)
// - save: 실제 저장 함수(실패하면 throw)
// - enabled: false면(값이 아직 올바르지 않을 때 등) 저장하지 않고 기다립니다.
export function useAutosave<T>(value: T, saved: T, save: (v: T) => Promise<unknown>, { delay = 900, enabled = true } = {}) {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const latest = useRef(value);
  const saveRef = useRef(save);
  const enabledRef = useRef(enabled);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  // 기준값: 서버 값이 바뀌면 서버 값으로, 저장에 성공하면 보낸 값으로 맞춥니다.
  // (서버 값을 다시 불러오기 전에 원래 값으로 되돌려 써도 저장되게 합니다.)
  const savedKey = JSON.stringify(saved);
  const serverKey = useRef(savedKey);
  const baseline = useRef(savedKey);
  if (serverKey.current !== savedKey) {
    serverKey.current = savedKey;
    baseline.current = savedKey;
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
    const key = JSON.stringify(snapshot);
    if (key === baseline.current) return true;
    if (!enabledRef.current) return false;
    setState('saving');
    let ok = false;
    const job = (async () => {
      try {
        await saveRef.current(snapshot);
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
  const valueKey = JSON.stringify(value);
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
      void flush();
    };
  }, [flush]);
  return { state: dirty && state === 'saved' ? ('idle' as SaveState) : state, dirty, error, flush };
}

// 서버 값이 바뀌면(AI 결과 등) 사용자가 손대지 않은 폼만 새 값으로 맞춥니다.
export function useSyncedForm<T>(server: T): [T, (v: T | ((p: T) => T)) => void] {
  const [form, setForm] = useState<T>(server);
  const last = useRef(JSON.stringify(server));
  const snap = JSON.stringify(server);
  useEffect(() => {
    if (snap === last.current) return;
    const prev = last.current;
    setForm((cur) => (JSON.stringify(cur) === prev ? (JSON.parse(snap) as T) : cur));
    last.current = snap;
  }, [snap]);
  return [form, setForm];
}

export const hasHangul = (s: string) => /[가-힣]/.test(s || '');
