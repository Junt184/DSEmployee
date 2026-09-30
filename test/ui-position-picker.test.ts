/**
 * 控制台岗位选择器（跑交付脚本里的真源码）。
 *
 * 两个容易写错、写错了又不报错的地方：
 *   · positionName()：岗位不在目录里时**原样显示 id**，而不是显示空白 ——
 *     空白会让人以为"这个员工没岗位"，而事实是"目录被改过/还没加载"；
 *   · buildPositionPicker().read()：三种结果对应两条保存路径（已存在的 id 直接用 /
 *     新名字要先 upsert / 什么都没选）—— 混合了就会建出指向不存在岗位的员工。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderControlUiScript } from '../src/web/ui.ts'

const SCRIPT = renderControlUiScript()

function extractFunction(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `交付脚本里找不到 function ${name}(`)
  let depth = 0
  for (let index = SCRIPT.indexOf('{', start); index < SCRIPT.length; index += 1) {
    const char = SCRIPT[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return SCRIPT.slice(start, index + 1)
    }
  }
  throw new Error(`function ${name} 的花括号没有配对`)
}

interface FakeNode {
  tag: string
  className: string
  textContent: string
  value: string
  type: string
  maxLength: number
  placeholder: string
  children: FakeNode[]
  classes: Set<string>
  parent: FakeNode | null
  appendChild(child: FakeNode): FakeNode
  classList: { toggle(name: string, on: boolean): void; add(name: string): void; contains(name: string): boolean }
  onchange: (() => void) | null
  focus(): void
}

function makeNode(tag = 'div', className = '', text = ''): FakeNode {
  const node: FakeNode = {
    tag,
    className,
    textContent: text,
    value: '',
    type: '',
    maxLength: 0,
    placeholder: '',
    children: [],
    classes: new Set(className === '' ? [] : className.split(' ')),
    parent: null,
    onchange: null,
    appendChild(child) {
      child.parent = node
      node.children.push(child)
      return child
    },
    classList: {
      toggle(name, on) {
        if (on) node.classes.add(name)
        else node.classes.delete(name)
      },
      add(name) {
        node.classes.add(name)
      },
      contains(name) {
        return node.classes.has(name)
      },
    },
    focus() {
      /* 无操作：测试不关心焦点 */
    },
  }
  return node
}

function makePickerHarness(positions: unknown[], currentId?: string) {
  const scope = {
    state: { positions },
    el: (tag: string, className?: string, text?: string) => makeNode(tag, className ?? '', text ?? ''),
    positionList: undefined as unknown,
  }
  const factory = new Function(
    'scope',
    `with (scope) {
      ${extractFunction('positionList')}
      ${extractFunction('buildPositionPicker')}
      return { buildPositionPicker }
    }`,
  ) as (scope: unknown) => { buildPositionPicker: (id?: string) => any }
  const api = factory(scope)
  const picker = api.buildPositionPicker(currentId)
  const select = picker.root.children[0] as FakeNode
  const input = picker.root.children[1] as FakeNode
  return { picker, select, input }
}

const CATALOG = [
  { id: 'general', name: '通用', panels: [], builtin: true },
  { id: 'pentest', name: '渗透测试', panels: [] },
]

describe('岗位显示名映射', () => {
  it('目录里有该 id → 显示名', () => {
    const scope = {
      state: { positions: CATALOG },
      positionList: undefined as unknown,
    }
    const factory = new Function(
      'scope',
      `with (scope) { ${extractFunction('positionList')} ${extractFunction('positionName')}
        return { positionName } }`,
    ) as (scope: unknown) => { positionName: (id?: string) => string }
    const { positionName } = factory(scope)
    assert.equal(positionName('pentest'), '渗透测试')
  })

  it('通用岗位不显示徽章（每张卡都挂一枚无信息量的标签是噪声）', () => {
    const factory = new Function(
      'scope',
      `with (scope) { ${extractFunction('positionList')} ${extractFunction('positionName')}
        return { positionName } }`,
    ) as (scope: unknown) => { positionName: (id?: string) => string }
    const { positionName } = factory({ state: { positions: CATALOG } })
    assert.equal(positionName('general'), '')
    assert.equal(positionName(''), '')
    assert.equal(positionName(undefined), '')
  })

  it('目录里没有该 id → 原样显示 id（不假装它不存在）', () => {
    const factory = new Function(
      'scope',
      `with (scope) { ${extractFunction('positionList')} ${extractFunction('positionName')}
        return { positionName } }`,
    ) as (scope: unknown) => { positionName: (id?: string) => string }
    const { positionName } = factory({ state: { positions: CATALOG } })
    assert.equal(positionName('deleted-one'), 'deleted-one')
  })
})

describe('岗位下拉的行为', () => {
  it('默认选中当前岗位；未设岗位时落在「通用」', () => {
    assert.equal(makePickerHarness(CATALOG, 'pentest').select.value, 'pentest')
    assert.equal(makePickerHarness(CATALOG, undefined).select.value, 'general')
  })

  it('选项来自目录，最后一项永远是「＋ 新增岗位」', () => {
    const { select } = makePickerHarness(CATALOG, 'general')
    const values = select.children.map((child) => child.value)
    assert.deepEqual(values, ['general', 'pentest', '__new_position__'])
  })

  it('绑定了一个已不在目录里的岗位时不丢绑定：补一条占位项', () => {
    const { select } = makePickerHarness(CATALOG, 'legacy-x')
    const values = select.children.map((child) => child.value)
    assert.ok(values.includes('legacy-x'), '当前绑定必须仍可选中（否则一保存就把它改掉了）')
    assert.equal(select.value, 'legacy-x')
  })

  it('read()：已存在的岗位给 id；选了＋新增且填了名字给 newName；没填名字给空', () => {
    const a = makePickerHarness(CATALOG, 'general')
    assert.deepEqual(a.picker.read(), { id: 'general' })

    const b = makePickerHarness(CATALOG, 'general')
    b.select.value = '__new_position__'
    b.input.value = '  风控审计  '
    assert.deepEqual(b.picker.read(), { newName: '风控审计' }, '名字要 trim')

    const c = makePickerHarness(CATALOG, 'general')
    c.select.value = '__new_position__'
    c.input.value = '   '
    assert.deepEqual(c.picker.read(), {}, '没填名字就不该走"新增"这条路')
  })

  it('选中「＋ 新增岗位」才显示输入框（否则那一行永远是空的）', () => {
    const { select, input } = makePickerHarness(CATALOG, 'general')
    assert.equal(input.classes.has('hidden'), true, '初始隐藏')
    select.value = '__new_position__'
    select.onchange?.()
    assert.equal(input.classes.has('hidden'), false, '选中新增项后要露出来')
    select.value = 'general'
    select.onchange?.()
    assert.equal(input.classes.has('hidden'), true, '换回已有岗位要收起来')
  })
})
