import { styleOf } from './home-layout.mjs';

export const homeThemes = [
  {
    id: 'cinematic',
    name: '시네마틱',
    mood: '도시의 밤과 깊은 몰입',
    image: '/images/home-cinematic.webp',
    eyebrow: 'SHORT STORIES, DEEP MOMENTS',
    headline: '짧은 순간,',
    highlight: '깊은 이야기.',
    description: '다양한 장르의 숏폼 드라마를\n언제 어디서나 만나보세요.',
    caption: '오늘의 장면이 내일의 취향이 됩니다.',
  },
  {
    id: 'bright',
    name: '밝은 발견',
    mood: '햇살과 산뜻한 설렘',
    image: '/images/home-bright.webp',
    eyebrow: 'EVERY DAY, A NEW STORY',
    headline: '가볍게 시작해,',
    highlight: '오래 남는 이야기.',
    description: '짧은 휴식에도 새로운 장면을 만나고\n취향에 맞는 작품을 발견해 보세요.',
    caption: '매일 새롭게 만나는 숏핑 오리지널',
  },
  {
    id: 'fantasy',
    name: '판타지',
    mood: '달빛과 마법의 세계',
    image: '/images/home-fantasy.webp',
    eyebrow: 'STEP INTO ANOTHER WORLD',
    headline: '상상 너머,',
    highlight: '새로운 세계.',
    description: '현실을 잠시 벗어나 다채로운 세계와\n새로운 주인공을 만나보세요.',
    caption: '짧은 장면에서 시작되는 큰 세계',
  },
  {
    id: 'classic',
    name: '고전 시네마',
    mood: '시간을 품은 우아함',
    image: '/images/home-classic.webp',
    eyebrow: 'TIMELESS STORIES, SHORT MOMENTS',
    headline: '시간이 지나도,',
    highlight: '남는 장면.',
    description: '섬세한 감정과 오래 기억될 서사를\n짧고 밀도 높은 이야기로 만나보세요.',
    caption: '시대를 넘어 이어지는 숏핑의 이야기',
  },
  {
    id: 'medieval',
    name: '중세 서사',
    mood: '성채와 장대한 전설',
    image: '/images/home-medieval.webp',
    eyebrow: 'LEGENDS IN EVERY MOMENT',
    headline: '짧은 순간이,',
    highlight: '전설이 되다.',
    description: '운명과 선택이 교차하는 장대한 서사를\n손안의 짧은 드라마로 만나보세요.',
    caption: '한 장면에서 시작되는 새로운 전설',
  },
];

export const appearanceFromSettings = (settings) => {
  const theme = homeThemes.find((item) => item.id === settings.home_theme) || homeThemes[0];
  const style = styleOf(settings.home_style);
  return {
    theme: theme.id,
    // 관리자가 올린 배경 사진이 있으면 테마 사진 대신 씁니다.
    image: style.image || theme.image,
    themeImage: theme.image,
    style,
    eyebrow: settings.home_eyebrow,
    headline: settings.home_headline,
    highlight: settings.home_highlight,
    description: settings.home_description,
    caption: settings.home_caption,
    copyright: settings.home_copyright,
  };
};
