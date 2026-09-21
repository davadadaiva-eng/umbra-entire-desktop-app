const fetch = require('node-fetch').default;
async function main() {
  const res = await fetch('http://127.0.0.1:8787/api/mcp/catalog?limit=2');
  const json = await res.json();
  console.log('Response keys:', Object.keys(json));
  console.log('Full response:', JSON.stringify(json, null, 2).substring(0, 1000));
}
main();
