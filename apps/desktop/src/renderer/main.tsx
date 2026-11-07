import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { ToastProvider } from '@clipwright/design-system';
import '@clipwright/design-system/tokens.css';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </React.StrictMode>
  );
}
