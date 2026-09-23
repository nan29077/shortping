import { useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { Modal } from '../App';
import './viewer.css';
import { asset } from '../platform';

// 작품 예고편. 모바일에서도 바로 재생되도록 음소거로 자동 재생하고, 소리는 버튼으로 켭니다.
export default function TrailerModal({
  src,
  title,
  poster,
  close,
}: {
  src: string;
  title: string;
  poster?: string;
  close: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true),
    [failed, setFailed] = useState(false);
  const toggleSound = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    // 소리를 켜는 건 사용자 조작이라, 멈춰 있었다면 이때 재생도 시작합니다.
    if (v.paused) void v.play().catch(() => {});
  };
  return (
    <Modal title={`${title} 예고편`} close={close} className="viewer-trailer-modal">
      <div className="viewer-trailer">
        {failed ? (
          <p className="viewer-trailer-error">예고편을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>
        ) : (
          <video
            ref={video}
            src={asset(src)}
            poster={asset(poster)}
            autoPlay
            muted
            playsInline
            controls
            preload="auto"
            onVolumeChange={() => setMuted(!!video.current?.muted)}
            onError={() => setFailed(true)}
          />
        )}
        {!failed && (
          <button
            className="viewer-trailer-sound"
            onClick={toggleSound}
            aria-pressed={!muted}
            aria-label={muted ? '소리 켜기' : '소리 끄기'}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            {muted ? '소리 켜기' : '소리 끄기'}
          </button>
        )}
      </div>
    </Modal>
  );
}
