import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { setupBrowserDebugLogging } from './lib/debug-logger';

setupBrowserDebugLogging();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root was not found.');
}
createRoot(root).render(<App />);
