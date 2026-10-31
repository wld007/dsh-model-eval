import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadDataset } from '../lib/datasets.js'
import { buildMessages } from '../lib/prompt.js'

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const mixed = await loadDataset(fixture('mixed.jsonl'))
assert.equal(mixed.samples.length, 6)
assert.equal(mixed.samples[0].category, '地理')
assert.deepEqual(mixed.samples[0].choices, ['上海', '北京', '广州', '深圳'])
assert.deepEqual(mixed.samples[4].answer, ['你好', '您好'])

const limited = await loadDataset(fixture('mixed.jsonl'), { limit: 2 })
assert.equal(limited.samples.length, 2)
assert.equal(limited.totalSamples, 6)
assert.ok(limited.warnings.some((w) => w.includes('前 2 条')))

const csv = await loadDataset(fixture('mcq.csv'))
assert.equal(csv.samples.length, 3)
assert.equal(csv.samples[1].input, '下列哪项是 "胰岛素" 的主要作用？\n（单选）')
assert.deepEqual(csv.samples[1].choices, ['升高血糖', '降低血糖', '升高血压', '降低体温'])
assert.equal(csv.samples[0].category, '医学')
const csvMessages = buildMessages(csv.samples[0])
assert.match(csvMessages[0].content, /B\. 60-100/)
assert.match(csvMessages[0].content, /请直接给出正确选项的字母/)

const chat = await loadDataset(fixture('chat.json'))
assert.equal(chat.samples.length, 3)
assert.equal(chat.samples[0].answer, 'HTN')
assert.equal(chat.samples[0].messages.length, 2)
assert.deepEqual(buildMessages(chat.samples[0]).map((m) => m.role), ['system', 'user'])
assert.equal(chat.samples[1].input, '把下面的句子翻译成英文\n\n今天天气很好')
assert.equal(chat.samples[1].answer, 'The weather is nice today')
assert.equal(chat.samples[2].id, 'm1#2')
assert.ok(chat.warnings.some((w) => w.includes('缺少输入字段')))
assert.ok(chat.warnings.some((w) => w.includes('id 重复')))

// Templates and system prompt override.
const templated = buildMessages(mixed.samples[0], { template: '问题：{{input}}\n{{choices}}\n类别：{{category}}', systemPrompt: '只回答字母' })
assert.equal(templated[0].content, '只回答字母')
assert.equal(templated[1].content, '问题：中国的首都是哪里？\nA. 上海\nB. 北京\nC. 广州\nD. 深圳\n类别：地理')

await assert.rejects(loadDataset(fixture('nope.jsonl')), /不存在/)

console.log('datasets: ok')
