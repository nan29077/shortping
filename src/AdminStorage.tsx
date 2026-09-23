import { useCallback, useEffect, useState } from 'react';
import { Clock3, FileX2, HardDrive, ShieldCheck, Trash2 } from 'lucide-react';
import { api, moment } from './api';
import { Empty, Modal } from './App';

// 최고 관리자 · 저장 공간 정리
// 어디에서도 쓰지 않는 업로드 파일(고르지 않은 포스터 후보, 저장하지 않은 배너 등)을
// 보관 기간이 지나면 자동으로 지웁니다. 보관 기간은 여기서 정하고, 0이면 자동 정리를 끕니다.
type Storage = {
  retention_days: number;
  default_days: number;
  total_files: number;
  candidates: {
    count: number;
    bytes: number;
    sampled: number;
    sample: { url: string; mime: string; created_at: string }[];
  };
  last_sweep: { at: string; deleted: number; days: number; by: 'manual' | 'auto' } | null;
  checked_places: number;
};
const n = (v: unknown) => Number(v) || 0;
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toFixed(2) + 'GB'
    : bytes >= 1024 ** 2
      ? (bytes / 1024 ** 2).toFixed(1) + 'MB'
      : Math.round(bytes / 1024) + 'KB';
const kindOf = (mime: string) =>
  mime.startsWith('image/') ? '이미지' : mime.startsWith('video/') ? '영상' : mime.startsWith('audio/') ? '음성' : '파일';

export default function AdminStorage({ notify }: { notify: (s: string) => void }) {
  const [data, setData] = useState<Storage | null>(null),
    [error, setError] = useState(''),
    [days, setDays] = useState(''),
    [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await api<Storage>('/admin/storage');
      setData(r);
      setDays(String(r.retention_days));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <Empty title="저장 공간 정보를 불러오지 못했어요" text={error} action={() => void load()} label="다시 시도" />;
  if (!data)
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    );
  const value = Number(days);
  const valid = days.trim() !== '' && Number.isInteger(value) && (value === 0 || (value >= 7 && value <= 3650));
  const changed = valid && value !== data.retention_days;
  const save = async (next: number) => {
    setBusy(true);
    try {
      await api('/admin/settings', 'PUT', { media_retention_days: next });
      notify(next === 0 ? '자동 정리를 껐어요.' : `보관 기간을 ${next}일로 저장했어요.`);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cleanup = async () => {
    setBusy(true);
    try {
      const r = await api<{ deleted: number }>('/admin/storage/cleanup', 'POST');
      notify(r.deleted ? `쓰이지 않는 파일 ${r.deleted.toLocaleString('ko-KR')}개를 정리했어요.` : '정리할 파일이 없어요.');
      setConfirming(false);
      await load();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const c = data.candidates;
  const off = data.retention_days === 0;
  return (
    <div className="management-layout">
      <div className="stats-grid">
        <div className="stat-card">
          <div>
            <Clock3 size={18} />
            <span>보관 기간</span>
          </div>
          <strong>{off ? '자동 정리 꺼짐' : `${data.retention_days}일`}</strong>
          <small>기본값 {data.default_days}일</small>
        </div>
        <div className="stat-card">
          <div>
            <HardDrive size={18} />
            <span>등록된 업로드 파일</span>
          </div>
          <strong>{n(data.total_files).toLocaleString('ko-KR')}개</strong>
          <small>영상 · 이미지 · 음성 전체</small>
        </div>
        <div className="stat-card">
          <div>
            <FileX2 size={18} />
            <span>지금 정리 대상</span>
          </div>
          <strong>{off ? '-' : `${n(c.count).toLocaleString('ko-KR')}개`}</strong>
          <small>
            {off
              ? '보관 기간을 정하면 계산해요'
              : `약 ${size(n(c.bytes))}${n(c.count) > n(c.sampled) ? ` (오래된 ${n(c.sampled)}개 기준)` : ''}`}
          </small>
        </div>
        <div className="stat-card">
          <div>
            <Trash2 size={18} />
            <span>마지막 정리</span>
          </div>
          <strong>{data.last_sweep ? `${n(data.last_sweep.deleted).toLocaleString('ko-KR')}개 삭제` : '기록 없음'}</strong>
          <small>
            {data.last_sweep
              ? `${moment(data.last_sweep.at)} · ${data.last_sweep.by === 'manual' ? '직접 실행' : '자동'}`
              : '서버를 켠 뒤 아직 정리하지 않았어요'}
          </small>
        </div>
      </div>

      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>미사용 파일 보관 기간</h3>
            <p>
              어디에서도 쓰지 않는 업로드 파일을 만든 날로부터 며칠 동안 보관할지 정해요. 기간이 지나면 하루에 한 번 자동으로
              지워요.
            </p>
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save(value);
          }}
        >
          <div className="form-columns">
            <label>
              보관 기간 (일)
              <input
                type="number"
                min={0}
                max={3650}
                step={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={!valid || undefined}
                required
              />
              <small className={valid ? 'muted' : 'danger'}>
                {valid ? '0을 넣으면 자동 정리를 꺼요.' : '0(끄기) 또는 7~3650 사이의 정수로 입력해 주세요.'}
              </small>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy || data.retention_days === data.default_days} onClick={() => void save(data.default_days)}>
              기본값({data.default_days}일)으로
            </button>
            <button className="primary" disabled={busy || !changed}>
              저장
            </button>
          </div>
        </form>
        <div className="info-box">
          <ShieldCheck size={15} /> 지우기 전에 {data.checked_places}곳(프로필 사진, 작품 포스터, 회차 영상, 방송국 배너·로고, AI
          스튜디오의 포스터·인물·컷·회차·결과 기록, 업로드 기록, 진행 중인 AI 작업)에서 쓰이는지 확인하고, 한 곳이라도 쓰고 있으면
          지우지 않아요. 지운 파일은 되돌릴 수 없어요.
        </div>
      </section>

      <section className="management-panel">
        <div className="panel-heading">
          <div>
            <h3>정리 대상 미리보기</h3>
            <p>{off ? '자동 정리가 꺼져 있어요.' : `만든 지 ${data.retention_days}일이 지났고 어디에서도 쓰지 않는 파일이에요. 오래된 순으로 20개까지 보여 줘요.`}</p>
          </div>
          <button className="secondary compact" disabled={busy || off || !n(c.count)} onClick={() => setConfirming(true)}>
            <Trash2 size={14} /> 지금 정리하기
          </button>
        </div>
        {!off && c.sample.length ? (
          <div className="table-scroll">
            <table className="management-table">
              <thead>
                <tr>
                  <th>파일</th>
                  <th>종류</th>
                  <th>만든 날</th>
                </tr>
              </thead>
              <tbody>
                {c.sample.map((f) => (
                  <tr key={f.url}>
                    <td className="storage-file">{f.url.replace('/uploads/', '')}</td>
                    <td>{kindOf(f.mime)}</td>
                    <td className="nowrap">{moment(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{off ? '보관 기간을 정하면 정리 대상을 보여 드려요.' : '지금 정리할 파일이 없어요.'}</p>
        )}
      </section>

      {confirming && (
        <Modal title="쓰이지 않는 파일 정리" close={() => !busy && setConfirming(false)}>
          <p className="modal-text">
            만든 지 {data.retention_days}일이 지났고 어디에서도 쓰지 않는 파일 {n(c.count).toLocaleString('ko-KR')}개를 지금 지울까요? 지운
            파일은 되돌릴 수 없어요.
          </p>
          <button className="primary full" disabled={busy} onClick={() => void cleanup()}>
            {busy ? '정리하는 중…' : '정리하기'}
          </button>
        </Modal>
      )}
    </div>
  );
}
