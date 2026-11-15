import { Worker } from 'node:worker_threads';
import { SaxesParser } from 'saxes';

export const IMAGE_DIMENSIONS = Object.freeze({
  square: [1024, 1024],
  landscape: [1536, 1024],
  portrait: [1024, 1536],
});

const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'title',
  'desc',
]);
const ATTRIBUTES = new Set([
  'xmlns',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'id',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
]);

function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function validateSvg(source, aspect = 'square') {
  const dimensions = IMAGE_DIMENSIONS[aspect];
  if (!dimensions) throw new Error('svg_invalid_aspect');
  if (typeof source !== 'string' || Buffer.byteLength(source) > 131072) {
    throw new Error('svg_invalid_size');
  }
  const text = source.trim();
  const parser = new SaxesParser();
  const output = [];
  let count = 0;
  let depth = 0;
  let rootSeen = false;
  parser.on('doctype', () => {
    throw new Error('svg_doctype_forbidden');
  });
  parser.on('processinginstruction', () => {
    throw new Error('svg_instruction_forbidden');
  });
  parser.on('opentag', (node) => {
    count += 1;
    depth += 1;
    if (count > 2048 || depth > 32) throw new Error('svg_too_complex');
    if (!ELEMENTS.has(node.name) || (node.name === 'svg' && rootSeen)) {
      throw new Error('svg_element_forbidden');
    }
    const attributes = { ...node.attributes };
    for (const [name, value] of Object.entries(attributes)) {
      if (!ATTRIBUTES.has(name) || value.length > 32768 || /[<>\\]/u.test(value)) {
        throw new Error('svg_attribute_forbidden');
      }
      if (name === 'xmlns') {
        if (depth !== 1 || value !== 'http://www.w3.org/2000/svg')
          throw new Error('svg_namespace_forbidden');
      } else if (/url\s*\(/iu.test(value) && !/^url\(\s*#[A-Za-z_][\w.-]*\s*\)$/u.test(value)) {
        throw new Error('svg_external_resource_forbidden');
      }
    }
    if (!rootSeen) {
      if (node.name !== 'svg') throw new Error('svg_root_required');
      rootSeen = true;
      const [width, height] = dimensions;
      const box = attributes.viewBox
        ?.trim()
        .split(/[\s,]+/u)
        .map(Number) ?? [0, 0, width, height];
      if (
        box.length !== 4 ||
        !box.every(Number.isFinite) ||
        box[2] <= 0 ||
        box[3] <= 0 ||
        box.some((value) => Math.abs(value) > 16384)
      ) {
        throw new Error('svg_invalid_viewbox');
      }
      attributes.xmlns = 'http://www.w3.org/2000/svg';
      attributes.width = String(width);
      attributes.height = String(height);
      attributes.viewBox = box.join(' ');
    }
    output.push(
      `<${node.name}${Object.entries(attributes)
        .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
        .join('')}>`,
    );
  });
  parser.on('closetag', (node) => {
    output.push(`</${node.name}>`);
    depth -= 1;
  });
  parser.on('text', (value) => {
    if (depth > 0) output.push(escapeXml(value));
  });
  parser.on('cdata', (value) => {
    output.push(escapeXml(value));
  });
  parser.on('error', () => {
    throw new Error('svg_invalid_xml');
  });
  parser.write(text).close();
  if (!rootSeen) throw new Error('svg_root_required');
  return output.join('');
}

export function renderSvg(svg, { signal, timeoutMs = 5000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./svg-render-worker.js', import.meta.url), {
      workerData: { svg },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => finish(new Error('svg_render_aborted'));
    const timer = setTimeout(() => finish(new Error('svg_render_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message) => {
      if (message.error) finish(new Error('svg_render_failed'));
      else finish(null, Buffer.from(message.data));
    });
    worker.once('error', () => finish(new Error('svg_render_failed')));
    worker.once('exit', () => {
      if (!settled) finish(new Error('svg_render_failed'));
    });
  });
}
