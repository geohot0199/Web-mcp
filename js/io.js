/*
 * Asset import / export. Orbit is no longer export-only: an agent can load
 * existing meshes, reason about them, modify them, and write them back.
 *
 * Import : OBJ · STL (ascii + binary) · PLY (ascii) · glTF/GLB (embedded)
 * Export : OBJ · STL (ascii + binary) · PLY · glTF 2.0 (JSON, base64 buffer)
 */

import { mesh, weld, cleanMesh, bounds, triangleCount, vertexCount, getVertex, sub, cross, normalize, volume, transformMesh, multiply } from './geom.js';

/* ------------------------------------------------------------------ util */

const toBase64 = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const fromBase64 = (text) => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text, 'base64'));
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export const SUPPORTED_IMPORT = ['obj', 'stl', 'ply', 'gltf', 'glb'];
export const SUPPORTED_EXPORT = ['obj', 'stl', 'stl-ascii', 'ply', 'gltf'];

/* ---------------------------------------------------------------- import */

export function parseOBJ(text, options = {}) {
  const maxTriangles = options.maxTriangles;
  const positions = [];
  const out = mesh();
  const remap = new Map();
  const pushVertex = (token) => {
    const key = token.split('/')[0];
    let index = Number.parseInt(key, 10);
    if (Number.isNaN(index)) return null;
    if (index < 0) index = positions.length + index; else index -= 1;
    if (!remap.has(index)) {
      const p = positions[index];
      if (!p) return null;
      remap.set(index, vertexCount(out));
      out.vertices.push(p[0], p[1], p[2]);
    }
    return remap.get(index);
  };
  if (typeof text !== 'string' || !text.trim()) throw new Error('parseOBJ: empty input');
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      positions.push([Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0]);
    } else if (parts[0] === 'f') {
      if (maxTriangles !== undefined && out.indices.length / 3 >= maxTriangles) {
        throw new Error(`parseOBJ: file exceeds the ${maxTriangles}-triangle budget — refusing to continue`);
      }
      const face = parts.slice(1).map(pushVertex).filter((i) => i !== null);
      for (let i = 1; i < face.length - 1; i += 1) out.indices.push(face[0], face[i], face[i + 1]);
    }
  }
  if (!out.indices.length) throw new Error('parseOBJ: file declares no faces');
  return weld(out);
}

export function parseSTL(data, options = {}) {
  if (typeof data === 'string') {
    if (/^\s*solid/i.test(data) && /facet\s+normal/i.test(data)) return parseSTLAscii(data, options);
    throw new Error('parseSTL: string input is not ASCII STL');
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const header = new TextDecoder().decode(bytes.slice(0, 80));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 84) {
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.length) return parseSTLBinary(view, count, options);
  }
  const text = new TextDecoder().decode(bytes);
  if (/facet\s+normal/i.test(text)) return parseSTLAscii(text, options);
  throw new Error(`parseSTL: unrecognised STL (header: ${header.slice(0, 20)})`);
}

function parseSTLBinary(view, count, options = {}) {
  if (options.maxTriangles !== undefined && count > options.maxTriangles) {
    throw new Error(`parseSTL: file declares ${count.toLocaleString()} triangles — above the ${options.maxTriangles.toLocaleString()}-triangle budget, refusing to decode`);
  }
  const out = mesh();
  let offset = 84;
  for (let i = 0; i < count; i += 1) {
    offset += 12; // skip the stored normal; we recompute from winding
    const base = vertexCount(out);
    for (let v = 0; v < 3; v += 1) {
      out.vertices.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
      offset += 12;
    }
    out.indices.push(base, base + 1, base + 2);
    offset += 2;
  }
  return weld(out);
}

function parseSTLAscii(text, options = {}) {
  const out = mesh();
  const numbers = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let match;
  const buffer = [];
  while ((match = numbers.exec(text)) !== null) {
    if (options.maxTriangles !== undefined && buffer.length / 3 >= options.maxTriangles * 3) {
      throw new Error(`parseSTL: file exceeds the ${options.maxTriangles}-triangle budget — refusing to continue`);
    }
    buffer.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  for (let i = 0; i + 2 < buffer.length; i += 3) {
    const base = vertexCount(out);
    for (let v = 0; v < 3; v += 1) out.vertices.push(...buffer[i + v]);
    out.indices.push(base, base + 1, base + 2);
  }
  return weld(out);
}

export function parsePLY(text, options = {}) {
  if (typeof text !== 'string' || !/^\s*ply/i.test(text)) throw new Error('parsePLY: not a PLY file');
  const lines = String(text).split(/\r?\n/);
  let vertexTotal = 0;
  let faceTotal = 0;
  let headerEnd = -1;
  let inVertexElement = false;
  const properties = []; // property names of the vertex element, in order
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const element = line.match(/^element\s+(\w+)\s+(\d+)/);
    if (element) {
      inVertexElement = element[1] === 'vertex';
      if (inVertexElement) vertexTotal = Number(element[2]);
      else if (element[1] === 'face') faceTotal = Number(element[2]);
      continue;
    }
    const property = line.match(/^property\s+(?:list\s+\S+\s+\S+|\S+)\s+(\S+)/);
    if (property && inVertexElement) properties.push(property[1]);
    if (line === 'end_header') { headerEnd = i; break; }
  }
  if (headerEnd < 0) throw new Error('parsePLY: missing end_header');
  // Each coordinate is located by *name*, independently — valid PLY files may
  // interleave normals or colours between x, y and z, or declare them in any
  // order, and assuming adjacency corrupts every vertex position.
  const xi = properties.indexOf('x');
  const yi = properties.indexOf('y');
  const zi = properties.indexOf('z');
  if (xi < 0 || yi < 0 || zi < 0) {
    throw new Error(`parsePLY: vertex element must declare x, y and z properties (found: ${properties.join(', ') || 'none'})`);
  }
  if (options.maxTriangles !== undefined && faceTotal > options.maxTriangles) {
    throw new Error(`parsePLY: file declares ${faceTotal.toLocaleString()} faces — above the ${options.maxTriangles.toLocaleString()}-triangle budget, refusing to decode`);
  }
  const out = mesh();
  let cursor = headerEnd + 1;
  for (let i = 0; i < vertexTotal; i += 1) {
    const parts = (lines[cursor++] || '').trim().split(/\s+/).map(Number);
    out.vertices.push(parts[xi] || 0, parts[yi] || 0, parts[zi] || 0);
  }
  for (let i = 0; i < faceTotal; i += 1) {
    const parts = (lines[cursor++] || '').trim().split(/\s+/).map(Number);
    const n = parts[0];
    for (let k = 1; k < n - 1; k += 1) out.indices.push(parts[1], parts[1 + k], parts[2 + k]);
  }
  if (!out.indices.length) throw new Error('parsePLY: file declares no faces');
  return weld(out);
}

/** Node local matrix: T · R(quaternion) · S, column-major like compose(). */
function gltfNodeMatrix(node) {
  const t = node.translation || [0, 0, 0];
  const s = node.scale || [1, 1, 1];
  const r = node.rotation;
  let m00 = 1; let m01 = 0; let m02 = 0;
  let m10 = 0; let m11 = 1; let m12 = 0;
  let m20 = 0; let m21 = 0; let m22 = 1;
  if (Array.isArray(r) && r.length === 4) {
    let [x, y, z, w] = r;
    const len = Math.hypot(x, y, z, w);
    if (len > 0) { x /= len; y /= len; z /= len; w /= len; }
    m00 = 1 - 2 * (y * y + z * z); m01 = 2 * (x * y - z * w); m02 = 2 * (x * z + y * w);
    m10 = 2 * (x * y + z * w); m11 = 1 - 2 * (x * x + z * z); m12 = 2 * (y * z - x * w);
    m20 = 2 * (x * z - y * w); m21 = 2 * (y * z + x * w); m22 = 1 - 2 * (x * x + y * y);
  }
  return [
    m00 * s[0], m10 * s[0], m20 * s[0], 0,
    m01 * s[1], m11 * s[1], m21 * s[1], 0,
    m02 * s[2], m12 * s[2], m22 * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

export function parseGLTF(source, options = {}) {
  const json = typeof source === 'string' ? JSON.parse(source) : source;
  const buffers = (json.buffers || []).map((buffer) => {
    // Only self-contained data URIs are accepted. A relative path or an http(s)
    // URI would make the importer fetch attacker-chosen locations on behalf of
    // the agent, so it is refused outright rather than resolved.
    if (typeof buffer.uri !== 'string' || !buffer.uri.startsWith('data:')) {
      throw new Error('parseGLTF: only embedded data-uri buffers are supported (external buffer references are refused)');
    }
    const comma = buffer.uri.indexOf(',');
    if (comma < 0) throw new Error('parseGLTF: malformed data uri');
    return fromBase64(buffer.uri.slice(comma + 1));
  });
  const componentBytes = (type) => ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type] || 1);
  const readAccessor = (index) => {
    const accessor = json.accessors[index];
    const view = json.bufferViews[accessor.bufferView];
    const bytes = buffers[view.buffer];
    const offset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const components = componentBytes(accessor.type);
    const compSize = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[accessor.componentType];
    if (!compSize) throw new Error(`parseGLTF: unsupported componentType ${accessor.componentType}`);
    const tight = components * compSize;
    // Interleaved vertex data (byteStride > the attribute's own size) must be
    // read with its stride; assuming a tight layout decodes padding or the
    // neighbouring attribute as coordinates.
    const stride = view.byteStride && view.byteStride > tight ? view.byteStride : tight;
    if (offset + (accessor.count - 1) * stride + tight > bytes.byteLength) {
      throw new Error('parseGLTF: accessor reads past the end of its buffer');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = [];
    for (let i = 0; i < accessor.count; i += 1) {
      const base = offset + i * stride;
      for (let c = 0; c < components; c += 1) {
        const at = base + c * compSize;
        if (accessor.componentType === 5126) values.push(dv.getFloat32(at, true));
        else if (accessor.componentType === 5125) values.push(dv.getUint32(at, true));
        else if (accessor.componentType === 5123) values.push(dv.getUint16(at, true));
        else values.push(dv.getUint8(at));
      }
    }
    return values;
  };
  const primitiveTriangles = (primitive) => {
    if (primitive.indices !== undefined) {
      const count = json.accessors[primitive.indices].count;
      return Math.floor(count / 3);
    }
    const count = json.accessors[primitive.attributes.POSITION].count;
    return Math.floor(count / 3);
  };
  // The asset's total triangle count is declared in the accessors, so the
  // budget is enforced *before* any buffer is decoded — a hostile 100 GB
  // declaration is refused without ever allocating.
  if (options.maxTriangles !== undefined) {
    const nodes = json.nodes || [];
    const totalTriangles = (count) => {
      let sum = 0;
      const walk = (nodeIndex) => {
        const node = nodes[nodeIndex];
        if (!node) return;
        const meshDef = (json.meshes || [])[node.mesh];
        for (const primitive of meshDef?.primitives || []) {
          if (primitive.attributes?.POSITION !== undefined) sum += primitiveTriangles(primitive);
        }
        for (const child of node.children || []) walk(child);
      };
      for (const nodeIndex of count) walk(nodeIndex);
      return sum;
    };
    const declared = totalTriangles((json.scenes && Array.isArray(json.scenes[0]?.nodes) && json.scenes[0].nodes.length)
      ? json.scenes[0].nodes
      : nodes.map((_, i) => i));
    if (declared > options.maxTriangles) {
      throw new Error(`parseGLTF: asset declares ${declared.toLocaleString()} triangles — above the ${options.maxTriangles.toLocaleString()}-triangle budget, refusing to decode`);
    }
  }
  const nodes = json.nodes || [];
  const sceneId = json.scene !== undefined ? json.scene : 0;
  const sceneNodes = (json.scenes && Array.isArray(json.scenes[sceneId]?.nodes) && json.scenes[sceneId].nodes.length)
    ? json.scenes[sceneId].nodes
    : nodes.map((_, i) => i);
  const parts = [];
  const visit = (nodeIndex, parentMatrix) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const world = parentMatrix ? multiply(parentMatrix, gltfNodeMatrix(node)) : gltfNodeMatrix(node);
    if (node.mesh !== undefined) {
      const meshDef = (json.meshes || [])[node.mesh];
      for (const primitive of meshDef?.primitives || []) {
        if (primitive.attributes?.POSITION === undefined) continue;
        const positions = readAccessor(primitive.attributes.POSITION);
        const indices = primitive.indices !== undefined
          ? readAccessor(primitive.indices)
          : positions.map((_, i) => i / 3).filter((n) => Number.isInteger(n));
        parts.push(transformMesh(mesh(positions, indices), world));
      }
    }
    for (const child of node.children || []) visit(child, world);
  };
  for (const nodeIndex of sceneNodes) visit(nodeIndex, null);
  // Degenerate-but-legal files carry meshes without any node/scene graph:
  // instantiate every primitive at the identity so those still import.
  if (!parts.length && !nodes.length && (json.meshes || []).length) {
    for (const meshDef of json.meshes) {
      for (const primitive of meshDef.primitives || []) {
        if (primitive.attributes?.POSITION === undefined) continue;
        const positions = readAccessor(primitive.attributes.POSITION);
        const indices = primitive.indices !== undefined
          ? readAccessor(primitive.indices)
          : positions.map((_, i) => i / 3).filter((n) => Number.isInteger(n));
        parts.push(mesh(positions, indices));
      }
    }
  }
  if (options.maxTriangles !== undefined) {
    const total = parts.reduce((sum, part) => sum + part.indices.length / 3, 0);
    if (total > options.maxTriangles) {
      throw new Error(`parseGLTF: asset has ${Math.round(total).toLocaleString()} triangles — above the ${options.maxTriangles.toLocaleString()}-triangle budget, refusing to import`);
    }
  }
  if (!parts.length) throw new Error('parseGLTF: no mesh primitives found');
  if (!parts.some((part) => part.indices.length)) throw new Error('parseGLTF: primitives contain no faces');
  const merged = parts.reduce((acc, part) => {
    const offset = vertexCount(acc);
    return mesh(acc.vertices.concat(part.vertices), acc.indices.concat(part.indices.map((i) => i + offset)));
  }, mesh());
  return weld(merged);
}

export function parseGLB(bytes, options = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('parseGLB: bad magic');
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < data.length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunk = data.slice(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (chunkType === 0x004e4942) binary = chunk;
    offset += 8 + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new Error('parseGLB: no JSON chunk');
  if (binary && json.buffers?.[0] && !json.buffers[0].uri) {
    json.buffers[0].uri = `data:application/octet-stream;base64,${toBase64(binary)}`;
  }
  return parseGLTF(json, options);
}

/**
 * Format-sniffing entry point used by the `import_mesh` tool. `options`
 * carries the scene's remaining triangle budget; every parser enforces it
 * while decoding so an oversized asset is refused before it can exhaust
 * memory, not merely rejected after it has already been stored.
 */
export function importMesh(data, format = 'auto', options = {}) {
  const fmt = format === 'auto' ? sniffFormat(data) : String(format).toLowerCase();
  switch (fmt) {
    case 'obj': return parseOBJ(typeof data === 'string' ? data : new TextDecoder().decode(data), options);
    case 'stl': return parseSTL(data, options);
    case 'ply': return parsePLY(typeof data === 'string' ? data : new TextDecoder().decode(data), options);
    case 'gltf': return parseGLTF(typeof data === 'string' ? data : new TextDecoder().decode(data), options);
    case 'glb': return parseGLB(data, options);
    default: throw new Error(`importMesh: unsupported format "${fmt}"`);
  }
}

export function sniffFormat(data) {
  if (typeof data !== 'string') {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
    const head = new TextDecoder().decode(bytes.slice(0, 256)).trim();
    if (head.startsWith('{')) return 'gltf';
    if (/^ply/i.test(head)) return 'ply';
    if (/^solid/i.test(head) && /facet/i.test(new TextDecoder().decode(bytes.slice(0, 2048)))) return 'stl';
    return 'stl';
  }
  const head = data.trim();
  if (head.startsWith('{')) return 'gltf';
  if (/^ply/i.test(head)) return 'ply';
  if (/^solid/i.test(head)) return 'stl';
  if (/^(v|vn|vt|f|o|g|mtllib)\s/m.test(head)) return 'obj';
  return 'obj';
}

/* ---------------------------------------------------------------- export */

export function exportOBJ(m, name = 'orbit') {
  const lines = [`# Orbit export — ${triangleCount(m)} triangles`, `o ${name}`];
  for (let i = 0; i < m.vertices.length; i += 3) {
    lines.push(`v ${m.vertices[i].toFixed(6)} ${m.vertices[i + 1].toFixed(6)} ${m.vertices[i + 2].toFixed(6)}`);
  }
  for (let i = 0; i < m.indices.length; i += 3) {
    lines.push(`f ${m.indices[i] + 1} ${m.indices[i + 1] + 1} ${m.indices[i + 2] + 1}`);
  }
  return `${lines.join('\n')}\n`;
}

export function exportSTLAscii(m, name = 'orbit') {
  const lines = [`solid ${name}`];
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = getVertex(m, m.indices[i]);
    const b = getVertex(m, m.indices[i + 1]);
    const c = getVertex(m, m.indices[i + 2]);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    lines.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
    lines.push('    outer loop');
    for (const v of [a, b, c]) lines.push(`      vertex ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return `${lines.join('\n')}\n`;
}

/** Binary STL with the Materialise Magics colour convention (bit 15 clear). */
export function exportSTLBinary(m, options = {}) {
  const { color = null } = options;
  const count = triangleCount(m);
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const header = color
    ? `Orbit binary STL COLOR=${color}`
    : 'Orbit binary STL';
  bytes.set(new TextEncoder().encode(header.slice(0, 79)), 0);
  view.setUint32(80, count, true);
  let offset = 84;
  const encoded = color ? encodeMagicsColor(color) : 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = getVertex(m, m.indices[i]);
    const b = getVertex(m, m.indices[i + 1]);
    const c = getVertex(m, m.indices[i + 2]);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    view.setFloat32(offset, n[0], true); view.setFloat32(offset + 4, n[1], true); view.setFloat32(offset + 8, n[2], true);
    offset += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(offset, v[0], true); view.setFloat32(offset + 4, v[1], true); view.setFloat32(offset + 8, v[2], true);
      offset += 12;
    }
    view.setUint16(offset, encoded, true);
    offset += 2;
  }
  return bytes;
}

function encodeMagicsColor(hex) {
  const value = String(hex).replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16) || 0;
  const g = Number.parseInt(value.slice(2, 4), 16) || 0;
  const b = Number.parseInt(value.slice(4, 6), 16) || 0;
  // Magics: bit 15 clear (valid), red in bits 0–4, green 5–9, blue 10–14.
  return ((r >> 3) & 0x1f) | (((g >> 3) & 0x1f) << 5) | (((b >> 3) & 0x1f) << 10);
}

export function exportPLY(m) {
  const lines = [
    'ply', 'format ascii 1.0', 'comment Orbit export',
    `element vertex ${vertexCount(m)}`,
    'property float x', 'property float y', 'property float z',
    `element face ${triangleCount(m)}`,
    'property list uchar int vertex_index', 'end_header'
  ];
  for (let i = 0; i < m.vertices.length; i += 3) {
    lines.push(`${m.vertices[i]} ${m.vertices[i + 1]} ${m.vertices[i + 2]}`);
  }
  for (let i = 0; i < m.indices.length; i += 3) {
    lines.push(`3 ${m.indices[i]} ${m.indices[i + 1]} ${m.indices[i + 2]}`);
  }
  return `${lines.join('\n')}\n`;
}

/** glTF 2.0 with a single embedded base64 buffer — materials included. */
export function exportGLTF(m, options = {}) {
  const { name = 'orbit', color = '#c8c8c8', metallic = 0.9, roughness = 0.3 } = options;
  const positions = new Float32Array(m.vertices);
  const indices = new Uint32Array(m.indices);
  const positionBytes = new Uint8Array(positions.buffer);
  const indexBytes = new Uint8Array(indices.buffer);
  const pad = (4 - (positionBytes.length % 4)) % 4;
  const merged = new Uint8Array(positionBytes.length + pad + indexBytes.length);
  merged.set(positionBytes, 0);
  merged.set(indexBytes, positionBytes.length + pad);

  const b = bounds(m);
  const hex = String(color).replace('#', '');
  const rgb = [0, 2, 4].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) || 200) / 255);

  return JSON.stringify({
    asset: { version: '2.0', generator: 'Orbit WebMCP agent studio' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{
      name: `${name}_material`,
      pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: metallic, roughnessFactor: roughness }
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount(m), type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 1, componentType: 5125, count: m.indices.length, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length + pad, byteLength: indexBytes.length, target: 34963 }
    ],
    buffers: [{ byteLength: merged.length, uri: `data:application/octet-stream;base64,${toBase64(merged)}` }]
  }, null, 2);
}

export function exportMesh(m, format = 'stl', options = {}) {
  switch (String(format).toLowerCase()) {
    case 'obj': return { data: exportOBJ(m, options.name), mime: 'model/obj', binary: false };
    case 'stl-ascii': return { data: exportSTLAscii(m, options.name), mime: 'model/stl', binary: false };
    case 'stl': return { data: exportSTLBinary(m, options), mime: 'model/stl', binary: true };
    case 'ply': return { data: exportPLY(m), mime: 'application/octet-stream', binary: false };
    case 'gltf': return { data: exportGLTF(m, options), mime: 'model/gltf+json', binary: false };
    default: throw new Error(`exportMesh: unsupported format "${format}"`);
  }
}
