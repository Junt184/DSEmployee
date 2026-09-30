/**
 * 员工级 LLM 端点配置的单元测试（v2：一个员工挂多条模型）。
 *
 * dsh 用最小的假对象（只记录调用）——接线逻辑要验证的是"我们往 dsh 发了什么"，
 * dsh 自己的行为由它的上游测试负责。probe 用本机临时 HTTP 服务器，不打外网。
 *
 * 这一组里最要紧的一条是**迁移不改路由名**：旧会话记录的 provider 就是路由名，
 * 迁移时把它改掉 = 那些会话当场失联（真实事故：一个旧会话因此天天 402，
 * 而界面上明明配好了新 key）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  activeModelOf,
  assertLlmApiUrl,
  deleteLlmConfig,
  llmEnvRefFor,
  llmRouteFor,
  llmViewModel,
  migrateV1,
  maskApiKey,
  modelEnvRefFor,
  modelRouteFor,
  newModelId,
  normalizeModelName,
  probeModels,
  readLlmFile,
  selectModelForSession,
  unwireModelFromDsh,
  wireModelToDsh,
  writeLlmFile,
} from '../src/node/employee-llm.ts'
import type { DshClient } from '../src/node/dsh-client.ts'

/** 只记录调用的假 dsh。 */
function fakeDsh(): { dsh: DshClient; calls: Array<{ method: string; payload: unknown }> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const dsh = {
    call: async (method: string, payload: unknown) => {
      calls.push({ method, payload })
      return {}
    },
  } as unknown as DshClient
  return { dsh, calls }
}

describe('员工 LLM 端点配置', () => {
  it('apiKey 掩码：露前三后四，短 key 全码', () => {
    assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-…cdef')
    assert.equal(maskApiKey('short'), '***')
  })

  it('llm.json 存取：写在工作区 .dsemployee 下、属主可读、可删', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-llm-test-'))
    try {
      const workspace = path.join(root, 'employee-x')
      const entry = {
        id: newModelId(),
        name: 'gpt5.6-noelle',
        endpointId: 'ep_1',
        apiUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
        model: 'gpt5.6',
      }
      await writeLlmFile(workspace, { version: 2, activeId: entry.id, models: [entry] })
      const file = path.join(workspace, '.dsemployee', 'llm.json')
      const info = await stat(file)

      // 权限位的断言只在类 POSIX 平台上做。
      // Windows 的 fs.stat().mode 不反映 POSIX 位（通常恒为 0o666），
      // 那里的文件访问由 ACL 决定 —— 断言 0o600 会永远失败，
      // 而它失败的原因与"apiKey 是否被保护"无关，纯粹是平台语义差异。
      // 与 src/util/identity.ts 里对私钥权限的处理保持同一套判断。
      if (process.platform !== 'win32') {
        assert.equal(info.mode & 0o777, 0o600, 'apiKey 落盘必须 0o600')
      } else {
        assert.ok(info.isFile(), 'llm.json 必须落盘为普通文件')
      }

      const read = await readLlmFile(workspace)
      assert.equal(read?.version, 2)
      assert.equal(read?.models[0]?.name, 'gpt5.6-noelle')
      assert.equal(read?.models[0]?.apiKey, 'sk-secret')
      assert.equal(activeModelOf(read)?.model, 'gpt5.6')

      await deleteLlmConfig(workspace)
      assert.equal(await readLlmFile(workspace), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('v1 → v2 迁移：**路由名必须原地不动**（旧会话记录的就是它），且自动落盘', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-llm-migrate-'))
    try {
      const workspace = path.join(root, 'employee-old')
      const employeeId = 'emp_a30a359d723e154741fc0ef0'
      await writeLlmFile(workspace, {
        version: 2,
        models: [],
      })
      /* 手工写一份 v1 形状（老节点留下的），再读回来 */
      const legacy = {
        apiUrl: 'https://old.example.com/v1',
        apiKey: 'sk-old',
        model: 'old-model',
        wiredAtMs: 123,
      }
      const { writeJsonFile } = await import('../src/util/fsx.ts')
      await writeJsonFile(path.join(workspace, '.dsemployee', 'llm.json'), legacy, 0o600)

      const read = await readLlmFile(workspace)
      assert.equal(read?.version, 2, '读一次就该迁移到 v2')
      const entry = read?.models[0]
      assert.ok(entry !== undefined)
      assert.equal(entry.name, 'old-model', '别名先沿用模型 id（用户随时可改）')
      assert.equal(entry.endpointId, '', '迁移来的算"本地端点"，还没收进端点库')
      assert.equal(entry.apiKey, 'sk-old', 'key 不能在迁移里丢')
      assert.equal(entry.legacyRoute, true, '必须带上"沿用它原来的路由名"的标记')
      assert.equal(
        modelRouteFor(employeeId, entry),
        llmRouteFor(employeeId),
        '**迁移不许改路由名** —— 旧会话记录的是这个名字，改了它们当场失联',
      )
      assert.equal(modelEnvRefFor(employeeId, entry), llmEnvRefFor(employeeId))

      /* 迁移是幂等的：再读一次仍是同一条，且不会重复追加 */
      const again = await readLlmFile(workspace)
      assert.equal(again?.models.length, 1)
      assert.equal(again?.models[0]?.id, entry.id)
      assert.equal(again?.models[0]?.legacyRoute, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrateV1 的形状：当前模型指向那一条，且不带任何"库"信息', () => {
    const file = migrateV1({ apiUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3' })
    assert.equal(file.models.length, 1)
    assert.equal(file.activeId, file.models[0]?.id)
    assert.equal(file.models[0]?.endpointId, '')
  })

  it('别名规则：空/纯空白/超长一律拒绝（界面上认的就是它）', () => {
    assert.equal(normalizeModelName('  gpt5.6-noelle  '), 'gpt5.6-noelle')
    assert.throws(() => normalizeModelName('   '), /别名不能为空/)
    assert.throws(() => normalizeModelName(undefined), /别名不能为空/)
    assert.throws(() => normalizeModelName('x'.repeat(65)), /最多 64 字/)
  })

  it('每条模型有**自己**的路由名与凭据名（同实例互不覆盖）', () => {
    const employeeId = 'emp_831bf9834ed9417ad72d25e6'
    const a = { id: 'm_aaaaaaaaaaaa', legacyRoute: false }
    const b = { id: 'm_bbbbbbbbbbbb', legacyRoute: false }
    const routeA = modelRouteFor(employeeId, a)
    const routeB = modelRouteFor(employeeId, b)
    assert.notEqual(routeA, routeB)
    assert.ok(routeA.startsWith(llmRouteFor(employeeId)))
    assert.notEqual(modelEnvRefFor(employeeId, a), modelEnvRefFor(employeeId, b))
    assert.match(modelEnvRefFor(employeeId, a), /_API_KEY$/)
  })

  it('URL 校验：只允许 http/https', () => {
    assert.equal(assertLlmApiUrl('https://api.example.com/v1').host, 'api.example.com')
    assert.equal(assertLlmApiUrl('http://192.168.1.5:11434/v1').host, '192.168.1.5:11434')
    assert.throws(() => assertLlmApiUrl('file:///etc/passwd'), /只允许 http\/https/)
    assert.throws(() => assertLlmApiUrl('ftp://x'), /只允许 http\/https/)
    assert.throws(() => assertLlmApiUrl('不是 URL'), /合法 URL/)
  })

  it('接线：声明这条模型自己的路由 + 按"员工+条目"唯一的凭据名；无 key 时不写凭据', async () => {
    const { dsh, calls } = fakeDsh()
    const employeeId = 'emp_a30a359d723e154741fc0ef0'
    const entry = {
      id: 'm_1234567890ab',
      name: 'gpt5.6-noelle',
      endpointId: 'ep_1',
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret',
      model: 'gpt5.6',
    }
    await wireModelToDsh(dsh, employeeId, '小艾', entry)

    const setCred = calls.find((c) => c.method === 'credentials.set')
    assert.ok(setCred !== undefined)
    assert.equal(
      (setCred.payload as { ref: string }).ref,
      modelEnvRefFor(employeeId, entry),
      '凭据名按"员工+条目"派生，同实例互不覆盖',
    )

    const mutate = calls.find((c) => c.method === 'settings.mutate')
    assert.ok(mutate !== undefined)
    const op = (mutate.payload as { ops: Array<{ path: string[]; value: Record<string, unknown> }> }).ops[0]
    assert.deepEqual(op?.path, ['providers', modelRouteFor(employeeId, entry)])
    assert.equal(op?.value['api'], 'openai-completions')
    assert.equal(op?.value['baseURL'], 'https://api.example.com/v1')
    assert.equal(op?.value['apiKeyEnv'], modelEnvRefFor(employeeId, entry))
    assert.deepEqual(op?.value['models'], [{ id: 'gpt5.6' }])
    assert.match(String(op?.value['displayName']), /小艾 · gpt5.6-noelle/, '显示名带上别名，排障时一眼看出是谁的哪条')

    // 无 key：不写凭据，声明里也不带 apiKeyEnv
    const bare = fakeDsh()
    const bareEntry = { ...entry, id: 'm_ffffffffffff', apiKey: undefined }
    await wireModelToDsh(bare.dsh, employeeId, '小艾', bareEntry)
    assert.equal(bare.calls.some((c) => c.method === 'credentials.set'), false)
    const bareOp = (
      bare.calls.find((c) => c.method === 'settings.mutate')?.payload as {
        ops: Array<{ value: Record<string, unknown> }>
      }
    ).ops[0]
    assert.equal(bareOp?.value['apiKeyEnv'], undefined)
  })

  it('拆线：删这条模型的路由声明 + 凭据（幂等，dsh 报错也不抛出）', async () => {
    const calls: string[] = []
    const dsh = {
      call: async (method: string) => {
        calls.push(method)
        throw new Error('dsh 不在（故意）')
      },
    } as unknown as DshClient
    await unwireModelFromDsh(dsh, 'emp_a30a359d723e154741fc0ef0', {
      id: 'm_abcdefabcdef',
      legacyRoute: false,
    })
    assert.deepEqual(calls, ['settings.mutate', 'credentials.unset'], '两件事都要尝试，且都不抛出')
  })

  it('选会话模型：成功/失败都如实回报（失败不抛 —— 调用方决定怎么报）', async () => {
    const ok = await selectModelForSession(
      { call: async () => ({}) } as unknown as DshClient,
      'session-1',
      'dse-emp-x',
      'gpt5.6',
    )
    assert.equal(ok.ok, true)
    const bad = await selectModelForSession(
      {
        call: async () => {
          throw new Error('回合进行中')
        },
      } as unknown as DshClient,
      'session-1',
      'dse-emp-x',
      'gpt5.6',
    )
    assert.equal(bad.ok, false)
    assert.match(String(bad.note), /回合进行中/)
  })

  it('对外视图：只回掩码，且标出哪条是当前', () => {
    const file = {
      version: 2 as const,
      activeId: 'm_1',
      models: [
        {
          id: 'm_1',
          name: 'gpt5.6-noelle',
          endpointId: 'ep_1',
          apiUrl: 'https://a.example.com/v1',
          apiKey: 'sk-1234567890abcdef',
          model: 'gpt5.6',
          wiredAtMs: 1,
        },
        {
          id: 'm_2',
          name: '本地 ollama',
          endpointId: '',
          apiUrl: 'http://192.168.1.5:11434/v1',
          model: 'qwen3',
        },
      ],
    }
    const view = llmViewModel('emp_x', file)
    assert.equal(view.configured, true)
    assert.equal(view.activeName, 'gpt5.6-noelle')
    assert.equal(view.models[0]?.keyMask, 'sk-…cdef')
    assert.equal(view.models[1]?.hasKey, false)
    assert.equal(JSON.stringify(view).includes('sk-1234567890abcdef'), false, '视图里绝不能出现完整 key')
    assert.equal(view.models[0]?.active, true)
    assert.equal(view.models[1]?.active, false)
    assert.equal(view.models[1]?.wired, false)
  })

  describe('probe（本机临时 HTTP 服务器，不打外网）', () => {
    async function withServer(
      handler: (req: { headers: Record<string, unknown> }) => {
        status: number
        body: unknown
        /** 额外响应头：用来模拟"对方套了 Cloudflare"这类边缘拦截 */
        headers?: Record<string, string>
      },
      run: (baseUrl: string) => Promise<void>,
    ): Promise<void> {
      const server: Server = createServer((req, res) => {
        const out = handler({ headers: req.headers })
        res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      try {
        await run(`http://127.0.0.1:${port}/v1`)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    it('正常返回 OpenAI 形状的模型列表，Bearer 头带上了 key', async () => {
      await withServer(
        (req) => {
          assert.equal(req.headers['authorization'], 'Bearer sk-probe')
          return { status: 200, body: { data: [{ id: 'm1' }, { id: 'm2' }, { noId: true }] } }
        },
        async (baseUrl) => {
          const result = await probeModels(baseUrl, 'sk-probe')
          assert.deepEqual(result.models, ['m1', 'm2'])
        },
      )
    })

    it('403 且带 Cloudflare 标记 ⇒ 说清"这不一定是 key 错了"（真实案例）', async () => {
      /* 用户那次：端点在 Cloudflare 后面，CF 对所有非浏览器来源直接 403。
         当时的消息是"API Key 不对或没填"，把人送去查一个完全无辜的 key。 */
      await withServer(
        () => ({ status: 403, headers: { 'cf-ray': 'a41759ee6c8cc3ca-SEA', server: 'cloudflare' }, body: '<html>Attention Required!</html>' }),
        async (baseUrl) => {
          await assert.rejects(
            () => probeModels(baseUrl, 'sk-perfectly-fine'),
            (error: unknown) => {
              const message = String((error as { message?: string }).message ?? '')
              assert.match(message, /Cloudflare/)
              assert.match(message, /不一定是 key 错了/)
              assert.match(message, /白名单/, '要给出下一步该做什么')
              return true
            },
          )
        },
      )
    })

    it('普通 403（没有 CF 标记）也说"不一定是 key 错了"，但不冒充知道原因', async () => {
      await withServer(
        () => ({ status: 403, body: { error: 'forbidden' } }),
        async (baseUrl) => {
          await assert.rejects(
            () => probeModels(baseUrl, 'sk-x'),
            (error: unknown) => {
              const message = String((error as { message?: string }).message ?? '')
              assert.match(message, /不一定是 key 错了/)
              assert.doesNotMatch(message, /Cloudflare/, '没有证据就不要点名 Cloudflare')
              return true
            },
          )
        },
      )
    })

    it('401 → 可读的凭据错误；非 JSON → 可读的"非 OpenAI 兼容"错误', async () => {
      await withServer(
        () => ({ status: 401, body: { error: 'nope' } }),
        async (baseUrl) => {
          await assert.rejects(() => probeModels(baseUrl, 'sk-bad'), /拒绝了凭据/)
        },
      )
      await withServer(
        () => ({ status: 200, body: '<html>nope</html>' }),
        async (baseUrl) => {
          await assert.rejects(() => probeModels(baseUrl, undefined), /不是 JSON/)
        },
      )
      await withServer(
        () => ({ status: 200, body: { models: [] } }),
        async (baseUrl) => {
          await assert.rejects(() => probeModels(baseUrl, undefined), /data 数组/)
        },
      )
    })
  })
})
