// 숏핑 스튜디오 빠른 시작: 장르 템플릿, 영상 스타일, 목소리 예시, 컷 고치기 요청 예시
export type Template = {
  id: string;
  name: string;
  hint: string;
  title: string;
  logline: string;
  genre: string;
  tone: string;
  episode_count: number;
  episode_seconds: number;
  style: string;
};
export const STYLES = [
  {
    id: 'cinematic',
    name: '실사 시네마틱',
    text: 'cinematic Korean drama, photorealistic, soft warm lighting, 35mm lens, shallow depth of field',
  },
  {
    id: 'romance',
    name: '감성 로맨스',
    text: 'dreamy romantic Korean drama, pastel color grading, golden hour backlight, soft focus',
  },
  {
    id: 'noir',
    name: '느와르 · 스릴러',
    text: 'neo-noir Korean thriller, low-key lighting, neon reflections on wet streets, high contrast',
  },
  {
    id: 'sageuk',
    name: '사극',
    text: 'Korean historical drama, hanbok, palace architecture, candlelight, cinematic composition',
  },
  {
    id: 'webtoon',
    name: '웹툰풍',
    text: 'Korean webtoon illustration style, clean line art, vibrant cel shading',
  },
  {
    id: 'anime3d',
    name: '3D 애니메이션',
    text: 'stylized 3D animation, expressive characters, soft global illumination, vibrant colors',
  },
  {
    id: 'medieval',
    name: '중세 판타지',
    text: 'cinematic medieval fantasy, stone castles, enchanted forest, soft volumetric light, detailed costumes',
  },
  {
    id: 'scifi',
    name: '근미래 SF',
    text: 'cinematic near-future science fiction, subtle holographic light, realistic city, blue and amber palette',
  },
];
export const TEMPLATES: Template[] = [
  {
    id: 'contract',
    name: '계약 로맨스',
    hint: '재벌·계약연애·설렘',
    title: '1년짜리 계약 연인',
    logline:
      '빚을 갚기 위해 재벌 3세와 1년짜리 계약 연애를 시작한 그녀, 그런데 계약서에 없는 감정이 생겨 버렸다',
    genre: '로맨스',
    tone: '설렘, 밀당, 달달함',
    episode_count: 10,
    episode_seconds: 60,
    style: STYLES[1].text,
  },
  {
    id: 'revenge',
    name: '복수극',
    hint: '배신·귀환·통쾌함',
    title: '돌아온 딸',
    logline:
      '가족에게 버림받고 모든 것을 잃은 딸이 10년 만에 새로운 얼굴로 돌아와 치밀한 복수를 시작한다',
    genre: '스릴러',
    tone: '긴장감, 통쾌함',
    episode_count: 12,
    episode_seconds: 60,
    style: STYLES[2].text,
  },
  {
    id: 'regression',
    name: '회귀 판타지',
    hint: '회귀·황궁·운명',
    title: '다시 피는 황녀',
    logline:
      '억울하게 죽은 황녀가 열 살 시절로 회귀해, 자신을 죽인 자들의 계획을 하나씩 무너뜨린다',
    genre: '판타지',
    tone: '웅장함, 통쾌함',
    episode_count: 10,
    episode_seconds: 60,
    style: STYLES[3].text,
  },
  {
    id: 'office',
    name: '오피스 코미디',
    hint: '회사·실수·웃음',
    title: '단톡방 대참사',
    logline: '입사 첫 주, 실수로 사장님이 있는 단톡방에 험담을 보낸 신입사원의 필사적인 수습기',
    genre: '코미디',
    tone: '유쾌함, 민망함',
    episode_count: 8,
    episode_seconds: 45,
    style: STYLES[0].text,
  },
  {
    id: 'school',
    name: '학원 청춘',
    hint: '전학·비밀·첫사랑',
    title: '옆자리의 비밀',
    logline:
      '전학 온 첫날, 모두가 피하는 옆자리 남학생이 밤마다 옥상에서 누군가를 기다린다는 걸 알게 됐다',
    genre: '청춘',
    tone: '풋풋함, 설렘',
    episode_count: 8,
    episode_seconds: 60,
    style: STYLES[1].text,
  },
  {
    id: 'mystery',
    name: '미스터리',
    hint: '미스터리·반전·오싹',
    title: '밤 11시 11분',
    logline: '매일 밤 11시 11분, 아무도 살지 않는 옆집에서 나에게 전화가 걸려 온다',
    genre: '스릴러',
    tone: '오싹함, 긴박함',
    episode_count: 6,
    episode_seconds: 60,
    style: STYLES[2].text,
  },
  {
    id: 'reunion',
    name: '재회 로맨스',
    hint: '첫사랑·재회·엇갈림',
    title: '다시, 같은 정류장',
    logline:
      '헤어진 지 7년 만에 같은 버스 정류장에서 만난 두 사람. 서로에게 보내지 못한 편지가 같은 날 도착한다.',
    genre: '로맨스',
    tone: '아련함, 따뜻함',
    episode_count: 6,
    episode_seconds: 45,
    style: STYLES[1].text,
  },
  {
    id: 'palace',
    name: '궁중 로맨스',
    hint: '궁궐·신분·비밀 약속',
    title: '달빛 아래 약속',
    logline:
      '서고를 지키는 궁녀는 밤마다 찾아오는 청년이 왕세자라는 사실을 모른 채 금지된 책을 함께 읽는다.',
    genre: '로맨스',
    tone: '서정적, 애틋함',
    episode_count: 8,
    episode_seconds: 60,
    style: STYLES[3].text,
  },
  {
    id: 'detective',
    name: '추리 수사극',
    hint: '단서·공조·반전',
    title: '마지막 알리바이',
    logline:
      '소리만 듣고 장소를 기억하는 편의점 직원이 형사와 함께 사라진 손님의 마지막 동선을 추적한다.',
    genre: '스릴러',
    tone: '긴장감, 치밀함',
    episode_count: 6,
    episode_seconds: 60,
    style: STYLES[2].text,
  },
  {
    id: 'time',
    name: '타임루프',
    hint: '반복되는 하루·선택',
    title: '8시 59분의 선택',
    logline:
      '면접에 떨어질 때마다 같은 아침으로 돌아가는 취업 준비생. 반복을 끝낼 열쇠는 낯선 사람에게 건네는 한마디다.',
    genre: '판타지',
    tone: '신비로움, 희망',
    episode_count: 5,
    episode_seconds: 45,
    style: STYLES[0].text,
  },
  {
    id: 'medieval',
    name: '중세 모험',
    hint: '기사·마법·동료',
    title: '견습 기사의 지도',
    logline:
      '검을 못 쓰는 견습 기사가 말하는 지도를 발견하고, 추방된 마법사와 함께 사라진 왕국의 길을 찾는다.',
    genre: '판타지',
    tone: '모험, 유쾌함',
    episode_count: 8,
    episode_seconds: 60,
    style: STYLES[6].text,
  },
  {
    id: 'scifi',
    name: '근미래 SF',
    hint: '인공지능·기억·선택',
    title: '내일의 음성메모',
    logline:
      '미래의 자신이 보낸 음성메모를 받는 수리공. 마지막 메모에는 절대로 고쳐서는 안 되는 로봇의 이름이 담겨 있다.',
    genre: '판타지',
    tone: '신비로움, 긴장감',
    episode_count: 6,
    episode_seconds: 60,
    style: STYLES[7].text,
  },
  {
    id: 'healing',
    name: '힐링 일상',
    hint: '동네·작은 위로·성장',
    title: '오늘도 문을 엽니다',
    logline:
      '폐점을 앞둔 작은 카페에 매일 같은 시간 찾아오는 손님들이 저마다의 하루를 한 문장씩 남기기 시작한다.',
    genre: '청춘',
    tone: '포근함, 담백함',
    episode_count: 4,
    episode_seconds: 30,
    style: STYLES[0].text,
  },
  {
    id: 'music',
    name: '음악 청춘',
    hint: '밴드·꿈·우정',
    title: '우리의 마지막 합주',
    logline:
      '해체를 앞둔 대학 밴드가 마지막 공연을 준비하며, 한 번도 완성하지 못한 노래에 각자의 진심을 담는다.',
    genre: '청춘',
    tone: '열정, 뭉클함',
    episode_count: 6,
    episode_seconds: 45,
    style: STYLES[0].text,
  },
  {
    id: 'sports',
    name: '스포츠 성장',
    hint: '도전·팀워크·역전',
    title: '벤치에서 시작된 봄',
    logline:
      '늘 벤치에 앉던 선수가 부상당한 주장을 대신해 동네 대회에 출전하고, 자신만의 방식으로 팀을 하나로 모은다.',
    genre: '청춘',
    tone: '희망, 열정',
    episode_count: 6,
    episode_seconds: 45,
    style: STYLES[0].text,
  },
  {
    id: 'roommates',
    name: '동거 시트콤',
    hint: '룸메이트·오해·소동',
    title: '우리 집 사용 설명서',
    logline:
      '생활 습관이 정반대인 세 사람이 한집에 살게 된다. 냉장고에 붙인 단 하나의 규칙이 매일 새로운 소동을 만든다.',
    genre: '코미디',
    tone: '경쾌함, 따뜻함',
    episode_count: 6,
    episode_seconds: 30,
    style: STYLES[0].text,
  },
  {
    id: 'pet',
    name: '반려동물 코미디',
    hint: '산책·이웃·뜻밖의 인연',
    title: '산책은 핑계일 뿐',
    logline:
      '매일 같은 강아지에게 끌려가는 두 이웃은 서로의 이름도 모른 채 동네의 사소한 사건들을 함께 해결한다.',
    genre: '코미디',
    tone: '귀여움, 유쾌함',
    episode_count: 4,
    episode_seconds: 30,
    style: STYLES[5].text,
  },
  {
    id: 'twist',
    name: '30초 반전극',
    hint: '짧은 호흡·단서·반전',
    title: '문 앞의 쪽지',
    logline:
      '퇴근할 때마다 문 앞에 놓인 익명의 쪽지. 마지막 한 줄을 읽는 순간, 주인공이 알고 있던 하루의 의미가 바뀐다.',
    genre: '스릴러',
    tone: '궁금증, 반전',
    episode_count: 1,
    episode_seconds: 30,
    style: STYLES[2].text,
  },
];
// 공급사별 목소리 이름 예시(공급사 문서에서 최신 목록을 확인하세요)
export function voiceSuggestions(provider = '', label = ''): string[] {
  const key = `${provider} ${label}`.toLowerCase();
  if (key.includes('openai'))
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
  if (key.includes('gemini') || key.includes('google'))
    return ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Zephyr'];
  if (key.includes('minimax') || key.includes('hailuo'))
    return [
      'Korean_SweetGirl',
      'Korean_CalmLady',
      'Korean_CheerfulBoyfriend',
      'Korean_IntellectualSenior',
    ];
  return [];
}
export const REWRITE_CHIPS = [
  '더 긴장감 있게',
  '대사를 더 짧고 강렬하게',
  '감정을 더 깊게',
  '반전을 넣어서',
  '코믹하게',
  '클로즈업 위주로',
];
