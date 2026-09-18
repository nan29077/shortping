# AWS 및 Android·iOS 후속 배포

## 현재 준비된 항목

공통 PostgreSQL 스키마·`pg` 어댑터, 운영 모드 차단 장치, Dockerfile, PostgreSQL 개발 컨테이너, PWA 매니페스트, Capacitor 구성 및 플랫폼 패키지. AWS 인프라 생성·결제사 연동·실제 모바일 빌드와 배포는 아직 실행하지 않았습니다.

## 권장 AWS 구성

CloudFront/ALB(ACM TLS) → ECS Fargate Node.js 앱 → RDS PostgreSQL. 프런트 정적 파일과 API는 같은 공개 도메인을 사용하여 현재 HttpOnly 쿠키 구조를 유지합니다. 최소 초기 구성은 단일 인스턴스와 영속 볼륨을 사용합니다. 여러 인스턴스로 확장하기 전 업로드 저장소와 rate limit을 공유해야 합니다.

- DB: RDS PostgreSQL, private subnet, 연결 TLS 검증, Secrets Manager의 DATABASE_URL.
- 영상: 추후 private S3 multipart 업로드 → MediaConvert HLS → CloudFront signed cookie/URL. 현재 구현은 로컬 MP4이므로 이 저장소·트랜스코딩 어댑터 구현이 필요합니다. 현재 MP4 서버를 대규모 스트리밍으로 간주하지 마세요.
- 업로드 영속성: 현재 `/app/uploads`를 영속 볼륨에 연결. Fargate 임시 디스크만 사용하면 재배포 시 잃습니다. 운영 확장 전 S3 전환 권장.
- 관측: CloudWatch 로그·지표, RDS 백업/PITR, 알림, 에러 추적.
- 다중 인스턴스 요청 제한: 현재 메모리 rate limit을 Redis 등 공유 저장소로 교체.
- ALB 뒤에서는 실제 프록시 구성을 확인하고 `TRUST_PROXY_HOPS=1` 지정. 무조건 모든 프록시를 신뢰하지 않습니다.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3033
APP_ORIGIN=https://your-confirmed-domain.example
DATABASE_URL=postgresql://...confirmed-production-connection...
ENABLE_DEMO=false
UPLOAD_DIR=/app/uploads
TRUST_PROXY_HOPS=1
ANDROID_STORE_URL=
IOS_STORE_URL=
```

운영 도메인·비밀키는 실제 값 확정 후 비밀 관리 서비스로 주입하세요. `.env`를 Git에 올리지 않습니다. `DATABASE_URL`만 설정한다고 기존 SQLite 데이터가 자동 이전되지는 않습니다. 마이그레이션은 외래키 순서에 맞춘 별도 데이터 이관 및 검증이 필요합니다.

```bash
docker build -t shortping .
# 실제 환경변수·영속 볼륨·TLS reverse proxy를 준비한 뒤 컨테이너 실행
```

운영 최초 관리자는 일반 이메일 회원가입을 완료한 계정을, DB에 접근 가능한 운영자가 다음 명령으로 승격합니다. 스크립트는 없는 계정을 생성하거나 비밀번호를 출력하지 않습니다.

```bash
node --env-file=.env scripts/promote-admin.mjs confirmed-admin@example.com
```

개발 PostgreSQL은 `docker compose up -d db`로 시작하고 `.env`의 `DATABASE_URL`을 연결합니다. 이때도 실제 개인정보나 운영 데이터를 사용하지 않습니다.

## 외부 로그인·결제

- 카카오·네이버·구글: 앱 등록, 클라이언트 식별자·시크릿, 허용 redirect URI, 서버 state/PKCE 검증, 신규/기존 계정 연결 정책, 탈퇴 흐름. 버튼은 현재 안내 기능입니다.
- 이메일: 메일 인증, 비밀번호 재설정, SMTP/SES 연동, 비정상 로그인 방어 확장.
- 웹 결제: 계약한 PG사의 서버 승인 및 서명 검증 webhook을 연결하고 실제 주문 상태 머신·취소/환불/구독 자동 갱신을 구현합니다. 현재 checkout은 운영에서 503이며 테스트 주문만 생성합니다.
- 정책·사업자 정보·콘텐츠 이용 권한·연령 정책은 정식 공개 전 확정. 현재 약관 모달은 확정된 법적 문서가 아닙니다.

## 모바일

Capacitor 앱 ID `com.shortping.app`, 앱 이름 `숏핑`, 웹 산출물 `dist`가 준비되어 있습니다.

```bash
npm run mobile:android
npm run mobile:sync
npx cap open android
```

iOS는 macOS·Xcode·Apple 개발자 서명이 필요한 후속 단계입니다.

```bash
npm run mobile:ios
npm run mobile:sync
npx cap open ios
```

**현재 네이티브 셸에 정적 파일만 넣으면 웹 API가 자동 연결되지 않습니다.** 앱 통합 단계에서 네이티브용 API base URL·인증/secure storage·CORS를 설계하거나 동일 출처의 호스팅 웹앱을 사용하는 배포 방식을 결정해야 합니다. 현재 세션 쿠키는 동일 출처 웹앱용입니다. 네이티브 API 연동을 완료했다고 주장하지 않습니다.

스토어 출시 전에는 플랫폼 로그인, 딥링크, 앱 아이콘·스플래시, 안전 영역, 푸시, 복원 가능한 인앱 구매 영수증 검증, 구독 복원, 개인정보 안내, 실제 기기 재생 검증이 필요합니다. 디지털 콘텐츠 결제 방식과 로그인·심사 요구사항은 출시 시점의 공식 정책을 다시 확인해야 합니다. 네이티브 인앱 결제 및 서명 패키지는 이번 로컬 개발 범위에 포함하지 않습니다.

## 참고 문서

- Vite: https://vite.dev/guide/
- Capacitor: https://capacitorjs.com/docs
- PostgreSQL driver: https://node-postgres.com/
- Node SQLite: https://nodejs.org/api/sqlite.html
