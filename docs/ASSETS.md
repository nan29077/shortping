# 생성형 이미지 및 브랜드 에셋

2026-09-19 추가: `public/avatars/block-01.webp`~`block-30.webp`는 내장 `image_gen`으로 만든 숏핑 전용 3D 블록 토이 프로필 30종입니다. 특정 완구 브랜드를 복제하지 않은 오리지널 캐릭터이며, 원본 시트는 `assets/source/shortping-block-avatars-sheet.png`, 분리·최적화 스크립트는 `scripts/prepare-avatars.mjs`입니다.

2026-09-18, 내장 `image_gen` 도구로 생성했습니다. 별도 OpenAI API 키를 사용하지 않았습니다. 모든 최종 이미지를 프로젝트에 저장했으며 외부 생성 경로에 의존하지 않습니다.

| 원본                              | 화면용 에셋               | 용도                                     |
| --------------------------------- | ------------------------- | ---------------------------------------- |
| assets/source/hero-original.png   | public/images/hero.webp   | 자정의 계약, 메인 히어로, PC 왼쪽 포스터 |
| assets/source/spring-original.png | public/images/spring.webp | 다시, 스물아홉, 봄 로맨스                |
| assets/source/shadow-original.png | public/images/shadow.webp | 그림자 게임, 스릴러                      |
| assets/source/moon-original.png   | public/images/moon.webp   | 달빛 아래 너, 사극 판타지                |
| assets/source/mascot-original.png | public/images/mascot.webp | PC 오른쪽 숏핑 마스코트 ‘핑이’           |

SVG 로고 `public/icon.svg`는 번개와 플레이를 조합한 자체 벡터 디자인입니다. 192px/512px PWA PNG 아이콘도 포함합니다. UI 아이콘은 Lucide의 같은 선형 스타일입니다. 제목은 CSS 조판이므로 웹 화면에서 이미지와 함께 표시되며 원본 이미지 파일에는 글자가 없습니다.

## 최종 프롬프트

### hero

Create original cinematic photography for a Korean mystery drama poster. Landscape image. Two fictional Korean adult detectives age 30 wearing fully buttoned formal business suits, woman foreground and man behind her, both facing camera thoughtfully. Dark glass Seoul office at night, turquoise shadows and warm window light, beautiful high-end film photography. Waist up portrait. Modest professional clothing. Sophisticated atmospheric mysterious mood. Faces in upper right half and empty dark space on left and bottom for website title overlay. No text, no logos, no watermark, no celebrities.

### spring

Original Korean drama poster photographic artwork, vertical portrait 1024x1536. Two fictional adult Korean people age 29 in modest casual coats, woman with shoulder length hair in cream trench coat, man in blue jacket, standing on a sunny quiet street outside a small bookshop with flowering cherry trees. Warm spring afternoon, nostalgic film photography, subtle natural emotion, peach pink and forest green palette, premium realistic editorial movie poster, beautiful visual storytelling. Main faces upper half, lower quarter darker for graphic title overlay later. No text, no lettering, no logos, no celebrities.

### shadow

Original dramatic Korean mystery thriller movie poster photo, vertical 1024x1536. A fictional Korean woman detective age 32 in a black raincoat standing in a rainy neon Seoul alley at night, thoughtful determined expression, short dark hair. Background a distant mysterious silhouette holding an umbrella, teal and cyan neon with restrained red highlights, glossy wet street. Photorealistic high-end film still, beautiful composition, sharp natural face upper center, dramatic chiaroscuro, atmospheric suspense. Modest clothing, no weapons, no violence, no text, no logo. Leave lower quarter dark for title overlay.

### moon

Original Korean historical fantasy drama key art, photorealistic cinematic movie poster, vertical 1024x1536. Fictional adult Korean noblewoman age 28 wearing elegant full coverage pale lavender and blue traditional hanbok, with a fictional adult Korean prince age 30 in deep navy Joseon ceremonial hanbok standing beside her in a moonlit palace courtyard. Fully clothed, respectful classic costume drama. A large moon, softly illuminated cherry blossoms, rich indigo and violet night, beautiful ethereal silver light, realistic faces, film grain, expensive film cinematography. Heads in upper half, lower quarter dark for title overlay. No text, no lettering, no logos, no celebrities.

### mascot

Use case stylized-concept. Original premium 3D brand mascot for a short drama app, a tiny friendly lime green rounded robot with a soft rounded square head, two small dark oval eyes, tiny smile, a small triangular play symbol engraved on its belly, wearing chunky dark teal headphones, holding a little cinema clapperboard and sitting with short dangling feet. Beautiful soft clay material, sophisticated toy design, studio soft lighting with pale green glow. Isolated centered character on perfectly uniform very dark navy background #090d10, no text, no letters, no watermark. Square composition, entire character visible with spacious margins, refined friendly not childish, professional Cinema 4D product render.

## 시연 영상

`public/demo/preview.mp4`는 hero 이미지에서 FFmpeg로 만든 12초의 무음 패닝 티저입니다. 실제 촬영한 드라마나 생성형 동영상으로 표시하지 않습니다. 서버의 시청 권한 API를 통해서만 제공합니다. 기본 96개 회차는 같은 티저를 참조하며 PD가 업로드하는 실제 MP4 파일을 지원합니다.

## 글꼴

`@fontsource-variable/noto-sans-kr`, `@fontsource-variable/noto-serif-kr` 패키지의 로컬 웹폰트. 해당 패키지에 포함된 SIL Open Font License 및 Lucide ISC 라이선스를 유지합니다.

## Desktop cinema wallpaper · 2026-09-18

- Generated with the built-in image_gen tool. Original: `assets/source/desktop-cinema-original.png`; optimized web asset: `public/images/desktop-cinema.webp`.
- Replaces the reused drama-poster background on the right and supplies a coherent background for both desktop margins. Existing thumbnail artwork remains unchanged.
- Final prompt: Use case: ads-marketing. Create a premium cinematic photographic background for Shortping, a Korean short-form drama streaming app. Asset: a single wide desktop wallpaper, no text or UI, 1536x1024 landscape composition. Original fictional Korean adult drama couple, woman in elegant charcoal coat near the far LEFT edge, man in dark tailored coat near the far RIGHT edge, both looking thoughtfully toward the middle from opposing sides of a nighttime Seoul cinema street. Keep the middle 50 percent mostly atmospheric dark teal negative space, distant wet street reflections and soft emerald/lime cinema lights. Characters placed in outermost quarters, half-body to full-body, real skin, editorial film still, restrained romantic mystery, sophisticated subtle lime green light accents matching #c4f562 and very dark navy #090d10. Outer edges have immersive architectural reflections, film-grain texture, soft bokeh. This image will sit behind a central mobile-width website and its left brand copy/right navigation. Left and right sides should each look beautiful as narrow vertical crops. No readable signs, no typography, no logos, no poster borders, no montage frames. Entire image is one coherent atmospheric scene, not a screenshot.

## 관리자 선택형 메인 여백 테마 · 2026-09-19

내장 `image_gen`으로 시네마틱·밝은 발견·판타지·고전 시네마·중세 서사의 5종을 생성했습니다. 원본은 `assets/source/home-*-original.png`, 화면용 파일은 `public/images/home-*.webp`이며 `scripts/prepare-home-themes.mjs`로 1920×1080 WebP를 다시 만들 수 있습니다.

공통 프롬프트는 중앙 44%를 앱 콘텐츠용 저밀도 영역으로 비우고 인물과 주요 장면을 좌우 끝에 배치하도록 지정했습니다. 각 변형에는 현대 서울의 밤, 햇살이 드는 도심 옥상, 달빛 판타지 궁전, 1930년대 고전 극장가, 중세 성채의 새벽 분위기를 각각 적용했으며 이미지 내부의 문자·로고·UI·워터마크는 모두 제외했습니다.

## PD 방송국 선택형 배너 · 2026-09-19

업로더가 `마이 방송국`에서 선택할 수 있는 3:1 생성형 배너 5종입니다. 네온 촬영장, 봄 로맨스 세트, 미스터리 누아르, 달빛 판타지, 크리에이터 작업실을 각각 표현했습니다. 원본은 `assets/source/channel-*-original.png`, 1800×600 WebP는 `public/images/channel-*.webp`이며 `scripts/prepare-channel-banners.mjs`로 다시 생성할 수 있습니다.

공통 프롬프트에는 방송국 웹 헤더용 3:1 구도, 넉넉한 여백, 중앙 수평 안전 영역, 문자·로고·UI·워터마크 제외 조건을 사용했습니다. 최종 선택값은 방송국 배너 경로와 대표 색상·분위기·오버레이 설정으로 함께 저장됩니다.
