import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, ChevronRight, Loader2, Plus, Sparkles } from 'lucide-react';
import { api, lama, type AiOverview, type StudioActivity } from '../api';
import { navigate } from '../App';

// 스튜디오 상단: 진행 중인 AI 작업·빠른 제작을 어느 메뉴에서든 보여 줍니다(10초마다 갱신).
export function ActivityChip({ go }: { go: () => void }) {
  const [a, setA] = useState<StudioActivity | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<StudioActivity>('/studio/ai/activity')
        .then((r) => alive && setA(r))
        .catch(() => {});
    void load();
    const t = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!a) return null;
  const autos = a.autopilots.filter((x) => x.status === 'running').length;
  const paused = a.autopilots.filter((x) => x.status === 'paused');
  if (!a.active && !autos && !a.failedLastHour && !paused.length) return null;
  const busy = a.active || autos;
  // 멈춘 빠른 제작이 하나뿐이면 그 프로젝트로 바로 이동합니다.
  const open = () => (!busy && paused.length === 1 ? navigate(`studio/ai/${paused[0].id}`) : go());
  return (
    <button className={'activity-chip' + (!busy && (a.failedLastHour || paused.length) ? ' warn' : '')} onClick={open} title={paused.length ? paused.map((x) => `${x.title}: ${x.message || '멈춤'}`).join('\n') : '숏핑 스튜디오 작업 보기'}>
      {busy ? <Loader2 size={14} className="spin" /> : <AlertTriangle size={14} />}
      {a.active ? `AI 작업 ${a.active}건` : ''}
      {autos ? `${a.active ? ' · ' : ''}빠른 제작 ${autos}개` : ''}
      {paused.length ? `${busy ? ' · ' : ''}빠른 제작 멈춤 ${paused.length}개` : ''}
      {!busy && !paused.length && a.failedLastHour ? `최근 실패 ${a.failedLastHour}건` : ''}
    </button>
  );
}

// PD 대시보드 카드: 최근 프로젝트 진행 상황과 바로가기
export function StudioOverviewCard({ go }: { go: () => void }) {
  const [d, setD] = useState<AiOverview | null>(null);
  useEffect(() => {
    api<AiOverview>('/studio/ai/overview')
      .then(setD)
      .catch(() => {});
  }, []);
  if (!d) return null;
  const recent = d.projects.slice(0, 3);
  return (
    <section className="management-panel studio-ai-card">
      <div className="panel-heading">
        <div>
          <span className="eyebrow lime">SHORTPING STUDIO</span>
          <h3>AI로 숏폼 드라마 만들기</h3>
          <p>아이디어 한 줄이면 기획·대본·스토리보드·음성·합성까지. 보유 라마 {lama(d.wallet.total)}</p>
        </div>
        <button className="primary compact" onClick={go}>
          {recent.length ? <Sparkles size={15} /> : <Plus size={15} />} {recent.length ? '스튜디오 열기' : '첫 작품 만들기'}
        </button>
      </div>
      {recent.length > 0 && (
        <div className="studio-ai-recent">
          {recent.map((p) => {
            const pct = p.episode_total ? Math.round(((p.composed || 0) / p.episode_total) * 100) : 0;
            const running = (p.autopilot || '').includes('"status":"running"');
            return (
              <button key={p.id} onClick={go}>
                <strong>
                  {running && <Bot size={13} className="lime" />} {p.title}
                </strong>
                <small>
                  {p.genre} · 합성 {p.composed}/{p.episode_total} · {lama(p.spent || 0)}
                </small>
                <span className="mini-progress">
                  <i style={{ width: pct + '%' }} />
                </span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
