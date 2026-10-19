/**
 * Local SSR self-check for the client half (not part of CI).
 *
 * Renders the registered tab once with react-dom/server against the react
 * copied in the local web profile: this is what catches "renders and throws"
 * regressions (a t() call that is not a function, a TDZ reference in a hooks
 * dependency array, a missing dictionary key) without opening a browser.
 *
 *   node scripts/ssr-check.mjs
 *
 * Skips silently when no web profile is present, so it never blocks anything.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
const profileManifest = join(dshHome, 'profiles', 'web', 'package.json')

if (!existsSync(profileManifest)) {
  console.log('ssr-check: skipped (no web profile at ' + profileManifest + ')')
  process.exit(0)
}

const require = createRequire(profileManifest)
let React
let renderToStaticMarkup
try {
  React = require('react')
  renderToStaticMarkup = require('react-dom/server').renderToStaticMarkup
} catch (error) {
  console.log('ssr-check: skipped (react not resolvable from the profile: ' + error.message + ')')
  process.exit(0)
}

const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

let capturedSpec = null
define('window', {
  __ModuleLoader__: { load: (spec) => { capturedSpec = spec } },
  localStorage: { getItem: () => null, setItem: () => {} },
})
define('document', { createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }), head: { appendChild() {} } })
define('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {} } })
define('fetch', async () => ({ status: 200, json: async () => ({ ok: true, data: {} }) }))

await import('file://' + join(repoRoot, 'src', 'client.js'))
if (capturedSpec === null) throw new Error('client half did not register itself with window.__ModuleLoader__')

const plugin = capturedSpec.factory((name) => {
  if (name === 'react') return React
  throw new Error('client half required a non-baseline module: ' + name)
})
if (typeof plugin.apply !== 'function') throw new Error('factory did not return an apply()')

/* Door 1 — dsh-better-sidebar is loaded: it hosts the tabs (and the bottom
   workbench with them). v0.20 registers TWO: the changes panel, and the
   explorer tab the panel's branch button opens. Both faces render here — the
   explorer is where the tree/log/detail markup lives, so the SSR check has to
   pull both descriptors apart instead of keeping the last one. */
const tabs = {}
const betterSidebar = { registerTab: (descriptor) => { tabs[descriptor.id] = descriptor; return () => {} } }
const ctx = {
  effect: (fn) => fn(),
  get: (name) => (name === 'betterSidebar' ? betterSidebar : undefined),
  inject: (deps, callback) => { callback(ctx) },
}
plugin.apply(ctx)
if (Object.keys(tabs).length === 0) throw new Error('apply() did not register a tab')

const panelTab = tabs['dsh-ide-git:panel']
const exploreTab = tabs['dsh-ide-git:explore']
if (panelTab === undefined) throw new Error('apply() did not register the changes panel tab')
if (exploreTab === undefined) throw new Error('apply() did not register the explorer tab')

const propsFor = (tab) => ({
  ctx, store: {},
  scope: { sessionId: 'ssr', cwd: '/tmp/ssr-workspace' },
  tab: { id: tab.id, type: tab.id, title: 'Git' },
  visible: true,
})
// A server render never runs effects, so the panel is stuck in its initial state:
// the workspace scan is still running (v0.5.4 shows a neutral loading state
// there — the old render printed "no repository found", a verdict nobody had
// reached). The chrome that only exists once a repository is known (picker,
// rail, branch tree, history, changes) is therefore NOT covered here — the
// assertions below pin the shell, and everything else relies on the real
// page. The TDZ class of bug is still caught, because a hooks dependency
// array is evaluated during render.
const props = propsFor(panelTab)
const html = renderToStaticMarkup(React.createElement(panelTab.component, props))
const needles = ['dig-root', 'dig-topbar', 'dig-shell', 'dig-empty']
for (const needle of needles) {
  if (html.indexOf(needle) < 0) throw new Error('rendered output is missing: ' + needle)
}
console.log('ssr-check: tab ' + panelTab.id + ' (' + panelTab.title() + ') rendered ' + html.length + ' chars - OK')

const exploreHtml = renderToStaticMarkup(React.createElement(exploreTab.component, propsFor(exploreTab)))
for (const needle of needles) {
  if (exploreHtml.indexOf(needle) < 0) throw new Error('the explorer render is missing: ' + needle)
}
console.log('ssr-check: tab ' + exploreTab.id + ' (' + exploreTab.title() + ') rendered ' + exploreHtml.length + ' chars - OK')

const empty = renderToStaticMarkup(React.createElement(panelTab.component, Object.assign({}, props, { scope: { sessionId: 'ssr-2' } })))
if (empty.length === 0) throw new Error('rendering without a cwd produced nothing')
console.log('ssr-check: workspace-less render ' + empty.length + ' chars - OK')

/* Door 2 — no better-sidebar: the plugin must fall back to DSH's own
   right-sidebar seats, and must register a guide entry so the tab is actually
   reachable (the guide is the only door into a page type). v0.14 registers a
   SECOND type — the guide-less preview tab (it opens itself from a diff verb,
   never from the start page) — and v0.20 a THIRD, the guide-less explorer
   (the changes panel's branch button opens it). Keyed by id, or the last
   registration would silently stand in for all of them. */
const nativeDefinitions = {}
const nativeBodies = {}
const sidebarRightTabs = {
  register: (definition) => {
    nativeDefinitions[definition.id] = definition
    return () => {}
  },
}
const slots = {
  inject: (name, callback) => callback(),
  register: (options, component) => {
    if (options.name === 'sidebar.right.pane.tab') nativeBodies[options.key] = component
    return () => {}
  },
}
const nativeCtx = {
  effect: (fn) => fn(),
  get: (name) => (name === 'sidebarRightTabs' ? sidebarRightTabs : name === 'slots' ? slots : undefined),
  /* Two different waits on this host: better-sidebar NEVER arrives (its
     callback stays pending forever), while the native seats DO arrive —
     their wait callback must run, exactly as cordis runs it once
     ui-sidebar-right provides the registry. Model both, or the check hides
     the very ordering bug v0.5.3 fixed. */
  inject: (deps, callback) => {
    if (Array.isArray(deps) && deps.includes('sidebarRightTabs')) callback(nativeCtx)
    return { dispose: () => {} }
  },
}
plugin.apply(nativeCtx)
const nativeDefinition = nativeDefinitions['dsh-ide-git']
const previewDefinition = nativeDefinitions['dsh-ide-git-preview']
const exploreDefinition = nativeDefinitions['dsh-ide-git-explore']
if (nativeDefinition === undefined) throw new Error('the native fallback registered no tab type')
if (previewDefinition === undefined) throw new Error('the native fallback registered no preview tab type')
if (exploreDefinition === undefined) throw new Error('the native fallback registered no explorer tab type')
const nativeBody = nativeBodies['dsh-ide-git']
const previewBody = nativeBodies['dsh-ide-git-preview']
const exploreBody = nativeBodies['dsh-ide-git-explore']
if (nativeBody === null || nativeBody === undefined) throw new Error('the native fallback registered no tab body')
if (previewBody === null || previewBody === undefined) throw new Error('the native fallback registered no preview tab body')
if (exploreBody === null || exploreBody === undefined) throw new Error('the native fallback registered no explorer tab body')
const guide = nativeDefinition.guide
if (typeof nativeDefinition.kind !== 'string' || nativeDefinition.kind === ''
  || !Array.isArray(guide) || guide.length === 0) {
  throw new Error('the native tab type needs a kind and at least one guide entry, or nothing opens it')
}
if (Array.isArray(previewDefinition.guide) && previewDefinition.guide.length > 0) {
  throw new Error('the preview tab must stay OFF the guide page (it opens itself from a diff verb)')
}
/* The explorer is the changes panel's own door, so the start page must keep its
   single Git card: no guide entry, and `hidden` on the better-sidebar side. */
if (Array.isArray(exploreDefinition.guide) && exploreDefinition.guide.length > 0) {
  throw new Error('the explorer tab must stay OFF the guide page (the rail branch button opens it)')
}
if (exploreTab.hidden !== true) throw new Error('the better-sidebar explorer must register with hidden: true')
const nativeHtml = renderToStaticMarkup(React.createElement(nativeBody, {
  sessionId: 'ssr-native',
  useWorkspaces: (selector) => selector({ items: [{ path: '/tmp/ssr-workspace', sessionIds: ['ssr-native'] }] }),
}))
if (nativeHtml.indexOf('dig-root') < 0) throw new Error('the native seat rendered no panel')
console.log('ssr-check: native right-sidebar seat rendered ' + nativeHtml.length + ' chars - OK')
const exploreNativeHtml = renderToStaticMarkup(React.createElement(exploreBody, {
  sessionId: 'ssr-native',
  useWorkspaces: (selector) => selector({ items: [{ path: '/tmp/ssr-workspace', sessionIds: ['ssr-native'] }] }),
}))
for (const needle of needles) {
  if (exploreNativeHtml.indexOf(needle) < 0) throw new Error('the native explorer seat is missing: ' + needle)
}
console.log('ssr-check: native explorer seat rendered ' + exploreNativeHtml.length + ' chars - OK')
const previewHtml = renderToStaticMarkup(React.createElement(previewBody, { sessionId: 'ssr-native' }))
if (previewHtml.indexOf('dig-preview-root') < 0) throw new Error('the preview seat rendered no body')
console.log('ssr-check: native preview tab rendered ' + previewHtml.length + ' chars - OK')
