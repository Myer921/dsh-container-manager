#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = join(root, 'src/client.template.js')
const cssPath = join(root, 'src/client.css')
const messagesPath = join(root, 'src/client-messages.json')
const outputPath = join(root, 'client.js')
const check = process.argv.includes('--check')

function replaceOnce(source, marker, value, label) {
  const first = source.indexOf(marker)
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(label + ' 占位符必须恰好出现一次')
  }
  return source.slice(0, first) + value + source.slice(first + marker.length)
}

const template = readFileSync(templatePath, 'utf8')
const css = readFileSync(cssPath, 'utf8')
const messages = JSON.parse(readFileSync(messagesPath, 'utf8'))
if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
  throw new Error('client-messages.json 必须是对象')
}
const output = replaceOnce(
  replaceOnce(template, '__CM_CSS__', JSON.stringify(css), 'CSS'),
  '__CM_MESSAGES__', JSON.stringify(messages),
  'MESSAGES',
)

if (check) {
  const current = readFileSync(outputPath, 'utf8')
  if (current !== output) {
    console.error('client.js 与 src/ 不一致，请运行 npm run build:client')
    process.exit(1)
  }
  console.log('client.js 与 src/ 一致')
} else {
  writeFileSync(outputPath, output)
  console.log('已生成 client.js（' + Buffer.byteLength(output) + ' 字节）')
}
