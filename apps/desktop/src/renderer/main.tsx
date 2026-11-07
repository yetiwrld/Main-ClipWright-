import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import '@clipwright/design-system/tokens.css';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
