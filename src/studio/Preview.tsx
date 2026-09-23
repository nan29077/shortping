import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { studioMedia, type StudioCharacter, type StudioShot } from '../api';
import { asset } from '../platform';

// 회차 미리보기(애니매틱): 합성 전에 컷 영상(없으면 스토리보드 이미지)과 대사 음성·자막을 이어서 재생합니다.
// 라마가 들지 않고, 브라우저에서만 재생합니다.
export default function PreviewPlayer({
  title,
  shots,
  cast,
  close,
}: {
  title: string;
  shots: StudioShot[];
  cast: StudioCharacter[];
  close: () => void;
}) {
  const playable = useMemo(() => shots.filter((s) => s.lipsync || s.video || s.image), [shots]);
  const durations = useMemo(() => playable.map((s) => Math.max(Number(s.seconds) || 4, s.audio_seconds ? Number(s.audio_seconds) + 0.35 : 0)), [playable]);
  const total = durations.reduce((a, b) => a + b, 0);
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(true),
    [elapsed, setElapsed] = useState(0);
  const audio = useRef<HTMLAudioElement>(null),
    sfx = useRef<HTMLAudioElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const shot = playable[index];
  useEffect(() => {
    if (sfx.current) sfx.current.volume = Math.max(0, Math.min(1, Number(shot?.sfx_volume ?? 0.6)));
  }, [shot]);
  useEffect(() => {
    setElapsed(0);
    for (const a of [audio.current, sfx.current]) {
      if (!a) continue;
      a.currentTime = 0;
      if (playing) void a.play().catch(() => {});
    }
    if (video.current) {
      video.current.currentTime = 0;
      if (playing) void video.current.play().catch(() => {});
    }
  }, [index]);
  useEffect(() => {
    if (playing) {
      void audio.current?.play().catch(() => {});
      void sfx.current?.play().catch(() => {});
      void video.current?.play().catch(() => {});
    } else {
      audio.current?.pause();
      sfx.current?.pause();
      video.current?.pause();
    }
  }, [playing]);
  useEffect(() => {
    if (!playing || !shot) return;
    const t = setInterval(() => {
      setElapsed((e) => {
        const next = e + 0.1;
        if (next >= durations[index]) {
          if (index < playable.length - 1) setIndex((i) => i + 1);
          else setPlaying(false);
          return 0;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [playing, index, durations, playable.length, shot]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(playable.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close, playable.length]);
  if (!shot)
    return (
      <div className="preview-overlay" role="dialog" aria-label="회차 미리보기">
        <div className="preview-empty">
          <p>미리볼 컷이 없어요. 스토리보드 이미지를 먼저 만들어 주세요.</p>
          <button className="primary" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    );
  const passed = durations.slice(0, index).reduce((a, b) => a + b, 0) + elapsed;
  const speaker = cast.find((c) => c.id === shot.speaker_id);
  return (
    <div className="preview-overlay" role="dialog" aria-label={title + ' 미리보기'}>
      <div className="preview-frame">
        <div className="preview-screen">
          {shot.lipsync ? (
            // 입 모양을 맞춘 영상은 대사 음성이 들어 있어 그대로 재생합니다.
            <video key={shot.id + 'l'} ref={video} src={studioMedia(shot.lipsync)} playsInline preload="auto" />
          ) : shot.video ? (
            <video key={shot.id} ref={video} src={studioMedia(shot.video)} muted={!!shot.audio} playsInline loop preload="auto" />
          ) : (
            <img key={shot.id} className="kenburns" src={asset(shot.image)} alt="" style={{ animationDuration: `${durations[index]}s` }} />
          )}
          {shot.audio && !shot.lipsync && <audio key={'a' + shot.id} ref={audio} src={studioMedia(shot.audio)} preload="auto" />}
          {shot.sfx && <audio key={'s' + shot.id} ref={sfx} src={studioMedia(shot.sfx)} preload="auto" />}
          {(shot.caption ?? shot.dialogue) && (
            <p className="preview-subtitle">
              {speaker && shot.caption == null ? <b>{speaker.name}</b> : null}
              {shot.caption ?? shot.dialogue}
            </p>
          )}
          <span className="preview-tag">
            #{index + 1} · {shot.camera || '컷'} {shot.lipsync ? '· 입 모양 영상' : shot.video ? '· 영상' : '· 스토리보드'}
          </span>
          <button className="preview-close" aria-label="닫기" onClick={close}>
            <X size={18} />
          </button>
        </div>
        <div className="preview-progress" aria-hidden="true">
          {playable.map((s, i) => (
            <span key={s.id} style={{ flex: durations[i] }} className={i < index ? 'done' : i === index ? 'now' : ''}>
              {i === index && <i style={{ width: `${Math.min(100, (elapsed / durations[i]) * 100)}%` }} />}
            </span>
          ))}
        </div>
        <div className="preview-controls">
          <button aria-label="이전 컷" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
            <ChevronLeft size={18} />
          </button>
          <button aria-label={playing ? '일시정지' : '재생'} className="play" onClick={() => {
            if (!playing && index === playable.length - 1 && elapsed === 0) setIndex(0);
            setPlaying((p) => !p);
          }}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button aria-label="다음 컷" onClick={() => setIndex((i) => Math.min(playable.length - 1, i + 1))} disabled={index === playable.length - 1}>
            <ChevronRight size={18} />
          </button>
          <small>
            {Math.floor(passed)}초 / {Math.round(total)}초 · 컷 {index + 1}/{playable.length}
            {shots.length > playable.length ? ` · 이미지가 없는 컷 ${shots.length - playable.length}개는 건너뛰어요` : ''}
          </small>
        </div>
      </div>
    </div>
  );
}
