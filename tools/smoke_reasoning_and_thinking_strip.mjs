import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentCode = fs.readFileSync(path.join(__dirname, '../agent/ai_worker_agent.mjs'), 'utf8');

// Test 1: Verify stripThinkingBlocks regex
const stripThinkingRegex = /<think>[\s\S]*?<\/think>/gi;

const inputWithThink = `<think>
Let's see, the user wants JSON:
{ "step": "scratchpad" }
</think>
{
  "task_id": "123",
  "result": "success",
  "score": 95
}`;

const cleaned = inputWithThink.replace(stripThinkingRegex, '').trim();
assert(!cleaned.includes('<think>'), 'Thinking tags must be removed');
assert(!cleaned.includes('scratchpad'), 'Content inside thinking tags must be removed');
assert(cleaned.startsWith('{'), 'Cleaned output should start with valid JSON');

const parsed = JSON.parse(cleaned);
assert.strictEqual(parsed.task_id, '123');
assert.strictEqual(parsed.score, 95);

// Test 2: Verify enable_thinking in buildPayload in ai_worker_agent.mjs
assert(agentCode.includes('enable_thinking: false'), 'enable_thinking: false must be present in buildPayload');
assert(agentCode.includes('chat_template_kwargs: { enable_thinking: false }'), 'chat_template_kwargs must be present');

// Test 3: Verify reasoning_content fallback
assert(agentCode.includes('message.reasoning_content'), 'message.reasoning_content fallback must be present');
assert(agentCode.includes('message.reasoning'), 'message.reasoning fallback must be present');

// Test 4: Verify stripThinkingBlocks is called in callOllamaOnce, callOpenAICompatOnce, and parseJsonCandidate
assert(agentCode.includes('return stripThinkingBlocks(text);'), 'stripThinkingBlocks must be called on LLM response');
assert(agentCode.includes('const cleaned = stripThinkingBlocks(text);'), 'parseJsonCandidate must clean thinking blocks');

console.log('smoke_reasoning_and_thinking_strip: ALL TESTS PASSED (100% OK)');
