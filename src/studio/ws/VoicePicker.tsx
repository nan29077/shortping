import { useEffect, useRef, useState } from 'react';
import { asset } from '../../platform';
import { Loader2, Play, Square } from 'lucide-react';
import { api, type VoiceModel } from '../../api';

// 목소리 라이브러리: 모델별 대표 목소리를 성별·나이대·느낌으로 보여 주고 바로 들어 볼 수 있어요.
let cache: Promise<VoiceModel[]> | null = null;
export const loadVoices = () => (cache ??= api<VoiceModel[]>('/studio/ai/voices').catch((e) => {
  cache = null;
  throw e;
}));
const sampleUrl = (url: string) => (url ? asset('/api/studio/ai/voices/sample/' + url.split('/').pop()) : '');

export default function VoicePicker({
  model,
  voice,
  onChange,
  notify,
  label = '목소리',
}: {
  model: string;
  voice: string;
  onChange: (v: { model: string; voice: string }) => void;
  notify: (s: string) => void;
  label?: string;
}) {
  const [list, setList] = useState<VoiceModel[] | null>(null);
  const [gender, setGender] = useState('전체');
  const [playing, setPlaying] = useState('');
  const [loading, setLoading] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    loadVoices().then(
      (v) => alive.current && setList(v),
      (e) => alive.current && notify((e as Error).message),
    );
    return () => {
      alive.current = false;
      audio.current?.pause();
    };
  }, [notify]);
  const current = list?.find((m) => m.model === model) || (model === 'auto' ? list?.[0] : undefined);
  const voices = (current?.voices || []).filter((v) => gender === '전체' || v.gender === gender);
  const play = async (m: string, v: string, cached: string) => {
    audio.current?.pause();
    if (playing === v) {
      setPlaying('');
      return;
    }
    let url = cached;
    if (!url) {
      setLoading(v);
      try {
        // 처음 듣는 목소리는 샘플을 만드는 데 몇 초 걸려요(라마는 들지 않아요).
        for (let i = 0; i < 30 && alive.current; i++) {
          const r = await api<{ url?: string; ready: boolean }>('/studio/ai/voices/preview', 'POST', { model: m, voice: v });
          if (r.ready && r.url) {
            url = r.url;
            break;
          }
          await new Promise((ok) => setTimeout(ok, 2000));
        }
        cache = null; // 새 샘플이 생겼으니 다음에 목록을 새로 받습니다.
      } catch (e) {
        notify((e as Error).message);
      } finally {
        setLoading('');
      }
      if (!url) return;
    }
    if (!alive.current) return;
    const a = new Audio(sampleUrl(url));
    audio.current = a;
    a.onended = () => setPlaying('');
    setPlaying(v);
    void a.play().catch(() => setPlaying(''));
  };
  if (!list) return <small className="muted">목소리 목록을 불러오는 중…</small>;
  if (!list.length) return <small className="muted">연결된 음성 모델이 없어요.</small>;
  return (
    <div className="voice-picker">
      <div className="voice-picker-head">
        <label>
          {label} 모델
          <select value={model} onChange={(e) => onChange({ model: e.target.value, voice: '' })}>
            <option value="auto">자동 선택</option>
            {list.map((m) => (
              <option key={m.model} value={m.model}>
                {m.label} · {m.provider}
              </option>
            ))}
          </select>
        </label>
        <div className="chip-row" aria-label="성별로 거르기">
          {['전체', '여', '남', '중성'].map((g) => (
            <button type="button" key={g} className={'chip' + (gender === g ? ' active' : '')} onClick={() => setGender(g)}>
              {g}
            </button>
          ))}
        </div>
      </div>
      {model === 'auto' && <small className="muted">자동 선택이면 첫 번째 음성 모델의 목소리 중에서 골라요. 모델을 정하면 더 정확해요.</small>}
      <div className="voice-grid">
        {voices.map((v) => (
          <div key={v.id} className={'voice-option' + (voice === v.id ? ' selected' : '')}>
            <button type="button" className="voice-choose" aria-pressed={voice === v.id} onClick={() => onChange({ model: current && model !== 'auto' ? model : current?.model || model, voice: v.id })}>
              <b>{v.tone}</b>
              <small>
                {v.gender} · {v.age}
              </small>
            </button>
            <button type="button" className="voice-play" aria-label={`${v.tone} 목소리 듣기`} disabled={!!loading && loading !== v.id} onClick={() => void play(current!.model, v.id, v.sample)}>
              {loading === v.id ? <Loader2 size={13} className="spin" /> : playing === v.id ? <Square size={12} /> : <Play size={13} />}
            </button>
          </div>
        ))}
      </div>
      <label className="voice-custom">
        직접 입력 (공급사 목소리 ID)
        <input value={voice} maxLength={80} placeholder="목록에 없는 목소리 ID" onChange={(e) => onChange({ model, voice: e.target.value })} />
      </label>
    </div>
  );
}
