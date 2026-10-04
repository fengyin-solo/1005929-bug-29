// 跨平台测试入口：用 esbuild 的 JS API 把 TS 场景脚本转成 CJS 再执行。
// 用法：node scripts/run-meter-scenarios.mjs
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outfile = join(tmpdir(), 'meter-scenarios.cjs')
await build({
  entryPoints: ['scripts/meter-scenarios.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'warning',
})
try {
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(outfile, { force: true })
}
