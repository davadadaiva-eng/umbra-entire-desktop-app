const { ConfigManager } = require('../dist/config/ConfigManager');
const { LLMConnector } = require('../dist/core/agent/LLMConnector');
const path = require('path');

async function main() {
  const cfg = new ConfigManager();
  await cfg.initialize();
  const llm = new LLMConnector(cfg.raw);
  console.log('provider:', cfg.raw.provider, '| endpoint:', cfg.raw.openaiCompatible.endpoint);
  console.log('models:', JSON.stringify(cfg.raw.models));

  const fast = await llm.complete(
    [{ role: 'user', content: 'Open the calculator app on Windows. Reply with one line.' }],
    'fast', { temperature: 0.1, maxTokens: 200 },
  );
  console.log('\n[fast] gpt-oss-20b =>', JSON.stringify(fast.content.slice(0, 120)), '| model:', fast.modelUsed, '| tokens:', fast.totalTokens);

  const reasoning = await llm.complete(
    [{ role: 'system', content: 'You are a task planner. Reply in JSON.' },
     { role: 'user', content: 'Plan: open example.com and read the title. Give 2 steps as JSON array.' }],
    'reasoning', { temperature: 0.1, maxTokens: 500 },
  );
  console.log('\n[reasoning] nemotron-ultra =>', JSON.stringify(reasoning.content.slice(0, 160)), '| model:', reasoning.modelUsed, '| tokens:', reasoning.totalTokens);

  const vision = await llm.complete(
    [{ role: 'user', content: [
      { type: 'text', text: 'What text is in this image? One word.' },
      { type: 'image', image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ] }],
    'vision', { temperature: 0.1, maxTokens: 50 },
  );
  console.log('\n[vision] llama-3.2-90b =>', JSON.stringify(vision.content.slice(0, 80)), '| model:', vision.modelUsed, '| tokens:', vision.totalTokens);
}

main().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
