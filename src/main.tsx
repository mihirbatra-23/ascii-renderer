import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted UI fonts (spec §7 "Fonts"): no third-party requests, works offline.
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import './styles/index.css';
import App from './App';
import { applyTheme } from './app/hooks';
import { applySettingsFromUrl } from './app/permalink';
import { prepareEngineWhenIdle } from './app/engineHost';
import { useStore } from './state/store';

// Before the first paint, so variant B never flashes variant A.
applyTheme(useStore.getState().ui.theme);
// A settings link wins over the stored params, and the editor starts in its look.
applySettingsFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// The engine and its shaders get ready while the start screen waits for a file.
prepareEngineWhenIdle();
