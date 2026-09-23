import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/noto-sans-kr';
import '@fontsource-variable/noto-serif-kr';
import './style.css';
import { isNativeApp, refreshMediaToken } from './platform';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <img src="/icon.svg" width="56" alt="" />
        <h1>잠시 화면을 불러오지 못했어요</h1>
        <button onClick={() => location.reload()}>다시 시도</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.root = root;
  });
const render = () =>
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
if (isNativeApp) {
  // 앱: 영상 · 음성 주소에 붙일 미디어 토큰을 먼저 받고(최대 3초 기다림) 화면을 그립니다.
  void Promise.race([refreshMediaToken(), new Promise((ok) => setTimeout(ok, 3000))]).then(render);
  // 안드로이드 뒤로 가기 버튼: 앱 안에서 뒤로 갈 곳이 있으면 뒤로, 없으면 앱을 닫습니다.
  // 패키지를 불러오지 않고 앱이 넣어 주는 플러그인(Capacitor.Plugins.App)을 바로 씁니다
  // (웹 개발 서버에서 @capacitor/app 설치 여부와 상관없이 화면이 뜨도록).
  type BackEvent = { canGoBack: boolean };
  type NativeAppPlugin = { addListener: (e: 'backButton', cb: (ev: BackEvent) => void) => unknown; exitApp: () => Promise<void> };
  const NativeApp = (window as unknown as { Capacitor?: { Plugins?: { App?: NativeAppPlugin } } }).Capacitor?.Plugins?.App;
  NativeApp?.addListener('backButton', ({ canGoBack }) => {
    // 열린 창(팝업)이 있으면 먼저 닫습니다.
    const open = document.querySelector('.modal-backdrop, .ws-overlay, .preview-overlay');
    if (open) {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    if (canGoBack || history.length > 1) history.back();
    else void NativeApp.exitApp();
  });
} else {
  render();
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
