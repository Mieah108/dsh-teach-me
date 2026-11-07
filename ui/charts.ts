/** Thin browser adapter for OpenMAIC's unmodified getChartOption(). */
import { init, use } from 'echarts/core'
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, AriaComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { getChartOption } from './upstream/openmaic/chartOption'
import { parseData } from './data.mjs'

use([BarChart, LineChart, PieChart, RadarChart, ScatterChart, GridComponent, LegendComponent, AriaComponent, SVGRenderer])

function element(tag: string, className?: string, content?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function mount(scope: ParentNode = document) {
  for (const host of scope.querySelectorAll<HTMLElement>('[data-teach-component="chart"]')) {
    if (host.dataset.teachMounted) continue
    if (!host.hasAttribute('data-teach-context')) host.dataset.teachContext = ''
    host.classList.add('teach-widget')
    try {
      const config = parseData('chart', host.querySelector('script[type="application/json"]')?.textContent || '')
      host.replaceChildren()
      const heading = element('div', 'teach-widget-heading')
      heading.append(element('strong', '', config.title || '数据对比'))
      const plot = element('div', 'teach-chart-plot')
      plot.setAttribute('role', 'img')
      plot.setAttribute('aria-label', config.title || '数据图表')
      const controls = element('div', 'teach-chart-controls')
      const state = element('p', 'teach-widget-state is-live')
      state.setAttribute('data-teach-state', '')
      state.setAttribute('aria-live', 'polite')
      const details = document.createElement('details')
      const emptyMessage = element('p', 'teach-widget-state', '当前读数全为零，暂无占比可显示。调整参数后可恢复图表。')
      emptyMessage.hidden = true
      details.className = 'teach-chart-data'
      details.append(element('summary', '', '查看数据表'))
      const table = element('table')
      details.append(table)
      host.append(heading, controls, plot, emptyMessage, details, state)
      const chart = init(plot, undefined, { renderer: 'svg' })
      const initial = config.data.series.map((row: number[]) => [...row])
      const inputs: HTMLInputElement[] = []
      function paint() {
        const style = getComputedStyle(host)
        const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
        const option = getChartOption({
          ...config,
          // The upstream renderer names vertical bars "bar" and horizontal bars "column".
          // Keep the public lesson contract conventional without editing the original converter.
          type: config.type === 'column' ? 'bar' : config.type === 'bar' ? 'column' : config.type,
          themeColors: [token('--accent', '#9c3524'), token('--ink-soft', '#4a423a'), token('--good', '#2c6a4d'), token('--bad', '#a3341f')],
          textColor: token('--ink-soft', '#4a423a'), lineColor: token('--rule', '#d8d0c2')
        })
        if (!option) throw new Error('Unsupported chart')
        // 图表里的数字是这一课最该看清的内容，跟正文同一套字号阶梯（13px，等宽数字）。
        const chartTextSize = 13
        option.textStyle = { ...option.textStyle, fontSize: chartTextSize }
        for (const axis of [option.xAxis, option.yAxis].flat()) {
          if (axis && axis.axisLabel) axis.axisLabel = { ...axis.axisLabel, fontSize: chartTextSize }
          if (axis && axis.name) axis.nameTextStyle = { ...axis.nameTextStyle, fontSize: chartTextSize }
        }
        if (option.legend) option.legend = { ...option.legend, textStyle: { ...option.legend.textStyle, fontSize: chartTextSize } }
        for (const series of option.series || []) {
          series.label = { ...series.label, fontSize: chartTextSize }
        }
        // ECharts' default value labels remain dark even when axes inherit a dark theme.
        // Keep values readable outside bars; other chart types retain their own placement.
        for (const series of option.series || []) {
          series.label = { ...series.label, color: token('--ink', '#16120f'), ...(config.type === 'column' || config.type === 'bar' ? { position: 'outside' } : {}) }
        }
        const emptyShare = (config.type === 'pie' || config.type === 'ring') && config.data.series[0].every((value: number) => value === 0)
        emptyMessage.hidden = !emptyShare
        plot.hidden = emptyShare
        if (emptyShare) chart.clear()
        else {
          chart.resize()
          chart.setOption({ ...option, animation: false, textStyle: { ...option.textStyle, fontFamily: style.fontFamily }, aria: { enabled: true } }, true)
        }
        table.replaceChildren()
        const thead = element('thead')
        const header = element('tr')
        for (const name of ['项目', ...config.data.legends]) header.append(element('th', '', name))
        thead.append(header)
        const tbody = element('tbody')
        config.data.labels.forEach((label: string, index: number) => {
          const row = element('tr')
          row.append(element('th', '', label))
          for (const values of config.data.series) row.append(element('td', 'num', String(values[index])))
          tbody.append(row)
        })
        table.append(thead, tbody)
        state.textContent = (emptyShare ? '当前全为零，暂无占比可显示。' : '') + (config.title || '数据对比') + '。' + config.data.legends.map((name: string, seriesIndex: number) => name + '：' + config.data.labels.map((label: string, index: number) => label + ' ' + config.data.series[seriesIndex][index]).join('，')).join('；')
        for (let index = 0; index < inputs.length; index++) inputs[index].nextElementSibling!.textContent = inputs[index].value
      }
      for (const control of config.controls) {
        const label = element('label', 'teach-chart-control')
        const input = document.createElement('input')
        input.type = 'range'
        input.min = String(control.min)
        input.max = String(control.max)
        input.step = String(control.step)
        input.value = String(control.value)
        input.setAttribute('aria-label', control.label)
        const output = element('output', '', input.value)
        label.append(element('span', '', control.label), input, output)
        controls.append(label)
        config.data.series[control.seriesIndex][control.dataIndex] = Number(input.value)
        input.addEventListener('input', () => {
          config.data.series[control.seriesIndex][control.dataIndex] = Number(input.value)
          paint()
        })
        inputs.push(input)
      }
      if (config.controls.length) {
        const reset = element('button', 'teach-widget-button', '恢复初始参数') as HTMLButtonElement
        reset.type = 'button'
        reset.addEventListener('click', () => {
          config.data.series = initial.map((row: number[]) => [...row])
          config.controls.forEach((control, index: number) => {
            inputs[index].value = String(control.value)
            config.data.series[control.seriesIndex][control.dataIndex] = Number(inputs[index].value)
          })
          paint()
        })
        controls.append(reset)
      }
      paint()
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => chart.resize()) : null
      observer?.observe(plot)
      const resize = () => chart.resize()
      window.addEventListener('resize', resize)
      const dark = window.matchMedia('(prefers-color-scheme: dark)')
      dark.addEventListener('change', paint)
      // Dispose observers when a caller intentionally removes a widget.
      host.addEventListener('teach:dispose', () => {
        observer?.disconnect()
        window.removeEventListener('resize', resize)
        dark.removeEventListener('change', paint)
        chart.dispose()
        delete host.dataset.teachMounted
      }, { once: true })
      host.dataset.teachMounted = 'true'
    } catch {
      host.replaceChildren(element('p', 'teach-widget-error', '图表暂时无法显示，请先继续阅读正文，或请导师检查数据。'))
      host.dataset.teachMounted = 'error'
    }
  }
  document.dispatchEvent(new CustomEvent('teach:components-ready'))
}

declare global { interface Window { teachCharts: { mount: typeof mount } } }
window.teachCharts = { mount }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(), { once: true })
else mount()
