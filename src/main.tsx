import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DemoStudio from './demo/DemoStudio';
import Home from './home/Home';
import './styles.css';
const path=window.location.pathname;
createRoot(document.getElementById('root')!).render(<StrictMode>{path.startsWith('/studio') ? <DemoStudio /> : path.startsWith('/editor') ? <><a className="editor-home-link" href="/">← 返回首页</a><App /></> : <Home />}</StrictMode>);
