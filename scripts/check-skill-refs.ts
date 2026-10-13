#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ProxyBridge MCP Server — Skill 引用完整性检查（AC-16）

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

let errors = 0

// 读取 SKILL.md
const skillMdPath = resolve(rootDir, 'skills/proxybridge/SKILL.md')
if (!existsSync(skillMdPath)) {
  console.error('❌ 缺少 skills/proxybridge/SKILL.md')
  process.exit(1)
}

const skillContent = readFileSync(skillMdPath, 'utf-8')

// 提取 references 引用
const referencePattern = /references\/([\w-]+\.md)/g
const references = [...skillContent.matchAll(referencePattern)]

console.log(`在 SKILL.md 中找到 ${references.length} 个 references 引用`)

// 检查每个引用是否存在
for (const [, refName] of references) {
  const refPath = resolve(rootDir, 'skills/proxybridge/references', refName)
  if (!existsSync(refPath)) {
    console.error(`❌ 缺少引用文件: ${refName}`)
    errors++
  } else {
    const content = readFileSync(refPath, 'utf-8')
    if (content.split('\n').length < 40) {
      console.error(`⚠️  ${refName} 行数不足 40 行: ${content.split('\n').length}`)
    } else {
      console.log(`✅ ${refName} 存在且长度足够`)
    }
  }
}

// 检查 SKILL.md 基本结构
const frontmatterMatch = skillContent.match(/^---\n(.*?)\n---\n/s)
if (!frontmatterMatch) {
  console.error('❌ SKILL.md 缺少 frontmatter')
  errors++
} else {
  const fm = frontmatterMatch[1]
  if (!fm.includes('name:')) {
    console.error('❌ frontmatter 缺少 name 字段')
    errors++
  }
  if (!fm.includes('description:')) {
    console.error('❌ frontmatter 缺少 description 字段')
    errors++
  }
}

// 检查行数
const lineCount = skillContent.split('\n').length
if (lineCount > 400) {
  console.error(`⚠️  SKILL.md 行数超过 400 行: ${lineCount}`)
} else {
  console.log(`✅ SKILL.md 行数: ${lineCount}`)
}

if (errors === 0) {
  console.log('\n✅ Skill 引用检查通过')
  process.exit(0)
} else {
  console.error(`\n❌ 发现 ${errors} 处问题`)
  process.exit(1)
}
