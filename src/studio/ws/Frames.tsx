import { useMemo, useState } from 'react';
import { ArrowRight, ImagePlus, Link2, X } from 'lucide-react';
import { api, type StudioShot } from '../../api';
import { asset } from '../../platform';
import { isBusy } from '../parts';
import { END_FRAME } from './Direction';
import { useFocusTrap, type WS } from './shared';

// 시작 · 끝 장면(2026-09-29, 힉스필드 벤치마킹 1단계)
// - 시작: 컷 이미지가 영상의 첫 장면이에요. '앞 컷에서 이어받기'를 누르면 앞 컷 영상의 마지막 장면이 이 컷의 시작이 돼요(무료).
// - 끝: 영상이 어느 장면으로 끝날지 정해요. 다음 컷의 첫 장면, 또는 프로젝트 이미지 중에서 골라요(지원하는 모델만).
export type FrameValue = { end_frame: boolean; end_image: string };

export function FramesPanel({ ws, s, prev, next, index, value, set }: { ws: WS; s: StudioShot; prev?: StudioShot; next?: StudioShot; index: number; value: FrameValue; set: (v: FrameValue) => void }) {
  const [picking, setPicking] = useState(false);
  const jobs = ws.data.jobs;
  const prevClip = prev?.lipsync || prev?.video;
  const busy = isBusy(jobs, s.id, 'shot_image') || isBusy(jobs, s.id, 'shot_image_edit') || isBusy(jobs, s.id, 'shot_upscale');
  const mode = value.end_image ? 'pick' : value.end_frame ? 'next' : 'free';
  const endUrl = value.end_image || (value.end_frame ? next?.image || '' : '');
  const family = ws.mode === 'manual' && ws.choices.video.requested !== 'auto' ? ws.models.find((m) => m.id === ws.choices.video.requested)?.family : null;
  const weak = mode !== 'free' && !!family && !END_FRAME.includes(family);
  // 마지막 영상 작업이 끝 장면을 따르지 않는 모델로 만들어졌으면 알려요(자동 선택에서 지원 모델이 없을 때 등).
  const lastVideo = jobs.find((j) => j.target_id === s.id && j.kind === 'shot_video' && j.status !== 'failed' && j.status !== 'canceled');
  const ignored = mode !== 'free' && !!lastVideo && String(lastVideo.flags || '').includes('end_ignored');
  const continueFromPrev = () =>
    void ws.act(async () => {
      await api(`/studio/ai/shots/${s.id}/continue`, 'POST');
    }, `${index}번 컷 영상의 마지막 장면을 이 컷의 시작으로 가져왔어요. 이전 이미지는 버전 기록에 있어요.`);
  return (
    <div className="fr-panel" aria-label="시작 · 끝 장면">
      <div className="fr-slots">
        <div className="fr-slot">
          <span className="fr-cap">여기서 시작</span>
          <span className="fr-thumb">{s.image ? <img src={asset(s.image)} alt="시작 장면(컷 이미지)" /> : <em>컷 이미지</em>}</span>
          {index > 0 && (
            <button
              type="button"
              className="secondary compact"
              disabled={!prevClip || busy}
              title={prevClip ? '앞 컷 영상의 마지막 장면을 이 컷의 시작 이미지로 써요(무료)' : '앞 컷 영상을 먼저 만들어 주세요'}
              onClick={continueFromPrev}
            >
              <Link2 size={12} /> 앞 컷에서 이어받기
            </button>
          )}
        </div>
        <ArrowRight size={14} className="fr-arrow" aria-hidden="true" />
        <div className="fr-slot">
          <span className="fr-cap">여기서 끝</span>
          <span className={'fr-thumb' + (endUrl ? '' : ' empty')}>
            {endUrl ? (
              mode === 'pick' ? (
                <button type="button" className="fr-repick" title="다른 이미지 고르기" onClick={() => setPicking(true)}>
                  <img src={asset(endUrl)} alt="끝 장면(눌러서 바꾸기)" />
                </button>
              ) : (
                <img src={asset(endUrl)} alt="끝 장면" />
              )
            ) : (
              <em>{mode === 'next' ? '다음 컷 이미지 없음' : '자유롭게'}</em>
            )}
            {value.end_image && (
              <button type="button" className="fr-clear" aria-label="끝 장면 지우기" onClick={() => set({ end_frame: false, end_image: '' })}>
                <X size={11} />
              </button>
            )}
          </span>
          <select
            aria-label="끝 장면 정하기"
            value={mode}
            onChange={(ev) => {
              const v = ev.target.value;
              if (v === 'pick') setPicking(true);
              else set({ end_frame: v === 'next', end_image: '' });
            }}
          >
            <option value="free">자유롭게</option>
            {next && (
              <option value="next" disabled={!next.image}>
                다음 컷 첫 장면{next.image ? '' : ' (이미지 필요)'}
              </option>
            )}
            <option value="pick">이미지 고르기</option>
          </select>
        </div>
      </div>
      <small className={'fr-note' + (weak || ignored ? ' warn' : '')}>
        {ignored
          ? `최근 영상은 끝 장면 지정을 따르지 않는 모델(${lastVideo?.model_label || '다른 모델'})로 만들어져 끝 장면이 다를 수 있어요. 지원 모델(Veo·Kling·Seedance)을 연결하거나 골라 다시 만들어 보세요.`
          : weak
          ? '지금 고른 영상 모델은 끝 장면 지정을 무시할 수 있어요. 모델을 ‘자동’으로 두면 지원하는 모델(Veo·Kling·Seedance)을 먼저 골라요.'
          : mode === 'free'
            ? '끝 장면을 정하면 컷과 컷이 한 호흡으로 이어져요.'
            : '끝 장면은 Veo·Kling·Seedance가 따라요. 자동 선택이 이 모델들을 먼저 골라요.'}
      </small>
      {picking && (
        <FramePicker
          ws={ws}
          exclude={s.image}
          close={() => setPicking(false)}
          pick={(url) => {
            set({ end_frame: false, end_image: url });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

// 프로젝트 이미지(컷 · 장소 · 인물 참고 · 소품) 중에서 끝 장면 고르기
function FramePicker({ ws, exclude, close, pick }: { ws: WS; exclude: string; close: () => void; pick: (url: string) => void }) {
  const groups = useMemo(() => {
    const d = ws.data;
    const shots = d.episodes.flatMap((e) => e.shots.map((x, i) => ({ url: x.image, label: `${e.number}화 ${i + 1}번 컷` })));
    const places = (d.locations || []).map((l) => ({ url: l.image, label: l.name }));
    const people = d.characters.flatMap((c) => [{ url: c.image, label: c.name }]);
    const things = (d.props || []).map((x) => ({ url: x.image, label: x.name }));
    // 서버가 받는 형식(이 프로젝트에서 만든 /uploads 이미지)만 보여 줘요.
    const clean = (list: { url: string; label: string }[]) => list.filter((x, i, a) => /^\/uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(x.url || '') && x.url !== exclude && a.findIndex((y) => y.url === x.url) === i);
    return [
      { name: '컷 이미지', list: clean(shots) },
      { name: '장소', list: clean(places) },
      { name: '인물', list: clean(people) },
      { name: '소품', list: clean(things) },
    ].filter((g) => g.list.length);
  }, [ws.data, exclude]);
  const trap = useFocusTrap<HTMLDivElement>();
  return (
    <div ref={trap} className="ws-overlay" role="dialog" aria-modal="true" aria-label="끝 장면 고르기" onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="ws-overlay-inner fr-picker">
        <div className="fr-picker-head">
          <strong>
            <ImagePlus size={14} /> 영상이 끝날 장면 고르기
          </strong>
          <button type="button" className="icon-button" aria-label="닫기" autoFocus onClick={close}>
            <X size={16} />
          </button>
        </div>
        {!groups.length && <p className="muted">고를 수 있는 이미지가 아직 없어요. 다른 컷이나 장소 이미지를 먼저 만들어 주세요.</p>}
        {groups.map((g) => (
          <section key={g.name}>
            <h4>{g.name}</h4>
            <div className="fr-grid">
              {g.list.map((x) => (
                <button type="button" key={x.url} className="fr-item" onClick={() => pick(x.url)}>
                  <img src={asset(x.url)} alt="" loading="lazy" />
                  <small>{x.label}</small>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
