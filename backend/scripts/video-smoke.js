/* Live smoke test: VideoProducer end-to-end without an LLM (script provided).
   Proves: OpenMontage bridge -> narration (piper) -> Remotion atelier compose -> render. */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { VideoProducer } = require('../dist/core/video/VideoProducer');
const { OpenMontageBridge } = require('../dist/core/video/OpenMontageBridge');

const fakeLLM = {
  complete: async () => ({ content: '{}' }),
};

async function main() {
  const bridge = new OpenMontageBridge();
  const producer = new VideoProducer(fakeLLM, bridge);
  if (!producer.isAvailable()) {
    console.error('FAIL: OpenMontage not installed');
    process.exit(1);
  }

  const script = {
    title: 'Umbra Smoke Test',
    narration: 'Umbra OS can now produce narrated videos from a script, with Remotion compositions and local speech.',
    scenes: [
      { type: 'title', title: 'Umbra OS' },
      { type: 'bullets', title: 'What is new', lines: ['Remotion compositions', 'Local narration', 'OpenMontage tools'] },
      { type: 'quote', text: 'Videos, generated locally.' },
      { type: 'text', text: 'This clip was rendered end to end on this machine.' },
    ],
  };

  console.log('Producing video...');
  const result = await producer.produceVideo({ description: 'smoke', title: 'umbra-smoke', script });

  if (!fs.existsSync(result.videoPath)) {
    console.error(`FAIL: no video at ${result.videoPath}`);
    process.exit(1);
  }

  const ffprobe = findFfprobe() || 'ffprobe';
  const probe = execSync(
    `"${ffprobe}" -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "${result.videoPath}"`,
    { encoding: 'utf-8' },
  );
  console.log('OK video:', result.videoPath);
  console.log('OK narration:', result.narrationPath);
  console.log(probe.trim());
}

function findFfprobe() {
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMDATA];
  for (const root of roots) {
    if (!root) continue;
    const base = path.join(root, 'Microsoft', 'WinGet', 'Packages');
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === 'ffprobe.exe') return full;
      }
    }
  }
  return null;
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
