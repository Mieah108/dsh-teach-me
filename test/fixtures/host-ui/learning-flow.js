const { hostModules } = await import('/host-assets/host-primitives.js')
const React = hostModules.react
const { createRoot } = hostModules['react-dom/client']
const h = React.createElement
const registrations = []
let exports
window.__ModuleLoader__ = { load: ({ factory }) => { exports = factory((name) => { if (Object.hasOwn(hostModules, name)) return hostModules[name]; throw new Error(name) }) } }
new Function(await (await fetch('/client.js')).text())()
exports.apply({
  effect: (factory) => factory(), locale: { register: () => () => {}, bind: () => (key) => exports.copy.zh[key] || key },
  configForms: { get: () => ({}), whileServed: (_entries, factory) => factory() },
  slots: { inject: (_name, factory) => factory(), register: (descriptor, component) => { registrations.push({ descriptor, component }); return () => {} } },
  sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openTab() {} }
})
const Courses = registrations.find((r) => r.descriptor.key === 'dsh-teach-me/courses' && r.descriptor.name === 'sidebar.right.pane.tab').component
const Classroom = registrations.find((r) => r.descriptor.key === 'dsh-teach-me' && r.descriptor.name === 'sidebar.right.pane.tab').component
const t = (key) => exports.copy.zh[key] || key
window.__flow = { calls: [] }
async function rpc(endpoint, payload, options = {}) {
  window.__flow.calls.push({ endpoint, payload })
  return (await fetch('/teach-classroom/rpc/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.ticket ? { 'x-teach-classroom': options.ticket } : {}) }, body: JSON.stringify({ payload }) })).json()
}
function App() {
  const [sessionId, setSession] = React.useState('session-a')
  const [lesson, setLesson] = React.useState(null)
  return h('div', {}, [
    h('nav', { key: 'nav' }, ['session-a', 'session-b'].map((id) => h('button', { key: id, onClick: () => { setSession(id); setLesson(null) } }, id))),
    h('div', { key: 'dock', id: 'dock' }, h(exports.TeachingDock, { key: sessionId, sessionId, session: { projectionValues: { agentPreset: 'teach' } }, t, callRpc: rpc })),
    h('div', { key: 'panes', style: { display: 'grid', gridTemplateColumns: '340px minmax(0,1fr)', height: '760px', gap: '24px' } }, [
      h('div', { key: 'courses', id: 'courses', style: { minHeight: 0 } }, h(Courses, { key: sessionId, t, sessionId, callRpc: rpc, openLessonById: (lessonId, collectionId, contentVersion) => setLesson({ lessonId, collectionId, contentVersion }) })),
      h('div', { key: 'classroom', id: 'classroom', style: { minHeight: 0 } }, lesson ? h(Classroom, { key: JSON.stringify(lesson) + sessionId, t, sessionId, useTabInfo: () => ({ tab: { navigation: { params: lesson, address: '' } } }), callRpc: rpc, lesson: (lessonId, collectionId, contentVersion) => rpc('classroom/open', { sessionId, lessonId, collectionId, contentVersion }), address: () => {}, openCourses: () => true }) : null)
    ])
  ])
}
createRoot(document.getElementById('root')).render(h(App))
