import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  // 확인 창은 항상 다른 창(출금 처리 · 편집기 · 서랍 등) 위에 떠야 해요. 어디에 {confirmUi}를 두든
  // body 맨 끝으로 그리고(portal) 가장 높은 층에 둡니다(2026-10-01 재점검: 출금 창 뒤에 깔리던 문제).
  const ui = pending ? createPortal(
    <Modal title={pending.title} close={() => done(false)} className="confirm-modal" backdropClassName="confirm-backdrop">
      <p className="confirm-text">{pending.text}</p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={() => done(false)}>
          취소
        </button>
        {/* 처음 초점: 위험한 작업은 '취소'(Modal 기본값), 일반 확인은 확인 버튼 */}
        <button
          type="button"
          className={pending.danger ? 'danger' : 'primary'}
          data-autofocus={pending.danger ? undefined : ''}
          onClick={() => done(true)}
        >
          {pending.ok || '확인'}
        </button>
      </div>
    </Modal>,
    document.body,
  ) : null;
  return [ask, ui];
}
