/**
 * Captures the README screenshots from a RUNNING dsh web instance.
 *
 * The instance must have exactly two plugins installed (dsh-better-sidebar and
 * dsh-ide-git) and be bound to the throwaway demo repository, so nothing private
 * — no real workspace, no wallpaper plugin, no other panel — can end up in the
 * images. Every shot is an element screenshot of the plugin's own root, so only
 * the panel is captured, never the surrounding shell.
 *
 * The panel has two faces (user request 2026-10-19): the default 变更 + 提交框
 * face, and the explorer tab (branch tree | commit list | commit detail) that
 * the rail's branch button opens. Shots 1 and 6 are the default face in the two
 * layouts the panel measures itself into; 2-5 are the explorer tab.
 *
 *   node scripts/demo-repo.mjs /tmp/dsh-ide-git-demo
 *   # a clean DSH_HOME with the two plugins, then:
 *   #   dsh web --port 3099 --no-open
 *   node scripts/screenshots.mjs "http://127.0.0.1:3099/?token=…"
 *
 * Playwright is loaded from the DSH checkout (DSH_CHECKOUT overrides the path).
 */
import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const url = process.argv[2]
if (url === undefined || url === '') {
  console.error('usage: node scripts/screenshots.mjs <web-url-with-token> [out-dir]')
  process.exit(1)
}

const outDir = process.argv[3] === undefined || process.argv[3] === ''
  ? fileURLToPath(new URL('../docs/screenshots/', import.meta.url))
  : process.argv[3]
mkdirSync(outDir, { recursive: true })

function loadPlaywright() {
  const checkout = process.env.DSH_CHECKOUT === undefined || process.env.DSH_CHECKOUT === ''
    ? '/Users/kanna/project/deepseek-harness'
    : process.env.DSH_CHECKOUT
  const store = join(checkout, 'node_modules', '.pnpm')
  const candidates = []
  if (existsSync(store)) {
    for (const name of readdirSync(store)) {
      if (name.indexOf('playwright@') !== 0) continue
      candidates.push(join(store, name, 'node_modules', 'playwright', 'package.json'))
    }
  }
  candidates.push(join(checkout, 'node_modules', 'playwright', 'package.json'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try { return createRequire(candidate)('playwright') } catch (error) { void error }
  }
  throw new Error('playwright not found under ' + checkout + ' (set DSH_CHECKOUT)')
}

const { chromium } = loadPlaywright()
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_SHOT_CHANNEL === undefined ? 'chrome' : process.env.DSH_SHOT_CHANNEL })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })

const log = (message) => console.log('[shot] ' + message)
const settle = (ms) => page.waitForTimeout(ms === undefined ? 1500 : ms)

async function clickText(text, options) {
  const locators = [page.getByRole('button', { name: text, exact: true }), page.getByText(text, { exact: true })]
  for (const locator of locators) {
    try {
      const target = locator.first()
      if (await target.count() === 0) continue
      await target.click({ timeout: options !== undefined && options.timeout !== undefined ? options.timeout : 6000 })
      await settle(options !== undefined && options.wait !== undefined ? options.wait : 1500)
      log('click ' + text)
      return true
    } catch (error) { void error }
  }
  log('MISS ' + text)
  return false
}

/* The panel has two faces (user request 2026-10-19): the DEFAULT one keeps the
   changes list and the commit box, and the explorer tab — opened by the rail's
   branch button — carries the branch tree, the commit list and the commit
   detail. Both can be on screen at once (the faces are separate tabs, and a
   folded dock leaves a zero-sized root behind), so a shot names the face it
   wants and the helper picks the VISIBLE root that owns that face's markup. */
const FACE_MARKUP = { changes: '.dig-changes-list', explore: '[data-pane="tree"]' }

async function shotFace(name, face) {
  const markup = FACE_MARKUP[face]
  if (markup === undefined) throw new Error('unknown face ' + face)
  const target = page.locator('.dig-root:visible:has(' + markup + ')').first()
  if (await target.count() === 0) throw new Error('no visible ' + face + ' panel for ' + name)
  await target.screenshot({ path: join(outDir, name) })
  log('saved ' + name + ' (' + face + ')')
}

/** Every interaction below is scoped to one face's root, so a shot can never
 *  accidentally hit the other face's rows. */
const faceRoot = (face) => page.locator('.dig-root:visible:has(' + FACE_MARKUP[face] + ')').first()

/** The explorer is registered `hidden` — deliberately absent from the base's +
 *  menu and from the sidebar's start page — so the rail's branch button is the
 *  only door, and this is the gesture a user makes. */
async function openExplorer() {
  const button = faceRoot('changes').locator('[data-action="tree"]').first()
  if (await button.count() === 0) throw new Error('the changes face offers no branch button')
  await button.click({ timeout: 8000 })
  await settle(6000)
  if (await faceRoot('explore').count() === 0) {
    throw new Error('the branch button did not open the explorer tab')
  }
  log('explorer tab open')
}

/** The panel remembers its last active tab, so a second run of this script on
 *  the same instance comes back on the explorer — switch back to the default
 *  face through its tab (the same click a user makes) instead of shooting the
 *  wrong pane. A clean profile needs none of this. */
async function ensureChangesFace() {
  if (await faceRoot('changes').count() > 0) return
  await page.locator('button:visible').filter({ hasText: /^Git$/ }).last().click({ timeout: 8000 }).catch(() => {})
  await settle(4000)
  if (await faceRoot('changes').count() === 0) {
    throw new Error('the default (changes) face is not on screen — restart from a clean profile')
  }
  log('switched back to the changes face')
}

/** Boots the clean instance into a session whose workspace is the demo repo. */
async function enterSession() {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await settle(7000)
  await clickText('继续')
  await clickText('稍后配置')
  await clickText('新建会话')
  await settle(2000)
  const editor = page.locator('textarea, [contenteditable="true"]').first()
  await editor.click({ timeout: 8000 })
  await page.keyboard.type('演示截图会话')
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click({ timeout: 8000 })
  await settle(7000)
}

/** Opens the bottom workbench (the wide chrome) and its Git tab. */
async function openBottomPanel() {
  await clickText('展开底部面板')
  await settle(2500)
  const resize = page.locator('.nArs4W_bottomResize').first()
  if (await resize.count() > 0) {
    const box = await resize.boundingBox()
    if (box !== null) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, Math.max(120, box.y - 320), { steps: 14 })
      await page.mouse.up()
      log('resized the workbench')
      await settle(1200)
    }
  }
  await page.locator('.nArs4W_tabBarPlus').first().click({ timeout: 8000 })
  await settle(1500)
  await page.getByText('Git', { exact: true }).first().click({ timeout: 8000 })
  await settle(6000)
}

try {
  await enterSession()
  await openBottomPanel()
  await ensureChangesFace()

  // 1 — the DEFAULT face in the wide bottom workbench: the vertical rail on the
  //     left, the change groups and the commit box in one column. The tree and
  //     the commit list live in the explorer tab (shots 2-5).
  await shotFace('1-bottom-workbench.png', 'changes')

  // 6 — the same face in the narrow right column (compact chrome). The workbench
  //     is folded first so exactly one panel is on screen.
  await page.keyboard.press('Escape')
  await clickText('折叠底部面板')
  await settle(1500)
  await clickText('打开右侧边栏')
  await settle(3000)
  // A freshly opened right sidebar shows its start page, whose cards open a tab
  // directly — no plus menu involved.
  await page.locator('button:visible').filter({ hasText: /^Git$/ }).last().click({ timeout: 8000 })
  await settle(6000)
  await ensureChangesFace()
  await shotFace('6-right-sidebar.png', 'changes')

  // 2..5 — the explorer tab (branch tree | commit list | commit detail), opened
  //     with the rail's branch button exactly as a user would, from the panel
  //     that is on screen right now.
  await openExplorer()

  // 2 — the commit context menu
  await faceRoot('explore').locator('.dig-commit').nth(2).click({ button: 'right' })
  await settle(1200)
  await shotFace('2-commit-menu.png', 'explore')
  await page.keyboard.press('Escape')
  await settle(800)

  // 3 — deleting a branch really deletes it; the toast offers an undo
  const branchRow = faceRoot('explore').locator('.dig-tree .dig-row').filter({ hasText: 'feature/search-index' }).first()
  await branchRow.click({ button: 'right' })
  await settle(1200)
  await page.getByText('删除', { exact: true }).first().click({ timeout: 6000 })
  await settle(1200)
  await page.locator('.dig-dialog .dig-btn-danger').first().click({ timeout: 6000 })
  await settle(3000)
  await shotFace('3-branch-undo.png', 'explore')
  const undoButton = page.locator('.dig-toast-action').first()
  if (await undoButton.count() > 0) {
    await undoButton.click({ timeout: 6000 })
    await settle(3000)
    log('branch restored through undo')
  }

  // 4 — the action rail settings (reorder + show/hide)
  await faceRoot('explore').locator('.dig-rail-settings').first().click({ timeout: 6000 })
  await settle(1500)
  await shotFace('4-rail-settings.png', 'explore')
  await page.locator('.dig-dialog .dig-btn-primary').first().click({ timeout: 6000 })
  await settle(1000)

  // 5 — the commit detail. One click selects a commit; a DOUBLE-click on a file
  //     opens its diff — which this host may take to its own preview tab, so the
  //     diff re-shot below is best-effort and never fails the run.
  await faceRoot('explore').locator('.dig-commit').nth(1).click({ timeout: 6000 })
  await settle(2500)
  await shotFace('5-commit-detail.png', 'explore')
  const detailFile = faceRoot('explore').locator('.dig-detail-files .dig-row').first()
  if (await detailFile.count() > 0) {
    try { await detailFile.dblclick({ timeout: 6000 }) } catch (error) { void error }
    await settle(2500)
    const withDiff = page.locator('.dig-root:visible:has(.dig-diff-pane)').first()
    if (await withDiff.count() > 0) {
      await withDiff.screenshot({ path: join(outDir, '5-commit-detail.png') })
      log('5-commit-detail.png re-shot with the inline diff pane')
    } else {
      log('the diff went to the host preview tab — 5-commit-detail.png keeps the detail')
    }
  }
  log('done')
} finally {
  await browser.close()
}