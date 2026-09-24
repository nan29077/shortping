import { randomBytes, scryptSync } from 'node:crypto';
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
// 방송국(마이 방송국) demo data: two uploaders, each with their own station shelf.
export const secondPd = 'demo-pd-2';
export const pd2Dramas = new Set(['moon', 'promise', 'summer']);
export const seedChannels = [
  [
    'channel-shortping',
    'demo-pd',
    '스튜디오 숏핑',
    'shortping-studio',
    '설렘부터 서스펜스까지, 매주 새로운 숏폼 드라마',
    '숏핑 오리지널을 만드는 제작 스튜디오입니다. 로맨스와 스릴러를 중심으로 매주 새로운 이야기를 공개합니다.',
    '/images/channel-neon.webp',
    '#c4f562',
    1,
    0,
    ['신작', '로맨스', '스릴러'],
  ],
  [
    'channel-moonlight',
    secondPd,
    '달빛 스튜디오',
    'moonlight',
    '시간을 건너는 사랑 이야기',
    '사극 판타지와 청춘 감성을 전문으로 하는 스튜디오입니다. 달빛 아래 너, 천 년의 약속을 제작했습니다.',
    '/images/channel-fantasy.webp',
    '#bda7f0',
    1,
    1,
    ['판타지', '청춘', '완결작'],
  ],
];
export const seedDramas = [
  [
    'midnight',
    '자정의 계약',
    '우리의 비밀은, 자정부터 시작된다.',
    '사라진 계약서 한 장, 그리고 서로를 의심하는 두 사람. 거대한 기업의 비밀을 쫓던 서윤은 그 비밀의 중심에서 도현을 만난다. 진실에 가까워질수록, 그에게도 가까워진다.',
    '로맨스',
    'hero',
    '#9bbaba',
    '독점',
    128400,
    3900,
  ],
  [
    'spring',
    '다시, 스물아홉',
    '끝인 줄 알았던 순간, 네가 다시 왔다.',
    '서른을 앞둔 봄. 작은 서점으로 돌아온 지우 앞에 오래전 첫사랑이 나타난다. 멈췄던 두 사람의 시간이 다시 흐르기 시작한다.',
    '로맨스',
    'spring',
    '#e6bda7',
    'NEW',
    86200,
    2900,
  ],
  [
    'shadow',
    '그림자 게임',
    '모두가 거짓말을 하고 있다.',
    '도시를 흔든 한 통의 메시지. 사건 담당 형사 하린은 범인의 다음 타깃이 자신이라는 사실을 알게 된다. 제한 시간은 단 24시간.',
    '스릴러',
    'shadow',
    '#71a4ae',
    '독점',
    109800,
    4900,
  ],
  [
    'moon',
    '달빛 아래 너',
    '다른 시간, 같은 마음.',
    '궁궐의 기록을 복원하던 수연은 어느 날 기록 속 조선에 눈을 뜬다. 그녀만을 기억하는 왕세자와 운명을 넘어선 이야기가 시작된다.',
    '판타지',
    'moon',
    '#b5aecf',
    'HOT',
    95700,
    3900,
  ],
  [
    'office',
    '팀장님, 로그아웃!',
    '퇴근 후에도 자꾸 생각나는 사람.',
    '회사에서는 완벽한 라이벌, 퇴근 후에는 온라인 게임 최강의 듀오. 서로의 정체를 모르는 두 사람의 이중생활 오피스 로맨스.',
    '코미디',
    'spring',
    '#e3c5af',
    'NEW',
    42800,
    2900,
  ],
  [
    'summer',
    '우리의 여름 페이지',
    '가장 빛나던 계절에, 너를 만났다.',
    '바닷가 마을에서 한 달 살기를 시작한 작가 은우. 오래된 필름 카메라 속 낯선 풍경이 그를 특별한 인연으로 이끈다.',
    '청춘',
    'hero',
    '#86acb2',
    '완결',
    73100,
    2900,
  ],
  [
    'signal',
    '마지막 시그널',
    '내일의 내가 보낸 경고.',
    '고장 난 라디오에서 들려오는 내일의 뉴스. 아나운서 유진은 아직 일어나지 않은 사건을 막으려 하지만, 미래를 바꿀 때마다 대가가 따른다.',
    '스릴러',
    'shadow',
    '#7295a6',
    'HOT',
    64300,
    3900,
  ],
  [
    'promise',
    '천 년의 약속',
    '한 번 더, 너를 찾을게.',
    '천 년을 살아온 기록관과 과거를 잊은 소설가. 매번 달라지는 생에서도 두 사람을 이어주는 단 하나의 약속.',
    '판타지',
    'moon',
    '#bdacdb',
    '완결',
    51200,
    3900,
  ],
];
export async function seed(db) {
  const now = new Date().toISOString();
  for (const [id, role, name] of [
    ['demo-admin', 'admin', '숏핑 관리자'],
    ['demo-pd', 'pd', '스튜디오 숏핑'],
    [secondPd, 'pd', '달빛 스튜디오'],
    ['demo-viewer', 'viewer', '숏핑러'],
  ]) {
    await db.run(
      'INSERT INTO users (id,email,name,password,role,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      [
        id,
        `${id.replace('demo-', '')}@shortping.local`,
        name,
        hashPassword(randomBytes(32).toString('hex')),
        role,
        now,
      ],
    );
  }
  for (const [
    id,
    title,
    tagline,
    synopsis,
    genre,
    image,
    accent,
    badge,
    views,
    price,
  ] of seedDramas) {
    await db.run(
      'INSERT INTO dramas (id,owner_id,title,tagline,synopsis,genre,image,accent,badge,status,price,views,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      [
        id,
        pd2Dramas.has(id) ? secondPd : 'demo-pd',
        title,
        tagline,
        synopsis,
        genre,
        `/images/${image}.webp`,
        accent,
        badge,
        'published',
        price,
        views,
        now,
        now,
      ],
    );
    for (let n = 1; n <= 12; n++)
      await db.run(
        'INSERT INTO episodes (id,drama_id,number,title,video,duration) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        [
          `${id}-${n}`,
          id,
          n,
          [
            '우연의 시작',
            '낯선 마음',
            '뜻밖의 재회',
            '숨겨진 이야기',
            '엇갈린 시선',
            '한 걸음 더',
            '위험한 선택',
            '진실의 조각',
            '서로의 시간',
            '마지막 비밀',
            '너에게 가는 길',
            '우리의 새로운 시작',
          ][n - 1],
          '/demo/preview.mp4',
          12,
        ],
      );
  }
  for (const [
    id,
    owner,
    name,
    slug,
    tagline,
    description,
    banner,
    accent,
    featured,
    order,
    categories,
  ] of seedChannels) {
    await db.run(
      "INSERT INTO channels (id,owner_id,name,slug,tagline,description,banner,logo,accent,status,featured,featured_order,created_at,banner_fit) VALUES (?,?,?,?,?,?,?,'',?,'active',?,?,?,'cover') ON CONFLICT(id) DO NOTHING",
      [id, owner, name, slug, tagline, description, banner, accent, featured, order, now],
    );
    await db.run('UPDATE dramas SET channel_id=? WHERE owner_id=? AND channel_id IS NULL', [
      id,
      owner,
    ]);
    let sort = 0;
    for (const category of categories)
      await db.run(
        'INSERT INTO channel_categories (id,channel_id,name,sort_order) VALUES (?,?,?,?) ON CONFLICT(channel_id,name) DO NOTHING',
        [`${id}-${sort}`, id, category, sort++],
      );
  }
}
