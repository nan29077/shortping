import {
  HeartHandshake,
  Flame,
  Hourglass,
  BriefcaseBusiness,
  GraduationCap,
  ScanEye,
  Mails,
  Crown,
  Fingerprint,
  TimerReset,
  Swords,
  Orbit,
  Coffee,
  Music2,
  Trophy,
  House,
  PawPrint,
  Zap,
  PenLine,
  type LucideIcon,
} from 'lucide-react';

// 기존 숏핑 아이콘과 같은 선 굵기, 장르별 포인트 색상을 쓰는 제작 아이콘 세트.
const icons: Record<string, LucideIcon> = {
  contract: HeartHandshake,
  revenge: Flame,
  regression: Hourglass,
  office: BriefcaseBusiness,
  school: GraduationCap,
  mystery: ScanEye,
  reunion: Mails,
  palace: Crown,
  detective: Fingerprint,
  time: TimerReset,
  medieval: Swords,
  scifi: Orbit,
  healing: Coffee,
  music: Music2,
  sports: Trophy,
  roommates: House,
  pet: PawPrint,
  twist: Zap,
};
const tones: Record<string, string> = {
  로맨스: 'rose',
  스릴러: 'amber',
  판타지: 'violet',
  코미디: 'mint',
  청춘: 'sky',
};

export default function TemplateIcon({ id, genre }: { id: string; genre?: string }) {
  const Icon = icons[id] || PenLine;
  return (
    <span className={`studio-template-icon ${tones[genre || ''] || 'lime'}`} aria-hidden="true">
      <Icon size={25} strokeWidth={1.65} />
    </span>
  );
}
