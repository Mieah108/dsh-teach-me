/** Data contracts for local teaching widgets. No expression evaluation or HTML strings. */
const types = new Set(['column', 'bar', 'line', 'area', 'pie', 'ring', 'radar', 'scatter'])
const text = (value, name, optional = false) => {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.length > 10000 || (!optional && !value.trim())) throw new Error(name + '需要填写文字')
  return value
}
const list = (value, name, max) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(name + '为空或条目过多')
  return value
}

export function parseData(kind, source) {
  if (typeof source !== 'string' || source.length > 100000) throw new Error('组件数据过大')
  const raw = JSON.parse(source)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('组件数据需要是对象')
  const title = text(raw.title, '标题', true)
  if (kind === 'flashcards') return {
    title,
    cards: list(raw.cards, '闪卡', 100).map((item) => ({
      front: text(item?.front, '问题'), back: text(item?.back, '答案'), hint: text(item?.hint, '提示', true)
    }))
  }
  if (kind === 'timeline') return {
    title,
    events: list(raw.events, '事件', 100).map((item) => ({
      date: text(item?.date, '时间', true), title: text(item?.title, '事件标题'), description: text(item?.description, '事件说明', true)
    }))
  }
  if (kind === 'chart') {
    if (!types.has(raw.type)) throw new Error('图表类型不受支持')
    const labels = list(raw.data?.labels, '图表标签', 64).map((item) => text(item, '图表标签'))
    const series = list(raw.data?.series, '数据系列', 8).map((values) => {
      if (!Array.isArray(values) || values.length !== labels.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('图表数据需要是与标签等长的有限数值')
      return [...values]
    })
    const legends = list(raw.data?.legends, '系列名称', 8).map((item) => text(item, '系列名称'))
    if (legends.length !== series.length) throw new Error('系列名称与数据数量不一致')
    const share = raw.type === 'pie' || raw.type === 'ring'
    if (share && series.length !== 1) throw new Error('饼图和环图需要且只能有一组数据')
    if (share && (series[0].some((value) => value < 0) || series[0].every((value) => value === 0))) throw new Error('饼图和环图需要非负且至少一项大于零的数据')
    if (raw.type === 'scatter' && series.length !== 2) throw new Error('散点图需要两组数据，分别表示 x 和 y')
    const controls = raw.controls === undefined ? [] : raw.controls
    if (!Array.isArray(controls) || controls.length > 8) throw new Error('控件数量过多')
    const positions = new Set()
    const normalized = controls.map((control) => {
      const seriesIndex = control.seriesIndex ?? 0
      const dataIndex = control.dataIndex ?? 0
      const step = control.step ?? 1
      const value = control.value ?? series[seriesIndex]?.[dataIndex]
      if (!Number.isInteger(seriesIndex) || seriesIndex < 0 || seriesIndex >= series.length || !Number.isInteger(dataIndex) || dataIndex < 0 || dataIndex >= labels.length) throw new Error('控件没有对应的数据位置')
      if (![control.min, control.max, step, value].every((item) => typeof item === 'number' && Number.isFinite(item)) || control.max <= control.min || step <= 0 || value < control.min || value > control.max) throw new Error('控件范围或步长无效')
      if (share && control.min < 0) throw new Error('饼图和环图的控件不能产生负数')
      const ticks = (value - control.min) / step
      if (!Number.isFinite(ticks) || Math.abs(ticks - Math.round(ticks)) > 1e-7) throw new Error('控件初始值需要与步长对齐')
      const position = seriesIndex + ':' + dataIndex
      if (positions.has(position)) throw new Error('同一读数不能重复配置控件')
      positions.add(position)
      return { label: text(control.label, '控件名称'), min: control.min, max: control.max, step, value, seriesIndex, dataIndex }
    })
    return { title, type: raw.type, data: { labels, legends, series }, controls: normalized, stack: raw.stack === true, percentStack: raw.percentStack === true }
  }
  throw new Error('组件类型不受支持')
}
