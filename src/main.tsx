import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/noto-sans-kr';
import '@fontsource-variable/noto-serif-kr';
import './style.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <img src="/icon.svg" width="56" />
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
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
if ('serviceWorker' in navigator && import.meta.env.PROD)
  navigator.serviceWorker.register('/sw.js').catch(() => {});
