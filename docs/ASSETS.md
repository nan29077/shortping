# 생성형 이미지 및 브랜드 에셋

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
