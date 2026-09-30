/**
 * 桌面通知（尽力而为）。
 *
 * 用途：`dse pair-code` 在终端本机生成配对码后，让码直接出现在屏幕上 ——
 * 人不用切回终端窗口抄码。这只是加分项：任何一步失败都静默回落，
 * 终端输出里永远有码，弹窗绝不阻塞主流程。
 *
 * 平台取舍：
 *   · macOS 用 osascript 的 display notification（不抢焦点；display dialog 是模态框，
 *     会把正在打字的人打断，不合适）；
 *   · Windows 用 PowerShell + WinForms 的 BalloonTip（真正的 Toast 需要注册 AppID，
 *     为一条通知去写注册表不值得）；
 *   · Linux 桌面环境差异太大（notify-send 不一定存在），直接跳过。
 */

import { execFile } from 'node:child_process'

/** 在系统通知里显示一个新的配对码。code 只可能是 6 位数字（我们自己生成的），无注入面。 */
export async function showPairCodeNotification(code: string): Promise<void> {
  const text = `新设备配对码：${code}（10 分钟内有效）`
  try {
    if (process.platform === 'darwin') {
      await run('osascript', [
        '-e',
        `display notification "${text}" with title "DSEmployee" sound name "Glass"`,
      ])
      return
    }
    if (process.platform === 'win32') {
      await run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          '$n = New-Object System.Windows.Forms.NotifyIcon',
          '$n.Icon = [System.Drawing.SystemIcons]::Information',
          '$n.Visible = $true',
          `$n.ShowBalloonTip(8000, 'DSEmployee', '${text}', 'Info')`,
          // NotifyIcon 进程一退就消失，多停几秒让气球真的被看见
          'Start-Sleep -Seconds 9',
          '$n.Dispose()',
        ].join('; '),
      ])
      return
    }
    // Linux：跳过（见头部注释）
  } catch {
    /* 静默回落：终端输出已经足够 */
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error) => {
      if (error !== null) reject(error)
      else resolve()
    })
  })
}
