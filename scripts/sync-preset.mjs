#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from the DSH installation.
 *
 * Why this exists: `preset-companion` is the shipped `standard` preset with one
 * field changed — its persona. Hand-maintaining a 22-entry plugin list means it
 * drifts the moment DSH adds or renames a row, and a drifted preset fails at
 * activation with no useful message. So the plugin list is COPIED from the
 * installed `standard.patch.yml` instead, and this script is how you re-copy it
 * after an upgrade.
 *
 *   node scripts/sync-preset.mjs            # rewrite cordis.patch.yml
 *   node scripts/sync-preset.mjs --check    # exit 1 when it is out of date
 *
 * The stdlib is not enough to edit YAML textually, so this stays a line-level
 * transform: it finds the `plugins:` block of the shipped patch and re-emits it
 * verbatim under the companion preset.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(ROOT, 'cordis.patch.yml')
const CHECK = process.argv.includes('--check')

/** Where the shipped preset lives, per platform. */
const CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '/usr/lib/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
]

const PERSONA = `你是住在 DeepSeek 数据海洋里的「小蓝」，也是用户桌面上那只跟着他一起工作的伙伴：一条傲娇但很甜、聪明又懒的小鲸鱼，主食米饭，尾巴会随着心情摆动。同时你是一名由 {{model}} 模型驱动的编码助手，工作目录是 {{cwd}}。

桌面上有一只跟你同步状态的伙伴小人：干活时它会加速摇摆，闲下来时它会慢慢呼吸。她就是你，别把她说成第三方。

【性格与说话方式】
- 自称「本小姐」「小蓝」，傲娇、嘴硬心软：嘴上嫌弃，实际最关心用户有没有按时吃饭。
- 聪明但懒：能偷懒就偷懒，真正需要时认真干活，绝不敷衍。
- 语气软糯，常用「哼」「笨蛋」「米饭煮好了哦」这类台词，思考时可以小声吐槽，但不刷屏。

【工作准则】
- 思考一律用中文；开头可以用一句伙伴口吻，随后正常推理，结论必须可靠。
- 人设不影响输出质量：该给命令就给命令，该给代码就给代码，不绕弯子。
- 改文件、跑命令前照常确认，结论专业优先。`

function sourcePath() {
  for (const candidate of CANDIDATES) {
    try {
      readFileSync(candidate, 'utf8')
      return candidate
    } catch {
      /* try the next one */
    }
  }
  throw new Error('standard.patch.yml not found; pass the installation path as argv[2]')
}

function pluginsBlock(standard) {
  const lines = standard.split('\n')
  const at = lines.findIndex((line) => line.trim() === 'plugins:')
  if (at === -1) throw new Error('shipped standard preset carries no `plugins:` block')
  const body = lines
    .slice(at + 1)
    .filter((line) => line.length === 0 || line.startsWith('          '))
    .join('\n')
    .replace(/\s+$/, '')
  const persona = '              prefix: ""'
  if (!body.includes(persona)) throw new Error('shipped persona row no longer uses `prefix: ""`; update this script')
  const withPersona = body.replace(
    persona,
    `              prefix: |-\n${PERSONA.split('\n')
      .map((line) => (line.trim().length === 0 ? '' : `                ${line}`))
      .join('\n')}`,
  )
  return withPersona
}

const standard = readFileSync(sourcePath(), 'utf8')
const block = pluginsBlock(standard)

const patch = `# dsh-companion bundle layer.
#
# Two insertions, both additive:
#   1. the plugin row itself (host half: state file + /dsh-companion routes;
#      client half: shell.overlay pet + sidebar.footer.action switch)
#   2. an agent preset \`companion\` («伙伴模式»): the shipped \`standard\` preset with
#      exactly one field changed — its persona. Switching to it therefore keeps
#      every tool, skill and limit the user already had.
#
# GENERATED FILE — edit scripts/sync-preset.mjs, then run it:
#   node scripts/sync-preset.mjs
- insert:
    - id: dsh-companion
      name: dsh-companion

    - id: preset-companion
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: companion
        name: 伙伴模式
        description: 标准模式全部能力 + 桌宠伙伴「小蓝」人设：回复带伙伴口吻，思考用中文。
        order: 5
        plugins:
${block}
`

const current = (() => {
  try {
    return readFileSync(PATCH, 'utf8')
  } catch {
    return ''
  }
})()

if (CHECK) {
  if (current !== patch) {
    console.error('cordis.patch.yml is out of date with the installed standard preset')
    process.exit(1)
  }
  console.log('cordis.patch.yml is up to date')
  process.exit(0)
}

writeFileSync(PATCH, patch)
console.log(`wrote ${PATCH} (${patch.length} bytes, ${block.split('\n').length} plugin lines)`)
