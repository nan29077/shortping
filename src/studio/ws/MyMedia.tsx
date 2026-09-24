import { useEffect, useRef, useState } from 'react';
import { Film, ImageIcon, Loader2, Mic, Square, Upload, X } from 'lucide-react';
import { api, type StudioShot } from '../../api';
import { Modal } from '../../App';
import type { WS } from './shared';

// 내 소재로 채우기(2026-09-24): 컷마다 AI 대신 내 사진·영상·목소리를 쓸 수 있어요(라마 들지 않음).
// 크기·길이 제한은 최고관리자가 정해요.
type Kind = 'image' | 'video' | 'audio';
const ACCEPT: Record<Kind, string> = {
  image: 'image/jpeg,image/png,image/webp',
  video: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm',
  audio: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/webm,audio/ogg,.mp3,.m4a,.wav,.webm,.ogg',
};
const NAME: Record<Kind, string> = { image: '사진', video: '영상', audio: '음성' };

export default function MyMedia({ ws, s, index }: { ws: WS; s: StudioShot; index: number }) {
  const limits = ws.features?.upload;
  const [busy, setBusy] = useState<Kind | ''>('');
  const [record, setRecord] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>('image');
  if (limits && !limits.enabled) return null;
  const maxMb = (k: Kind) => (limits ? { image: limits.image_mb, video: limits.video_mb, audio: limits.audio_mb }[k] : 0);
  const send = async (k: Kind, file: File, source: 'upload' | 'record' = 'upload') => {
    const mb = maxMb(k);
    if (mb && file.size > mb * 1024 * 1024) {
      ws.notify(`${NAME[k]} 파일은 ${mb}MB까지 올릴 수 있어요.`);
      return false;
    }
    setBusy(k);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api<{ seconds: number | null; duration: number }>(`/studio/ai/shots/${s.id}/media?kind=${k}&source=${source}`, 'POST', form);
      await ws.load();
      ws.notify(
        k === 'video'
          ? `${index + 1}번 컷에 내 영상을 넣었어요.${r.duration > 10 ? ' 컷에는 앞부분 최대 10초가 쓰여요.' : ''}`
          : k === 'audio'
            ? `${index + 1}번 컷 대사에 ${source === 'record' ? '녹음한 목소리' : '내 음성'}를 넣었어요.`
            : `${index + 1}번 컷에 내 사진을 넣었어요.`,
      );
      return true;
    } catch (e) {
      ws.notify((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };
  const pick = (k: Kind) => {
    setKind(k);
    requestAnimationFrame(() => input.current?.click());
  };
  const removeVideo = async () => {
    if (!(await ws.ask({ title: '영상을 뺄까요?', text: '이 컷은 이미지에 카메라 움직임을 넣어 합성해요. 뺀 영상은 버전 기록에 남아 다시 고를 수 있어요.', ok: '영상 빼기' }))) return;
    await ws.act(() => api(`/studio/ai/shots/${s.id}/media/video`, 'DELETE'), '영상을 뺐어요. 이미지로 합성해요.');
  };
  return (
    <div className="my-media" aria-label="내 소재로 채우기">
      <span className="my-media-label">
        <Upload size={12} /> 내 소재로
      </span>
      <button type="button" className="chip" disabled={!!busy} onClick={() => pick('image')}>
        {busy === 'image' ? <Loader2 size={12} className="spin" /> : <ImageIcon size={12} />} 사진
      </button>
      <button type="button" className="chip" disabled={!!busy} onClick={() => pick('video')}>
        {busy === 'video' ? <Loader2 size={12} className="spin" /> : <Film size={12} />} 영상
      </button>
      <button type="button" className="chip" disabled={!!busy} onClick={() => setRecord(true)}>
        <Mic size={12} /> 목소리 녹음
      </button>
      <button type="button" className="chip" disabled={!!busy} onClick={() => pick('audio')}>
        {busy === 'audio' ? <Loader2 size={12} className="spin" /> : <Upload size={12} />} 음성 파일
      </button>
      {s.video && (
        <button type="button" className="chip" disabled={!!busy || ws.busy} onClick={() => void removeVideo()}>
          <X size={12} /> 영상 빼기
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={ACCEPT[kind]}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void send(kind, f);
        }}
      />
      {limits && (
        <small className="muted my-media-limit">
          사진 {limits.image_mb}MB · 영상 {limits.video_mb}MB/{limits.video_seconds}초 · 음성 {limits.audio_seconds}초까지
        </small>
      )}
      {record && <Recorder line={s.dialogue} maxSeconds={limits?.audio_seconds || 120} close={() => setRecord(false)} use={(f) => send('audio', f, 'record')} />}
    </div>
  );
}

// 목소리 녹음: 대사를 보면서 녹음하고, 들어 본 뒤 쓸지 정해요.
function Recorder({ line, maxSeconds, close, use }: { line: string; maxSeconds: number; close: () => void; use: (f: File) => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'recording' | 'done' | 'saving'>('idle');
  const [error, setError] = useState('');
  const [secs, setSecs] = useState(0);
  const [url, setUrl] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const blob = useRef<Blob | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number>(0);
  const stopAll = () => {
    window.clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(
    () => () => {
      stopAll();
      if (url) URL.revokeObjectURL(url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const start = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('이 기기·브라우저에서는 녹음을 쓸 수 없어요. 녹음한 파일을 ‘음성 파일’로 올려 주세요.');
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError('마이크를 쓸 수 없어요. 브라우저·앱 설정에서 마이크 권한을 허용해 주세요.');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const r = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stopAll();
      const b = new Blob(chunks.current, { type: (r.mimeType || type || 'audio/webm').split(';')[0] });
      blob.current = b;
      if (url) URL.revokeObjectURL(url);
      setUrl(URL.createObjectURL(b));
      setState('done');
    };
    rec.current = r;
    r.start(250);
    setSecs(0);
    setState('recording');
    const began = Date.now();
    timer.current = window.setInterval(() => {
      const t = Math.floor((Date.now() - began) / 1000);
      setSecs(t);
      if (t >= maxSeconds) r.state === 'recording' && r.stop();
    }, 250);
  };
  const stop = () => rec.current?.state === 'recording' && rec.current.stop();
  const save = async () => {
    const b = blob.current;
    if (!b) return;
    setState('saving');
    const ext = b.type.includes('mp4') ? 'm4a' : b.type.includes('ogg') ? 'ogg' : 'webm';
    const ok = await use(new File([b], `voice.${ext}`, { type: b.type === 'audio/mp4' ? 'audio/mp4' : b.type || 'audio/webm' }));
    if (ok) close();
    else setState('done');
  };
  return (
    <Modal title="목소리 녹음" close={() => state !== 'saving' && (stop(), close())}>
      <div className="recorder">
        {line ? (
          <blockquote className="recorder-line">{line}</blockquote>
        ) : (
          <p className="muted">이 컷에는 대사가 없어요. 내레이션처럼 자유롭게 녹음해도 돼요.</p>
        )}
        <div className={'recorder-meter ' + state}>
          <b>
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
          </b>
          <small>최대 {maxSeconds}초</small>
        </div>
        {error && <p className="danger">{error}</p>}
        {url && state !== 'recording' && <audio src={url} controls />}
        <div className="form-actions">
          {state === 'recording' ? (
            <button type="button" className="primary" onClick={stop}>
              <Square size={14} /> 녹음 멈추기
            </button>
          ) : (
            <button type="button" className={state === 'done' ? 'secondary' : 'primary'} disabled={state === 'saving'} onClick={() => void start()}>
              <Mic size={14} /> {state === 'done' ? '다시 녹음' : '녹음 시작'}
            </button>
          )}
          {state !== 'recording' && url && (
            <button type="button" className="primary" disabled={state === 'saving'} onClick={() => void save()}>
              {state === 'saving' ? '넣는 중…' : '이 녹음 쓰기'}
            </button>
          )}
        </div>
        <small className="muted">조용한 곳에서 휴대폰을 입에서 한 뼘쯤 떨어뜨려 녹음하면 좋아요. 녹음은 라마가 들지 않아요.</small>
      </div>
    </Modal>
  );
}
