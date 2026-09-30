// 시청자(공개) 화면에 보내는 작품 칸. 심사 의견(review_note)·소유자 ID·권리 신고 내역·판매 원가 같은
// 내부 칸은 공개 목록에 싣지 않습니다. 새 칸을 시청자 화면에 쓰려면 여기에 더해 주세요.
const PUBLIC_DRAMA_FIELDS = [
  'id',
  'channel_id',
  'channel_name',
  'channel_slug',
  'category_id',
  'published_at',
  'created_at',
  'title',
  'tagline',
  'synopsis',
  'genre',
  'image',
  'accent',
  'badge',
  'status',
  'free',
  'episode_pings',
  'free_episodes',
  'views',
  'episode_count',
  'ai_usage',
  'trailer',
  'hashtags',
  'subtitle_style',
  'thumb_id',
];
export function publicDrama(d) {
  if (!d) return d;
  const out = {};
  for (const k of PUBLIC_DRAMA_FIELDS) if (k in d) out[k] = d[k];
  // AI 기본법 표시: PD 자가 신고 또는 스튜디오 제작 회차가 있으면 표시(원래 칸 대신 결과만 보냄)
  out.ai_label = Boolean(d.ai_usage && d.ai_usage !== 'none') || Number(d.studio_episodes || 0) > 0;
  return out;
}
// 방송국 공개 정보: 운영용 칸(관리자 숨김 표시·소유자 ID)은 뺍니다.
export function publicChannel(c) {
  if (!c) return c;
  const { admin_hidden, owner_id, ...rest } = c;
  return rest;
}
