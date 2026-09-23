import { useEffect, useMemo, useState } from 'react';
import { Clapperboard, Eye, Film, ImageIcon, LayoutTemplate, Megaphone, Send, Sparkles, Tags, Trash2, Wand2 } from 'lucide-react';
import { api, jobKindLabel, lama, parseJson, studioMedia, won, type StudioEpisode } from '../../api';
import { navigate } from '../../App';
import { useSyncedForm } from '../hooks';
import { JobBadge, Versions, isBusy } from '../parts';
import ThumbStudio from '../ThumbStudio';
import CardMaker from '../CardMaker';
import { ModelSettings, Section, episodeStatus, epLabel, runningCount, type WS } from './shared';
import { asset } from '../../platform';

type Meta = { titles: string[]; tagline: string; synopsis: string; hashtags: string[]; episode_titles: { number: number; title: string }[]; at?: string };
const dramaStatus: Record<string, string> = { draft: '임시저장', pending: '심사 대기', published: '공개 중', rejected: '반려', hidden: '노출 중단' };
type Overlay =
  | { kind: 'poster' }
  | { kind: 'episode-thumb'; e: StudioEpisode }
  | { kind: 'card'; which: 'intro' | 'outro'; e: StudioEpisode }
  | null;

export default function FinishTab({ ws }: { ws: WS }) {
  const { data } = ws;
  const p = data.project;
  const [overlay, setOverlay] = useState<Overlay>(null);
  // 썸네일 A/B 비교 후보(대표 포스터 외 최대 3장). 이 화면에서 만든 썸네일도 후보에 더해요.
  const [variants, setVariants] = useState<string[]>([]);
  const [made, setMade] = useState<string[]>([]);
  const meta = parseJson<Meta | null>(p.meta, null);
  // 썸네일 · 카드 만들기 창: Esc(안드로이드 뒤로 가기)로 닫기. 확인 창이 떠 있으면 확인 창이 먼저 닫혀요.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !document.querySelector('.modal-backdrop')) setOverlay(null);
    };
    document.addEventListener('keydown', onKey);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = old;
    };
  }, [overlay]);
  const backgrounds = useMemo(() => {
    const list: { url: string; label: string }[] = [];
    const add = (url: string, label: string) => url && !list.some((x) => x.url === url) && list.push({ url, label });
    if (p.poster) add(p.poster, '대표 포스터');
    data.assets.filter((a) => a.kind === 'thumb_bg').forEach((a, i) => add(a.url, `AI 배경 ${i + 1}`));
    data.assets.filter((a) => a.target_type === 'project' && a.kind === 'image').forEach((a, i) => add(a.url, `AI 포스터 ${i + 1}`));
    data.characters.forEach((c) => add(c.image, c.name));
    data.episodes.forEach((e) => e.shots.forEach((s, i) => add(s.image, `${e.number}화 ${i + 1}번 컷`)));
    return list.slice(0, 40);
  }, [data, p.poster]);
  return (
    <>
      <ComposeSection ws={ws} open={setOverlay} />
      <TrailerSection ws={ws} />
      <PosterSection ws={ws} backgrounds={backgrounds} made={made} variants={variants} setVariants={setVariants} openStudio={() => setOverlay({ kind: 'poster' })} />
      <MetaSection ws={ws} meta={meta} />
      <ExportSection ws={ws} meta={meta} variants={variants} />
      <CostSection ws={ws} />
      {overlay && (
        <div className="ws-overlay" role="dialog" aria-modal="true">
          <div className="ws-overlay-inner">
            {overlay.kind === 'poster' && (
              <ThumbStudio
                title={p.title}
                genre={p.genre}
                tagline={meta?.tagline || p.logline}
                backgrounds={backgrounds}
                notify={ws.notify}
                close={() => setOverlay(null)}
                onSaved={async (r) => {
                  const urls = [r.poster, r.square, r.wide].filter(Boolean) as string[];
                  setMade((cur) => [...new Set([...urls, ...cur])]);
                  if (r.poster && (await ws.ask({ title: '대표 포스터로 쓸까요?', text: '방금 만든 세로 썸네일을 작품 대표 포스터로 바꿔요. 아니면 A/B 비교 후보로만 남겨요.', ok: '대표로 쓰기' })))
                    await ws.act(() => api(`/studio/ai/projects/${p.id}/poster`, 'PUT', { image: r.poster }), '대표 포스터로 정했어요.');
                  setOverlay(null);
                }}
              />
            )}
            {overlay.kind === 'episode-thumb' && (
              <ThumbStudio
                title={p.title}
                genre={p.genre}
                tagline={overlay.e.title}
                episodeLabel={`${overlay.e.number}화`}
                backgrounds={[...overlay.e.shots.filter((s) => s.image).map((s, i) => ({ url: s.image, label: `${i + 1}번 컷` })), ...backgrounds].filter((x, i, a) => a.findIndex((y) => y.url === x.url) === i)}
                notify={ws.notify}
                close={() => setOverlay(null)}
                onSaved={async (r) => {
                  const url = r.poster || r.square || r.wide;
                  if (url) await ws.act(() => api(`/studio/ai/projects/${p.id}/episodes/${overlay.e.id}`, 'PATCH', { thumbnail: url }), `${overlay.e.number}화 썸네일을 정했어요.`);
                  setOverlay(null);
                }}
              />
            )}
            {overlay.kind === 'card' && (
              <CardMaker
                kind={overlay.which}
                title={p.title}
                episodeNumber={overlay.e.number}
                episodeTitle={overlay.e.title}
                background={overlay.e.shots.find((s) => s.image)?.image || p.poster || undefined}
                nextHint={overlay.which === 'outro' ? data.episodes.find((x) => x.number === overlay.e.number + 1)?.hook || overlay.e.cliffhanger || '' : undefined}
                notify={ws.notify}
                close={() => setOverlay(null)}
                onSaved={async (url) => {
                  await ws.act(
                    () => api(`/studio/ai/projects/${p.id}/episodes/${overlay.e.id}`, 'PATCH', { [overlay.which === 'intro' ? 'intro_card' : 'outro_card']: url }),
                    `${overlay.e.number}화 ${overlay.which === 'intro' ? '오프닝' : '엔딩'} 카드를 붙였어요. 다시 합성하면 들어가요.`,
                  );
                  setOverlay(null);
                }}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── 회차 합성 ────────────────────────────────────────────────
function ComposeSection({ ws, open }: { ws: WS; open: (o: Overlay) => void }) {
  const p = ws.data.project;
  const all = ws.data.episodes.filter((e) => e.shots.length && e.status !== 'composed' && e.status !== 'composing' && e.shots.every((s) => s.image || s.video || s.lipsync));
  const composeAll = async () => {
    let n = 0;
    for (const e of all) {
      try {
        await api(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`, 'POST');
        n++;
      } catch (err) {
        ws.notify(`${e.number}화: ${(err as Error).message}`);
      }
    }
    await ws.load();
    if (n) ws.notify(`${n}개 회차 합성을 시작했어요.`);
  };
  return (
    <Section
      title="회차 합성"
      desc="컷 영상(없으면 이미지) · 대사 음성 · 효과음 · 배경음악 · 자막을 이어 붙여 세로 MP4 한 편을 만들어요. 라마가 들지 않아요."
      actions={
        <>
          <label className="ws-inline-select">
            화질
            <select value={p.resolution || '720p'} onChange={(ev) => void ws.act(() => api(`/studio/ai/projects/${p.id}/settings`, 'PATCH', { resolution: ev.target.value }), '화질을 바꿨어요. 다시 합성하면 적용돼요.')}>
              <option value="720p">720p (빠름)</option>
              <option value="1080p">1080p (선명)</option>
            </select>
          </label>
          <button className="secondary compact" disabled={!all.length || ws.busy} onClick={() => void composeAll()}>
            <Clapperboard size={14} /> 준비된 회차 모두 합성 {all.length ? `(${all.length})` : ''}
          </button>
        </>
      }
    >
      <div className="ws-compose">
        {ws.data.episodes.map((e) => (
          <ComposeRow key={e.id} ws={ws} e={e} open={open} />
        ))}
      </div>
    </Section>
  );
}
function ComposeRow({ ws, e, open }: { ws: WS; e: StudioEpisode; open: (o: Overlay) => void }) {
  const p = ws.data.project;
  const [info, setInfo] = useState<{ progress: number; queue: number } | null>(null);
  const composing = e.status === 'composing';
  // 합성 중에는 진행률과 대기 순서를 3초마다 봅니다.
  useEffect(() => {
    if (!composing) {
      setInfo(null);
      return;
    }
    let alive = true;
    const tick = () =>
      api<{ progress: number; queue: number }>(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`).then(
        (r) => alive && setInfo({ progress: r.progress, queue: r.queue }),
        () => {},
      );
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [composing, p.id, e.id]);
  const missing = e.shots.findIndex((s) => !s.image && !s.video && !s.lipsync);
  const pending = e.shots.some((s) => ['shot_image', 'shot_tts', 'shot_video', 'shot_lipsync', 'shot_sfx', 'shot_image_edit'].some((k) => isBusy(ws.data.jobs, s.id, k)));
  const ready = e.shots.length > 0 && missing < 0 && !pending;
  const stale = !!e.video && e.status !== 'composed' && !composing;
  const why = !e.shots.length ? '대본이 없어요' : missing >= 0 ? `${missing + 1}번 컷에 이미지가 없어요` : pending ? 'AI 작업이 끝나면 합성할 수 있어요' : '';
  const card = (which: 'intro' | 'outro') => {
    const url = which === 'intro' ? e.intro_card : e.outro_card;
    return url ? (
      <span className="ws-card-thumb">
        <img src={asset(url)} alt={which === 'intro' ? '오프닝 카드' : '엔딩 카드'} />
        <button
          className="icon-button"
          aria-label={`${which === 'intro' ? '오프닝' : '엔딩'} 카드 빼기`}
          onClick={() => void ws.act(() => api(`/studio/ai/projects/${p.id}/episodes/${e.id}`, 'PATCH', { [which === 'intro' ? 'intro_card' : 'outro_card']: '' }), '카드를 뺐어요.')}
        >
          <Trash2 size={11} />
        </button>
      </span>
    ) : (
      <button className="text-link" onClick={() => open({ kind: 'card', which, e })}>
        + {which === 'intro' ? '오프닝' : '엔딩'} 카드
      </button>
    );
  };
  return (
    <article className={'ws-compose-row' + (e.status === 'compose_failed' ? ' failed' : '')}>
      <div className="ws-compose-info">
        <strong>{epLabel(e)}</strong>
        <small>
          컷 {e.shots.length} · 영상 {e.shots.filter((s) => s.video).length} · 음성 {e.shots.filter((s) => s.audio).length} · {episodeStatus[e.status] || e.status}
          {e.duration ? ` · ${e.duration}초` : ''}
          {e.exported_at ? ' · 내보냄' : ''}
        </small>
        {composing && (
          <div className="ws-compose-progress">
            <i style={{ width: `${Math.max(3, info?.progress ?? Number(e.compose_progress || 0))}%` }} />
            <span>{info?.queue ? `앞에 ${info.queue}개 대기 중` : `합성 중 ${Math.round(info?.progress ?? Number(e.compose_progress || 0))}%`}</span>
          </div>
        )}
        {e.status === 'compose_failed' && <small className="danger">합성 실패: {e.compose_error || '원인을 알 수 없어요.'}</small>}
        {stale && <small className="lime">합성한 뒤 내용이 바뀌었어요. 다시 합성해 주세요.</small>}
        {!ready && !composing && why && <small className="muted">{why}</small>}
        <div className="ws-row ws-cards">
          {card('intro')}
          {card('outro')}
          {e.thumbnail ? (
            <span className="ws-card-thumb">
              <img src={asset(e.thumbnail)} alt="회차 썸네일" />
            </span>
          ) : null}
          <button className="text-link" onClick={() => open({ kind: 'episode-thumb', e })}>
            {e.thumbnail ? '썸네일 바꾸기' : '+ 회차 썸네일'}
          </button>
        </div>
      </div>
      {e.video && !composing && (
        <video controls preload="none" playsInline src={studioMedia(e.video)}>
          {e.subtitles && <track kind="subtitles" srcLang="ko" label="한국어" default src={asset(`/api/studio/ai/episodes/${e.id}/subtitles`)} />}
        </video>
      )}
      <div className="ws-compose-actions">
        <button className="secondary compact" disabled={!e.shots.some((s) => s.image || s.video)} onClick={() => ws.preview(e)}>
          <Eye size={13} /> 미리보기
        </button>
        <button
          className="primary compact"
          disabled={ws.busy || !ready || composing}
          onClick={() => void ws.act(() => api(`/studio/ai/projects/${p.id}/episodes/${e.id}/compose`, 'POST'), `${e.number}화 합성을 시작했어요.`)}
        >
          {composing ? '합성 중…' : e.video ? '다시 합성' : '합성하기'}
        </button>
      </div>
    </article>
  );
}

// ── 예고편 ──────────────────────────────────────────────────
function TrailerSection({ ws }: { ws: WS }) {
  const p = ws.data.project;
  const [pick, setPick] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const status = p.trailer_status || '';
  const working = status === 'queued' || status === 'rendering';
  const render = ws.data.renders?.find((r) => r.kind === 'trailer');
  const shots = ws.data.episodes.flatMap((e) => e.shots.map((s, i) => ({ s, label: `${e.number}화 ${i + 1}` }))).filter((x) => x.s.image || x.s.video || x.s.lipsync);
  return (
    <Section
      title="예고편"
      desc="회차마다 가장 강렬한 컷을 모아 15~30초 예고편을 만들어요. 작품 상세 화면에서 시청자가 먼저 볼 수 있어요. 라마가 들지 않아요."
      defaultOpen={!!p.trailer || working}
      actions={
        <button
          className="secondary compact"
          disabled={working || !shots.length || ws.busy}
          onClick={() => void ws.act(() => api(`/studio/ai/projects/${p.id}/trailer`, 'POST', { shotIds: pick }), pick.length ? `고른 ${pick.length}컷으로 예고편을 만들기 시작했어요.` : '예고편을 만들기 시작했어요.')}
        >
          <Megaphone size={14} /> {working ? '만드는 중…' : p.trailer ? '예고편 다시 만들기' : '예고편 만들기'}
        </button>
      }
    >
      {working && (
        <div className="ws-compose-progress">
          <i style={{ width: `${Math.max(3, Number(render?.progress || 0))}%` }} />
          <span>{status === 'queued' ? '대기 중' : `만드는 중 ${Math.round(Number(render?.progress || 0))}%`}</span>
        </div>
      )}
      {status === 'failed' && <p className="danger">예고편을 만들지 못했어요.{render?.error ? ` ${render.error}` : ''} 다시 시도해 주세요.</p>}
      {p.trailer && !working && <video className="ws-trailer" controls preload="none" playsInline src={studioMedia(p.trailer)} />}
      <button type="button" className="text-link" onClick={() => setChoosing(!choosing)}>
        {choosing ? '컷 고르기 닫기' : `넣을 컷 직접 고르기 ${pick.length ? `(${pick.length}/12)` : '(고르지 않으면 자동)'}`}
      </button>
      {choosing && (
        <div className="ws-pick-grid">
          {shots.map(({ s, label }) => {
            const on = pick.includes(s.id);
            return (
              <button
                type="button"
                key={s.id}
                className={on ? 'selected' : ''}
                aria-pressed={on}
                disabled={!on && pick.length >= 12}
                onClick={() => setPick(on ? pick.filter((x) => x !== s.id) : [...pick, s.id])}
              >
                {s.image ? <img src={asset(s.image)} alt="" loading="lazy" /> : <Film size={18} />}
                <small>
                  {on ? `${pick.indexOf(s.id) + 1} · ` : ''}
                  {label}
                </small>
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ── 포스터 · 썸네일 ─────────────────────────────────────────
function PosterSection({
  ws,
  backgrounds,
  made,
  variants,
  setVariants,
  openStudio,
}: {
  ws: WS;
  backgrounds: { url: string; label: string }[];
  made: string[];
  variants: string[];
  setVariants: (v: string[]) => void;
  openStudio: () => void;
}) {
  const p = ws.data.project;
  const bgRunning = runningCount(ws.data.jobs, (j) => j.kind === 'thumb_bg');
  const candidates = [...made.map((url) => ({ url, label: '직접 만든 썸네일' })), ...backgrounds].filter((x, i, a) => a.findIndex((y) => y.url === x.url) === i && /^\/uploads\//.test(x.url));
  const serial = ws.data.drama?.status === 'published';
  return (
    <Section title="포스터 · 썸네일" desc="AI로 포스터와 배경 후보를 만들고, 제목을 올린 썸네일을 직접 꾸며요. 후보를 여러 장 고르면 공개 후 가장 잘 눌리는 이미지를 자동으로 찾아요(A/B 비교).">
      <ModelSettings ws={ws} caps={['image']} />
      <div className="form-actions start">
        <button className="secondary" disabled={isBusy(ws.data.jobs, p.id, 'poster')} onClick={() => ws.run('AI 포스터 만들기', 'poster', 'image')}>
          <Sparkles size={15} /> AI 포스터
        </button>
        <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="poster" />
        <Versions assets={ws.data.assets} targetId={p.id} kind="image" current={p.poster} onUse={ws.useAsset} />
        <button className="secondary" disabled={bgRunning > 0 || !ws.data.characters.length} onClick={() => ws.run('썸네일 배경 후보 4장', 'thumb_bg', 'image', { options: { count: 4, aspect: '9:16' } })}>
          <ImageIcon size={15} /> {bgRunning ? `배경 만드는 중 (${bgRunning})` : '배경 후보 4장'}
        </button>
        <button className="primary" disabled={!backgrounds.length} onClick={openStudio}>
          <LayoutTemplate size={15} /> 썸네일 꾸미기
        </button>
      </div>
      {!candidates.length ? (
        <p className="muted">아직 고를 이미지가 없어요. 인물 · 장면 이미지를 만들거나 AI 포스터를 만들어 보세요.</p>
      ) : (
        <div className="ws-poster-grid">
          {candidates.map((c) => {
            const main = c.url === p.poster;
            const ab = variants.includes(c.url);
            return (
              <figure key={c.url} className={(main ? 'main ' : '') + (ab ? 'ab' : '')}>
                <img src={asset(c.url)} alt={c.label} loading="lazy" />
                <figcaption>
                  <small>{main ? '대표 포스터' : c.label}</small>
                  {!main && (
                    <button className="text-link" disabled={ws.busy} onClick={() => void ws.act(() => api(`/studio/ai/projects/${p.id}/poster`, 'PUT', { image: c.url }), '대표 포스터로 정했어요.')}>
                      대표로
                    </button>
                  )}
                  {!main && !serial && (
                    <label className="inline-check">
                      <input type="checkbox" checked={ab} disabled={!ab && variants.length >= 3} onChange={() => setVariants(ab ? variants.filter((x) => x !== c.url) : [...variants, c.url])} />
                      A/B
                    </label>
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {!!variants.length && <p className="muted settings-note">대표 포스터와 후보 {variants.length}장을 공개 후 비교해요. 작품으로 내보낼 때 함께 등록돼요.</p>}
    </Section>
  );
}

// ── 제목 · 소개 · 해시태그 제안 ───────────────────────────────
function MetaSection({ ws, meta }: { ws: WS; meta: Meta | null }) {
  const p = ws.data.project;
  const [title, setTitle] = useState('');
  const apply = (body: Record<string, unknown>, msg: string) => void ws.act(() => api(`/studio/ai/projects/${p.id}/metadata/apply`, 'POST', body), msg);
  return (
    <Section
      title="제목 · 소개 · 해시태그"
      desc="AI가 시청자가 누르고 싶은 제목 후보 · 한 줄 소개 · 해시태그 · 회차 제목을 제안해요. 고른 내용은 아래 공개 설정에 채워져요."
      defaultOpen={!!meta}
      actions={
        <>
          <button className="secondary compact" disabled={isBusy(ws.data.jobs, p.id, 'metadata') || !ws.data.episodes.some((e) => e.summary.trim())} onClick={() => ws.run('제목 · 소개 · 해시태그 제안', 'metadata', 'text')}>
            <Tags size={14} /> {meta ? 'AI로 다시 제안' : 'AI로 제안받기'}
          </button>
          <JobBadge jobs={ws.data.jobs} targetId={p.id} kind="metadata" />
        </>
      }
    >
      {!meta ? (
        <p className="muted">회차 줄거리를 채운 뒤 제안을 받아 보세요.</p>
      ) : (
        <div className="ws-meta">
          <div className="ws-field">
            <span>제목 후보</span>
            <div className="chip-row">
              {meta.titles.map((t) => (
                <button type="button" key={t} className={'chip' + ((title || p.title) === t ? ' active' : '')} onClick={() => setTitle(t)}>
                  {t}
                </button>
              ))}
            </div>
            {title && title !== p.title && (
              <button className="secondary compact" onClick={() => apply({ title }, `제목을 ‘${title}’(으)로 바꿨어요.`)}>
                이 제목으로 바꾸기
              </button>
            )}
          </div>
          {meta.synopsis && (
            <div className="ws-field">
              <span>작품 소개</span>
              <p>{meta.synopsis}</p>
              <button className="text-link" onClick={() => apply({ synopsis: meta.synopsis }, '작품 소개(줄거리)를 바꿨어요.')}>
                줄거리로 쓰기
              </button>
            </div>
          )}
          {!!meta.episode_titles.length && (
            <div className="ws-field">
              <span>회차 제목</span>
              <ol className="ws-ep-titles">
                {meta.episode_titles.map((t) => (
                  <li key={t.number}>
                    <b>{t.number}화</b> {t.title}
                  </li>
                ))}
              </ol>
              <button className="text-link" onClick={() => apply({ episodeTitles: true }, '회차 제목을 바꿨어요.')}>
                회차 제목 모두 적용
              </button>
            </div>
          )}
        </div>
      )}
      <ModelSettings ws={ws} caps={['text']} />
    </Section>
  );
}

// ── 작품으로 내보내기 · 검수 신청 ───────────────────────────────
const toLocal = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function ExportSection({ ws, meta, variants }: { ws: WS; meta: Meta | null; variants: string[] }) {
  const { data } = ws;
  const p = data.project;
  const drama = data.drama;
  const season = parseJson<{ paywall_from?: number }>(p.season, {});
  const serial = drama?.status === 'published';
  const locked = !!drama && ['pending', 'hidden'].includes(drama.status);
  const composed = data.episodes.filter((e) => e.video);
  const stale = composed.filter((e) => e.status !== 'composed');
  const initial = {
    title: p.title,
    tagline: drama?.tagline || meta?.tagline || p.logline.slice(0, 120),
    synopsis: p.synopsis || p.logline,
    hashtags: (meta?.hashtags || []).join(' '),
    free: !!Number(drama?.free || 0),
    episode_pings: Number(drama?.episode_pings || 0),
    free_episodes: Number(drama?.free_episodes || (season.paywall_from ? Math.max(1, season.paywall_from - 1) : 1)),
    attachTrailer: true,
    publish_at: '',
  };
  const [f, setF] = useSyncedForm(initial);
  const [busy, setBusy] = useState(false);
  // 입력한 공개 설정은 이 기기에 임시로 기억해요(화면을 옮겨도 유지).
  const key = `shortping.export.${p.id}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved) setF((cur) => ({ ...cur, ...saved }));
    } catch {
      // 저장 공간을 쓸 수 없으면 기본값으로 시작해요.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(f));
    } catch {
      // 저장 공간을 쓸 수 없으면 이번 화면에서만 기억해요.
    }
  }, [key, f]);
  const tags = f.hashtags
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean)
    .map((t) => t.slice(0, 30))
    .slice(0, 12);
  const valid = f.tagline.trim().length >= 2 && f.title.trim().length >= 1 && (!f.synopsis.trim() || f.synopsis.trim().length >= 10);
  const go = async (submit: boolean) => {
    if (submit && !(await ws.ask({ title: serial ? '새 회차 검수 신청' : '검수 신청', text: serial ? '새로 합성한 회차만 검수를 받아요. 승인되면(예약했다면 그 시각에) 시청자에게 공개돼요.' : '작품 정보와 합성한 회차를 관리자에게 보내요. 검수 중에는 작품을 고칠 수 없어요.', ok: '검수 신청' })))
      return;
    setBusy(true);
    try {
      const r = await api<{ submitted: boolean; episodes: number; numbers: number[]; serial: boolean }>(`/studio/ai/projects/${p.id}/export`, 'POST', {
        title: f.title.trim(),
        tagline: f.tagline.trim(),
        ...(f.synopsis.trim().length >= 10 ? { synopsis: f.synopsis.trim() } : {}),
        hashtags: tags,
        free: f.free,
        episode_pings: f.episode_pings,
        free_episodes: f.free_episodes,
        variants,
        attachTrailer: f.attachTrailer,
        publish_at: f.publish_at ? new Date(f.publish_at).toISOString() : null,
        submit,
      });
      try {
        sessionStorage.removeItem(key);
      } catch {
        // 무시
      }
      await ws.load();
      const eps = r.numbers.map((n) => n + '화').join(', ');
      ws.notify(r.submitted ? `${eps}를 내보내고 검수를 신청했어요.` : `${eps}를 작품으로 내보냈어요. 내 작품에서 이어서 수정할 수 있어요.`);
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={serial ? '새 회차 공개 (연재)' : '작품으로 내보내기 · 검수 신청'} desc={serial ? '공개 중인 작품에 새 회차를 더해요. 새 회차만 따로 검수를 받고, 원하는 시각에 공개되게 예약할 수 있어요.' : '합성한 회차가 작품의 회차로 등록되고 ‘AI 제작’ 표시가 붙어요. 관리자 검수를 거쳐 공개돼요.'}>
      {drama && (
        <div className="info-box">
          연결된 작품: <b>{drama.title}</b> · {dramaStatus[drama.status] || drama.status}
          {drama.review_note && ` · 검토 의견: ${drama.review_note}`}
          <button className="text-link" onClick={() => navigate('studio/contents')}>
            내 작품에서 보기
          </button>
        </div>
      )}
      <p className="muted settings-note">
        내보낼 회차: {composed.length ? composed.map((e) => `${e.number}화${e.status !== 'composed' ? '(다시 합성 필요)' : ''}`).join(', ') : '없음 · 위에서 회차를 먼저 합성하세요'}
        {' · '}포스터: {p.poster ? '선택됨' : '없으면 첫 인물 이미지를 써요'}
      </p>
      {!!stale.length && <p className="danger settings-note">{stale.map((e) => e.number + '화').join(', ')}는 합성한 뒤 내용이 바뀌었어요. 다시 합성해야 내보낼 수 있어요.</p>}
      {!serial && (
        <>
          <label>
            작품 제목
            <input value={f.title} maxLength={70} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label>
            한 줄 소개
            <input value={f.tagline} maxLength={120} onChange={(e) => setF({ ...f, tagline: e.target.value })} />
          </label>
          <label>
            작품 소개
            <textarea rows={3} maxLength={3000} value={f.synopsis} onChange={(e) => setF({ ...f, synopsis: e.target.value })} />
          </label>
        </>
      )}
      <label>
        해시태그 <small className="muted">띄어쓰기로 구분 · 최대 12개</small>
        <input value={f.hashtags} maxLength={400} placeholder="예: 계약결혼 재벌 반전" onChange={(e) => setF({ ...f, hashtags: e.target.value })} />
      </label>
      {!!tags.length && (
        <div className="chip-row ws-tags">
          {tags.map((t) => (
            <span key={t} className="chip">
              #{t}
            </span>
          ))}
        </div>
      )}
      {!serial && (
        <div className="form-columns">
          <label>
            회차 가격 (핑 · 0이면 기본값)
            <input type="number" min={0} max={1000} value={f.episode_pings} disabled={f.free} onChange={(e) => setF({ ...f, episode_pings: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label>
            무료 회차 수 {season.paywall_from ? <small className="muted">(시즌 설계: {season.paywall_from}화부터 유료)</small> : null}
            <input type="number" min={1} max={50} value={f.free_episodes} onChange={(e) => setF({ ...f, free_episodes: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} />
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={f.free} onChange={(e) => setF({ ...f, free: e.target.checked })} />전 회차 무료
          </label>
        </div>
      )}
      <div className="form-columns">
        <label className="inline-check">
          <input type="checkbox" checked={f.attachTrailer} disabled={!p.trailer} onChange={(e) => setF({ ...f, attachTrailer: e.target.checked })} />
          예고편 함께 올리기{!p.trailer ? ' (예고편 없음)' : ''}
        </label>
        <label>
          공개 예약 <small className="muted">비우면 승인 즉시 공개</small>
          <input type="datetime-local" value={f.publish_at} min={toLocal(new Date(Date.now() + 5 * 60000).toISOString())} onChange={(e) => setF({ ...f, publish_at: e.target.value })} />
        </label>
      </div>
      <div className="form-actions start">
        {!serial && (
          <button className="secondary" disabled={busy || locked || !composed.length || !valid} onClick={() => void go(false)}>
            작품으로 내보내기
          </button>
        )}
        <button className="primary" disabled={busy || locked || !composed.length || !valid} onClick={() => void go(true)}>
          <Send size={15} /> {serial ? '새 회차 검수 신청' : '내보내고 바로 검수 신청'}
        </button>
      </div>
      {locked && <p className="muted settings-note">{drama?.status === 'pending' ? '검수 중이라 다시 내보낼 수 없어요. 결과가 나오면 알림으로 알려 드려요.' : '관리자가 노출을 멈춘 작품이에요. 고객센터로 문의해 주세요.'}</p>}
    </Section>
  );
}

function CostSection({ ws }: { ws: WS }) {
  const { data } = ws;
  return (
    <Section title={`제작 비용 · 총 ${lama(data.spent)}`} desc={`≈ ${won(data.spent * 10)} · 실패한 작업은 전액 돌려드렸어요.`} defaultOpen={false}>
      {data.costs?.length ? (
        <table className="estimate-table">
          <tbody>
            {data.costs.map((c) => (
              <tr key={c.kind}>
                <td>{jobKindLabel[c.kind] || c.kind}</td>
                <td>
                  {c.jobs}건{Number(c.failed) > 0 ? ` · 실패 ${c.failed}(반환)` : ''}
                </td>
                <td>{lama(c.lama)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">아직 AI 작업 기록이 없어요.</p>
      )}
      <button className="text-link" onClick={() => ws.goLama()}>
        <Wand2 size={13} /> 라마 충전 · 사용 내역
      </button>
    </Section>
  );
}
