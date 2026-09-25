import React from 'react';
import ReactDOM from 'react-dom/client';
import { initI18n } from '@/lib/i18n';
import App from './App';
import './style.css';

void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
