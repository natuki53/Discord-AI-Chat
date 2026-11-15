import { parentPort, workerData } from 'node:worker_threads';
import { Resvg } from '@resvg/resvg-js';

try {
  const renderer = new Resvg(workerData.svg, {
    font: { loadSystemFonts: false },
    logLevel: 'off',
  });
  const image = renderer.render();
  parentPort.postMessage({ data: image.asPng() });
} catch {
  parentPort.postMessage({ error: 'svg_render_failed' });
}
