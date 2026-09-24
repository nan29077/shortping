import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../../api';
import { Section, type TabId, type WS } from './shared';

// 공개 전 품질 점검: 합성·검수 신청 전에 고칠 거리를 모아 보여 주고, 버튼 하나로 고쳐요.
type Fix = { kind: 'ai' | 'edit' | 'compose' | 'tab'; action?: string; cap?: 'text' | 'image' | 'tts' | 'video'; targetId?: string; instruction?: string; code?: string; tab?: TabId; label: string };
type Issue = { level: 'error' | 'warn' | 'info'; code: string; text: string; where: string; episodeId?: string; shotId?: string; fix?: Fix };
type Report = { checked_at: string; summary: { error: number; warn: number; info: number }; issues: Issue[] };
const icon = { error: XCircle, warn: AlertTriangle, info: Info };

export default function QualityCheck({ ws }: { ws: WS }) {
  const pid = ws.data.project.id;
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api<Report>(`/studio/ai/projects/${pid}/check`));
    } catch (e) {
      ws.notify((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  // 작업이 끝나거나 내용이 바뀌면 다시 점검해요.
  const stamp = ws.data.project.updated_at + ':' + ws.data.jobs.filter((j) => j.status === 'succeeded').length + ':' + ws.data.episodes.map((e) => e.status).join(',');
  useEffect(() => {
    const t = setTimeout(() => void load(), 400);
    return () => clearTimeout(t);
  }, [load, stamp]);
  const fix = async (i: Issue) => {
    const f = i.fix;
    if (!f) return;
    if (f.kind === 'ai' && f.action && f.cap) ws.run(`${i.where} · ${f.label}`, f.action, f.cap, { targetId: f.targetId, instruction: f.instruction });
    else if (f.kind === 'edit' && f.code) {
      if (await ws.act(() => api(`/studio/ai/projects/${pid}/check/fix`, 'POST', { code: f.code, targetId: f.targetId }), `${i.where}: ${f.label}`)) void load();
    } else if (f.kind === 'compose' && f.targetId) void ws.act(() => api(`/studio/ai/projects/${pid}/episodes/${f.targetId}/compose`, 'POST'), `${i.where} 합성을 시작했어요.`);
    else if (f.kind === 'tab' && f.tab) ws.goTab(f.tab);
  };
  const open = (i: Issue) => {
    if (i.episodeId) ws.setEpisodeId(i.episodeId);
    if (i.shotId) ws.setFocus(i.shotId);
    ws.goTab(i.shotId ? 'scene' : i.episodeId ? 'script' : 'plan');
  };
  const list = (report?.issues || []).filter((i) => showInfo || i.level !== 'info');
  const s = report?.summary;
  return (
    <Section
      title="공개 전 점검"
      desc="합성 · 검수 신청 전에 고칠 거리를 찾아 드려요. 무료예요."
      id="quality"
      badge={s ? <i className={'qc-badge ' + (s.error ? 'error' : s.warn ? 'warn' : 'ok')}>{s.error ? `꼭 고칠 것 ${s.error}` : s.warn ? `살펴볼 것 ${s.warn}` : '문제 없음'}</i> : null}
      actions={
        <button type="button" className="secondary compact" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> 다시 점검
        </button>
      }
    >
      {!report ? (
        <p className="muted">점검하는 중…</p>
      ) : !report.issues.length ? (
        <p className="qc-ok">
          <ShieldCheck size={16} /> 고칠 거리가 없어요. 합성하고 검수를 신청해도 좋아요.
        </p>
      ) : (
        <>
          <div className="qc-summary">
            <span className="error">꼭 고칠 것 {s!.error}</span>
            <span className="warn">살펴볼 것 {s!.warn}</span>
            <button type="button" className={'chip' + (showInfo ? ' active' : '')} onClick={() => setShowInfo(!showInfo)}>
              참고 {s!.info}
            </button>
          </div>
          {!list.length && (
            <p className="qc-ok">
              <CheckCircle2 size={16} /> 꼭 고칠 것과 살펴볼 것이 없어요.
            </p>
          )}
          <ul className="qc-list">
            {list.map((i, k) => {
              const Icon = icon[i.level];
              return (
                <li key={k} className={i.level}>
                  <Icon size={15} />
                  <div>
                    <b>{i.where}</b>
                    <span>{i.text}</span>
                  </div>
                  <div className="qc-actions">
                    {(i.episodeId || i.shotId) && (
                      <button type="button" className="text-link" onClick={() => open(i)}>
                        보기
                      </button>
                    )}
                    {i.fix && (
                      <button type="button" className="secondary compact" disabled={ws.busy} onClick={() => void fix(i)}>
                        {i.fix.label}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}
