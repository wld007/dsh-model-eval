import assert from 'node:assert/strict'
import {
  answerLetter, autoScorer, bleu, extractChoice, extractPredictedNumber, parseNumber, rougeL, scoreOutput, tokenF1,
} from '../lib/scorers.js'
import { normalize, stripReasoning, tokenize } from '../lib/text.js'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

test('normalize: full-width, case, edge punctuation', () => {
  assert.equal(normalize('  ＡＢＣ。 '), 'abc')
  assert.equal(normalize('“你好！”'), '你好')
  assert.equal(normalize('Hello   World.'), 'hello world')
})

test('stripReasoning', () => {
  assert.equal(stripReasoning('<think>abc</think> 答案 B'), '答案 B')
  assert.equal(stripReasoning('长篇推理…</think>B'), 'B')
  assert.equal(stripReasoning('plain'), 'plain')
})

test('tokenize mixes CJK chars and words', () => {
  assert.deepEqual(tokenize('高血压 HTN 2型'), ['高', '血', '压', 'htn', '2', '型'])
})

test('extractChoice patterns', () => {
  const choices = ['上海', '北京', '广州', '深圳']
  assert.equal(extractChoice('答案是 B', choices), 'B')
  assert.equal(extractChoice('正确答案：（C）', choices), 'C')
  assert.equal(extractChoice('The answer is d.', choices), 'D')
  assert.equal(extractChoice('B. 北京', choices), 'B')
  assert.equal(extractChoice('我选择 A，因为…', choices), 'A')
  assert.equal(extractChoice('应该是北京吧', choices), 'B')
  assert.equal(extractChoice('A', choices), 'A')
  assert.equal(extractChoice('I think so', choices), null)
  // E is outside the 4 options.
  assert.equal(extractChoice('答案是 E', choices), null)
})

test('answerLetter accepts letter, index, option text', () => {
  const choices = ['x', 'y', 'z']
  assert.equal(answerLetter({ choices, answer: 'b' }), 'B')
  assert.equal(answerLetter({ choices, answer: 2 }), 'C')
  assert.equal(answerLetter({ choices, answer: 'z' }), 'C')
  assert.equal(answerLetter({ choices, answer: '(A) x' }), 'A')
})

test('numbers', () => {
  assert.equal(parseNumber('1,230'), 1230)
  assert.equal(parseNumber('3/4'), 0.75)
  assert.equal(parseNumber('15%'), 0.15)
  assert.equal(parseNumber('2型糖尿病'), null)
  assert.equal(parseNumber('42 apples'), null)
  assert.equal(extractPredictedNumber('先算 3+5=8，所以答案是 8。'), 8)
  assert.equal(extractPredictedNumber('#### 1,230'), 1230)
  assert.equal(extractPredictedNumber('结果 \\boxed{12}'), 12)
  assert.equal(extractPredictedNumber('共 7 个，再加 2 个是 9'), 9)
  assert.equal(scoreOutput('number', '答案是 8', { answer: 'a\n#### 8' }).pass, true)
  assert.equal(scoreOutput('number', '答案是 8.0000001', { answer: '8' }).pass, true)
  assert.equal(scoreOutput('number', '答案是 9', { answer: '8' }).pass, false)
})

test('autoScorer', () => {
  assert.equal(autoScorer({ choices: ['a', 'b'], answer: 'A' }), 'choice')
  assert.equal(autoScorer({ answer: '#### 72' }), 'number')
  assert.equal(autoScorer({ answer: '2型糖尿病' }), 'exact')
  assert.equal(autoScorer({ answer: 'x', scorer: 'f1' }), 'f1')
})

test('exact / includes / regex with multiple references', () => {
  assert.equal(scoreOutput('exact', '您好！', { answer: ['你好', '您好'] }).pass, true)
  assert.equal(scoreOutput('includes', '诊断为 2 型糖尿病。', { answer: '2型糖尿病' }).pass, false)
  assert.equal(scoreOutput('includes', '诊断为2型糖尿病。', { answer: '2型糖尿病' }).pass, true)
  assert.equal(scoreOutput('regex', 'Stage IIIA', { answer: 'stage\\s*iii' }).pass, true)
  assert.equal(scoreOutput('regex', 'stage iiia', { answer: '/Stage/' }).pass, false)
  assert.equal(scoreOutput('exact', 'x', { answer: '' }).error, 'missing-reference')
})

test('overlap metrics', () => {
  assert.equal(tokenF1('the cat sat', 'the cat sat'), 1)
  assert.ok(Math.abs(tokenF1('高血压病', '高血压') - 2 * (3 / 4) * 1 / (3 / 4 + 1)) < 1e-9)
  assert.equal(tokenF1('abc', 'xyz'), 0)
  assert.equal(rougeL('a b c d', 'a c d'), 2 * (3 / 4) * 1 / (3 / 4 + 1))
  assert.ok(bleu('the cat is on the mat', 'the cat is on the mat') > 0.99)
  assert.ok(bleu('the cat', 'the cat is on the mat') < 0.5)
  const graded = scoreOutput('f1', '患者高血压', { answer: '高血压' }, { threshold: 0.7 })
  assert.equal(graded.pass, true)
  assert.ok(graded.score < 1)
})

console.log(`scorers: ${passed} passed`)
