import {
  AlarmClock,
  ChevronDown,
  ChevronUp,
  Eye,
  Focus,
  Gauge,
  Highlighter,
  KeyRound,
  LogIn,
  LogOut,
  Maximize2,
  Minimize2,
  MousePointer2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defaultWereadAssistPreferences, getWereadAssistPreferences, saveWereadAssistPreferences } from '../db';
import type { NativeBounds, WereadAssistDiagnostics, WereadAssistMode, WereadAssistPreferences } from '../types';

interface WereadWorkspaceProps {
  onNotice: (message: string) => void;
  onImmersiveChange: (value: boolean) => void;
}

function toBounds(element: HTMLElement): NativeBounds {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const rest = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function sentenceDiagnosticLabel(value: WereadAssistDiagnostics) {
  if (value.status === 'ready') return `${value.sentences} 句`;
  if (value.status === 'unsupported') return '不支持';
  if (value.status === 'error') return '未识别';
  return '识别中';
}

function sentenceDiagnosticTitle(value: WereadAssistDiagnostics) {
  if (value.status === 'ready') return `已从${value.source === 'canvas' ? '官方绘制层' : '正文'}识别 ${value.sentences} 个句子`;
  if (value.status === 'unsupported') return '当前页面的正文渲染方式暂不支持逐句色块';
  if (value.status === 'error') return '正文已显示，但没有捕获到可定位的句子；切换章节后会自动重试';
  return value.source === 'canvas' ? '正在读取官方绘制层' : '正在等待正文';
}

const assistModes: Array<{ value: WereadAssistMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'ruler', label: '阅读窗' },
  { value: 'paragraph', label: '段落' },
];

export function WereadWorkspace({ onNotice, onImmersiveChange }: WereadWorkspaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hasSession, setHasSession] = useState(false);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookieFormat, setCookieFormat] = useState<'header' | 'json'>('header');
  const [cookieValue, setCookieValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [assist, setAssist] = useState<WereadAssistPreferences>(defaultWereadAssistPreferences);
  const [assistReady, setAssistReady] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(42);
  const [timerMinutes, setTimerMinutes] = useState(25);
  const [secondsLeft, setSecondsLeft] = useState(25 * 60);
  const [timerRunning, setTimerRunning] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [sentenceDiagnostics, setSentenceDiagnostics] = useState<WereadAssistDiagnostics>({ status: 'scanning', source: 'none', detected: false, sentences: 0, blocks: 0, reason: 'waiting-reader' });

  useLayoutEffect(() => {
    const native = window.readerNative?.weread;
    const host = hostRef.current;
    if (!native || !host) return undefined;
    let active = true;
    const sync = () => {
      if (active && !cookieOpen) native.open(toBounds(host)).then((status) => setHasSession(status.hasSession)).catch((error: Error) => onNotice(error.message));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      active = false;
      observer.disconnect();
      native.hide().catch(() => undefined);
    };
  }, [cookieOpen, onNotice]);

  useEffect(() => {
    const native = window.readerNative?.weread;
    native?.status().then((status) => setHasSession(status.hasSession)).catch(() => undefined);
    getWereadAssistPreferences().then((stored) => {
      setAssist(stored);
      setAssistReady(true);
    }).catch((error: Error) => onNotice(error.message));
  }, [onNotice]);

  useEffect(() => {
    const unsubscribe = window.readerNative?.weread.onAssistDiagnostics(setSentenceDiagnostics);
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!assist.sentenceHighlight || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      sendAssistAction({ type: 'move-sentence', direction: event.key === 'ArrowDown' ? 1 : -1 });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [assist.sentenceHighlight]);

  useEffect(() => {
    if (!assistReady) return undefined;
    const timeout = window.setTimeout(() => {
      window.readerNative?.weread.setAssist(assist).catch((error: Error) => onNotice(error.message));
      saveWereadAssistPreferences(assist).catch((error: Error) => onNotice(error.message));
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [assist, assistReady, onNotice]);

  useEffect(() => {
    if (!timerRunning) return undefined;
    const interval = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current > 1) return current - 1;
        window.clearInterval(interval);
        setTimerRunning(false);
        onNotice('本轮专注完成，站起来活动一下再继续。');
        return 0;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [timerRunning, onNotice]);

  useEffect(() => {
    onImmersiveChange(immersive);
    return () => onImmersiveChange(false);
  }, [immersive, onImmersiveChange]);

  useEffect(() => () => {
    window.readerNative?.weread.assistAction({ type: 'auto-scroll', active: false, speed: scrollSpeed }).catch(() => undefined);
  }, [scrollSpeed]);

  function updateAssist(patch: Partial<WereadAssistPreferences>) {
    setAssist((current) => ({ ...current, ...patch }));
  }

  function sendAssistAction(action: Parameters<NonNullable<Window['readerNative']>['weread']['assistAction']>[0]) {
    window.readerNative?.weread.assistAction(action).catch((error: Error) => onNotice(error.message));
  }

  function toggleAutoScroll() {
    const next = !autoScroll;
    setAutoScroll(next);
    sendAssistAction({ type: 'auto-scroll', active: next, speed: scrollSpeed });
  }

  function changeScrollSpeed(value: number) {
    setScrollSpeed(value);
    if (autoScroll) sendAssistAction({ type: 'auto-scroll', active: true, speed: value });
  }

  function changeTimerDuration(value: number) {
    setTimerMinutes(value);
    setSecondsLeft(value * 60);
    setTimerRunning(false);
  }

  function resetTimer() {
    setTimerRunning(false);
    setSecondsLeft(timerMinutes * 60);
  }

  function closeCookieDialog() {
    setCookieValue('');
    setCookieOpen(false);
  }

  async function login() {
    setBusy(true);
    try {
      const status = await window.readerNative?.weread.login();
      setHasSession(Boolean(status?.hasSession));
      onNotice('已打开微信读书官方登录页，请使用微信扫码。');
    } catch (error: any) {
      onNotice(error.message || '无法打开登录页。');
    } finally {
      setBusy(false);
    }
  }

  async function importCookie() {
    if (!cookieValue.trim()) return;
    const payload = { format: cookieFormat, value: cookieValue };
    setCookieValue('');
    setBusy(true);
    try {
      const result = await window.readerNative?.weread.importCookie(payload);
      setCookieOpen(false);
      setHasSession(Boolean(result?.imported));
      onNotice(`已在本机导入 ${result?.imported || 0} 个 Cookie。`);
    } catch (error: any) {
      onNotice(error.message || 'Cookie 导入失败。');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!window.confirm('确定清除此设备上的微信读书登录会话吗？')) return;
    setBusy(true);
    try {
      await window.readerNative?.weread.logout();
      setHasSession(false);
      onNotice('微信读书本机登录会话已清除。');
    } catch (error: any) {
      onNotice(error.message || '无法清除登录会话。');
    } finally {
      setBusy(false);
    }
  }

  if (!window.readerNative) {
    return <section className="weread-workspace"><div className="reader-empty"><Focus size={22} /><span>请从桌面应用打开微信读书。</span></div></section>;
  }

  return (
    <section className={`weread-workspace ${immersive ? 'is-immersive' : ''}`}>
      <header className="weread-toolbar">
        <div><span className="eyebrow">官方同步</span><h1>微信读书</h1></div>
        <div className="weread-actions">
          <span className={`session-status ${hasSession ? 'is-ready' : ''}`}><ShieldCheck size={16} />{hasSession ? '登录会话已保存' : '请在阅读区登录'}</span>
          <button className="quiet-button" type="button" disabled={busy} onClick={login}><LogIn size={16} />扫码登录</button>
          <button className="quiet-button" type="button" disabled={busy} onClick={() => setCookieOpen(true)}><KeyRound size={16} />导入 Cookie</button>
          {hasSession && <button className="icon-button" type="button" disabled={busy} onClick={logout} aria-label="退出微信读书" title="退出微信读书"><LogOut size={17} /></button>}
        </div>
      </header>

      <section className="weread-assistbar" aria-label="专注辅助工具">
        <div className="assist-brand"><Focus size={17} /><strong>专注</strong></div>
        <div className="segmented-control" aria-label="聚焦模式">
          {assistModes.map((item) => <button key={item.value} className={assist.mode === item.value ? 'is-active' : ''} type="button" onClick={() => updateAssist({ mode: item.value })}>{item.label}</button>)}
        </div>
        <label className="assist-range" title="阅读窗高度"><span>窗高</span><input type="range" min="64" max="300" step="8" value={assist.bandHeight} disabled={assist.mode === 'off' || assist.sentenceHighlight} onChange={(event) => updateAssist({ bandHeight: Number(event.target.value) })} /><output>{assist.bandHeight}</output></label>
        <label className="assist-range" title="背景遮罩强度"><span>遮罩</span><input type="range" min="0.2" max="0.82" step="0.02" value={assist.dimming} disabled={assist.mode === 'off' || assist.sentenceHighlight} onChange={(event) => updateAssist({ dimming: Number(event.target.value) })} /><output>{Math.round(assist.dimming * 100)}%</output></label>
        <div className="assist-icon-group">
          <button className={`icon-button ${assist.sentenceHighlight ? 'is-active' : ''}`} type="button" onClick={() => updateAssist({ sentenceHighlight: !assist.sentenceHighlight })} aria-label="逐句色块" title="逐句色块"><Highlighter size={17} /></button>
          {assist.sentenceHighlight && <span className={`sentence-status ${sentenceDiagnostics.status === 'ready' ? 'is-ready' : sentenceDiagnostics.status === 'error' || sentenceDiagnostics.status === 'unsupported' ? 'is-error' : ''}`} title={sentenceDiagnosticTitle(sentenceDiagnostics)}>{sentenceDiagnosticLabel(sentenceDiagnostics)}</span>}
          {assist.sentenceHighlight && <><button className="icon-button" type="button" disabled={sentenceDiagnostics.status !== 'ready'} onClick={() => sendAssistAction({ type: 'move-sentence', direction: -1 })} aria-label="上一句" title="上一句"><SkipBack size={16} /></button><button className="icon-button" type="button" disabled={sentenceDiagnostics.status !== 'ready'} onClick={() => sendAssistAction({ type: 'move-sentence', direction: 1 })} aria-label="下一句" title="下一句"><SkipForward size={16} /></button></>}
          <button className={`icon-button ${assist.followPointer ? 'is-active' : ''}`} type="button" disabled={assist.mode === 'off' || assist.sentenceHighlight} onClick={() => updateAssist({ followPointer: !assist.followPointer })} aria-label="鼠标跟随" title="鼠标跟随"><MousePointer2 size={17} /></button>
          <button className={`icon-button ${assist.showGuideLine ? 'is-active' : ''}`} type="button" disabled={assist.mode === 'off' || assist.sentenceHighlight} onClick={() => updateAssist({ showGuideLine: !assist.showGuideLine })} aria-label="阅读标尺" title="阅读标尺"><Eye size={17} /></button>
          <button className="icon-button" type="button" disabled={assist.mode === 'off' || assist.sentenceHighlight} onClick={() => sendAssistAction({ type: 'recenter' })} aria-label="重新居中" title="重新居中"><RotateCcw size={17} /></button>
          {assist.mode === 'paragraph' && !assist.sentenceHighlight && <><button className="icon-button" type="button" onClick={() => sendAssistAction({ type: 'move', direction: -1 })} aria-label="上一段" title="上一段"><ChevronUp size={17} /></button><button className="icon-button" type="button" onClick={() => sendAssistAction({ type: 'move', direction: 1 })} aria-label="下一段" title="下一段"><ChevronDown size={17} /></button></>}
        </div>
        <div className="assist-scroll-control">
          <button className={`quiet-button compact ${autoScroll ? 'is-active' : ''}`} type="button" onClick={toggleAutoScroll}>{autoScroll ? <Pause size={15} /> : <Gauge size={15} />}自动滚动</button>
          <select value={scrollSpeed} onChange={(event) => changeScrollSpeed(Number(event.target.value))} aria-label="自动滚动速度" title="自动滚动速度"><option value="24">慢</option><option value="42">中</option><option value="68">快</option></select>
        </div>
        <div className={`focus-timer ${timerRunning ? 'is-running' : ''}`}>
          <AlarmClock size={15} />
          <output aria-label="专注剩余时间">{formatCountdown(secondsLeft)}</output>
          <button className="icon-button tiny" type="button" onClick={() => secondsLeft ? setTimerRunning((value) => !value) : resetTimer()} aria-label={timerRunning ? '暂停计时' : '开始计时'} title={timerRunning ? '暂停计时' : '开始计时'}>{timerRunning ? <Pause size={14} /> : <Play size={14} />}</button>
          <button className="icon-button tiny" type="button" onClick={resetTimer} aria-label="重置计时" title="重置计时"><RotateCcw size={14} /></button>
          <select value={timerMinutes} onChange={(event) => changeTimerDuration(Number(event.target.value))} aria-label="专注时长" title="专注时长"><option value="15">15 分</option><option value="25">25 分</option><option value="40">40 分</option></select>
        </div>
        <button className={`icon-button immersive-button ${immersive ? 'is-active' : ''}`} type="button" onClick={() => setImmersive((value) => !value)} aria-label={immersive ? '退出沉浸布局' : '进入沉浸布局'} title={immersive ? '退出沉浸布局' : '进入沉浸布局'}>{immersive ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      </section>

      <div ref={hostRef} className="weread-surface" />
      {cookieOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeCookieDialog}>
          <section className="cookie-dialog" role="dialog" aria-modal="true" aria-label="导入 Cookie" onMouseDown={(event) => event.stopPropagation()}>
            <header className="dialog-header"><div><span className="eyebrow">仅当前设备</span><h2>导入 Cookie</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={closeCookieDialog}><X size={18} /></button></header>
            <select value={cookieFormat} onChange={(event) => setCookieFormat(event.target.value as 'header' | 'json')} aria-label="Cookie 格式"><option value="header">Cookie Header</option><option value="json">Cookie JSON</option></select>
            <textarea value={cookieValue} onChange={(event) => setCookieValue(event.target.value)} placeholder={cookieFormat === 'header' ? 'name=value; name2=value2' : '[{"name":"...","value":"...","domain":"weread.qq.com"}]'} spellCheck={false} autoComplete="off" />
            <footer className="dialog-actions"><button className="quiet-button" type="button" onClick={closeCookieDialog}>取消</button><button className="command-button" type="button" disabled={busy || !cookieValue.trim()} onClick={importCookie}>{busy ? <RefreshCw className="spin" size={16} /> : <KeyRound size={16} />}导入</button></footer>
          </section>
        </div>
      )}
    </section>
  );
}
