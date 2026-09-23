import { useCallback, useRef, useState } from 'react';
import { Modal } from './App';

// 되돌리기 어려운 작업 앞에서 한 번 더 묻는 확인 창.
// const [ask, confirmUi] = useConfirm();  →  if (!(await ask({ title, text }))) return;  … JSX 안에 {confirmUi}
type Ask = { title: string; text: string; ok?: string; danger?: boolean };
export function useConfirm(): [(a: Ask) => Promise<boolean>, React.ReactNode] {
  const [pending, setPending] = useState<Ask | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback(
    (a: Ask) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setPending(a);
      }),
    [],
  );
  const done = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setPending(null);
  };
  const ui = pending ? (
    <Modal title={pending.title} close={() => done(false)} className="confirm-modal">
      <p className="confirm-text">{pending.text}</p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={() => done(false)}>
          취소
        </button>
        <button type="button" className={pending.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
          {pending.ok || '확인'}
        </button>
      </div>
    </Modal>
  ) : null;
  return [ask, ui];
}
