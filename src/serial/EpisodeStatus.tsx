import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import './serial.css';

// 연재형 공개: 회차 상태 표시와 한국 시간(KST) 변환 도우미.
export type ReviewStatus = 'approved' | 'draft' | 'pending' | 'rejected' | 'scheduled';

// ISO 시각 → "2026.09.23 21:00" (한국 시간)
export function kstLabel(iso?: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}
// ISO 시각 → datetime-local 입력값("2026-09-23T21:00", 한국 시간 기준)
export function kstInputValue(iso?: string | null) {
  const label = kstLabel(iso);
  return label ? label.replace(/\./g, '-').replace(' ', 'T') : '';
}
// datetime-local 입력값을 한국 시간으로 읽어 ISO(UTC)로 바꿉니다. 형식이 틀리면 null.
export function kstInputToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value + ':00+09:00');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
// 지금부터 한 시간 뒤(정각)를 예약 기본값으로 씁니다.
export function defaultReserveInput() {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setUTCMinutes(0, 0, 0);
  return kstInputValue(next.toISOString());
}
export const nowKstInput = () => kstInputValue(new Date().toISOString());

export function EpisodeStatusChip({
  status,
  publishAt,
}: {
  status?: string | null;
  publishAt?: string | null;
}) {
  const s = (status || 'approved') as ReviewStatus;
  const text =
    s === 'approved'
      ? '공개 중'
      : s === 'draft'
        ? '검수 전'
        : s === 'pending'
          ? publishAt
            ? `검수 대기 · ${kstLabel(publishAt)} 예약`
            : '검수 대기'
          : s === 'rejected'
            ? '반려'
            : s === 'scheduled'
              ? `예약 공개 ${kstLabel(publishAt)}`
              : s;
  return <span className={'serial-chip ' + s}>{text}</span>;
}

// 모달 안에서도 화면 아래에 뜨는 짧은 안내(앱 전체 알림을 받을 수 없는 창에서 사용)
export function useSerialToast(): [(s: string) => void, React.ReactNode] {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(''), 2800);
    return () => clearTimeout(t);
  }, [text]);
  const ui = text
    ? createPortal(
        <div className="toast" role="status">
          <Check size={17} />
          {text}
        </div>,
        document.body,
      )
    : null;
  return [setText, ui];
}
