// 미리보기 봇에는 서버가 카드 태그를 보내고, 방문자는 기존 웹앱 화면으로 이동시킵니다.
const match = /^\/share\/(drama|channel)\/([^/]+)$/.exec(window.location.pathname);
if (match) window.location.replace(`/#/${match[1]}/${encodeURIComponent(decodeURIComponent(match[2]))}`);
