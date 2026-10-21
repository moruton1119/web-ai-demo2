/** Thin host bindings. This file contains no model lifecycle or generation policy. */
export function attachCore(module, schema, { suspension = 'direct' } = {}) {
  if (!['direct', 'asyncify'].includes(suspension)) throw new TypeError('Unknown suspension mode');
  if (suspension === 'asyncify' && typeof module.ccall !== 'function') {
    throw new TypeError('Asyncify calls require the Emscripten ccall helper');
  }
  if (module._sdc_abi_version() !== schema.abiVersion) {
    throw new Error('The runtime and binding schema have different ABI versions');
  }
  if (typeof module._sdc_schema_hash !== 'function' || typeof schema.schemaSha256 !== 'string') {
    throw new Error('Missing binding-schema fingerprint');
  }
  const hashPointer = Number(module._sdc_schema_hash());
  if (!Number.isSafeInteger(hashPointer) || hashPointer < 0 || hashPointer + 65 > module.HEAPU8.length ||
      new TextDecoder().decode(module.HEAPU8.subarray(hashPointer, hashPointer + 64)) !== schema.schemaSha256) {
    throw new Error('The compiled core and binding schema do not match');
  }
  const records = new Map(schema.records.map(record => [record.name, record]));
  const constants = new Map(schema.constants.map((name, index) => [name, index]));
  let busy = false;
  const assertIdle = () => {
    if (busy) throw new Error('A native call is pending; serialize access to this module');
  };
  const asIndex = value => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Unsafe memory index');
    return n;
  };
  const span = (pointer, length) => {
    const start = asIndex(pointer);
    const size = asIndex(length);
    // Always re-read HEAPU8: memory growth can invalidate cached views.
    const heap = module.HEAPU8;
    if (start > heap.length || size > heap.length - start) throw new RangeError('Memory access out of bounds');
    return new Uint8Array(heap.buffer, heap.byteOffset + start, size);
  };
  function recordInfo(name) {
    const record = records.get(name);
    if (!record) throw new TypeError(`Unknown record: ${name}`);
    return record;
  }
  function fieldInfo(name, field) {
    const record = recordInfo(name);
    const spec = record.fields.find(entry => entry.name === field);
    if (!spec) throw new TypeError(`Unknown field: ${name}.${field}`);
    return {
      ...spec,
      offset: module._sdc_offsetof_field(record.id, spec.id),
      size: asIndex(module._sdc_sizeof_field(record.id, spec.id)),
    };
  }
  function fieldView(name, pointer, field) {
    const info = fieldInfo(name, field);
    const bytes = span(BigInt(pointer) + info.offset, info.size);
    return { info, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
  const api = Object.create(null);
  const scalarType = kind => ['pointer', 'record', 'u64', 'i64'].includes(kind) ? 'bigint' : 'number';
  for (const fn of schema.functions) {
    if (typeof module[fn.export] !== 'function') throw new Error(`Missing export: ${fn.export}`);
    api[fn.name] = async (...args) => {
      assertIdle();
      const kinds = fn.parameters.map(p => p.kind);
      if (fn.returnKind === 'record') kinds.unshift('pointer');
      if (args.length !== kinds.length) throw new TypeError(`${fn.name}: expected ${kinds.length} arguments`);
      kinds.forEach((kind, index) => {
        const value = args[index];
        if (['pointer', 'record', 'u64', 'i64'].includes(kind)) {
          if (typeof value !== 'bigint') throw new TypeError(`${fn.name}: argument ${index} must be bigint`);
          const min = kind === 'i64' ? -(1n << 63n) : 0n;
          const max = kind === 'i64' ? (1n << 63n) - 1n : (1n << 64n) - 1n;
          if (value < min || value > max) throw new RangeError('64-bit argument out of range');
        } else {
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Numeric argument required');
          if (kind !== 'float' && (!Number.isInteger(value) ||
              value < (kind === 'signed' ? -2147483648 : 0) ||
              value > (kind === 'signed' ? 2147483647 : kind === 'boolean' ? 1 : 4294967295))) {
            throw new RangeError('Integer argument out of range');
          }
        }
      });
      busy = true;
      try {
        // A raw Asyncify export returns while Wasm is unwound. ccall owns the
        // completion Promise; awaiting the raw return would release the guard early.
        // Normalized pointers use uint64_t even on Wasm32, so preserve bigint arguments.
        return await (suspension === 'asyncify'
          ? module.ccall(fn.export.slice(1),
            ['void', 'record'].includes(fn.returnKind) ? null : scalarType(fn.returnKind),
            kinds.map(scalarType), args, { async: true })
          : module[fn.export](...args));
      }
      finally { busy = false; }
    };
  }
  return {
    module, api, schema,
    get busy() { return busy; },
    pointerBytes: module._sdc_pointer_bytes(),
    constant(name) {
      if (!constants.has(name)) throw new TypeError(`Unknown constant: ${name}`);
      const value = module._sdc_constant(constants.get(name));
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new RangeError('Constant cannot be represented exactly as a number');
      return n;
    },
    alloc(bytes) {
      assertIdle();
      const size = asIndex(bytes);
      if (size === 0) throw new RangeError('Allocation size must be positive');
      const ptr = module._sdc_malloc(BigInt(size));
      if (ptr === 0n) throw new Error('Native allocation failed');
      return ptr;
    },
    free(pointer) { assertIdle(); module._sdc_free(BigInt(pointer)); },
    recordSize(name) { return asIndex(module._sdc_sizeof_record(recordInfo(name).id)); },
    recordAlignment(name) { return asIndex(module._sdc_alignof_record(recordInfo(name).id)); },
    allocRecord(name) {
      const size = this.recordSize(name);
      const pointer = this.alloc(size);
      span(pointer, size).fill(0);
      return pointer;
    },
    fieldAddress(name, pointer, field) {
      return BigInt(pointer) + fieldInfo(name, field).offset;
    },
    getField(name, pointer, field) {
      const { info, view } = fieldView(name, pointer, field);
      const { kind, size } = info;
      if (kind === 'record' || kind === 'array') throw new TypeError('Use fieldAddress for compound fields');
      if (kind === 'float') return size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
      const signed = kind === 'signed' || kind === 'i64';
      const method = `get${size === 8 ? 'Big' : ''}${signed ? 'Int' : 'Uint'}${size * 8}`;
      const value = view[method](0, true);
      return ['pointer', 'u64', 'i64'].includes(kind) ? BigInt(value) : value;
    },
    setField(name, pointer, field, value) {
      assertIdle();
      const { info, view } = fieldView(name, pointer, field);
      const { kind, size } = info;
      if (kind === 'record' || kind === 'array') throw new TypeError('Use fieldAddress for compound fields');
      if (kind === 'float') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('A finite number is required');
        view[size === 4 ? 'setFloat32' : 'setFloat64'](0, value, true);
        return;
      }
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        throw new TypeError('An exact integer is required');
      }
      const integer = BigInt(value);
      const signed = kind === 'signed' || kind === 'i64';
      const bits = BigInt(size * 8);
      const min = signed ? -(1n << (bits - 1n)) : 0n;
      const max = kind === 'boolean' ? 1n : signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      if (integer < min || integer > max) throw new RangeError('Field value out of range');
      const method = `set${size === 8 ? 'Big' : ''}${signed ? 'Int' : 'Uint'}${size * 8}`;
      view[method](0, size === 8 ? integer : Number(integer), true);
    },
    bytes: span,
    utf8(text) {
      const data = new TextEncoder().encode(text);
      const pointer = this.alloc(data.length + 1);
      const dest = span(pointer, data.length + 1);
      dest.set(data); dest[data.length] = 0;
      return pointer;
    },
    readUtf8(pointer, maximum = 1048576) {
      const start = asIndex(pointer);
      if (start === 0) return null;
      const heap = module.HEAPU8;
      if (start >= heap.length) throw new RangeError('String pointer out of bounds');
      const end = Math.min(start + asIndex(maximum), heap.length);
      let stop = start;
      while (stop < end && heap[stop] !== 0) stop++;
      if (stop === end) throw new RangeError('Unterminated string within requested limit');
      return new TextDecoder().decode(heap.subarray(start, stop));
    },
  };
}
