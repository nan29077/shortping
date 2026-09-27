import { useEffect, useState } from 'react';
import { Film } from 'lucide-react';
import { api } from '../api';
import { Modal, navigate } from '../App';
import { asset } from '../platform';

// 영상 → 대본(2026-09-25): 내가 올린 완성 영상(자막이 있는 회차)으로 새 AI 프로젝트를 시작해요.
type Source = { id: string; title: string; genre: string; image: string; status: string; episodes: { number: number; title: string; duration: number; has_subtitles: boolean }[] };

export default function ReverseStart({ close, notify, opened }: { close: () => void; notify: (s: string) => void; opened: (id: string) => void }) {
  const [list, setList] = useState<Source[] | null>(null);
  const [pick, setPick] = useState('');
  const [nums, setNums] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Source[]>('/studio/ai/reverse/sources')
      .then((l) => {
        setList(l);
        if (l[0]) setPick(l[0].id);
      })
      .catch((e) => {
        notify((e as Error).message);
        setList([]);
      });
  }, [notify]);
  const d = list?.find((x) => x.id === pick);
  useEffect(() => {
    setNums(d ? d.episodes.filter((e) => e.has_subtitles).slice(0, 12).map((e) => e.number) : []);
  }, [d]);
  const toggle = (n: number) => setNums((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : cur.length >= 12 ? cur : [...cur, n].sort((a, b) => a - b)));
  const missing = d?.episodes.filter((e) => !e.has_subtitles).length || 0;
  return (
    <Modal title="영상에서 대본 뽑기" close={() => !busy && close()}>
      <div className="reverse-start">
        <p className="muted">
          내가 올린 완성 영상의 자막(대사)으로 제작용 대본을 복원해 새 AI 프로젝트를 만들어요. 리메이크 · 다른 버전 · 해외판을 만들 때 좋아요. 대본 복원에는 라마가 조금 들어요(실행 전에 알려 드려요).
        </p>
        {!list ? (
          <div className="loading">
            <span className="spinner" />
          </div>
        ) : !list.length ? (
          <div className="info-box">
            영상을 올린 작품이 없어요.{' '}
            <button type="button" className="text-link" onClick={() => navigate('studio/contents')}>
              내 작품에서 영상 올리기
            </button>
          </div>
        ) : (
          <>
            <label>
              작품
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                {list.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title} · {x.episodes.length}화
                  </option>
                ))}
              </select>
            </label>
            {d && (
              <div className="reverse-eps" role="group" aria-label="가져올 회차(최대 12화)">
                {d.image && <img src={asset(d.image)} alt="" />}
                <div>
                  {d.episodes.map((e) => (
                    <label key={e.number} className={'chip' + (nums.includes(e.number) ? ' active' : '') + (!e.has_subtitles ? ' off' : '')} title={e.has_subtitles ? e.title : '자막이 없어요'}>
                      <input type="checkbox" disabled={!e.has_subtitles} checked={nums.includes(e.number)} onChange={() => toggle(e.number)} />
                      {e.number}화{!e.has_subtitles ? ' · 자막 없음' : ''}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {missing > 0 && (
              <small className="muted">
                자막이 없는 회차 {missing}개는 고를 수 없어요.{' '}
                <button type="button" className="text-link" onClick={() => navigate('studio/contents')}>
                  내 작품에서 AI 자막 만들기
                </button>
              </small>
            )}
            <button
              type="button"
              className="primary full"
              disabled={!nums.length || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api<{ id: string }>('/studio/ai/reverse', 'POST', { dramaId: pick, numbers: nums });
                  notify('자막을 가져왔어요. ‘자막으로 대본 복원’을 눌러 대본을 되살려 보세요.');
                  opened(r.id);
                } catch (e) {
                  notify((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Film size={15} /> {nums.length ? `${nums.length}개 회차로 새 프로젝트 만들기` : '회차를 골라 주세요'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
