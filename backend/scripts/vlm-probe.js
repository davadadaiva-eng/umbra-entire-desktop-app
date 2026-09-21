const path = require('path');
const os = require('os');
const fs = require('fs');

const umbra = 'C:\\Users\\User1\\.claude\\Nuova cartella\\davide\\umbra';
const { LLMConnector } = require(path.join(umbra, 'dist', 'core', 'agent', 'LLMConnector.js'));

const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.umbra', 'config.json'), 'utf-8'));

async function main() {
  const shot = fs.readFileSync(path.join(os.homedir(), '.umbra', 'tmp', 'desktop2-test.png'));
  const base64 = shot.toString('base64');

  const llm = new LLMConnector(config);
  console.log('provider=' + config.provider + ' visionModel=' + config.models.vision);

  const messages = [
    { role: 'system', content: 'You are a computer-use verifier. Respond with JSON only: {"verified": true/false, "reason": "short"}' },
    { role: 'user', content: [
      { type: 'text', text: 'Did the action succeed? Action: Navigate to example.com' },
      { type: 'image', image: base64, detail: 'low' },
    ] },
  ];

  try {
    const result = await llm.complete(messages, 'vision', { temperature: 0.1 });
    console.log('RAW CONTENT: ' + JSON.stringify(result.content));
    console.log('modelUsed: ' + result.modelUsed);
    try {
      const parsed = JSON.parse(result.content);
      console.log('PARSED OK: ' + JSON.stringify(parsed));
      process.exit(0);
    } catch (e) {
      console.log('JSON PARSE FAILED: ' + e.message);
      process.exit(2);
    }
  } catch (e) {
    console.log('CALL FAILED: ' + e.message);
    process.exit(3);
  }
}

main().catch(e => { console.log('FATAL: ' + e.message); process.exit(4); });
