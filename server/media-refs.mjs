// 업로드 파일이 쓰이는 모든 자리(파일 주소는 m.url). 오래된 미사용 파일 정리와 프로필 사진 교체 때
// 같은 목록으로 '아직 쓰이는 파일인지'를 판단합니다. 새 칸에 업로드 파일을 저장하게 되면 여기에 추가해 주세요.
export const MEDIA_REFERENCES = [
  'SELECT 1 FROM user_profiles WHERE avatar=m.url',
  'SELECT 1 FROM dramas WHERE image=m.url',
  'SELECT 1 FROM episodes WHERE video=m.url',
  'SELECT 1 FROM channels WHERE banner=m.url OR logo=m.url',
  'SELECT 1 FROM studio_projects WHERE poster=m.url',
  'SELECT 1 FROM studio_characters WHERE image=m.url OR voice_sample=m.url',
  'SELECT 1 FROM studio_shots WHERE image=m.url OR audio=m.url OR video=m.url',
  'SELECT 1 FROM studio_episodes WHERE video=m.url',
  'SELECT 1 FROM studio_assets WHERE url=m.url',
  // 분할 업로드 기록은 진행 중일 때만 보호합니다(끝난 업로드 파일은 회차·포스터 등 실제로 쓰인 자리가 지켜 줌).
  "SELECT 1 FROM upload_sessions WHERE url=m.url AND status='open'",
  "SELECT 1 FROM ai_jobs WHERE status IN ('queued','running') AND input LIKE '%' || m.url || '%'",
  // 숏핑 스튜디오 고도화(2026-09-23)에서 생긴 자리: 오프닝/엔딩 카드·회차 썸네일·배경음악·예고편·장소·참고 이미지·입 모양·효과음
  'SELECT 1 FROM studio_episodes WHERE intro_card=m.url OR outro_card=m.url OR thumbnail=m.url OR bgm=m.url',
  'SELECT 1 FROM studio_projects WHERE bgm=m.url OR trailer=m.url',
  'SELECT 1 FROM studio_locations WHERE image=m.url',
  "SELECT 1 FROM studio_characters WHERE refs LIKE '%' || m.url || '%'",
  'SELECT 1 FROM studio_shots WHERE lipsync=m.url OR sfx=m.url',
  'SELECT 1 FROM dramas WHERE trailer=m.url',
  'SELECT 1 FROM episodes WHERE thumbnail=m.url',
  'SELECT 1 FROM drama_thumbnails WHERE url=m.url',
  'SELECT 1 FROM voice_samples WHERE url=m.url',
  // 메인페이지 여백 배경 사진(지금 설정과 되돌리기용 기록)
  "SELECT 1 FROM platform_settings WHERE key='home_style' AND value LIKE '%' || m.url || '%'",
  "SELECT 1 FROM home_history WHERE data LIKE '%' || m.url || '%'",
  // 드라매직 벤치마킹 고도화(2026-09-25): 소품 이미지 · 스타일 잠금 참고 이미지 · 내 자산 라이브러리
  'SELECT 1 FROM studio_props WHERE image=m.url',
  "SELECT 1 FROM studio_projects WHERE style_refs LIKE '%' || m.url || '%'",
  "SELECT 1 FROM studio_library WHERE image=m.url OR data LIKE '%' || m.url || '%'",
  // 힉스필드 벤치마킹 고도화(2026-09-29): 컷 끝 장면 이미지
  'SELECT 1 FROM studio_shots WHERE end_image=m.url',
  // 대본 버전 기록(되돌리기용): 예전 컷 목록(JSON)에 남은 이미지·영상·음성도 지우지 않습니다.
  "SELECT 1 FROM studio_script_versions WHERE shots LIKE '%' || m.url || '%'",
  // AI 품질 시험(관리자): 기준 인물 이미지와 시험 결과(2026-10-01 점검에서 빠진 자리)
  'SELECT 1 FROM ai_benchmarks WHERE ref_image=m.url',
  'SELECT 1 FROM ai_benchmark_runs WHERE result_url=m.url',
  // AI 비서 대화 기록에 남은 결과(이미지·영상 링크)도 지우지 않아요(2026-10-01 재점검).
  "SELECT 1 FROM studio_chat WHERE result LIKE '%' || m.url || '%'",
];
// 주어진 파일 주소가 어딘가에서 쓰이고 있으면 1을 돌려주는 SQL(매개변수는 주소 하나).
export const MEDIA_IN_USE_SQL = `SELECT 1 AS used FROM (SELECT CAST(? AS TEXT) AS url) m WHERE ${MEDIA_REFERENCES.map((q) => `EXISTS (${q})`).join(' OR ')}`;
