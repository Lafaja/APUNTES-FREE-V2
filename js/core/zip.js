// ZIP mínimo (escritura y lectura) sin dependencias. Compatible con cualquier descompresor.
// - Escritura: método "store" o "deflate" (CompressionStream), nombres UTF-8.
// - Lectura: directorio central + descompresión con DecompressionStream.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const enc = new TextEncoder();

function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
  const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, day };
}

async function streamTransform(u8, stream) {
  const res = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export const canDeflate = typeof globalThis.CompressionStream === 'function';
export const canInflate = typeof globalThis.DecompressionStream === 'function';

/**
 * Escritor ZIP. `sink.write(chunk: Uint8Array|Blob)` puede ser asíncrono.
 */
export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.entries = [];
    this.offset = 0;
    this.names = new Set();
  }

  async _write(chunk) {
    this.offset += chunk.byteLength !== undefined ? chunk.byteLength : chunk.size;
    await this.sink.write(chunk);
  }

  async add(name, data, { compress = true, date = new Date() } = {}) {
    let u8 = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this.names.has(name)) throw new Error(`Entrada duplicada en ZIP: ${name}`);
    this.names.add(name);
    const crc = crc32(u8);
    let method = 0;
    let payload = u8;
    if (compress && canDeflate && u8.length > 256) {
      try {
        const c = await streamTransform(u8, new CompressionStream('deflate-raw'));
        if (c.length < u8.length * 0.95) {
          payload = c;
          method = 8;
        }
      } catch {
        // Si falla la compresión, se guarda sin comprimir.
      }
    }
    if (this.offset + payload.length > 0xfffffff0) throw new Error('La copia supera 4 GB; divídela en varias (exporta por carpetas).');
    const nameBytes = enc.encode(name);
    const { time, day } = dosDateTime(date);
    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, method, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, day, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, payload.length, true);
    dv.setUint32(22, u8.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    const localOffset = this.offset;
    await this._write(header);
    await this._write(payload);
    this.entries.push({ nameBytes, crc, csize: payload.length, usize: u8.length, method, time, day, localOffset });
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, e.time, true);
      dv.setUint16(14, e.day, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.csize, true);
      dv.setUint32(24, e.usize, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint32(42, e.localOffset, true);
      rec.set(e.nameBytes, 46);
      await this._write(rec);
    }
    const cdSize = this.offset - cdStart;
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, cdSize, true);
    dv.setUint32(16, cdStart, true);
    await this._write(end);
    if (this.sink.close) await this.sink.close();
  }
}

/** Sumidero en memoria que produce un Blob (las partes se convierten en Blobs para no retener memoria JS). */
export function blobSink(type = 'application/zip') {
  const parts = [];
  return {
    write(chunk) {
      parts.push(chunk instanceof Blob ? chunk : new Blob([chunk]));
    },
    toBlob() {
      return new Blob(parts, { type });
    }
  };
}

/** Lector ZIP sobre un Blob/File (no carga el archivo entero en memoria). */
export class ZipReader {
  constructor(blob) {
    this.blob = blob;
    this.entries = null;
  }

  async _read(start, end) {
    return new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
  }

  async list() {
    if (this.entries) return this.entries;
    const size = this.blob.size;
    const tailLen = Math.min(size, 65557);
    const tail = await this._read(size - tailLen, size);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('El archivo no es un ZIP válido');
    const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
    const count = dv.getUint16(10, true);
    const cdSize = dv.getUint32(12, true);
    const cdOffset = dv.getUint32(16, true);
    const cd = await this._read(cdOffset, cdOffset + cdSize);
    const cdv = new DataView(cd.buffer);
    const dec = new TextDecoder();
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cdv.getUint32(p, true) !== 0x02014b50) throw new Error('Directorio del ZIP dañado');
      const method = cdv.getUint16(p + 10, true);
      const crc = cdv.getUint32(p + 16, true);
      const csize = cdv.getUint32(p + 20, true);
      const usize = cdv.getUint32(p + 24, true);
      const nlen = cdv.getUint16(p + 28, true);
      const xlen = cdv.getUint16(p + 30, true);
      const clen = cdv.getUint16(p + 32, true);
      const offset = cdv.getUint32(p + 42, true);
      const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
      entries.push({ name, method, crc, csize, usize, offset });
      p += 46 + nlen + xlen + clen;
    }
    this.entries = entries;
    return entries;
  }

  async read(entryOrName) {
    const entries = await this.list();
    const e = typeof entryOrName === 'string' ? entries.find(x => x.name === entryOrName) : entryOrName;
    if (!e) return null;
    const lh = await this._read(e.offset, e.offset + 30);
    const ldv = new DataView(lh.buffer);
    if (ldv.getUint32(0, true) !== 0x04034b50) throw new Error(`Entrada dañada: ${e.name}`);
    const start = e.offset + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
    const raw = await this._read(start, start + e.csize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) {
      if (!canInflate) throw new Error('Este navegador no puede descomprimir la copia');
      out = await streamTransform(raw, new DecompressionStream('deflate-raw'));
    } else {
      throw new Error(`Método de compresión no soportado en ${e.name}`);
    }
    if (crc32(out) !== e.crc) throw new Error(`La entrada ${e.name} está dañada (CRC incorrecto)`);
    return out;
  }

  async readText(name) {
    const u8 = await this.read(name);
    return u8 ? new TextDecoder().decode(u8) : null;
  }

  async readJSON(name) {
    const t = await this.readText(name);
    return t ? JSON.parse(t) : null;
  }
}
