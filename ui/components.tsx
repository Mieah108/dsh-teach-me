/** Adapted from DeepTutor FlashCardsBlock / TimelineBlock; see upstream/SOURCES.json. */
import React, { useId, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { parseData } from './data.mjs'

type Card = { front: string; back: string; hint?: string }
type TimelineEvent = { date?: string; title: string; description?: string }

function FlashCards({ title, cards, host }: { title?: string; cards: Card[]; host: HTMLElement }) {
  // Upstream navigation/flip state is retained; hints now require learner action.
  const [idx, setIdx] = useState(0)
  const [showBack, setShowBack] = useState(false)
  const [showHint, setShowHint] = useState(false)
  // 可访问名交给可见文字（题面/答案），说明挂在 aria-describedby 上：
  // 原先把 aria-label 写成「翻面查看答案」，读屏就再也听不到题面。
  const instructionId = useId()
  const card = cards[Math.min(idx, cards.length - 1)]
  function flip() {
    if (!showBack) host.dataset.teachShowedSolution = 'true'
    setShowBack((value) => !value)
  }
  function move(next: number) {
    setShowBack(false)
    setShowHint(false)
    setIdx(next)
  }
  return <div className="teach-flashcards">
    <div className="teach-widget-heading"><strong>{title || '回想与核对'}</strong><span aria-label="闪卡进度">{idx + 1} / {cards.length}</span></div>
    <p className="teach-widget-instruction" id={instructionId}>先试着回答，再翻面核对。</p>
    <button type="button" className="teach-flash-face" onClick={flip} aria-pressed={showBack} aria-describedby={instructionId}>
      <span className="teach-face-label">{showBack ? '答案' : '问题'}</span>
      <span className="teach-face-text">{showBack ? card.back : card.front}</span>
    </button>
    {card.hint && !showBack && <div className="teach-hint-row">
      <button type="button" className="teach-widget-button" aria-expanded={showHint} onClick={() => {
        if (!showHint) host.dataset.teachHintsUsed = 'true'
        setShowHint((value) => !value)
      }}>{showHint ? '收起提示' : '查看提示'}</button>
      {showHint && <p className="teach-hint">{card.hint}</p>}
    </div>}
    <div className="teach-widget-controls">
      <button type="button" className="teach-widget-button" onClick={() => move(Math.max(0, idx - 1))} disabled={idx === 0}>上一张</button>
      <button type="button" className="teach-widget-button" onClick={flip}>{showBack ? '返回问题' : '翻面核对'}</button>
      <button type="button" className="teach-widget-button" onClick={() => move(Math.min(cards.length - 1, idx + 1))} disabled={idx === cards.length - 1}>下一张</button>
    </div>
    <p className="teach-widget-state is-live" data-teach-state="" aria-live="polite">第 {idx + 1} 张。问题：{card.front}{showHint && card.hint ? '；已查看提示：' + card.hint : ''}{showBack ? '；当前答案：' + card.back : '；尚未揭晓本题答案。'}</p>
  </div>
}

function Timeline({ title, events }: { title?: string; events: TimelineEvent[] }) {
  // The upstream event list and optional date/description structure are retained.
  return <div className="teach-timeline">
    {title && <div className="teach-widget-heading"><strong>{title}</strong></div>}
    <ol data-teach-state="">{events.map((event, idx) => <li key={idx}>
      <span className="teach-timeline-date">{event.date || String(idx + 1).padStart(2, '0')}</span>
      <div><strong>{event.title}</strong>{event.description && <p>{event.description}</p>}</div>
    </li>)}</ol>
  </div>
}

function mount(scope: ParentNode = document) {
  for (const host of scope.querySelectorAll<HTMLElement>('[data-teach-component="flashcards"], [data-teach-component="timeline"]')) {
    if (host.dataset.teachMounted) continue
    if (!host.hasAttribute('data-teach-context')) host.dataset.teachContext = ''
    host.classList.add('teach-widget')
    try {
      const data = parseData(host.dataset.teachComponent, host.querySelector('script[type="application/json"]')?.textContent || '')
      const root = createRoot(host)
      flushSync(() => root.render(host.dataset.teachComponent === 'flashcards' ? <FlashCards {...data} host={host} /> : <Timeline {...data} />))
      host.dataset.teachMounted = 'true'
    } catch {
      const line = document.createElement('p')
      line.className = 'teach-widget-error'
      line.setAttribute('role', 'status')
      line.textContent = '这段互动暂时无法显示，请先继续阅读正文，或请导师检查组件内容。'
      host.replaceChildren(line)
      host.dataset.teachMounted = 'error'
    }
  }
  document.dispatchEvent(new CustomEvent('teach:components-ready'))
}

declare global { interface Window { teachComponents: { mount: typeof mount } } }
window.teachComponents = { mount }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(), { once: true })
else mount()
