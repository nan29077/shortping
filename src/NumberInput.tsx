import { useLayoutEffect, useRef, type InputHTMLAttributes, type PointerEvent } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// 숫자 입력칸: 브라우저 기본 위/아래 화살표 대신 앱 디자인에 맞춘 버튼을 붙여요.
// 값을 바꾸는 방식은 그대로(onChange에 e.target.value)라 기존 코드를 고칠 필요가 없어요.
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export default function NumberInput(rest: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const steps = useRef<HTMLSpanElement>(null);

  // 입력칸 크기·여백이 화면마다 달라서, 버튼을 입력칸 오른쪽 안쪽에 맞춰 붙여요.
  useLayoutEffect(() => {
    const el = ref.current;
    const box = steps.current;
    const wrap = el?.parentElement;
    if (!el || !box || !wrap) return;
    const place = () => {
      const h = el.offsetHeight;
      if (!h) return;
      const pad = h < 34 ? 3 : 5;
      box.style.top = el.offsetTop + pad + 'px';
      box.style.bottom = 'auto';
      box.style.height = h - pad * 2 + 'px';
      box.style.right = wrap.clientWidth - (el.offsetLeft + el.offsetWidth) + pad + 'px';
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  const timer = useRef<{ t?: ReturnType<typeof setTimeout>; moved?: boolean }>({});

  const bump = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el || el.disabled || el.readOnly) return;
    const before = el.value;
    try {
      if (dir > 0) el.stepUp();
      else el.stepDown();
    } catch {
      const min = el.min === '' ? -Infinity : Number(el.min);
      const max = el.max === '' ? Infinity : Number(el.max);
      el.value = String(Math.min(max, Math.max(min, Number(el.value || 0) + dir)));
    }
    if (el.value === before) return;
    timer.current.moved = true;
    // React가 입력으로 알아차리도록 input 이벤트를 보내요.
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const stop = () => {
    clearTimeout(timer.current.t);
    timer.current.t = undefined;
    // 칸을 벗어날 때 저장·보정하는 화면이 있어서, 버튼을 뗄 때 한 번 알려 줘요.
    if (timer.current.moved && rest.onBlur) {
      timer.current.moved = false;
      setTimeout(
        () => ref.current?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
        0,
      );
    }
  };

  const start = (dir: 1 | -1) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 입력칸 포커스를 빼앗지 않아요(모바일 키보드도 안 떠요).
    bump(dir);
    const repeat = (delay: number) => {
      timer.current.t = setTimeout(() => {
        bump(dir);
        repeat(70);
      }, delay);
    };
    repeat(420);
  };

  const off = rest.disabled || rest.readOnly;
  return (
    <span className={'num-field' + (rest.className ? ' has-' + rest.className.split(' ')[0] : '')}>
      <input ref={ref} type="number" {...rest} />
      <span ref={steps} className="num-steps" aria-hidden="true">
        <button
          type="button"
          tabIndex={-1}
          disabled={off}
          onPointerDown={start(1)}
          onMouseDown={(e) => e.preventDefault()}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
        >
          <ChevronUp size={12} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={off}
          onPointerDown={start(-1)}
          onMouseDown={(e) => e.preventDefault()}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
        >
          <ChevronDown size={12} strokeWidth={2.4} />
        </button>
      </span>
    </span>
  );
}
