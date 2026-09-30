/**
 * 员工互调授权（ACL）。
 *
 * 匹配语义刻意做得可预测 —— 授权判定出错要么放行不该放行的调用，要么卡死正常协作，
 * 所以规则必须能一眼看懂：
 *
 *   1. 一条规则命中需 `from` 与 `to` 同时匹配（`'*'` 为通配）。
 *   2. **最具体者优先**：`from`/`to` 都不是通配的规则 > 一个通配 > 两个通配。
 *   3. 同具体度时 `deny` > `approve` > `allow`（冲突时朝更安全的方向收敛）。
 *   4. 无任何规则命中 → 采用默认效果（见下）。
 *
 * 默认效果选 `'approve'` 而不是 `'deny'`：'deny' 虽然最安全，但会让平台开箱即不可用；
 * 'approve' 是"要么有人明确批准、要么有人明确写规则允许"，仍是人工在环的 fail-closed。
 * 想更严的部署可以把 `DEFAULT_ACL_EFFECT` 改成 'deny'（此时必须显式写 allow 规则）。
 */

import { newId } from '../util/fsx.ts'
import type { AclEffect, AclRule } from './types.ts'

export const DEFAULT_ACL_EFFECT: AclEffect = 'approve'

/** 效果的安全优先级：数字越大越"保守"。 */
const EFFECT_SAFETY: Readonly<Record<AclEffect, number>> = {
  allow: 0,
  approve: 1,
  deny: 2,
}

export interface AclDecision {
  effect: AclEffect
  /** 命中的规则 id；未命中任何规则时为 undefined（说明走了默认效果） */
  matchedRuleId?: string
  /** 面向人的解释，会展示在审批界面与日志里 */
  reason: string
}

function matches(rule: AclRule, from: string, to: string): boolean {
  const fromOk = rule.from === '*' || rule.from === from
  const toOk = rule.to === '*' || rule.to === to
  return fromOk && toOk
}

function specificity(rule: AclRule): number {
  return (rule.from === '*' ? 0 : 1) + (rule.to === '*' ? 0 : 1)
}

/** 对一次"员工 A 调用员工 B"给出授权决定。 */
export function evaluateAcl(
  rules: readonly AclRule[],
  from: string,
  to: string,
  defaultEffect: AclEffect = DEFAULT_ACL_EFFECT,
): AclDecision {
  const hits = rules.filter((rule) => matches(rule, from, to))
  if (hits.length === 0) {
    return {
      effect: defaultEffect,
      reason:
        defaultEffect === 'approve'
          ? '没有匹配的授权规则，按默认策略需要人工审批'
          : '没有匹配的授权规则，按默认策略拒绝',
    }
  }

  const best = hits.reduce((winner, candidate) => {
    const ws = specificity(winner)
    const cs = specificity(candidate)
    if (cs > ws) return candidate
    if (cs < ws) return winner
    return EFFECT_SAFETY[candidate.effect] > EFFECT_SAFETY[winner.effect] ? candidate : winner
  })

  return {
    effect: best.effect,
    matchedRuleId: best.id,
    reason: best.note ?? `命中规则 ${best.from} → ${best.to}：${best.effect}`,
  }
}

export interface UpsertAclInput {
  from: string
  to: string
  effect: AclEffect
  note?: string
  createdBy: string
}

/**
 * 写入/覆盖一条规则。
 *
 * 以 `(from, to)` 为唯一键 —— 同一条边上留两条规则只会让判定变得难以预测，
 * 因此这里是"覆盖"而不是"追加"。
 */
export function upsertAclRule(rules: AclRule[], input: UpsertAclInput): AclRule {
  const existing = rules.find((rule) => rule.from === input.from && rule.to === input.to)
  if (existing !== undefined) {
    existing.effect = input.effect
    existing.note = input.note
    existing.createdBy = input.createdBy
    existing.createdAtMs = Date.now()
    return existing
  }
  const rule: AclRule = {
    id: newId('acl'),
    from: input.from,
    to: input.to,
    effect: input.effect,
    createdAtMs: Date.now(),
    createdBy: input.createdBy,
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  rules.push(rule)
  return rule
}

export function removeAclRule(rules: AclRule[], ruleId: string): boolean {
  const index = rules.findIndex((rule) => rule.id === ruleId)
  if (index < 0) return false
  rules.splice(index, 1)
  return true
}
