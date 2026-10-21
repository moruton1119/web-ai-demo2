/**
 * Mount a synchronous random-access source on Emscripten's JavaScript FS.
 * The caller owns the source, its lifetime, persistence and locking policy.
 */
export function mountReadOnlyFile(core, path, source, { maxChunkBytes = 8 * 1024 * 1024 } = {}) {
  const { FS } = core.module;
  if (!FS?.createNode) throw new Error('The JavaScript filesystem was not exported');
  if (!path.startsWith('/') || path.endsWith('/') || path.split('/').some(x => x === '..' || x === '.')) {
    throw new TypeError('An absolute file path without dot segments is required');
  }
  if (!Number.isSafeInteger(source.size) || source.size < 0 || typeof source.read !== 'function') {
    throw new TypeError('Source requires a safe integer size and a synchronous read(view, offset) function');
  }
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new RangeError('Invalid chunk size');
  const fail = code => { throw new FS.ErrnoError(core.constant(code)); };
  const split = path.lastIndexOf('/');
  const parentPath = path.slice(0, split) || '/';
  FS.mkdirTree(parentPath);
  if (FS.analyzePath(path).exists) throw new Error(`File already exists: ${path}`);
  const parent = FS.lookupPath(parentPath).node;
  const timestamp = Date.now();
  const node = FS.createNode(parent, path.slice(split + 1), 0o100444, 0);
  const size = source.size;
  let opens = 0;
  let removed = false;
  node.node_ops = {
    getattr() {
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
        size, atime: new Date(timestamp), mtime: new Date(timestamp), ctime: new Date(timestamp),
        blksize: 4096, blocks: Math.ceil(size / 4096) };
    },
    setattr() { fail('EROFS'); },
  };
  node.stream_ops = {
    open(stream) {
      if (removed) fail('ENOENT');
      if ((stream.flags & 3) !== 0 || (stream.flags & 512) !== 0) fail('EROFS');
      opens++;
    },
    close() { opens--; },
    llseek(stream, offset, whence) {
      const position = offset + (whence === 0 ? 0 : whence === 1 ? stream.position : whence === 2 ? size : NaN);
      if (!Number.isSafeInteger(position) || position < 0) fail('EINVAL');
      return position;
    },
    read(_stream, buffer, offset, length, position) {
      if (![offset, length, position].every(Number.isSafeInteger) || Math.min(offset, length, position) < 0 ||
          offset > buffer.length || length > buffer.length - offset) fail('EINVAL');
      let done = 0;
      const wanted = Math.min(length, Math.max(0, size - position));
      while (done < wanted) {
        const n = Math.min(maxChunkBytes, wanted - done);
        const view = buffer.subarray(offset + done, offset + done + n);
        let count;
        try { count = source.read(view, position + done); }
        catch { fail('EIO'); }
        // Promises, oversized counts and negative results are errors, not successful short reads.
        if (!Number.isSafeInteger(count) || count < 0 || count > n) fail('EIO');
        if (count === 0) break;
        done += count;
      }
      return done;
    },
    write() { fail('EROFS'); },
    mmap() { fail('EINVAL'); },
  };
  // createNode registers the node in FS's name hash; MEMFS also needs its directory entry.
  if (!parent.contents || typeof parent.contents !== 'object') {
    FS.destroyNode(node);
    throw new Error('The parent must be a writable directory in MEMFS');
  }
  parent.contents[node.name] = node;
  return {
    path,
    remove() {
      if (opens !== 0) throw new Error('Close all native file handles before removing this source');
      if (!removed) { FS.unlink(path); removed = true; }
    },
  };
}
