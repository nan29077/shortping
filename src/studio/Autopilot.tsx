import { useEffect, useState } from 'react';
import { Bot, Loader2, Pause, Play, Rocket, Square } from 'lucide-react';
import { api, lama, won, type AiModelOption, type AutopilotEstimate, type StudioProjectDetail } from '../api';
import { ModelPicker, OptionRow, effectiveChoices, type Choices } from './parts';

const stageName: Record<string, string> = {
  plan: '기획안',
  bible: '설정집',
  season: '시즌 설계',
  cast: '인물 이미지',
  script: '대본',
  board: '스토리보드',
  voice: '대사 음성',
  video: '컷 영상',
  lipsync: '입 모양',
  sfx: '효과음',
  music: '배경음악',
  compose: '회차 합성',
};
const statusName = { running: '진행 중', paused: '일시 멈춤', done: '완료', stopped: '멈춤' } as const;

// 빠른 제작: 비어 있는 단계만 순서대로 채우고, PD가 정한 최대 라마 안에서만 씁니다.
export default function AutopilotPanel({
  data,
  models,
  notify,
  reload,
  goLama,
  compact = false,
}: {
  data: StudioProjectDetail;
  models: AiModelOption[];
  notify: (s: string) => void;
  reload: () => Promise<void>;
  goLama: () => void;
  compact?: boolean;
}) {
  const ap = data.autopilot;
  const running = ap?.status === 'running';
  const [open, setOpen] = useState(!compact);
  const [choices, setChoices] = useState<Choices>(() => ({ ...effectiveChoices(), ...((ap?.choices as Partial<Choices>) || {}) }));
  const [includeVideo, setIncludeVideo] = useState(!!ap?.includeVideo);
  const has = (c: string) => models.some((m) => m.capability === c);
  const [extra, setExtra] = useState({
    includeBible: ap ? !!ap.includeBible : true,
    includeLipsync: !!ap?.includeLipsync,
    includeSfx: !!ap?.includeSfx,
    includeMusic: !!ap?.includeMusic,
    musicMood: ap?.musicMood || data.project.tone || '',
  });
  // 모델이 준비되지 않은 기능은 끄고 보냅니다.
  const opts = {
    ...extra,
    includeLipsync: extra.includeLipsync && includeVideo && has('lipsync'),
    includeSfx: extra.includeSfx && has('sfx'),
    includeMusic: extra.includeMusic && has('music'),
  };
  const [cap, setCap] = useState('');
  const [est, setEst] = useState<AutopilotEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ choices, includeVideo, ...opts, ...(cap ? { cap: Number(cap) } : {}) });
  // 설정이 바뀌면 예상 비용을 다시 계산합니다.
  useEffect(() => {
    if (!open || running) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await api<AutopilotEstimate>(`/studio/ai/projects/${data.project.id}/autopilot/estimate`, 'POST', { choices, includeVideo, ...opts });
        if (alive) setEst(r);
      } catch (e) {
        if (alive) notify((e as Error).message);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, running, choices, includeVideo, JSON.stringify(opts), data.project.id, data.project.updated_at, data.characters.length, data.episodes]);
  const suggested = est ? Math.ceil(est.total * 1.3) + 10 : 0;
  const lacking = !!est && est.wallet.total < Math.min(cap ? Number(cap) : suggested, est.total);
  const start = async () => {
    setBusy(true);
    try {
      await api(`/studio/ai/projects/${data.project.id}/autopilot`, 'POST', body());
      notify('빠른 제작을 시작했어요. 화면을 닫아도 계속 진행돼요.');
      await reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api(`/studio/ai/projects/${data.project.id}/autopilot/stop`, 'POST');
      notify('빠른 제작을 멈췄어요.');
      await reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stages = Object.keys(stageName).filter(
    (s) =>
      (!['bible', 'season'].includes(s) || ap?.includeBible) &&
      (s !== 'video' || ap?.includeVideo) &&
      (s !== 'lipsync' || (ap?.includeVideo && ap?.includeLipsync)) &&
      (s !== 'sfx' || ap?.includeSfx) &&
      (s !== 'music' || ap?.includeMusic),
  );
  const at = ap ? stages.indexOf(ap.stage) : -1;
  return (
    <section className={'management-panel autopilot-card' + (running ? ' running' : '')}>
      <div className="panel-heading">
        <div>
          <h3>
            <Bot size={18} /> 빠른 제작
            {ap && <span className={'status-chip ' + (ap.status === 'running' ? '' : 'neutral')}>{statusName[ap.status]}</span>}
          </h3>
          <p>버튼 한 번으로 기획부터 회차 합성까지 비어 있는 단계만 차례로 채워요. 정한 라마를 넘으면 스스로 멈춰요.</p>
        </div>
        {compact && !running && (
          <button className="secondary compact" onClick={() => setOpen(!open)}>
            {open ? '접기' : '설정 열기'}
          </button>
        )}
      </div>
      {ap && (
        <div className={'autopilot-status ' + ap.status}>
          <ol className="autopilot-stages">
            {stages.map((s, i) => (
              <li key={s} className={ap.status === 'done' || i < at ? 'done' : i === at ? 'now' : ''}>
                {i === at && running ? <Loader2 size={12} className="spin" /> : null}
                {stageName[s]}
              </li>
            ))}
          </ol>
          <p>
            {ap.message}
            {typeof ap.spent === 'number' && (
              <small>
                {' '}
                · 사용 {lama(ap.spent)} / 최대 {lama(ap.cap)}
              </small>
            )}
          </p>
          {running && (
            <div className="autopilot-meter" aria-hidden="true">
              <i style={{ width: `${Math.min(100, ((ap.spent || 0) / Math.max(1, ap.cap)) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {running ? (
        <div className="form-actions start">
          <button className="secondary" disabled={busy} onClick={() => void stop()}>
            <Square size={14} /> 빠른 제작 멈추기
          </button>
          <small className="muted">대기 중인 작업은 취소하고 라마를 돌려드려요.</small>
        </div>
      ) : (
        open && (
          <>
            <div className="picker-bar">
              {(
                [
                  'text',
                  'image',
                  'tts',
                  ...(includeVideo ? ['video'] : []),
                  ...(opts.includeLipsync ? ['lipsync'] : []),
                  ...(opts.includeSfx ? ['sfx'] : []),
                  ...(opts.includeMusic ? ['music'] : []),
                ] as (keyof Choices)[]
              ).map((c) => (
                <ModelPicker key={c} capability={c} models={models} value={choices[c]} onChange={(v) => setChoices({ ...choices, [c]: v })} />
              ))}
            </div>
            <div className="opt-list">
              <OptionRow checked={extra.includeBible} onChange={(v) => setExtra({ ...extra, includeBible: v })} title="설정집 · 시즌 설계 먼저" desc="회차끼리 이야기가 잘 이어져요." />
              <OptionRow checked={includeVideo} onChange={setIncludeVideo} title="컷 영상까지 만들기" desc="비용이 커요. 끄면 이미지에 카메라 움직임을 넣어 무료로 합성해요." />
              <OptionRow
                checked={opts.includeLipsync}
                disabled={!has('lipsync') || !includeVideo}
                onChange={(v) => setExtra({ ...extra, includeLipsync: v })}
                title={'입 모양 맞추기' + (has('lipsync') ? '' : ' (준비 중)')}
                desc={has('lipsync') ? '컷 영상을 만들 때만 쓸 수 있어요.' : '관리자가 모델을 준비하면 쓸 수 있어요.'}
              />
              <OptionRow checked={opts.includeSfx} disabled={!has('sfx')} onChange={(v) => setExtra({ ...extra, includeSfx: v })} title={'효과음' + (has('sfx') ? '' : ' (준비 중)')} desc="장면에 맞는 소리를 더해요." />
              <OptionRow checked={opts.includeMusic} disabled={!has('music')} onChange={(v) => setExtra({ ...extra, includeMusic: v })} title={'배경음악' + (has('music') ? '' : ' (준비 중)')} desc="작품 분위기에 맞는 음악을 깔아요." />
            </div>
            <div className="form-columns">
              {opts.includeMusic && (
                <label>
                  음악 분위기
                  <input value={extra.musicMood} maxLength={200} placeholder="예: 설레는 피아노" onChange={(e) => setExtra({ ...extra, musicMood: e.target.value })} />
                </label>
              )}
              <label>
                최대 사용 라마
                <input type="number" min={1} value={cap} placeholder={suggested ? `추천 ${suggested.toLocaleString('ko-KR')}` : '자동'} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} />
              </label>
            </div>
            {est ? (
              <table className="estimate-table">
                <tbody>
                  {est.stages.map((s) => (
                    <tr key={s.stage} className={s.count ? '' : 'muted'}>
                      <td>{s.label}</td>
                      <td>{s.count ? `${s.count}${s.stage === 'video' ? '' : '건'}` : '완료'}</td>
                      <td>{s.lama === null ? <span className="danger">모델 없음</span> : s.lama ? lama(s.lama) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>예상 합계</td>
                    <td />
                    <td className="lime">
                      {lama(est.total)} <small>≈ {won(est.total * 10)}</small>
                    </td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <p className="muted">
                <Loader2 size={13} className="spin" /> 예상 비용을 계산하는 중…
              </p>
            )}
            {!!est?.unavailable.length && <p className="danger settings-note">연결된 모델이 없는 단계가 있어요: {est.unavailable.join(', ')}</p>}
            <div className="form-actions start">
              {lacking ? (
                <button className="primary" onClick={goLama}>
                  라마 충전하러 가기 (보유 {lama(est!.wallet.total)})
                </button>
              ) : (
                <button className="primary" disabled={busy || !est || !!est.unavailable.length} onClick={() => void start()}>
                  {ap?.status === 'paused' || ap?.status === 'stopped' ? <Play size={15} /> : <Rocket size={15} />}
                  {ap?.status === 'paused' || ap?.status === 'stopped' ? ' 이어서 빠른 제작' : ' 빠른 제작 시작'}
                </button>
              )}
              {ap?.status === 'paused' && (
                <small className="muted">
                  <Pause size={12} /> 멈춘 이유를 확인하고, 필요하면 최대 라마를 늘려 이어서 진행하세요.
                </small>
              )}
            </div>
          </>
        )
      )}
    </section>
  );
}
